import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { NodePermissionGateway } from './permission-gateway'
import { deepFreeze, type SessionBinding } from './turn-definition'
import { AGENT_PERMISSION_ACTIONS, type PermissionSnapshot } from '../../src/contracts/agent-runtime'

function makeGateway(appDataRoot?: string): NodePermissionGateway {
  const workspaceRoot = path.join(os.tmpdir(), 'tdease-gw-test')
  fs.mkdirSync(path.join(workspaceRoot, '.tdease', 'skills', 'probe'), { recursive: true })
  const permissionCeiling = Object.fromEntries(
    AGENT_PERMISSION_ACTIONS.map((action) => [action, 'allow']),
  ) as PermissionSnapshot
  const binding = deepFreeze<SessionBinding>({
    workspaceId: 'gw-test', sessionId: 'gw-session',
    workspaceRoot,
    authority: 'local-user', permissionCeiling,
    toolCeiling: { builtins: ['bash'], mcp: false }, generation: 1,
  })
  const systemWikiRoot = path.join(os.tmpdir(), 'tdease-gw-wiki')
  fs.mkdirSync(path.join(systemWikiRoot, 'method'), { recursive: true })
  return new NodePermissionGateway(binding, systemWikiRoot, appDataRoot)
}

describe('NodePermissionGateway app-data relaxation', () => {
  const dataRoot = path.join(os.tmpdir(), 'tdease-gw-data')
  fs.mkdirSync(path.join(dataRoot, 'backend', 'nodes'), { recursive: true })
  fs.mkdirSync(path.join(dataRoot, 'system', 'logs'), { recursive: true })
  fs.mkdirSync(path.join(dataRoot, 'system', 'agent'), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'backend', 'config.json'), '{}\n')
  fs.writeFileSync(path.join(dataRoot, 'system', 'settings.json'), '{}\n')
  fs.writeFileSync(path.join(dataRoot, 'system', 'agent', 'auth.json'), '{}\n')
  const gateway = makeGateway(dataRoot)
  const inside = (...parts: string[]) => path.join(dataRoot, ...parts)

  it('lets the agent reach the product data root; the ceiling decides run vs prompt', () => {
    expect(() => gateway.assertShellCommand(`ls "${inside('backend', 'nodes')}"`)).not.toThrow()
    expect(() => gateway.assertShellCommand(`cat ${inside('system', 'logs', 'backend.log')}`)).not.toThrow()
    expect(gateway.resolveWorkspacePath(inside('backend', 'config.json'), 'read')).toContain('config.json')
    expect(gateway.assertCommandCwd(inside('backend'))).toBe(inside('backend'))
  })

  it('denies provider credentials inside the data root in every mode', () => {
    for (const operation of ['read', 'write'] as const) {
      expect(() => gateway.resolveWorkspacePath(inside('system', 'settings.json'), operation)).toThrow(/credentials/)
      expect(() => gateway.resolveWorkspacePath(inside('system', 'agent', 'auth.json'), operation)).toThrow(/credentials/)
    }
    expect(() => gateway.assertShellCommand(`cat "${inside('system', 'settings.json')}"`)).toThrow(/credential/)
    expect(() => gateway.assertShellCommand(`cat "${inside('system', 'agent', 'auth.json')}"`)).toThrow(/credential/)
    expect(() => gateway.assertShellCommand(`cd "${inside('system')}" && type settings.json`)).toThrow(/credential/)
    expect(() => gateway.assertShellCommand('type "C:\\Program Files\\TDEaseNexus\\resources\\backend\\settings.seed.json"')).toThrow(/credential/)
    expect(() => gateway.assertCommandCwd(inside('system'))).toThrow(/credentials/)
    expect(() => gateway.assertCommandCwd(inside('system', 'agent'))).toThrow(/credentials/)
  })

  it('leaves non-credential data-root paths and same-named workspace files alone', () => {
    expect(gateway.resolveWorkspacePath(inside('system', 'logs', 'backend.log'), 'read')).toContain('backend.log')
    expect(gateway.assertCommandCwd(inside('system', 'logs'))).toBe(inside('system', 'logs'))
    expect(() => gateway.assertShellCommand('cat .vscode/settings.json')).not.toThrow()
    expect(() => gateway.assertShellCommand(`ls "${inside('system', 'logs')}"`)).not.toThrow()
  })

  it('still denies outside paths that are not the data root', () => {
    expect(() => gateway.assertShellCommand('ls /etc')).toThrow(/outside the workspace/)
    expect(() => gateway.assertShellCommand('cat C:\\Users\\ray\\secret.txt')).toThrow(/outside the workspace/)
  })

  it('keeps containment: the data root cannot be climbed out of', () => {
    expect(() => gateway.resolveWorkspacePath(inside('..', '..', 'Windows'), 'read')).toThrow()
  })
})

