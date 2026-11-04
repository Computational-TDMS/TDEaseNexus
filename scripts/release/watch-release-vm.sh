#!/usr/bin/env bash
# Watch the Linux working tree and sync every change into the Windows release
# VM, so the guest repo under C:/TDEase/TDEase-nexus is always current before
# any build. Complements run-release-vm.sh (which syncs once per invocation):
# start this in a terminal during a dev session and the VM stays warm.
#
# Usage:
#   scripts/release/watch-release-vm.sh [--debounce 2]
# Env: same as run-release-vm.sh (TDEASE_VM_HOST, TDEASE_VM_REPO)
#
# Requires inotifywait (inotify-tools). Falls back to a 5s poll loop if absent.

set -euo pipefail

VM_HOST="${TDEASE_VM_HOST:-tdease-win}"
VM_REPO="${TDEASE_VM_REPO:-C:/TDEase/TDEase-nexus}"
DEBOUNCE="${3:-2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

sync_once() {
    ssh "$VM_HOST" "if not exist \"${VM_REPO}\" mkdir \"${VM_REPO}\"" 2>/dev/null || true
    if tar -C "$REPO" -czf - \
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
        --exclude='./.zcode' \
        . 2>/dev/null | ssh "$VM_HOST" "cmd /c \"chcp 65001 >nul & tar -xzf - -C ${VM_REPO}\"" 2>/dev/null; then
        echo "$(date +%H:%M:%S) synced"
    else
        echo "$(date +%H:%M:%S) sync had errors (non-UTF8 filenames are skipped; see run-release-vm.sh)" >&2
    fi
}

sync_once

if command -v inotifywait >/dev/null 2>&1; then
    echo "watching (inotify, debounce ${DEBOUNCE}s)..."
    while true; do
        inotifywait -r -q -e close_write,moved_to,create --exclude '(\.git|node_modules|\.scratch|target|__pycache__|\.venv|/release/|/dist|/dist-electron|\.zcode)' "$REPO" >/dev/null 2>&1 || true
        # collapse the event burst
        sleep "$DEBOUNCE"
        while inotifywait -r -q -t 1 -e close_write,moved_to,create --exclude '(\.git|node_modules|\.scratch|target|__pycache__|\.venv|/release/|/dist|/dist-electron|\.zcode)' "$REPO" >/dev/null 2>&1; do sleep 1; done || true
        sync_once
    done
else
    echo "inotifywait not found; polling every 5s (install inotify-tools for event-driven sync)"
    while true; do
        sleep 5
        NEWEST=$(find "$REPO" -type f -newer /tmp/.watch-release-vm-marker \
            -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.scratch/*' \
            -not -path '*/target/*' -not -path '*/release/*' -not -path '*/dist*' \
            -not -path '*/__pycache__/*' -not -path '*/.venv/*' -not -path '*/.zcode/*' \
            2>/dev/null | head -1 || true)
        if [ -n "$NEWEST" ]; then
            touch /tmp/.watch-release-vm-marker
            sync_once
        fi
    done
fi
