#!/usr/bin/env bash
# Build the Linux desktop artifact (AppImage by default, unpacked dir with --dir).
#
# This is the Linux counterpart of build-desktop.ps1: it stages everything
# electron-builder.json maps out of `<repo>/.scratch/` and then runs the same
# frontend build chain. The Windows script's staging is PowerShell/Windows
# specific (MinGit, python.org CPython, uv.exe); the pieces below are the
# native equivalents, and they keep the SAME layout, because the packaged
# runtime resolvers are platform-parameterised but path-fixed:
#
#   .scratch/runtime/uv                      backend_manager._bundledUvPath()
#   .scratch/runtime/cpython-*/bin/python3   backend_manager._bundledPythonPath()
#   .scratch/runtime/settings.seed.json      provider seed -> backend/settings.seed.json
#   .scratch/runtime/nodes.zip               node catalog seed -> backend/nodes.zip
#   .scratch/vendor/search-tools/{rg,fd}     managed bash PATH (skill_runtime.cjs)
#   .scratch/electron-dist                   Electron runtime (config electronDist)
#
# The interpreter version differs from Windows on purpose: uv's python download
# manifest has no 3.12.13 Linux build yet (3.12.12 is the newest 3.12.x), and the
# backend only requires >=3.11,<3.15.
#
# Usage:
#   scripts/release/build-desktop-linux.sh [--dir] [--skip-build]
#
#   --dir         build the unpacked directory only (fast packaging iteration)
#   --skip-build  reuse the existing dist/ + electron main bundle
#
# Env:
#   TDEASE_DEEPSEEK_API_KEY  seal a provider key into settings.seed.json
#                            (optional; public releases must NOT set it)
#   UV_VERSION               pinned uv release (default 0.9.9)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND="$REPO/TDEase-FrontEnd"
RUNTIME="$REPO/.scratch/runtime"
ELECTRON_DIST="$REPO/.scratch/electron-dist"
UV_CACHE="$REPO/.scratch/uv-cache"
UV_VERSION="${UV_VERSION:-0.9.9}"
UV_SHA256="9ec303873e00deed44d1b2b52b85ab7aa55d849588d7242298748390eaea07ef"
PYTHON_VERSION="3.12.12"

TARGET=AppImage
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --dir) TARGET=dir ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n--- %s ---\n' "$1"; }
fail() { printf 'build-desktop-linux: %s\n' "$1" >&2; exit 1; }

[[ "$(uname -s)" == "Linux" ]] || fail "this script builds Linux artifacts"
for tool in node pnpm cargo curl tar sha256sum rsync; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing build prerequisite: $tool"
done

echo "=== TDEaseNexus Linux desktop build ==="
echo "  repo:       $REPO"
echo "  frontend:   $FRONTEND"
echo "  target:     $TARGET"
mkdir -p "$RUNTIME"

# ── Phase -1: Non-secret provider defaults ──────────────────────────────────
step "Phase -1: provider seed"
SEED_PATH="$RUNTIME/settings.seed.json"
node - "$SEED_PATH" <<'NODE'
const fs = require('node:fs')
const target = process.argv[2]
const seed = { providers: { deepseek: { base_url: 'https://api.deepseek.com/v1' } } }
// Only seal a key when the release environment explicitly passes one: public
// releases are downloadable by anyone, so a developer's local key must never
// leak into the installer through an implicit fallback.
if (process.env.TDEASE_DEEPSEEK_API_KEY) {
  seed.providers.deepseek.api_key = process.env.TDEASE_DEEPSEEK_API_KEY
  console.log('  deepseek api_key sealed into provider seed')
}
fs.writeFileSync(target, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 })
NODE
echo "  non-secret provider seed written -> $SEED_PATH"

# ── Phase 0: Python runtime (uv + pinned interpreter + skill deps) ──────────
step "Phase 0: Python runtime"
UV="$RUNTIME/uv"
if [[ -x "$UV" ]]; then
  echo "  uv already staged: $("$UV" --version)"