describe('NodePermissionGateway.assertShellCommand', () => {
  const gateway = makeGateway()

  it('allows the standard stderr suppress 2>/dev/null', () => {
    // `2>/dev/null` is ubiquitous in shell discovery commands and is harmless;
    // the old rule read the `/dev/null` as an absolute redirection and denied
    // every such command, stalling the Agent's open-search flow.
    expect(() => gateway.assertShellCommand('cd $HOME 2>/dev/null; ls run 2>/dev/null')).toThrow(/outside the workspace/)
    expect(() => gateway.assertShellCommand('ls /etc')).toThrow(/outside the workspace/)
    expect(() => gateway.assertShellCommand('cat C:\\Users\\ray\\secret.txt')).toThrow(/outside the workspace/)
    expect(() => gateway.assertShellCommand('which tdeasenexus-toolbox 2>/dev/null; echo ok')).not.toThrow()
    expect(() => gateway.assertShellCommand('python census.py --out result.json 2>/dev/null')).not.toThrow()
  })

  it('allows redirection to a workspace-relative file', () => {
    // Writing analysis output into the workspace via `>` is the intended output
    // path; cwd containment already pins the shell inside the root.
    expect(() => gateway.assertShellCommand('python census.py > analysis/out.json')).not.toThrow()
  })

  it('denies redirection to a system-critical location', () => {
    expect(() => gateway.assertShellCommand('python x.py > /etc/passwd')).toThrow(/Sandbox denied system-critical redirection/)
    expect(() => gateway.assertShellCommand('python x.py > C:\\Windows\\temp\\x.txt')).toThrow(/Sandbox denied system-critical redirection/)
    expect(() => gateway.assertShellCommand('python x.py > /usr/bin/x')).toThrow(/Sandbox denied system-critical redirection/)
  })

  it('still denies the other destructive commands', () => {
    expect(() => gateway.assertShellCommand('format c:')).toThrow(/Sandbox denied disk administration/)
    expect(() => gateway.assertShellCommand('diskpart /s wipe.txt')).toThrow(/Sandbox denied disk administration/)
    expect(() => gateway.assertShellCommand('shutdown /s')).toThrow(/Sandbox denied system shutdown/)
  })

  it('denies file deletion and movement unconditionally (harness_5a5857d4 incident)', () => {
    // The incident command verbatim: a relative `rm -rf runs/<run>` from a
    // drifted cwd that the old location-conditional rule could not see.
    expect(() => gateway.assertShellCommand('cd "$TMP/../.." && pwd && rm -rf runs/histone48-mouse 2>/dev/null')).toThrow(/file deletion or movement/)
    expect(() => gateway.assertShellCommand('rm -rf /etc')).toThrow(/file deletion or movement/)
    expect(() => gateway.assertShellCommand('rm results/scratch.json')).toThrow(/file deletion or movement/)
    expect(() => gateway.assertShellCommand('rmdir analysis/old')).toThrow(/file deletion or movement/)
    expect(() => gateway.assertShellCommand('unlink tmp.lock')).toThrow(/file deletion or movement/)
    expect(() => gateway.assertShellCommand('shred notes.txt')).toThrow(/file deletion or movement/)
    expect(() => gateway.assertShellCommand('mv out.json final.json')).toThrow(/file deletion or movement/)
    expect(() => gateway.assertShellCommand('git rm -r runs/x')).toThrow(/file deletion or movement/)
    expect(() => gateway.assertShellCommand('powershell -c "Remove-Item -Recurse runs/x"')).toThrow(/file deletion or movement/)
  })

  it('does not shadow ordinary analysis commands', () => {
    // Word boundaries must not fire on substrings (form.rs, model_del.txt,
    // mvn) or the sanctioned checklist query the Agent loops over.
    expect(() => gateway.assertShellCommand('cat form.rs')).not.toThrow()
    expect(() => gateway.assertShellCommand('cat model_del.txt')).not.toThrow()
    expect(() => gateway.assertShellCommand('mvn clean')).not.toThrow()
    expect(() => gateway.assertShellCommand('rg "removed rows" notes.md')).not.toThrow()
    expect(() => gateway.assertShellCommand('tdeasenexus-toolbox spectrum --mode scans --out-format mgf sample.mzML > scan.mgf')).not.toThrow()
    expect(() => gateway.assertShellCommand('uv run --script "$TDEASE_SYSTEM_ASSETS/skills/mass-shift-analysis/scripts/checklist_query.py" --checklist runs/histone48-mouse/analysis/z/assignment-checklist.csv --offset 0 --limit 24')).not.toThrow()
  })

  it('rejects an empty command', () => {
    expect(() => gateway.assertShellCommand('')).toThrow(/A shell command is required/)
  })

  it('denies private session state but permits Workspace Skills', () => {
    expect(() => gateway.assertShellCommand('cat .tdease/sessions/old/events.jsonl')).toThrow(/workspace runtime state/)
    expect(() => gateway.assertShellCommand('rg secret .\\.tdease\\sessions')).toThrow(/workspace runtime state/)
    expect(() => gateway.assertShellCommand('cat .tdease/event.jsonl')).not.toThrow()
    expect(() => gateway.assertShellCommand('cat .tdease/events.jsonl')).toThrow(/workspace runtime state/)
    expect(() => gateway.assertShellCommand('uv run --script ".tdease/skills/probe/scripts/run.py"')).not.toThrow()
    expect(() => gateway.assertShellCommand('uv run --script "$TDEASE_SYSTEM_ASSETS/skills/probe/scripts/run.py"')).not.toThrow()
  })

  it('denies the permission policy across dot-segment, separator and case variants (2026-09-05 review)', () => {
    // The literal path was always blocked; the review bypassed the check with
    // spellings the raw-string comparison missed. Every view must deny.
    expect(() => gateway.assertShellCommand('cat .tdease/permissions.json')).toThrow(/workspace runtime state/)
    expect(() => gateway.assertShellCommand('cat .tdease/./permissions.json')).toThrow(/workspace runtime state/)
    expect(() => gateway.assertShellCommand('cat .tdease/.//././permissions.json')).toThrow(/workspace runtime state/)
    expect(() => gateway.assertShellCommand('echo x > .TDEASE\\PERMISSIONS.JSON')).toThrow(/workspace runtime state/)
    expect(() => gateway.assertShellCommand('python -c "open(\'.tdease//sessions/x/events.jsonl\')"')).toThrow(/workspace runtime state/)
  })

  it('still does not shadow benign paths that merely contain the letters', () => {
    expect(() => gateway.assertShellCommand('cat analysis/sessions-notes.md')).not.toThrow()
    expect(() => gateway.assertShellCommand('cat notes-permissions.txt')).not.toThrow()
  })
})

