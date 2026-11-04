$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path

$requiredCommands = @("git", "node", "pnpm", "uv")

# Node catalog binaries are Backend-owned and stay outside the packaged app.
# They live under the Backend data root used by development/release tests.
$nodeCatalog = @(
    @{ Path = (Join-Path $repo "data/backend/nodes/toppic/topfd.exe"); Label = "TopFD (catalog)" },
    @{ Path = (Join-Path $repo "data/backend/nodes/toppic/toppic.exe"); Label = "TopPIC (catalog)" },
    @{ Path = (Join-Path $repo "data/backend/nodes/toppic/topindex.exe"); Label = "TopIndex (catalog)" },
    @{ Path = (Join-Path $repo "data/backend/nodes/msconvert/msconvert.exe"); Label = "msconvert (catalog)" },
    @{ Path = (Join-Path $repo "data/backend/nodes/_template/rules.smk"); Label = "node _template" }
)

# Ignored packaging roots electron-builder consumes at build time
# (electron-builder.json extraResources) and the submodules it packages.
$staging = @(
    @{ Path = (Join-Path $repo ".scratch/runtime/uv.exe"); Label = "bundled uv" },
    @{ Path = (Join-Path $repo ".scratch/runtime/wheelhouse"); Label = "PEP 723 wheelhouse" },
    @{ Path = (Join-Path $repo ".scratch/runtime/settings.seed.json"); Label = "settings seed" },
    @{ Path = (Join-Path $repo ".scratch/vendor/git/cmd/git.exe"); Label = "bundled Git" },
    @{ Path = (Join-Path $repo ".scratch/vendor/search-tools"); Label = "bundled search tools" },
    @{ Path = (Join-Path $repo "tdease-backend/pyproject.toml"); Label = "backend submodule" },
    @{ Path = (Join-Path $repo "tdease-backend/uv.lock"); Label = "backend lockfile" },
    @{ Path = (Join-Path $repo "tdease-ai-capability/system/skills"); Label = "system skills" },
    @{ Path = (Join-Path $repo "tdease-ai-capability/system/prompts/internal/base_role.md"); Label = "system prompts" },
    @{ Path = (Join-Path $repo "tdease-ai-capability/system/reference"); Label = "system reference" }
)

# A managed CPython under .scratch/runtime is resolved by directory prefix
# (backend_manager._bundledPythonPath); any cpython-* layout passes.
$cpythonPresent = @(Get-ChildItem -LiteralPath (Join-Path $repo ".scratch/runtime") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "cpython-*" }).Count -gt 0

$failures = [System.Collections.Generic.List[string]]::new()

foreach ($command in $requiredCommands) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        $failures.Add("command not found: $command")
    }
}

foreach ($entry in ($nodeCatalog + $staging)) {
    if (-not (Test-Path -LiteralPath $entry.Path)) {
        $failures.Add("$($entry.Label) missing: $($entry.Path)")
    }
}

if (-not $cpythonPresent) {
    $failures.Add("bundled CPython missing: no cpython-* directory under .scratch/runtime")
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    throw "TDEase release VM preflight failed with $($failures.Count) problem(s)"
}

Write-Output "TDEase release VM preflight passed"
Write-Output "  repo: $repo"
