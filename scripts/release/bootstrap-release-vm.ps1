param(
    [string]$RepositoryUrl = "",
    [string]$CheckoutRoot = "C:/TDEase",
    [switch]$InstallGitHubRunner = $false
)

$ErrorActionPreference = "Stop"

$packages = @(
    @{ Id = "Git.Git"; Name = "Git" },
    @{ Id = "Volta.Volta"; Name = "Volta" },
    @{ Id = "Microsoft.PowerShell"; Name = "PowerShell 7" }
)

foreach ($package in $packages) {
    Write-Output "Installing $($package.Name)..."
    # --source winget: a pristine VM's msstore source demands interactive
    # region/agreement setup and fails closed (0x8a15000f); the winget source
    # needs neither and carries all the tooling below.
    winget install --id $package.Id --source winget --exact --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "winget failed for $($package.Id)"
    }
}

$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
    [Environment]::GetEnvironmentVariable("Path", "User")
volta install node@24 pnpm
irm https://astral.sh/uv/install.ps1 | iex

git config --system core.longpaths true
New-Item -ItemType Directory -Force -Path $CheckoutRoot | Out-Null

if ($RepositoryUrl) {
    $repoPath = Join-Path $CheckoutRoot "TDEase-nexus"
    if (Test-Path -LiteralPath $repoPath) {
        throw "Checkout already exists: $repoPath"
    }
    git clone $RepositoryUrl $repoPath
}

Write-Output "Base VM tooling is installed."
Write-Output "Next: provision the packaging roots (.scratch/runtime, .scratch/vendor) and the data/backend/nodes catalog per docs/RELEASE-VM.md."
if ($InstallGitHubRunner) {
    Write-Warning "Register the GitHub Actions runner interactively with labels: Windows,X64,tdease-release."
}