describe('NodePermissionGateway.resolveWorkspacePath', () => {
  const gateway = makeGateway()

  it('denies direct reads of private session state', () => {
    expect(() => gateway.resolveWorkspacePath('.tdease/sessions/old/events.jsonl', 'read')).toThrow(/private session state/)
    expect(() => gateway.resolveWorkspacePath('.\\.tdease\\sessions\\old\\snapshot.md', 'read')).toThrow(/private session state/)
    expect(() => gateway.resolveWorkspacePath('.tdease/events.jsonl', 'read')).toThrow(/private session state/)
  })

  it('denies the permission policy through dot-segment, absolute and case spellings (2026-09-05 review)', () => {
    // The private-path judgment runs on the RESOLVED absolute path, after
    // containment — the raw string is no longer the authority.
    expect(() => gateway.resolveWorkspacePath('.tdease/permissions.json', 'write')).toThrow(/private session state/)
    expect(() => gateway.resolveWorkspacePath('.tdease/./permissions.json', 'write')).toThrow(/private session state/)
    // Interior `..` that RESOLVES BACK INTO the private tree still denies;
    // `.tdease/sub/../../permissions.json` resolves to the workspace root's
    // permissions.json — a different, ordinary file — and correctly does not.
    expect(() => gateway.resolveWorkspacePath('.tdease/sub/../permissions.json', 'write')).toThrow(/private session state/)
    // Absolute-inside-workspace: containment accepts it (same root), the
    // private judgment on the resolved target still denies it.
    const root = path.join(os.tmpdir(), 'tdease-gw-test')
    expect(() => gateway.resolveWorkspacePath(path.join(root, '.tdease', 'permissions.json'), 'write')).toThrow(/private session state/)
    expect(() => gateway.resolveWorkspacePath(path.join(root, '.TDEASE', 'Permissions.Json'), 'read')).toThrow(/private session state/)
  })

  it('denies a bash cwd inside workspace runtime state', () => {
    expect(() => gateway.assertCommandCwd('.tdease/sessions/gw-session')).toThrow(/runtime state/)
    expect(() => gateway.assertCommandCwd('.tdease/./sessions')).toThrow(/runtime state/)
    expect(gateway.assertCommandCwd(undefined)).toBe(path.join(os.tmpdir(), 'tdease-gw-test'))
    expect(gateway.assertCommandCwd('analysis')).toContain('analysis')
  })

  it('keeps Workspace Skills available', () => {
    expect(gateway.resolveWorkspacePath('.tdease/skills/probe/SKILL.md', 'read')).toContain(path.join('.tdease', 'skills', 'probe', 'SKILL.md'))
  })

  it('resolves the system-wiki/ virtual prefix onto the System wiki root', () => {
    const resolved = gateway.resolveWorkspacePath('system-wiki/method/TopFD.md', 'write')
    expect(resolved).toContain(path.join('tdease-gw-wiki', 'method', 'TopFD.md'))
    // The prefix is a virtual namespace: it never resolves into the Workspace,
    // even if a directory of that name exists there.
    expect(resolved).not.toContain(path.join('tdease-gw-test', 'system-wiki'))
    expect(gateway.resolveWorkspacePath('system-wiki', 'read')).toContain('tdease-gw-wiki')
  })

  it('denies traversal out of the System wiki through the prefix', () => {
    expect(() => gateway.resolveWorkspacePath('system-wiki/../../secrets.txt', 'read'))
      .toThrow(/system wiki path traversal denied/)
    expect(() => gateway.resolveWorkspacePath('system-wiki/..\\..\\x.md', 'write'))
      .toThrow(/system wiki path traversal denied/)
  })
})
