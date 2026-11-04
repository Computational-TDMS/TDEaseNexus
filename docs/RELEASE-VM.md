# Windows release VM

The release VM is the only environment allowed to claim a Windows release pass.
It must run `.github/workflows/release-validation.yml` with the runner label
`tdease-release`.

## Host creation

Prerequisites: elevated PowerShell, Hyper-V enabled, and a Windows 11 ISO.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
./scripts/release/new-release-vm.ps1 -IsoPath D:/ISO/Windows11.iso
```

Install Windows in the VM, apply updates, enable long paths, and take a snapshot
named `windows-clean` before installing development tools.

## Guest bootstrap

Run in an elevated PowerShell inside the guest:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
./scripts/release/bootstrap-release-vm.ps1 -RepositoryUrl <repository-url>
```

Provision the real, licensed or large assets into the ignored packaging roots
(`.scratch/runtime`, `.scratch/vendor`) and the Backend node catalog
(`data/backend/nodes/`) — the installer ships none of them. The preflight checks the
exact paths it needs.

The node catalog binaries must contain at least:

```text
data/backend/nodes/toppic/{topfd.exe,toppic.exe,topindex.exe,...}
data/backend/nodes/msconvert/msconvert.exe
```

Run the preflight before registering the VM as a release runner:

```powershell
./scripts/release/test-vm-preflight.ps1
```

## Snapshots

Maintain three checkpoints:

1. `windows-clean`: Windows updates only.
2. `release-tools`: Git, Node 24, pnpm, uv, ProteoWizard, TopPIC assets.
3. `release-fixtures`: frozen RAW, mzML, FASTA and workflow fixtures used by the
   desktop E2E.

Revert to `release-fixtures` before each release validation. Do not develop in this
VM and do not retain user credentials or model API keys in its snapshots.

## Install verification

After `scripts/release/build-desktop.ps1`, verify the packaged install before
shipping:

```powershell
./scripts/release/build-desktop.ps1
./.scratch/electron-installed/TDEaseNexus.exe    # launch once: initializes the external data root, then close
./scripts/release/verify-install.ps1          # layout + external Node rules.smk paths
./scripts/release/verify-install.ps1 -EngineSmoke
```

Without a prior launch the runtime-state and engine sections fail with "launch
the installed app once" — the packaged layout and Node-package audit still run.
The installer force-reinstalls: running it over an existing install wipes the
app dir AND the data root beside it (`TDEaseNexus-Data`/legacy `TDEase-Data`,
`electron/installer.nsh`), so post-install verification always evaluates a
first-launch state — launch once after (re)installing to initialize the data
root before the runtime-state sections.
`-EngineSmoke` additionally runs the shipped `tdeasenexus-docs` doctor against
the installed data root, resolves a Node binding through the installed
Backend's own code (`scan_nodes`/`resolve_bindings`/`bound_node_paths`), and
executes the seeded `topindex` Node in a temporary Run root outside the
install with the installed venv's Snakemake — proving the engine config points
at the absolute catalog path (`config["nodes"]`) and no node material is ever
written under the Run root.

The final section re-audits the packaged source trees *after* those checks have
run the installed Python: no `__pycache__`, `.pyc`, virtualenv or cache residue
may appear. The `extraResources` filters keep the build clean; this proves the
product never writes back into its own install (the packaged backend and the
agent bash sandbox both run with `PYTHONDONTWRITEBYTECODE=1`, and the verifier
invokes the installed Python with `-B`).
