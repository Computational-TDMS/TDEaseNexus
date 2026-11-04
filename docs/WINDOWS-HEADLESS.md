# Headless Windows development and release

> Status update: the release chain described at the bottom (sync → build →
> silent install → verify → audit → E2E) has since been operated end-to-end
> on this VM; the earlier "not yet verified" caveats about the command
> channel no longer apply to the current state.

Use this runbook when building, testing or diagnosing TDEaseNexus on Windows from a Linux host. Windows installation and the remote command channel are not yet verified; do not treat the presence of this document as evidence of a functioning release environment.

## Current host and safety boundary

- The current VM is `TDEase-Windows` in `qemu:///session`, not `qemu:///system`. It uses KVM, 8 vCPUs, 16 GiB RAM, UEFI Secure Boot-capable firmware with enrolled keys and an emulated TPM 2.0. Verify the guest's Secure Boot state independently after installation.
- The VM disk and installation ISO are in `/home/ray/VMs/TDEase-Windows/`. The ISO MD5 was checked against the value supplied by the maintainer. This is not a cryptographic authenticity guarantee; HTTP download and MD5 do not establish the publisher's identity.
- `virsh -c qemu:///session domstate TDEase-Windows` checks state. `virsh -c qemu:///session domblklist TDEase-Windows` lists attached images. Run as the owning Linux user. This session VM is not configured to autostart and may depend on that user's login/session services.
- The existing VNC console listens on localhost only. It is for exceptional recovery; access it via an authenticated SSH tunnel rather than exposing VNC publicly. GUI-dependent tests still require a Windows interactive desktop session; a remote service or SSH session is not automatically equivalent.
- The user selected Windows 11 Pro, authorised initialization of **only** the VM disk, and confirmed acceptance of applicable license terms in this session. Activation and edition entitlements remain the user's responsibility. Confirm these choices again for a different VM or installation.
- Preserve existing repo changes. Never store passwords, private keys, release tokens, or unattended installation media in Git. Treat unattended XML and its Windows cached copies as sensitive if they contain credentials; remove them safely after verifying recovery and rotate bootstrap credentials.

## Installation and command channel (in progress)

On this host, `/home/ray/VMs/TDEase-Windows/create-bootstrap.py` generated a one-time answer ISO and SSH key under `bootstrap-private/` (directory mode 0700). The media contains a plaintext temporary local administrator password: never commit, share, or leave it attached longer than needed. The VM has a QEMU user network with TCP `127.0.0.1:22222` forwarded to guest port 22, and a local-only VNC console. The answer file configured Windows 11 Pro, initialized virtual disk 0 and created the `tdease` admin account. Windows reached its desktop; its `sshd` service is running. The first-logon bootstrap remained stalled, and an OpenSSH firewall rule was added manually inside the guest; a host-side SSH protocol handshake then succeeded. Key-based login and credential cleanup are **not verified**: the agent's SSH test was blocked by a host safety rule protecting the private key. Respect that boundary; obtain an authorised access path rather than bypassing the safety control. `create-bootstrap.py` targets this exact VM/ISO and is not a reusable unattended installer without review.

The VM-specific original libvirt definition is backed up at `/home/ray/VMs/TDEase-Windows/domain-before-install.xml`; compare the current inactive definition before restoring anything. The current configuration uses `on_reboot=restart` for Windows setup. The Windows installer and a second CD-ROM containing the sensitive answer media remain attached. The answer file authorizes wiping disk 0: **booting the installer with this answer medium present could reinstall Windows and erase the VM disk.** Do not boot it again. After an authorised operator has verified a working recovery and remote-access path, eject the installation and answer media, remove cached answer-file credentials as appropriate, rotate the bootstrap password, and confirm a normal disk boot. Keep a known-good recovery path and verify the boot disk before any reinstall or recovery action.

1. Confirm the VM's state and disk attachment; take a backup before destructive changes. Initializing the VM disk destroys anything already on that disk. Do not infer that a low allocated size guarantees it is empty.
2. Supply a Windows Setup answer file with edition, UEFI/GPT partitioning, locale, local account and consent values. The ISO image contains `Windows 11 Pro` at image index 3; re-inspect metadata for a different ISO. Windows Setup may still prompt on missing or invalid settings. [Microsoft answer-file documentation](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/automate-windows-setup).
3. Install and enable Windows OpenSSH Server; authenticate with a dedicated key. Verify Windows firewall policy and host key. The VM currently uses libvirt user-mode NAT, which does not automatically provide host-to-guest SSH. Establish an explicit loopback-only forwarding mechanism and verify it is listening on `127.0.0.1`, not a public interface. [Microsoft OpenSSH documentation](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse).
4. Verify remote Windows execution, reboot recovery, access control, and cleanup of bootstrap secrets before proceeding. Do not report the environment ready until these checks pass.

## Windows build and validation

Work with a known commit and initialise the repository's submodules. The existing local Linux checkout may have uncommitted changes; do not overwrite it. Install Node in the range required by `TDEase-FrontEnd/package.json`, pnpm, Git, uv, Python and Rust. Supply the Windows-specific ignored runtime and scientific binaries; Linux binaries and virtual environments are not transferable.

