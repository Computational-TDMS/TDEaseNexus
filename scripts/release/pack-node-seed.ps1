# Windows entry point for the node-catalog seed packer.
#
# The implementation lives in `node-seed.mjs` (manifest invariants + zip writer,
# shared with `build-desktop-linux.sh`). This shim keeps the documented
# PowerShell contract — `-RepoRoot`/`-NodesDir`/`-OutZip`, relative paths
# resolved against the repo — so `build-desktop.ps1` Phase 0.6 and any release-VM
# invocation keep working unchanged. Both paths runnable in seconds:
#   success:  powershell -NoProfile -File scripts/release/pack-node-seed.ps1 -RepoRoot . -OutZip .tmp/seed.zip
#   residue:  plant an unlisted directory under data/backend/nodes -> named failure
param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [string]$NodesDir = "",
    [Parameter(Mandatory = $true)][string]$OutZip
)

$ErrorActionPreference = "Stop"
# PS7 4+ treats native stderr as ErrorRecord; with Stop above, node progress
# chatter could fail a success path.
$PSNativeCommandUseErrorActionPreference = $false

$repo = (Resolve-Path $RepoRoot).Path
$nodeArgs = @((Join-Path $PSScriptRoot "node-seed.mjs"), "--repo", $repo, "--out", $OutZip)
if ($NodesDir) { $nodeArgs += @("--nodes", $NodesDir) }

& node @nodeArgs
if ($LASTEXITCODE -ne 0) {
    throw "Node seed packing failed (node-seed.mjs exit $LASTEXITCODE)"
}
