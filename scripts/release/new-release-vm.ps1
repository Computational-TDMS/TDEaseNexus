param(
    [Parameter(Mandatory = $true)]
    [string]$IsoPath,
    [string]$VmName = "TDEase-Release",
    [string]$VmRoot = "C:/Hyper-V/TDEase-Release",
    [string]$SwitchName = "Default Switch",
    [int64]$MemoryStartupBytes = 8GB,
    [int64]$DiskSizeBytes = 160GB,
    [int]$ProcessorCount = 8
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session."
}
if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) {
    throw "Hyper-V PowerShell is unavailable. Enable Microsoft-Hyper-V-All and reboot first."
}
if (-not (Test-Path -LiteralPath $IsoPath -PathType Leaf)) {
    throw "Windows ISO not found: $IsoPath"
}
if (Get-VM -Name $VmName -ErrorAction SilentlyContinue) {
    throw "VM already exists: $VmName"
}

$resolvedRoot = [System.IO.Path]::GetFullPath($VmRoot)
New-Item -ItemType Directory -Force -Path $resolvedRoot | Out-Null
$vhdPath = Join-Path $resolvedRoot "$VmName.vhdx"

$vm = New-VM -Name $VmName -Generation 2 -MemoryStartupBytes $MemoryStartupBytes `
    -NewVHDPath $vhdPath -NewVHDSizeBytes $DiskSizeBytes -SwitchName $SwitchName
Set-VMProcessor -VMName $VmName -Count $ProcessorCount
Set-VMMemory -VMName $VmName -DynamicMemoryEnabled $true -MinimumBytes 4GB -MaximumBytes 16GB
Set-VMFirmware -VMName $VmName -EnableSecureBoot On

$dvd = Add-VMDvdDrive -VMName $VmName -Path (Resolve-Path $IsoPath).Path -Passthru
Set-VMFirmware -VMName $VmName -FirstBootDevice $dvd

Write-Output "VM created: $($vm.Name)"
Write-Output "VHDX: $vhdPath"
Write-Output "Install Windows, then run scripts/release/bootstrap-release-vm.ps1 inside the guest."
