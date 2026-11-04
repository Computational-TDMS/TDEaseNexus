# Idempotency self-check for audit-installed-assets.ps1.
# Runs the auditor twice against the installed app and requires the two
# -Json outputs to be byte-identical. No output is stripped or filtered:
# any difference is a real determinism defect in the auditor.
#
# The only normalization applied is CRLF -> LF on both captures, so that
# Windows line-ending noise from PowerShell's console encoding does not
# mask byte-level content differences (documented here, not a data change).
#
# Exit 0 = idempotency: PASS; exit 1 = unified diff excerpt printed.

param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string]$RepoRoot = "C:/TDEase/TDEase-nexus"
)

$ErrorActionPreference = "Stop"
$auditor = Join-Path $PSScriptRoot "audit-installed-assets.ps1"
$tmp1 = [System.IO.Path]::GetTempFileName()
$tmp2 = [System.IO.Path]::GetTempFileName()
try {
    foreach ($pair in @(@($tmp1, 1), @($tmp2, 2))) {
        $out = $pair[0]
        $n = $pair[1]
        & pwsh -NoProfile -File $auditor -InstallDir $InstallDir -DataRoot $DataRoot -RepoRoot $RepoRoot -Json *> $out
        if ($LASTEXITCODE -ne 0) {
            Write-Error "auditor run $n exited $LASTEXITCODE (see $out)"
        }
    }

    # Normalize only line endings (CRLF -> LF); content is otherwise compared raw.
    $norm = {
        param($path)
        (Get-Content -LiteralPath $path -Raw) -replace "`r`n", "`n"
    }
    $a = & $norm $tmp1
    $b = & $norm $tmp2

    if ($a -ceq $b) {
        Write-Output "idempotency: PASS"
        exit 0
    }

    Write-Output "idempotency: FAIL — auditor output differs between runs"
    $fa = [System.IO.Path]::GetTempFileName()
    $fb = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($fa, $a)
    [System.IO.File]::WriteAllText($fb, $b)
    try {
        $diff = & git diff --no-index --unified=3 -- $fa $fb 2>$null
        if ($LASTEXITCODE -notin 0, 1) { $diff = @("git diff unavailable (exit $LASTEXITCODE); compare $tmp1 vs $tmp2") }
        $diff | Select-Object -First 40 | ForEach-Object { Write-Output $_ }
    } finally {
        Remove-Item -LiteralPath $fa, $fb -Force -ErrorAction SilentlyContinue
    }
    exit 1
} finally {
    Remove-Item -LiteralPath $tmp1, $tmp2 -Force -ErrorAction SilentlyContinue
}
