# Direct-download bootstrap for the Windows release VM.
#
# Counterpart of bootstrap-release-vm.ps1 for machines where winget cannot
# work (pristine images whose store region data was never initialized fail
# every winget source open with 0x8a15000f). Installs the same toolchain from
# pinned release artifacts:
#   PowerShell 7 MSI -> Git (MinGit) -> Volta MSI -> node@24 + pnpm -> uv
# Run in PowerShell (5.1 works) inside the VM.

param(
    [string]$CheckoutRoot = "C:/TDEase"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Get-Asset([string]$Url, [string]$Out) {
    if (Test-Path $Out) { Write-Output "  cached: $Out"; return }
    Write-Output "  downloading: $Url"
    curl.exe -fsSL -o $Out $Url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $Url" }
}

# ── PowerShell 7 ─────────────────────────────────────────────────────────────
$psVersion = "7.6.9"
$psMsi = "$env:TEMP\PowerShell-$psVersion-win-x64.msi"
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
    Write-Output "Installing PowerShell $psVersion ..."
    Get-Asset "https://github.com/PowerShell/PowerShell/releases/download/v$psVersion/PowerShell-$psVersion-win-x64.msi" $psMsi
    Start-Process msiexec -ArgumentList "/i `"$psMsi`" /qn ADD_EXPLORER_CONTEXT_MENU_OPENPOWERSHELL=0 ENABLE_PSFILEINTEXPLORE_CONTEXTMENU=0 REGISTER_MANIFEST=1" -Wait
    if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    }
    if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) { throw "pwsh not on PATH after MSI install" }
} else { Write-Output "PowerShell already installed" }

# ── Git (MinGit) ──────────────────────────────────────────────────────────────
$gitVersion = "2.56.0.windows.4"   # asset: MinGit-2.56.0.4-64-bit.zip
$gitDir = "C:\Tools\MinGit"
if (-not (Test-Path "$gitDir\cmd\git.exe")) {
    Write-Output "Installing MinGit ..."
    $gitZip = "$env:TEMP\MinGit-2.56.0.4-64-bit.zip"
    Get-Asset "https://github.com/git-for-windows/git/releases/download/v$gitVersion/MinGit-2.56.0.4-64-bit.zip" $gitZip
    New-Item -ItemType Directory -Force -Path $gitDir | Out-Null
    & (Join-Path $env:SystemRoot "System32\tar.exe") -xf $gitZip -C $gitDir
    if ($LASTEXITCODE -ne 0) { throw "MinGit extraction failed" }
    Remove-Item $gitZip
    # MinGit's git.exe lives in cmd\ and mingw64\bin; expose cmd\ on PATH.
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($machinePath -notlike "*$gitDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$machinePath;$gitDir\cmd", "Machine")
    }
} else { Write-Output "MinGit already installed" }
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")

& git --version
if ($LASTEXITCODE -ne 0) { throw "git not runnable" }

# ── Volta ────────────────────────────────────────────────────────────────────
if (-not (Get-Command volta -ErrorAction SilentlyContinue)) {
    Write-Output "Installing Volta 2.0.2 ..."
    $voltaMsi = "$env:TEMP\volta-2.0.2-windows-x86_64.msi"
    Get-Asset "https://github.com/volta-cli/volta/releases/download/v2.0.2/volta-2.0.2-windows-x86_64.msi" $voltaMsi
    Start-Process msiexec -ArgumentList "/i `"$voltaMsi`" /qn" -Wait
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
} else { Write-Output "Volta already installed" }

& volta install node@24 pnpm@10
if ($LASTEXITCODE -ne 0) { throw "volta install failed" }
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
& node --version
& pnpm --version

# ── uv ───────────────────────────────────────────────────────────────────────
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Output "Installing uv ..."
    & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
} else { Write-Output "uv already installed" }
& uv --version

& git config --system core.longpaths true
New-Item -ItemType Directory -Force -Path $CheckoutRoot | Out-Null

Write-Output "Base VM tooling is installed (direct download path)."
Write-Output "Next: scripts/release/provision-release-vm.ps1, then test-vm-preflight.ps1."