Run the canonical requirements and commands from `.github/workflows/release-validation.yml` and `scripts/release/test-vm-preflight.ps1`. The preflight checks the command line tools, Windows node catalog and packaging staging roots. `scripts/release/build-desktop.ps1` also has more specific prerequisites; inspect it before invoking it. A passing preflight does not by itself prove the installer works. The release workflow's checkout does not explicitly initialise submodules; verify both submodule contents on the runner before trusting a run.

For an authorised Windows session, the following is the workflow order, **not yet verified on this VM**. Run from the repository root, with release-only resources staged, after reviewing each script and ensuring the runtime's command authentication policy permits it:

```powershell
$env:TDEASE_RELEASE_GATE = '1'
$env:TDEASE_CLI_GATE = '1'
$env:SKIP_HEAVY = '0'
$ErrorActionPreference = 'Stop'
function Invoke-CheckedNative {
  param([string]$Command, [string[]]$Arguments)
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed: $LASTEXITCODE" }
}
./scripts/release/test-vm-preflight.ps1
Invoke-CheckedNative 'uv' @('run', '--project', 'tdease-backend', 'pytest', 'tests/', '-q')
Push-Location TDEase-FrontEnd
try {
  Invoke-CheckedNative 'pnpm.cmd' @('install', '--frozen-lockfile')
  Invoke-CheckedNative 'pnpm.cmd' @('run', 'build')
  Invoke-CheckedNative 'pnpm.cmd' @('test:run')
  Invoke-CheckedNative 'pnpm.cmd' @('run', 'test:e2e:desktop')
} finally { Pop-Location }
./scripts/release/build-desktop.ps1 -Installer
```

Check each native command's exit code and stop on failure; PowerShell does not universally throw for a nonzero native exit. The desktop build script **recursively deletes its resolved `-InstallDir` if it exists** (default `.scratch/electron-installed`) before copying a new build. Inspect and explicitly confirm that destination contains no user data before running it. It can also download tools and modify staging directories. The generated installer and SHA-256 file are placed under `TDEase-FrontEnd/release/`; check the actual output before reporting success.

The release workflow uses a self-hosted runner labelled `self-hosted`, `Windows`, `X64`, `tdease-release`, and uploads artifacts. Runner registration requires repository-admin authorization. Do not allow untrusted pull requests to run on a machine with release resources or credentials. It does not automatically prove that the produced installer was installed and exercised.

Run frontend tests and the real Electron desktop E2E in the correct Windows interactive-session context. Separately test the **built installer** on a clean VM/snapshot: install, launch, backend startup, scientific workflow using non-sensitive sample data, upgrade and uninstall. Verify data deletion behavior first: `electron-builder.json` currently sets `deleteAppDataOnUninstall: true`. Check licenses and redistribution terms for each external tool.

Do not use `-Publish` in `scripts/release/build-desktop.ps1` unless the user explicitly authorizes a release. Its seed logic can embed `TDEASE_DEEPSEEK_API_KEY` in an installer; keep that variable unset for public artifacts and verify no secrets are included.

## Recovery

If commands fail, collect exact exit codes and logs; distinguish installation, SSH connectivity, Windows interactive-session availability, missing staging resources, and test failures. Check VM state and storage before restarting or restoring snapshots. A disk-only snapshot is not necessarily a consistent backup of UEFI NVRAM and TPM state. Retain an isolated console recovery path.

## Code sync (Linux → VM)

- Per build: `scripts/release/run-release-vm.sh` syncs the working tree
  (tar-over-ssh; the guest has no rsync) before building.
- While developing: `scripts/release/watch-release-vm.sh` keeps the guest warm
  (inotify, poll fallback).

## Build → install → verify

```bash
scripts/release/run-release-vm.sh                # sync + build (NSIS installer)
# silent update replay (electron-updater path; preserves the data root):
ssh tdease-win "pwsh -File C:/TDEase/TDEase-nexus/scripts/release/test-update-channel.ps1 -Installer C:/Temp/Setup.exe -InstallDir <app> -DataRoot <data>"
```

Verification chain (headless, no UI):

1. `scripts/release/verify-install.ps1 [-EngineSmoke]` — layout, node catalog,
   real engine Run through the installed backend.
2. `scripts/release/audit-installed-assets.ps1` — assets vs design: node
   catalog == committed seed manifest, rules.smk portability, binary
   inventory, skills/prompts/templates/reference byte parity vs repo,
   packaged hygiene. Idempotent (`test-audit-idempotency.ps1`).
3. `tests/desktop/desktop-e2e.spec.ts` against the INSTALLED app:
   `TDEASE_E2E_MAIN_BUNDLE=<exe> TDEASE_E2E_DATA_ROOT=<fresh dir>` — the
   full merged journey (real agent turn, tool roundtrip, blocked card,
   queue, export) against the packaged build.
4. `tests/release/installed-release.spec.ts` (CDP over port 9333) —
   workspace reopen, fail-closed no-key guard, agent turn against the
   mock provider (`scripts/release/mock-llm-server.mjs`, port 9100) or a
   real key (`E2E_DEEPSEEK_API_KEY`).

Operational rules:

- Kill stray `TDEaseNexus.exe`/`tdease-backend.exe` before any release-E2E
  run — a leftover tree locks the data root or races the backend port.
- `resources/backend/nodes.zip` is CONSUMED by the first seed
  (`node_catalog_seed` discardSeed). Restore it from
  `.scratch/runtime/nodes.zip` (or `C:/TDEase/pw/nodes.zip`) before runs.
- Never develop inside the VM; snapshots should not contain credentials.
