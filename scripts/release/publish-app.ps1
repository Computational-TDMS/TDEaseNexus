param(
    # Gates only: print the plan, build nothing, upload nothing. Safe to run anytime.
    [switch]$DryRun = $false
)

# TDEaseNexus application release orchestration — the only path that uploads the
# app. docs/design/PACKAGE-DISTRIBUTION.md §Release pipeline:
#   "only formal versions are uploaded" is implemented as: the upload code
#   exists only in this script. No CI, no webhook, no timer; a human running
#   this script is the decision itself.
#
# Preconditions (enforced by gates):
#   - main worktree clean (dirty submodule contents are caught by porcelain)
#   - no remote tag v{version} for the TDEase-FrontEnd/package.json version
#   - gh authenticated, and the TDEaseNexus-Releases repo reachable
#
# Chain: build-desktop.ps1 -Installer (vendor + quality gates + electron-builder,
# -Publish passes `-p always` to electron-builder's github provider, uploading
# the three artifacts: installer / latest.yml / blockmap) -> anonymous latest.yml
# verification -> update-source replay -> tag and push.
#
# GH_TOKEN comes from the gh CLI; never written to disk or committed.

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$frontend = Join-Path $repo "TDEase-FrontEnd"

# Feed repo = the electron-builder.json publish target (single source of truth:
# the client app-update.yml is baked from this exact value).
$publishConfig = (Get-Content (Join-Path $frontend "electron-builder.json") -Raw | ConvertFrom-Json).publish[0]
if (-not $publishConfig.owner -or -not $publishConfig.repo) {
    Write-Output "FAIL electron-builder.json has no publish.owner/repo"
    exit 1
}
$feedRepo = "$($publishConfig.owner)/$($publishConfig.repo)"

Set-Location $repo

# ── Gate 1: worktree clean ──────────────────────────────────────────────────
$dirty = git status --porcelain
if ($dirty) {
    Write-Output "FAIL main worktree is dirty — releases are cut only from committed state:"
    $dirty | ForEach-Object { Write-Output "  $_" }
    exit 1
}

# ── Gate 2: version is releasable (remote v{version} tag absent) ─────────────
$packageJson = Get-Content (Join-Path $frontend "package.json") -Raw | ConvertFrom-Json
$version = $packageJson.version
$tag = "v$version"
if (-not $version) { Write-Output "FAIL cannot read package.json version"; exit 1 }
$existing = git ls-remote --tags origin "refs/tags/$tag"
if ($existing) {
    Write-Output "FAIL tag $tag already exists on the remote — bump the version first"
    exit 1
}

# ── Gate 3: feed repo reachable (public + gh auth + name not redirected) ─────
gh repo view $feedRepo --json visibility 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Output "FAIL gh not authenticated or $feedRepo unreachable"; exit 1 }
# A renamed/moved repo still 301s under its old name; the release chain must not
# rely on that fallback — a stale config stops here.
$canonicalFeed = gh api "repos/$feedRepo" --jq .full_name 2>$null
if ($LASTEXITCODE -ne 0 -or $canonicalFeed -ne $feedRepo) {
    Write-Output "FAIL feed repo $feedRepo resolves to '$canonicalFeed' — stale config (would rely on a GitHub transfer redirect)"
    exit 1
}
if (-not $env:GH_TOKEN) { $env:GH_TOKEN = (gh auth token) | Out-String; $env:GH_TOKEN = $env:GH_TOKEN.Trim() }

Write-Output "=== TDEaseNexus release plan ==="
Write-Output "  version: $version  (tag $tag)"
Write-Output "  feed:    $feedRepo (electron-builder github provider)"
Write-Output "  build:   build-desktop.ps1 -Installer  (-Publish)"
Write-Output "  verify:  anonymous latest.yml + update-source replay"
if ($DryRun) { Write-Output "DRY-RUN: all gates passed, stopping here."; exit 0 }

# ── Build + upload ───────────────────────────────────────────────────────────
# -Publish uses electron-builder's `-p always` (electron-builder 26 has no
# EP_PUBLISH env var; only the CLI flag works — the env var silently did nothing
# on the first release and the three artifacts were uploaded by hand).
& (Join-Path $PSScriptRoot "build-desktop.ps1") -Installer -Publish
if ($LASTEXITCODE -ne 0) { Write-Output "FAIL build failed — nothing uploaded, no tag created"; exit 1 }

# ── Verify feed (anonymous loop, identical to what the updater runs) ─────────
$feedUrl = "https://github.com/$feedRepo/releases/download/$tag/latest.yml"
$latest = (curl.exe -sL $feedUrl) -join "`n"
if (-not ($latest -match [regex]::Escape("version: $version"))) {
    Write-Output "FAIL anonymous verification: $feedUrl does not contain version: $version"
    Write-Output $latest
    exit 1
}
Write-Output "OK feed anonymously verifiable: $feedUrl"

# ── Verify update source (replay electron-updater requests, hop by hop) ──────
# The latest.yml check does not cover /releases/latest, releases.atom, or the
# path the client actually walks; $feedRepo is what app-update.yml bakes in.
& node (Join-Path $PSScriptRoot "check-update-source.mjs") --slug $feedRepo --platform win32 --expect-version $version
if ($LASTEXITCODE -ne 0) { Write-Output "FAIL update-source verification failed (see redirect hops above)"; exit 1 }

# ── Tag (only after upload; electron-builder's release may already tag) ──────
$remoteTag = git ls-remote --tags origin "refs/tags/$tag"
if (-not $remoteTag) {
    git tag -a $tag -m "TDEaseNexus $version"
    git push origin $tag
} else {
    git fetch --tags origin 2>$null
}
Write-Output "=== release complete: $version ==="
