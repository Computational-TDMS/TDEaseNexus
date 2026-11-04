# Provision the Windows release VM packaging payloads (docs/RELEASE-VM.md).
#
# build-desktop.ps1 stages MinGit and the node seed zip itself; this script
# provisions what the preflight requires BEFORE the build and what the build
# assumes pre-staged:
#   .scratch/runtime/uv.exe
#   .scratch/runtime/cpython-3.12.13-windows-x86_64-none/   (via uv python install)
#   .scratch/runtime/skill-requirements.txt + skill-dependencies.json
#   .scratch/runtime/wheelhouse
# The node catalog exes (data/backend/nodes/{toppic,msconvert}/*.exe) are large
# licensed binaries — run-release-vm.sh syncs them from the host; not handled here.
#
# Run in PowerShell 7+ inside the VM, at the checked-out repo.

param(
    [string]$PythonVersion = "3.12.13",
    [string]$UvZipUrl = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$runtime = Join-Path $repo ".scratch/runtime"
$vendor = Join-Path $repo ".scratch/vendor"
New-Item -ItemType Directory -Force -Path $runtime, $vendor | Out-Null

# ── 1. bundled uv ────────────────────────────────────────────────────────────
$uv = Join-Path $runtime "uv.exe"
if (Test-Path -LiteralPath $uv) {
    Write-Output "uv.exe already staged"
} else {
    Write-Output "Downloading uv ..."
    $zip = Join-Path $env:TEMP "tdease-uv.zip"
    curl.exe -fsSL -o $zip $UvZipUrl
    if ($LASTEXITCODE -ne 0) { throw "uv download failed: $UvZipUrl" }
    $tmp = Join-Path $env:TEMP "tdease-uv-expand"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    & (Join-Path $env:SystemRoot "System32\tar.exe") -xf $zip -C $tmp
    Copy-Item -LiteralPath (Join-Path $tmp "uv.exe") -Destination $uv
    Remove-Item $zip, $tmp -Recurse -Force
    Write-Output "  staged: $uv"
}

# ── 2. bundled CPython via uv (managed python dir is named exactly
#      cpython-<ver>-windows-x86_64-none, the layout backend_manager probes) ──
$cpythonDir = Join-Path $runtime "cpython-$PythonVersion-windows-x86_64-none"
if (Test-Path -LiteralPath (Join-Path $cpythonDir "python.exe")) {
    Write-Output "bundled CPython already staged"
} else {
    Write-Output "Installing CPython $PythonVersion via uv ..."
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $runtime "uv-python-install"
    & $uv python install $PythonVersion
    if ($LASTEXITCODE -ne 0) { throw "uv python install failed" }
    $installed = Get-ChildItem -LiteralPath $env:UV_PYTHON_INSTALL_DIR -Directory |
        Where-Object { $_.Name -like "cpython-$PythonVersion-windows-x86_64-none*" } |
        Select-Object -First 1
    if (-not $installed) { throw "uv installed no cpython-$PythonVersion-windows-x86_64-none" }
    Move-Item -LiteralPath $installed.FullName -Destination $cpythonDir
    Remove-Item $env:UV_PYTHON_INSTALL_DIR -Recurse -Force
    Write-Output "  staged: $cpythonDir"
}
$python = Join-Path $cpythonDir "python.exe"

# ── 3. skill dependency manifest + wheelhouse ───────────────────────────────
Write-Output "Collecting skill dependencies ..."
& $python (Join-Path $repo "scripts/release/collect-skill-dependencies.py") `
    --skills-dir (Join-Path $repo "tdease-ai-capability/system/skills") `
    --requirements-out (Join-Path $runtime "skill-requirements.txt") `
    --manifest-out (Join-Path $runtime "skill-dependencies.json")
if ($LASTEXITCODE -ne 0) { throw "skill dependency collection failed" }

$wheelhouse = Join-Path $runtime "wheelhouse"
New-Item -ItemType Directory -Force -Path $wheelhouse | Out-Null
$requirements = Join-Path $runtime "skill-requirements.txt"
$existing = @(Get-ChildItem -LiteralPath $wheelhouse -Filter *.whl -ErrorAction SilentlyContinue)
if ($existing.Count -eq 0) {
    Write-Output "Populating wheelhouse (Windows wheels) ..."
    & $python -m pip download --quiet --only-binary=:all: -r $requirements -d $wheelhouse
    if ($LASTEXITCODE -ne 0) { throw "wheelhouse download failed" }
} else {
    Write-Output "wheelhouse already populated ($($existing.Count) wheels)"
}

Write-Output "Provisioning complete. Next: scripts/release/test-vm-preflight.ps1"

# ── 4. non-secret provider seed ─────────────────────────────────────────────
# The preflight requires settings.seed.json BEFORE build-desktop.ps1 runs, and
# build-desktop Phase -1 rewrites it anyway (same content, plus an optional
# sealed key from TDEASE_DEEPSEEK_API_KEY) — so pre-write it here to break the
# chicken-and-egg between preflight and build. Idempotent.
$seedPath = Join-Path $runtime "settings.seed.json"
$seed = @{ providers = @{ deepseek = @{ base_url = "https://api.deepseek.com/v1" } } }
Set-Content -LiteralPath $seedPath -Value ($seed | ConvertTo-Json -Depth 6) -Encoding utf8
Write-Output "  non-secret provider seed written -> $seedPath"

# ── 5. MinGit (bundled bash for the agent sandbox) ──────────────────────────
# The preflight requires the staged tree before build-desktop runs; the build
# calls the same idempotent script (Phase 0.5), so both see one implementation.
& pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "vendor-git.ps1") -RepoRoot $repo