else
  echo "  downloading uv $UV_VERSION ..."
  TMP_UV="$(mktemp -d)"
  trap 'rm -rf "$TMP_UV"' EXIT
  curl -fsSL --retry 5 --retry-all-errors -o "$TMP_UV/uv.tar.gz" \
    "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz"
  echo "$UV_SHA256  $TMP_UV/uv.tar.gz" | sha256sum -c --quiet - || fail "uv archive checksum mismatch"
  tar -xzf "$TMP_UV/uv.tar.gz" -C "$TMP_UV"
  install -m 0755 "$TMP_UV/uv-x86_64-unknown-linux-gnu/uv" "$UV"
  rm -rf "$TMP_UV"
  trap - EXIT
  echo "  staged uv: $("$UV" --version)"
fi

export UV_CACHE_DIR="$UV_CACHE"
export UV_PYTHON_INSTALL_DIR="$RUNTIME"
PYROOT="$(find "$RUNTIME" -maxdepth 1 -type d -name 'cpython-*' -print -quit)"
if [[ -z "$PYROOT" ]]; then
  echo "  installing CPython $PYTHON_VERSION via uv ..."
  # --no-bin: do not link the interpreter into ~/.local/bin; the package only
  # ships what is under .scratch/runtime.
  "$UV" python install --no-bin "$PYTHON_VERSION"
  PYROOT="$(find "$RUNTIME" -maxdepth 1 -type d -name 'cpython-*' -print -quit)"
fi
[[ -n "$PYROOT" && -x "$PYROOT/bin/python3" ]] || fail "bundled interpreter missing under $RUNTIME"
PY="$PYROOT/bin/python3"
echo "  interpreter: $("$PY" --version) ($PYROOT)"

# Stdlib precompile: python-build-standalone ships sources only, and the
# packaged backend runs with PYTHONDONTWRITEBYTECODE=1 (the install tree must
# not be mutated), so without this every import re-parses .py sources.
PY_DOT_VERSION="$("$PY" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
STDLIB="$PYROOT/lib/python${PY_DOT_VERSION}"
if [[ -d "$STDLIB" ]]; then
  "$PY" -m compileall -q "$STDLIB"
  echo "  stdlib precompiled: $STDLIB"
fi

"$PY" "$REPO/scripts/release/collect-skill-dependencies.py" \
  --skills-dir "$REPO/tdease-ai-capability/system/skills" \
  --requirements-out "$RUNTIME/skill-requirements.txt" \
  --manifest-out "$RUNTIME/skill-dependencies.json"

# ── Phase 0.6: Node seed zip ────────────────────────────────────────────────
step "Phase 0.6: Node seed zip"
[[ -f "$REPO/data/backend/nodes/toppic/rules.smk" ]] || fail "node catalog prerequisite missing: $REPO/data/backend/nodes"
node "$REPO/scripts/release/node-seed.mjs" --repo "$REPO" --out "$RUNTIME/nodes.zip"

# ── Phase 0.7: Electron runtime ─────────────────────────────────────────────
step "Phase 0.7: Electron runtime"
ELECTRON_VERSION="$(node -p "require('$FRONTEND/node_modules/electron/package.json').version")"
LOCAL_ELECTRON="$FRONTEND/node_modules/electron/dist"
[[ -x "$LOCAL_ELECTRON/electron" ]] || fail "electron dist not installed at $LOCAL_ELECTRON (run pnpm install)"
if [[ -f "$ELECTRON_DIST/electron" && "$(cat "$ELECTRON_DIST/version" 2>/dev/null)" == "$ELECTRON_VERSION" ]]; then
  echo "  electron $ELECTRON_VERSION already staged: $ELECTRON_DIST"
else
  rm -rf "$ELECTRON_DIST"
  mkdir -p "$ELECTRON_DIST"
  # rsync keeps the electronDist cache warm across builds instead of recopying 280 MB.
  rsync -a --delete "$LOCAL_ELECTRON/" "$ELECTRON_DIST/"
  echo "  staged electron $ELECTRON_VERSION -> $ELECTRON_DIST"
