param(
    [string]$InstallDir = ".scratch/electron-installed",
    [switch]$Installer = $false,
    # 发布: 让 electron-builder 构建后直接上传 feed 三件套 (installer/
    # latest.yml/blockmap) 到 publish 配置指向的 GitHub 仓。注意 electron-
    # builder 26.x 没有 EP_PUBLISH 环境变量 —— 只有 CLI 标志生效。
    [switch]$Publish = $false
)

$ErrorActionPreference = "Stop"
# PS7 4+ 把 native 命令的 stderr（uv 的进度/成功输出全走 stderr）当作
# ErrorRecord，配合上面的 Stop 会把成功路径也判成失败。发布 VM 用 PS7，
# 必须显式关闭该桥接。
$PSNativeCommandUseErrorActionPreference = $false
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$frontend = Join-Path $repo "TDEase-FrontEnd"
$install = [System.IO.Path]::GetFullPath((Join-Path $repo $InstallDir))

Write-Output "=== TDEaseNexus Desktop Build ==="
Write-Output "  repo:      $repo"
Write-Output "  frontend:  $frontend"
Write-Output "  install:   $install"

# ── Phase -1: Non-secret provider defaults ──────────────────────────────────

$runtime = Join-Path $repo ".scratch/runtime"
$seedPath = Join-Path $runtime "settings.seed.json"
$seed = @{ providers = @{ deepseek = @{ base_url = "https://api.deepseek.com/v1" } } }
# api_key 只在 TDEASE_DEEPSEEK_API_KEY 显式给出时封进种子 —— 发布是公开分发
# (feed 仓库人人可下载), 曾经的"回退本机 dev settings"会把开发者个人 key
# 静默打进公开安装包。私发交付需要预置 key 时, 在发布环境显式传 env。
$deepseekKey = $env:TDEASE_DEEPSEEK_API_KEY
if ($deepseekKey) {
    # Hashtable 须用字典索引赋值: Add-Member 只加在 PSObject 包装上,
    # ConvertTo-Json 序列化字典条目, key 会被静默丢弃。
    $seed.providers.deepseek["api_key"] = $deepseekKey
    Write-Output "  deepseek api_key sealed into provider seed"
}
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Set-Content -LiteralPath $seedPath -Value ($seed | ConvertTo-Json -Depth 6) -Encoding utf8
Write-Output "  non-secret provider seed written -> $seedPath"

# ── Phase 0: Provision Skill dependencies ──────────────────────────────────

$uv = Join-Path $runtime "uv.exe"
$python = Join-Path $runtime "cpython-3.12.13-windows-x86_64-none/python.exe"
$skillRequirements = Join-Path $runtime "skill-requirements.txt"
$skillManifest = Join-Path $runtime "skill-dependencies.json"
$skillsDir = Join-Path $repo "tdease-ai-capability/system/skills"
$collector = Join-Path $repo "scripts/release/collect-skill-dependencies.py"

foreach ($required in @($uv, $python, $skillsDir, $collector)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Release runtime prerequisite missing: $required"
    }
}

Write-Output ""
Write-Output "--- Phase 0: Skill runtime ---"
& $python $collector --skills-dir $skillsDir --requirements-out $skillRequirements --manifest-out $skillManifest
if ($LASTEXITCODE -ne 0) {
    throw "Skill dependency collection failed"
}

