#!/usr/bin/env bash
# Drive the Windows release VM (docs/RELEASE-VM.md) from this Linux host.
#
# The VM is a QEMU/KVM guest ("TDEase-Windows") whose SSH is forwarded to
# 127.0.0.1:22222. Connection details come from SSH config so no key path or
# port is hardcoded here — add to ~/.ssh/config:
#
#   Host tdease-win
#     Hostname 127.0.0.1
#     Port 22222
#     User tdease
#     IdentityFile ~/VMs/TDEase-Windows/bootstrap-private/windows_vm_ed25519
#
# The guest has no rsync; the repo and the licensed node payloads travel as
# tar streams over ssh, unpacked with the guest's System32 tar.
#
# Usage:
#   scripts/release/run-release-vm.sh                 # sync + provision + preflight + build (installer)
#   scripts/release/run-release-vm.sh --skip-sync     # reuse the already-synced repo
#   scripts/release/run-release-vm.sh --skip-provision
#   scripts/release/run-release-vm.sh --no-installer  # unpacked dir only
#   scripts/release/run-release-vm.sh --verify        # + launch-once + verify-install
#
# Env:
#   TDEASE_VM_HOST   ssh target (default tdease-win)
#   TDEASE_VM_REPO   guest repo path (default C:/TDEase/TDEase-nexus)
#   TDEASE_PWIZ_DIR      host msconvert payload (default ~/Desktop/pwiz)
#   TDEASE_TOPPIC_DIR    host toppic payload (default ~/Desktop/toppic-windows-1.8.0)

set -euo pipefail

VM_HOST="${TDEASE_VM_HOST:-tdease-win}"
VM_REPO="${TDEASE_VM_REPO:-C:/TDEase/TDEase-nexus}"
PWIZ_DIR="${TDEASE_PWIZ_DIR:-$HOME/Desktop/pwiz}"
TOPPIC_DIR="${TDEASE_TOPPIC_DIR:-$HOME/Desktop/toppic-windows-1.8.0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

SKIP_SYNC=0
SKIP_PROVISION=0
INSTALLER=1
VERIFY=0
for arg in "$@"; do
    case "$arg" in
        --skip-sync) SKIP_SYNC=1 ;;
        --skip-provision) SKIP_PROVISION=1 ;;
        --no-installer) INSTALLER=0 ;;
        --verify) VERIFY=1 ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

vm() { ssh "$VM_HOST" "$@"; }

echo "=== TDEase Windows release VM driver ==="
echo "  host: $VM_HOST"
echo "  repo: $VM_REPO"

vm "if not exist \"${VM_REPO}\" mkdir \"${VM_REPO}\""

if [ "$SKIP_SYNC" -ne 1 ]; then
    echo "--- sync repo (tar stream) ---"
    tar -C "$REPO" -czf - \
        --exclude='.git' \
        --exclude='node_modules' \
        --exclude='.scratch' \
        --exclude='target' \
        --exclude='data' \
        --exclude='TDEase-FrontEnd/release' \
        --exclude='TDEase-FrontEnd/dist' \
        --exclude='TDEase-FrontEnd/dist-electron' \
        --exclude='__pycache__' \
        --exclude='.venv' \
        --exclude='docs/paper' \
        --exclude='.zcode' \
        --exclude='tdease-backend/.zcode' \
        . | vm "tar -xzf - -C \"${VM_REPO}\""

    echo "--- sync node catalog definitions + licensed binaries ---"
    tar -C "$REPO/data/backend" -czf - nodes | vm "tar -xzf - -C \"${VM_REPO}/data/backend\""
    # The licensed Windows payloads (pwiz, toppic) are binary-only drops: they
    # carry exes/dlls/resources but NOT the definition layer (rules.smk,
    # README.md). Replace each payload node's CONTENT while preserving its
    # definitions — a whole-dir rmdir would destroy rules.smk and the build's
    # Phase 0.6 prerequisite check with it.
    for node in msconvert toppic; do
        vm "pwsh -NoProfile -Command \"Get-ChildItem -LiteralPath '${VM_REPO}/data/backend/nodes/${node}' | Where-Object { \$_.Name -notin @('rules.smk','README.md') } | Remove-Item -Recurse -Force\""
    done
    tar -C "$PWIZ_DIR" -czf - . | vm "tar -xzf - -C \"${VM_REPO}/data/backend/nodes/msconvert\""
    tar -C "$TOPPIC_DIR" -czf - . | vm "tar -xzf - -C \"${VM_REPO}/data/backend/nodes/toppic\""
fi

if [ "$SKIP_PROVISION" -ne 1 ]; then
    echo "--- provision packaging payloads ---"
    vm "pwsh -NoProfile -ExecutionPolicy Bypass -File \"${VM_REPO}/scripts/release/provision-release-vm.ps1\""
fi

echo "--- preflight ---"
vm "pwsh -NoProfile -ExecutionPolicy Bypass -File \"${VM_REPO}/scripts/release/test-vm-preflight.ps1\""

echo "--- build desktop ---"
BUILD_ARGS=""
if [ "$INSTALLER" -eq 1 ]; then BUILD_ARGS="-Installer"; fi
vm "pwsh -NoProfile -ExecutionPolicy Bypass -File \"${VM_REPO}/scripts/release/build-desktop.ps1\" $BUILD_ARGS"

if [ "$VERIFY" -eq 1 ]; then
    echo "--- verify install (launch-once + audit) ---"
    # First run unpacks a ~350MB node seed and provisions the backend venv;
    # a fixed sleep cut it short (verify saw a half-provisioned data root).
    # Poll for the catalog marker instead, then stop the app.
    vm "pwsh -NoProfile -Command \"Start-Process '${VM_REPO}/.scratch/electron-installed/TDEaseNexus.exe'; \$deadline = (Get-Date).AddMinutes(8); \$marker = '${VM_REPO}/.scratch/TDEaseNexus-Data/backend/nodes/_template/rules.smk'; while ((Get-Date) -lt \$deadline -and -not (Test-Path \$marker)) { Start-Sleep -Seconds 5 }; Start-Sleep -Seconds 20; Get-Process TDEaseNexus -ErrorAction SilentlyContinue | Stop-Process -Force\""
    vm "pwsh -NoProfile -ExecutionPolicy Bypass -File \"${VM_REPO}/scripts/release/verify-install.ps1\""
    vm "pwsh -NoProfile -ExecutionPolicy Bypass -File \"${VM_REPO}/scripts/release/verify-install.ps1\" -EngineSmoke"
fi

echo "=== release VM chain complete ==="
