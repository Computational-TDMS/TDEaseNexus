# Vendor MinGit (bundled bash + msys coreutils for the agent sandbox).
#
# A clean target machine has no Git for Windows; the agent bash sandbox needs
# bash + msys coreutils, so MinGit (usr/bin coreutils + mingw64 git) is bundled
# with bash.exe restored (MinGit ships sh.exe = the bash binary; copies of it
# serve as usr/bin/bash.exe and the bin/ sh/bash pair the msys shebang
# dispatcher resolves as /bin/sh). Version pinned to the GfW release the
# toolchain was validated against.
#
# Called idempotently by provision-release-vm.ps1 (the preflight requires the
# staged tree BEFORE the build) and build-desktop.ps1 Phase 0.5.
#
# Run in PowerShell 7+ inside the VM, at the checked-out repo.

param(
    [Parameter(Mandatory = $true)][string]$RepoRoot
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$repo = (Resolve-Path $RepoRoot).Path
$gitVendorDir = Join-Path $repo ".scratch/vendor/git"
$gitVendorBash = Join-Path $gitVendorDir "usr/bin/bash.exe"
if (Test-Path -LiteralPath $gitVendorBash) {
    Write-Output "  Vendor Git already staged: $gitVendorDir"
    exit 0
}

$gitVersion = "2.56.0.windows.4"
$mingitUrl = "https://github.com/git-for-windows/git/releases/download/v$gitVersion/MinGit-2.56.0.4-64-bit.zip"
$mingitZip = Join-Path $env:TEMP "tdease-mingit-$gitVersion.zip"
Write-Output "  Downloading MinGit $gitVersion ..."
# curl -f so an HTTP error body never becomes the "zip"; validate the PK
# magic + a size floor before extraction, retry through transient flakiness.
function Test-MinGitZip {
    if (-not (Test-Path -LiteralPath $mingitZip)) { return $false }
    $zip = Get-Item -LiteralPath $mingitZip
    if ($zip.Length -lt 10MB) { return $false }
    $stream = [System.IO.File]::OpenRead($zip.FullName)
    try {
        $magic = New-Object byte[] 2
        [void]$stream.Read($magic, 0, 2)
        return ($magic[0] -eq 0x50 -and $magic[1] -eq 0x4B)
    } finally {
        $stream.Close()
    }
}
if (Test-MinGitZip) {
    Write-Output "  Valid MinGit zip already staged: $mingitZip"
} else {
    $mingitOk = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        curl.exe -fsSL -o $mingitZip $mingitUrl
        if (Test-MinGitZip) { $mingitOk = $true; break }
        Write-Output "  MinGit download attempt ${attempt} invalid — retrying..."
        Start-Sleep -Seconds 5
    }
    if (-not $mingitOk) {
        throw "MinGit download failed after 3 attempts: $mingitUrl"
    }
}
New-Item -ItemType Directory -Path $gitVendorDir -Force | Out-Null
# System32 bsdtar explicitly: a Git-Bash PATH puts GNU tar first, and GNU tar
# reads "-f C:\..." as a remote host name.
$windowsTar = Join-Path $env:SystemRoot "System32\tar.exe"
& $windowsTar -xf $mingitZip -C $gitVendorDir
if ($LASTEXITCODE -ne 0) {
    throw "MinGit extraction failed"
}
# sh.exe in MinGit IS the bash binary (full GfW ships the same file under
# both names). Restore bash.exe and the bin/ pair the msys shebang
# dispatcher needs for `#!/bin/sh` scripts (python launchers, skill shims).
Copy-Item -LiteralPath (Join-Path $gitVendorDir "usr/bin/sh.exe") -Destination (Join-Path $gitVendorDir "usr/bin/bash.exe")
New-Item -ItemType Directory -Path (Join-Path $gitVendorDir "bin") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $gitVendorDir "usr/bin/bash.exe") -Destination (Join-Path $gitVendorDir "bin/bash.exe")
Copy-Item -LiteralPath (Join-Path $gitVendorDir "usr/bin/bash.exe") -Destination (Join-Path $gitVendorDir "bin/sh.exe")
Copy-Item -LiteralPath (Join-Path $gitVendorDir "usr/bin/msys-2.0.dll") -Destination (Join-Path $gitVendorDir "bin/msys-2.0.dll")
Remove-Item -LiteralPath $mingitZip -Force
Write-Output "  Vendor Git staged: $gitVendorDir"