# ── Phase 0.7: Bundled interpreter housekeeping ──────────────────────────────
# The Python dependency set is NOT shipped: first boot runs `uv sync --locked`
# against the uv cache or the network (product decision — the installer stays
# ~0.5 GB smaller, and both uv sides are online by design). What still ships is
# the pinned interpreter (runtime/cpython-3.12.13-*, the one
# backend_manager._bundledPythonPath() probes for UV_PYTHON), and its stdlib is
# precompiled — what python.org installers do. Runtime probes (uv -I, venv
# trampolines) run with flags that ignore PYTHONDONTWRITEBYTECODE, so a stock
# Lib would grow __pycache__ inside the install directory on the user's
# machine; with the bytecode shipped, those writes become no-ops.
$shippedCpython = Join-Path $runtime "cpython-3.12.13-windows-x86_64-none"
Write-Output ""
Write-Output "--- Phase 0.7: Stdlib precompile ---"
& (Join-Path $shippedCpython "python.exe") -m compileall -q (Join-Path $shippedCpython "Lib")
if ($LASTEXITCODE -ne 0) {
    throw "stdlib precompile failed"
}
Write-Output "  stdlib precompiled: $shippedCpython"

# ── Phase 0.6: Node seed zip (compute tools ship with the installer) ────────

# The installer carries the node packages as ONE compressed archive; the app
# extracts it into <dataRoot>/backend/nodes on first launch (see main.ts
# provisionNodeCatalogSeed). Regenerated every build so the shipped rules.smk
# bytes are always THIS build's bytes. The vendor source archive and the
# digest-snapshot store are not product content and stay out.
$nodesZip = Join-Path $runtime "nodes.zip"
$catalogSource = Join-Path $repo "data/backend/nodes"
if (-not (Test-Path -LiteralPath (Join-Path $catalogSource "toppic/rules.smk"))) {
    throw "Node catalog prerequisite missing: $catalogSource"
}
Write-Output ""
Write-Output "--- Phase 0.6: Node seed zip ---"
if (Test-Path -LiteralPath $nodesZip) { Remove-Item -LiteralPath $nodesZip -Force }
# System32 bsdtar explicitly: a Git-Bash PATH puts GNU tar first, and GNU tar
# reads "-f C:\..." as a remote host name ("Cannot connect to C:").
$windowsTar = Join-Path $env:SystemRoot "System32\tar.exe"
& $windowsTar -a -cf $nodesZip --exclude "nodes/.snapshots" --exclude "nodes/toppic-windows-1.8.1.zip" -C (Join-Path $repo "data/backend") nodes
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nodesZip)) {
    throw "Node seed zip creation failed"
}
$nodesZipMb = [math]::Round((Get-Item -LiteralPath $nodesZip).Length / 1MB, 1)
Write-Output "  node seed zip: $nodesZip ($nodesZipMb MB)"

# ── Phase 0.5: Vendor Git (bundled bash for the agent sandbox) ──────────────

# A clean target machine has no Git for Windows; the agent bash sandbox needs
# bash + msys coreutils, so MinGit (usr/bin coreutils + mingw64 git) is bundled
# with bash.exe restored (MinGit ships sh.exe = the bash binary; copies of it
# serve as usr/bin/bash.exe and the bin/ sh/bash pair the msys shebang
# dispatcher resolves as /bin/sh). Version pinned to the GfW release the
# toolchain was validated against.
$gitVendorDir = Join-Path $repo ".scratch/vendor/git"
$gitVendorBash = Join-Path $gitVendorDir "usr/bin/bash.exe"
if (-not (Test-Path -LiteralPath $gitVendorBash)) {
    Write-Output ""
    Write-Output "--- Phase 0.5: Vendor Git ---"
    $gitVersion = "2.55.0.windows.5"
    $mingitUrl = "https://github.com/git-for-windows/git/releases/download/$gitVersion/MinGit-2.55.0.5-64-bit.zip"
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
    # System32 bsdtar explicitly (same reason as Phase 0.6): a Git-Bash PATH
    # puts GNU tar first, and GNU tar reads "-f C:\..." as a remote host name.
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
} else {
    Write-Output "  Vendor Git already staged: $gitVendorDir"
}

# ── Phase 1: Build Electron app ─────────────────────────────────────────────

