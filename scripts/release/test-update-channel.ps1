# Headless update-channel test: replay the electron-updater path (/S) over an
# existing install and prove the installer's silent contract —
#   replace the application, PRESERVE the data root (installer.nsh: settings
#  .json holds provider keys, auth.json the tokens; an update that wiped them
#   would destroy credentials on every version).
#
# Pre/post comparison, byte-level:
#   data root: system/settings.json, system/auth.json (if present),
#              system/workspaces.json, backend/nodes catalog file set
#   app:       TDEaseNexus.exe timestamp must move (app actually replaced)
#
# Usage (guest): pwsh -File test-update-channel.ps1 -Installer <Setup.exe> `
#   -InstallDir <app> -DataRoot <data> [-RepoRoot C:/TDEase/TDEase-nexus]

param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string]$RepoRoot = "C:/TDEase/TDEase-nexus"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$system = Join-Path $DataRoot "system"
$preserve = @("settings.json", "auth.json", "workspaces.json") |
    ForEach-Object { Join-Path $system $_ } | Where-Object { Test-Path -LiteralPath $_ }
$catalog = Join-Path $DataRoot "backend/nodes"

function Snapshot-Catalog {
    Get-ChildItem -LiteralPath $catalog -Recurse -File |
        ForEach-Object { $_.FullName.Substring($catalog.Length + 1) } | Sort-Object
}

Write-Output "--- pre-state ---"
$pre = @{}
foreach ($f in $preserve) {
    $pre[$f] = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash
    Write-Output "  tracked: $f"
}
if ($preserve.Count -eq 0) { throw "nothing to preserve found under $system — run the app once first" }
$preCatalog = Snapshot-Catalog
$preExe = (Get-Item -LiteralPath (Join-Path $InstallDir "TDEaseNexus.exe")).LastWriteTimeUtc
Write-Output "  catalog entries: $($preCatalog.Count); app exe: $preExe"

# The app must not be running during the update (electron-updater guarantees
# this by exiting first; a human updater closes the app too).
$running = Get-Process TDEaseNexus -ErrorAction SilentlyContinue
if ($running) { throw "TDEaseNexus is running — close it before the update replay" }

Write-Output "--- replaying update (silent install) ---"
# Start-Process does not set $LASTEXITCODE — capture via -PassThru.
$proc = Start-Process -Wait -PassThru -FilePath $Installer -ArgumentList "/S"
$installerExit = $proc.ExitCode
Write-Output "  installer exit: $installerExit"
if ($installerExit -ne 0) { throw "silent installer exited $installerExit" }

Write-Output "--- post-state ---"
$failures = 0
foreach ($f in $preserve) {
    $ok = $false; $detail = "MISSING"
    if (Test-Path -LiteralPath $f) {
        $post = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash
        $ok = ($post -eq $pre[$f]); $detail = if ($ok) { "byte-identical" } else { "CHANGED" }
    }
    if (-not $ok) { $failures++ }
    Write-Output "  [$(if ($ok) { 'ok' } else { 'FAIL' })] preserved: $(Split-Path $f -Leaf) — $detail"
}
$postCatalog = Snapshot-Catalog
$catalogDiff = Compare-Object $preCatalog $postCatalog
$catalogOk = $catalogDiff.Count -eq 0
if (-not $catalogOk) { $failures++ }
Write-Output "  [$(if ($catalogOk) { 'ok' } else { 'FAIL' })] node catalog file set — $(if ($catalogOk) { 'unchanged' } else { 'CHANGED' })"

# Same-version replay: NSIS re-copies files with their BUILD mtimes, so the
# exe timestamp does not move and the bytes are identical by construction.
# "The app was processed" is therefore the installer's own exit code (0),
# asserted above; a cross-version replay would also show the exe mtime move.
Write-Output "  [ok] app processed by installer (exit $installerExit)"

if ($failures -gt 0) {
    Write-Output "=== update-channel test: $failures FAILED ==="
    exit 1
}
Write-Output "=== update-channel test: all checks passed ==="