fi

# ── Phase 1: Build ──────────────────────────────────────────────────────────
step "Phase 1: Electron build"
pushd "$FRONTEND" >/dev/null
if [[ "$SKIP_BUILD" -eq 0 ]]; then
  pnpm run desktop:dist:prep
else
  echo "  --skip-build: reusing dist/ and electron/dist"
fi
echo "  packaging target: $TARGET"
pnpm exec electron-builder --config electron-builder.json --linux "$TARGET"
popd >/dev/null

# ── Phase 2: Verify the packaged tree ───────────────────────────────────────
step "Phase 2: Verify"
UNPACKED="$FRONTEND/release/linux-unpacked"
[[ -d "$UNPACKED" ]] || fail "unpacked build not found: $UNPACKED"
RES="$UNPACKED/resources"

missing=0
require() {
  if [[ -e "$1" ]]; then
    printf '  [+] %s\n' "$2"
  else
    printf '  [MISSING] %s (%s)\n' "$2" "$1"
    missing=$((missing + 1))
  fi
}
require "$RES/backend/pyproject.toml" "backend/pyproject.toml"
require "$RES/backend/app" "backend/app/"
require "$RES/backend/src" "backend/src/"
require "$RES/backend/runtime/uv" "backend/runtime/uv"
require "$RES/backend/settings.seed.json" "backend/settings.seed.json"
require "$RES/backend/nodes.zip" "backend/nodes.zip"
require "$RES/vendor/search-tools/rg" "vendor/search-tools/rg"
require "$RES/vendor/search-tools/fd" "vendor/search-tools/fd"
require "$RES/native/tdeasenexus-toolbox" "native/tdeasenexus-toolbox"
require "$RES/app/assets/skills" "app/assets/skills/"
require "$RES/app/assets/templates" "app/assets/templates/"
require "$RES/app.asar" "app.asar"
if compgen -G "$RES/backend/runtime/cpython-*/bin/python3" >/dev/null; then
  echo "  [+] backend/runtime/cpython-*/bin/python3"
else
  echo "  [MISSING] backend/runtime/cpython-*/bin/python3"
  missing=$((missing + 1))
fi
[[ "$missing" -eq 0 ]] || fail "$missing expected resource(s) missing from the build"

"$RES/backend/runtime/uv" --version >/dev/null || fail "packaged uv does not run"
"$RES"/backend/runtime/cpython-*/bin/python3 --version >/dev/null || fail "packaged interpreter does not run"
"$RES/vendor/search-tools/rg" --version >/dev/null || fail "packaged rg does not run"
"$RES/vendor/search-tools/fd" --version >/dev/null || fail "packaged fd does not run"
"$RES/native/tdeasenexus-toolbox" schema fragment-theoretical >/dev/null || fail "packaged native CLI does not run"

echo "  unpacked: $UNPACKED ($(du -sh "$UNPACKED" | cut -f1))"

if [[ "$TARGET" == "AppImage" ]]; then
  APPIMAGE="$(ls -1t "$FRONTEND"/release/*.AppImage 2>/dev/null | head -n 1 || true)"
  [[ -n "$APPIMAGE" ]] || fail "AppImage was not produced"
  [[ -x "$APPIMAGE" ]] || chmod +x "$APPIMAGE"
  ( cd "$(dirname "$APPIMAGE")" && sha256sum "$(basename "$APPIMAGE")" > "$(basename "$APPIMAGE").sha256" )
  echo "  AppImage:  $APPIMAGE ($(du -h "$APPIMAGE" | cut -f1))"
  echo "  SHA-256:   $APPIMAGE.sha256"
fi

echo
echo "=== Build complete ==="
if [[ "$TARGET" == "AppImage" ]]; then
  echo "  Run: $APPIMAGE"
else
  echo "  Run: $UNPACKED/tdeasenexus"
fi
