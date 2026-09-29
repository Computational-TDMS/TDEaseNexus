param(
    # 只跑门闸并打印计划，不构建不上传 —— 用于随时验证发布前提。
    [switch]$DryRun = $false
)

# TDEaseNexus 应用发布编排 —— 唯一的应用上传路径。
# docs/design/PACKAGE-DISTRIBUTION.md §Release pipeline:
#   "只有正式版本才上传"的实现 = 上传代码只存在于本脚本。没有 CI、
#   没有 webhook、没有定时器；人执行本脚本这个动作就是决策本身。
#
# 前提（全部由门闸强制）:
#   - 主仓工作树干净（子模块内容脏也会被 porcelain 捕获）
#   - TDEase-FrontEnd/package.json 的版本号对应的 v{version} tag 远端不存在
#   - gh 已认证，且 TDEaseNexus-Releases 公开仓可达
#
# 链路: build-desktop.ps1 -Installer（vendor + 质量门 + electron-builder，
# EP_PUBLISH=always 穿透到 electron-builder 的 github provider 上传三件套:
# 安装包 / latest.yml / blockmap）→ 匿名验证 latest.yml → 打 tag 并推送。
#
# GH_TOKEN 从 gh CLI 取，不落盘不入库。

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$frontend = Join-Path $repo "TDEase-FrontEnd"
$feedRepo = "Tisen-Ray/TDEaseNexus-Releases"

Set-Location $repo

# ── Gate 1: 工作树干净 ────────────────────────────────────────────────────────
$dirty = git status --porcelain
if ($dirty) {
    Write-Output "FAIL 主仓工作树不干净 —— 发布只从落账状态切出:"
    $dirty | ForEach-Object { Write-Output "  $_" }
    exit 1
}

# ── Gate 2: 版本号可发布（v{version} tag 远端不存在）─────────────────────────
$packageJson = Get-Content (Join-Path $frontend "package.json") -Raw | ConvertFrom-Json
$version = $packageJson.version
$tag = "v$version"
if (-not $version) { Write-Output "FAIL 读不到 package.json 版本号"; exit 1 }
$existing = git ls-remote --tags origin "refs/tags/$tag"
if ($existing) {
    Write-Output "FAIL tag $tag 已存在于远端 —— 先升版本号再发布"
    exit 1
}

# ── Gate 3: feed 仓可达（公开 + gh 认证）─────────────────────────────────────
gh repo view $feedRepo --json visibility 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Output "FAIL gh 未认证或 $feedRepo 不可达"; exit 1 }
if (-not $env:GH_TOKEN) { $env:GH_TOKEN = (gh auth token) | Out-String; $env:GH_TOKEN = $env:GH_TOKEN.Trim() }

Write-Output "=== TDEaseNexus 发布计划 ==="
Write-Output "  版本:   $version  (tag $tag)"
Write-Output "  feed:   $feedRepo (electron-builder github provider)"
Write-Output "  构建:   build-desktop.ps1 -Installer  (EP_PUBLISH=always)"
Write-Output "  验证:   匿名 curl latest.yml"
if ($DryRun) { Write-Output "DRY-RUN 门闸全部通过，到此为止。"; exit 0 }

# ── 构建 + 上传 ───────────────────────────────────────────────────────────────
# -Publish 走 electron-builder 的 `-p always` (26.x 没有 EP_PUBLISH 环境变量,
# 只有 CLI 标志生效 —— 第一次发布时环境变量静默失效, 三件套是手动补传的)。
& (Join-Path $PSScriptRoot "build-desktop.ps1") -Installer -Publish
if ($LASTEXITCODE -ne 0) { Write-Output "FAIL 构建失败 —— 未上传，未打 tag"; exit 1 }

# ── 验证 feed（匿名回路，与更新器将运行的完全一致）───────────────────────────
$feedUrl = "https://github.com/$feedRepo/releases/download/$tag/latest.yml"
$latest = (curl.exe -sL $feedUrl) -join "`n"
if (-not ($latest -match [regex]::Escape("version: $version"))) {
    Write-Output "FAIL 匿名验证失败: $feedUrl 中没有 version: $version"
    Write-Output $latest
    exit 1
}
Write-Output "OK feed 已可匿名验证: $feedUrl"

# ── 打 tag（上传成功之后才动；electron-builder 的 release 可能已建远程 tag）──
$remoteTag = git ls-remote --tags origin "refs/tags/$tag"
if (-not $remoteTag) {
    git tag -a $tag -m "TDEaseNexus $version"
    git push origin $tag
} else {
    git fetch --tags origin 2>$null
}
Write-Output "=== 发布完成: $version ==="
