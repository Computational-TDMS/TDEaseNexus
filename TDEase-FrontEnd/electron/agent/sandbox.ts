/**
 * OS-level sandbox for the agent's persistent bash — defense in depth, not a
 * permission system.
 *
 * First principles (the same conclusion pi's security.md and Claude Code's
 * sandboxing doc reach): string rules and prompts stop the MODEL, but a bash
 * command runs under a real shell with the user's whole file tree in reach.
 * The permission engine (permissionResolver.ts) decides what asks; the
 * destructive-command blacklist (permission-gateway.ts) blocks known
 * machine-killers; only the OS can make "ran but could not escape" true. This
 * module is that third layer: it wraps the persistent bash process at spawn
 * time so the WHOLE session shell lives inside an OS-enforced box — writes
 * confined to the Workspace and the OS temp area, everything else read-only.
 * The sandbox holds regardless of any allow/ask/deny decision, exactly like
 * the containment layer does.
 *
 * Platform matrix (honest): macOS wraps with sandbox-exec/Seatbelt; Linux
 * with bubblewrap; Windows has no sandbox primitive an Electron app can use
 * without a privileged helper, so there the agent bash runs unsandboxed and
 * the containment + blacklist layers remain the boundary — the settings page
 * and this comment say so rather than pretending. A restricted-token backend
 * can slot in behind `planBashSandbox` later without touching callers.
 *
 * The wrapper encloses the persistent shell itself (not per-command wrapping
 * like Claude Code): the session keeps its cd/env state, and the profile is
 * computed once per spawn from the bound workspace root. Network policy is
 * deliberately NOT restricted yet — git push / pip install are legitimate
 * workflows, and a domain proxy is a separate, larger mechanism.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export type SandboxBackendId = 'seatbelt' | 'bwrap' | 'none'

export interface SandboxProfile {
  /** Absolute Workspace root: the primary read-write area inside the box. */
  workspaceRoot: string
}

export interface SandboxPlan {
  readonly backend: Exclude<SandboxBackendId, 'none'>
  /** argv prefix that goes before the bash invocation. */
  readonly prefix: ReadonlyArray<string>
  /** Extra env stamped onto the sandboxed process (audit/display marker). */
  readonly env: Readonly<Record<string, string>>
  /** Release temp resources (the Seatbelt profile file) once the shell dies. */
  dispose(): void
}

/**
 * Plan the sandbox for one persistent-bash spawn. Returns undefined when no
 * OS sandbox is available (Windows, or the tool is missing on this machine) —
 * callers then spawn exactly as before, so availability can never change the
 * command shape, only the box around it.
 */
export function planBashSandbox(profile: SandboxProfile): SandboxPlan | undefined {
  const backend = selectSandboxBackend(process.platform)
  if (backend === 'seatbelt') return planSeatbelt(profile)
  if (backend === 'bwrap') return planBwrap(profile)
  return undefined
}

/**
 * Pick the backend for this machine. `none` on anything unsupported — never a
 * half-working approximation: a sandbox that silently does less than it claims
 * is worse than none, because callers would stop asking.
 */
export function selectSandboxBackend(platform: NodeJS.Platform): SandboxBackendId {
  if (platform === 'darwin' && existsSync(SEATBELT_EXEC)) return 'seatbelt'
  if (platform === 'linux' && bwrapOnPath()) return 'bwrap'
  return 'none'
}

const SEATBELT_EXEC = '/usr/bin/sandbox-exec'

// Capability is checked once per process: the persistent shell spawns once per
// session, but the settings display and tests may ask repeatedly.
let bwrapAvailable: boolean | undefined

function bwrapOnPath(): boolean {
  if (bwrapAvailable !== undefined) return bwrapAvailable
  try {
    // Presence is not capability. Ubuntu 24.04 ships bwrap but restricts
    // unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1),
    // so every real invocation dies with "setting up uid map: Permission
    // denied" and an interactive shell would exit during startup. Prove a
    // trivial namespace can actually be created before committing to bwrap.
    const probe = spawnSync(
      'bwrap',
      ['--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc', '--', 'true'],
      { stdio: 'ignore', timeout: 5_000 },
    )
    bwrapAvailable = probe.status === 0
  } catch {
    bwrapAvailable = false
  }
  return bwrapAvailable
}

// ── macOS: sandbox-exec (Seatbelt) ───────────────────────────────────────────
//
// Default-allow with writes pinned down: an interactive bash needs to exec the
// user's toolchain from anywhere (brew, nvm, system python), so a default-deny
// profile would break every legitimate command. What a coding agent must not
// do is WRITE outside the analysis surface, so file-write* is denied and
// re-allowed exactly for the Workspace and the OS temp area. `-i` bash and its
// toolchains also write tiny session files (bash history is off, but git, ssh,
// compilers want $HOME caches) — those fail closed to read-only, which is the
// intended posture: analysis runs, machine configuration does not.

export function seatbeltProfile(profile: SandboxProfile): string {
  const workspace = path.resolve(profile.workspaceRoot)
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${workspace}") (subpath "${tmpdir()}"))`,
  ].join('\n')
}

function planSeatbelt(profile: SandboxProfile): SandboxPlan {
  // The profile must come from a file (sandbox-exec has no stdin mode). A
  // private temp directory per spawn; dispose removes it when the shell dies.
  const dir = mkdtempSync(path.join(tmpdir(), 'tdease-sandbox-'))
  const profileFile = path.join(dir, 'profile.sb')
  writeFileSync(profileFile, seatbeltProfile(profile), 'utf8')
  return {
    backend: 'seatbelt',
    prefix: [SEATBELT_EXEC, '-f', profileFile],
    env: { TDEASE_SANDBOX: 'seatbelt' },
    dispose() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // A leaked empty temp dir is preferable to failing shell teardown.
      }
    },
  }
}

// ── Linux: bubblewrap ────────────────────────────────────────────────────────
//
// Same posture as Seatbelt, expressed as mounts: the whole root re-bound
// read-only, then the Workspace and temp re-bound writable. /dev, /proc and
// the X11-less runtime bits a shell needs stay as-is (bwrap requires them for
// anything beyond `true`), which keeps every toolchain working. Later binds
// override earlier ones — the writable pair must come after the ro-bind.

export function bwrapPrefix(profile: SandboxProfile): ReadonlyArray<string> {
  const workspace = path.resolve(profile.workspaceRoot)
  const temp = tmpdir()
  return [
    'bwrap',
    '--ro-bind', '/', '/',
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
    '--bind', workspace, workspace,
    '--bind', temp, temp,
    '--',
  ]
}

function planBwrap(profile: SandboxProfile): SandboxPlan {
  return {
    backend: 'bwrap',
    prefix: bwrapPrefix(profile),
    env: { TDEASE_SANDBOX: 'bwrap' },
    dispose() {
      // No temp resources: the args are pure data.
    },
  }
}