Write-Output ""
Write-Output "--- Phase 1: Electron build ---"

    Push-Location $frontend
    try {
        Write-Output "  Building frontend + electron..."
        if ($Publish) {
            # desktop:dist 是 && 链；pnpm 会把追参（含 "--"）原样追加到链尾，
            # electron-builder 的 yargs 把 "--" 之后的 -p always 当位置参数丢弃
            # → 静默不发布（0.9.0-beta 的三件套因此手动补传过）。发布路径：
            # 先跑链的前置段，再直接调 electron-builder 携带发布旗标。
            & pnpm.cmd run desktop:dist:prep 2>&1 | ForEach-Object { Write-Output "    $_" }
            if ($LASTEXITCODE -ne 0) {
                throw "dist prep failed"
            }
            & pnpm.cmd exec electron-builder --config electron-builder.json -p always 2>&1 | ForEach-Object { Write-Output "    $_" }
        } else {
            $buildCommand = if ($Installer) { "desktop:dist" } else { "desktop:build" }
            & pnpm.cmd run $buildCommand 2>&1 | ForEach-Object { Write-Output "    $_" }
        }
        if ($LASTEXITCODE -ne 0) {
            throw "electron build failed"
        }
    } finally {
        Pop-Location
    }

# ── Phase 2: Verify output ───────────────────────────────────────────────────

$unpacked = Join-Path $frontend "release/win-unpacked"
if (-not (Test-Path -LiteralPath $unpacked)) {
    throw "Electron unpacked build not found: $unpacked"
}

Write-Output ""
Write-Output "--- Phase 2: Verify ---"
Write-Output "  Unpacked build: $unpacked"

# Check that backend resources are included
$backendDir = Join-Path $unpacked "resources/backend"
$checks = @(
    @{ Path = "$backendDir/pyproject.toml"; Label = "pyproject.toml" },
    @{ Path = "$backendDir/app"; Label = "app/" },
    @{ Path = "$backendDir/src"; Label = "src/" },
    @{ Path = "$backendDir/runtime/cpython-3.12.13-windows-x86_64-none/python.exe"; Label = "bundled interpreter" },
    @{ Path = (Join-Path $unpacked "resources/app/assets/templates"); Label = "templates/" }
    @{ Path = (Join-Path $unpacked "resources/app/assets/skills"); Label = "skills/" },
    @{ Path = (Join-Path $unpacked "resources/vendor/git/usr/bin/bash.exe"); Label = "vendor/git bash" }
)
$allOk = $true
foreach ($check in $checks) {
    $exists = Test-Path -LiteralPath $check.Path
    $mark = if ($exists) { "+" } else { "MISSING" }
    if (-not $exists) { $allOk = $false }
    Write-Output "  [$mark] $($check.Label)"
}
if (-not $allOk) {
    throw "Some expected resources are missing from the build"
}

# ── Phase 3: Copy to install target ──────────────────────────────────────────

if (Test-Path -LiteralPath $install) {
    Write-Output ""
    Write-Output "  Removing previous install at $install..."
    Remove-Item -LiteralPath $install -Recurse -Force
}
New-Item -ItemType Directory -Path $install | Out-Null
Copy-Item -Path (Join-Path $unpacked "*") -Destination $install -Recurse

Write-Output ""
Write-Output "=== Build complete ==="
Write-Output "  Install dir: $install"
Write-Output "  Run: $install/TDEaseNexus.exe"
if ($Installer) {
    $installerFile = Get-ChildItem -LiteralPath (Join-Path $frontend "release") -Filter "*.exe" -File |
        Where-Object { $_.Name -ne "TDEaseNexus.exe" } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $installerFile) {
        throw "NSIS installer was not produced"
    }
    $checksumPath = "$($installerFile.FullName).sha256"
    $hash = (Get-FileHash -LiteralPath $installerFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath $checksumPath -Value "$hash  $($installerFile.Name)" -Encoding ascii
    Write-Output "  Installer: $($installerFile.FullName)"
    Write-Output "  SHA-256:   $checksumPath"
}
$install
