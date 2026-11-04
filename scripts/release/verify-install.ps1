param(
    [string]$InstallDir = ".scratch/electron-installed",
    [string]$DataRoot = "",
    [switch]$EngineSmoke = $false
)

# Verifies a packaged install without launching the UI:
#   1. the packaged resource layout (backend sources, assets, vendor, native CLI)
#   2. every Node package's rules.smk: present, no absolute host path, and every
#      executable/script it names actually ships in that package
#   3. when the app has been launched at least once: the Backend catalog, the
#      provisioned environment/tools and the rebuildable index
#   4. -EngineSmoke: a real engine run of a Node from the Backend catalog in a
#      temp Run root outside the install, proving Run-root-relative resolution.
#   5. packaged hygiene, checked last: no bytecode, virtualenv or cache residue
#      in the packaged source trees. The extraResources filters keep the build
#      clean; running the installed Python here proves the product never writes
#      back into its own install.
#
# Exit code is 1 when any check fails.

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$repo = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
# Rooted -InstallDir values (e.g. C:\TDEaseNexus) are honored as-is.
$install = if ([System.IO.Path]::IsPathRooted($InstallDir)) { $InstallDir } else { Join-Path $repo $InstallDir }
$install = [System.IO.Path]::GetFullPath($install)

$script:failures = 0
function Check([string]$Label, [bool]$Ok, [string]$Detail = "") {
    $mark = if ($Ok) { "[ok]  " } else { "[fail]"; $script:failures++ }
    Write-Output "  $mark $Label$(if ($Detail) { " — $Detail" })"
}

if (-not (Test-Path -LiteralPath $install)) { throw "install directory missing: $install" }
Write-Output "=== Install verification ==="
Write-Output "  install: $install"

# ── 1. Packaged layout ───────────────────────────────────────────────────────
Write-Output ""
Write-Output "--- Packaged layout ---"
$backend = Join-Path $install "resources/backend"
$assets = Join-Path $install "resources/app/assets"
foreach ($item in @(
    @{ Path = (Join-Path $install "TDEaseNexus.exe"); Label = "TDEaseNexus.exe" },
    @{ Path = (Join-Path $backend "pyproject.toml"); Label = "backend/pyproject.toml" },
    @{ Path = (Join-Path $backend "uv.lock"); Label = "backend/uv.lock" },
    @{ Path = (Join-Path $backend "src/contracts/run_lifecycle.json"); Label = "backend/src (lifecycle declaration)" },
    @{ Path = (Join-Path $assets "skills"); Label = "assets/skills" },
    @{ Path = (Join-Path $assets "prompts/internal/base_role.md"); Label = "assets/prompts" },
    @{ Path = (Join-Path $assets "templates"); Label = "assets/templates" },
    @{ Path = (Join-Path $assets "reference"); Label = "assets/reference" },
    @{ Path = (Join-Path $install "resources/native/tdeasenexus-toolbox.exe"); Label = "native/tdeasenexus-toolbox.exe" },
    @{ Path = (Join-Path $install "resources/vendor/git/usr/bin/bash.exe"); Label = "vendor/git bash" }
)) {
    Check $item.Label (Test-Path -LiteralPath $item.Path)
}

$skills = @(Get-ChildItem -LiteralPath (Join-Path $assets "skills") -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "SKILL.md") })
Check "shipped skills" ($skills.Count -gt 0) "$($skills.Count) skill(s)"
foreach ($expected in @("tdeasenexus-docs", "workflow", "toppic-suite", "isoforma")) {
    Check "skill: $expected" ($skills.Name -contains $expected)
}

# ── 2. Node package rules.smk paths ──────────────────────────────────────────
Write-Output ""
Write-Output "--- Node packages (Backend catalog) ---"
$catalogSource = Join-Path $repo "data/backend/nodes"
$packages = @(Get-ChildItem -LiteralPath $catalogSource -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike "_*" })
Check "node packages" ($packages.Count -gt 0) "$($packages.Count) package(s): $($packages.Name -join ', ')"
Check "_template present" (Test-Path -LiteralPath (Join-Path $catalogSource "_template/rules.smk"))

foreach ($package in $packages) {
    $rulesPath = Join-Path $package.FullName "rules.smk"
    if (-not (Test-Path -LiteralPath $rulesPath)) {
        Check "node $($package.Name)/rules.smk" $false "missing"
        continue
    }
    $rules = Get-Content -Raw -LiteralPath $rulesPath
    # Comments carry prose (URLs, example host paths, sibling test names); the
    # audit is about what the rule executes, so scan code lines only.
    $code = ($rules -split "`r?`n" | Where-Object { $_.TrimStart() -notlike "#*" }) -join "`n"

    # An absolute host path in a node rule is the classic dev-tree leak: the
    # same file must run unchanged wherever the package is deployed. The
    # lookbehind keeps `https://…` from reading as a drive letter, and a
    # wildcard pattern (`C:\Program Files\ProteoWizard\*\msconvert.exe`) is
    # host *discovery*, not a hardcoded dependency.
    $absolute = [regex]::Matches($code, '(?<![A-Za-z])[A-Za-z]:[\\/][^"''\r\n]*') |
        ForEach-Object { $_.Value.TrimEnd(')', ',', ' ') } | Where-Object { $_ -notmatch '\*' } | Select-Object -Unique
    Check "node $($package.Name): no hardcoded absolute path" ($absolute.Count -eq 0) ($absolute -join ', ')

    # Every executable/script the rules name must ship inside this package (or,
    # for a node that deliberately delegates, inside the package it names). The
    # trailing boundary keeps `sys.executable` from reading as `sys.exe`.
    $referenced = [regex]::Matches($code, '[A-Za-z0-9_\-]+\.(exe|py|bat|cmd|ps1)\b') |
        ForEach-Object { $_.Value } | Select-Object -Unique
    $files = @(Get-ChildItem -LiteralPath $package.FullName -Recurse -File | Select-Object -ExpandProperty Name)
    $missing = @($referenced | Where-Object { $files -notcontains $_ })
    # topindex ships its binary inside the toppic suite package by design.
    if ($package.Name -eq "topindex") {
        $toppicFiles = @(Get-ChildItem -LiteralPath (Join-Path $catalogSource "toppic") -Recurse -File -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Name)
        $missing = @($missing | Where-Object { $toppicFiles -notcontains $_ })
    }
    Check "node $($package.Name): referenced binaries ship" ($missing.Count -eq 0) `
        "names: $($referenced -join ', ')$(if ($missing.Count) { "; missing: $($missing -join ', ')" })"
}

# ── 3. External runtime state (only after the app has launched once) ────────
Write-Output ""
Write-Output "--- Installed runtime state ---"
if (-not $DataRoot) {
    $parent = Split-Path -Parent $install
    $probe = Join-Path $parent "TDEaseNexus-Data"
    if (Test-Path -LiteralPath $probe) { $DataRoot = $probe }
}
if (-not $DataRoot -or -not (Test-Path -LiteralPath $DataRoot)) {
    Check "data root" $false "not found — launch the installed app once (looked beside $install)"
} else {
    Check "data root" $true $DataRoot
    $catalogRoot = Join-Path $DataRoot "backend/nodes"
    # Dot-prefixed dirs (.snapshots — the digest-addressed bind store) are
    # backend-owned state, not packages; the catalog scanner skips them too.
    $seeded = @(Get-ChildItem -LiteralPath $catalogRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike "_*" -and $_.Name -notlike ".*" })
    Check "Backend node catalog" ($seeded.Count -eq $packages.Count) `
        "$($seeded.Count)/$($packages.Count): $($seeded.Name -join ', ')"
    foreach ($package in $packages) {
        Check "catalog $($package.Name)/rules.smk" (Test-Path -LiteralPath (Join-Path $catalogRoot "$($package.Name)/rules.smk"))
    }
    $venvPython = Join-Path $DataRoot "backend/runtime/venv/Scripts/python.exe"
    Check "backend environment" (Test-Path -LiteralPath $venvPython) $venvPython
    Check "backend CLI" (Test-Path -LiteralPath (Join-Path $DataRoot "backend/runtime/venv/Scripts/tdease-backend.exe"))
    Check "provisioned native tool" (Test-Path -LiteralPath (Join-Path $DataRoot "system/agent/tools/tdeasenexus-toolbox.exe"))
    Check "run index" (Test-Path -LiteralPath (Join-Path $DataRoot "backend/database/db.sqlite3"))
    Check "backend log" (Test-Path -LiteralPath (Join-Path $DataRoot "system/logs/backend.log"))

    # The doctor that ships inside this install inspects its own installation.
    $doctor = Join-Path $assets "skills/tdeasenexus-docs/scripts/doctor.py"
    if ((Test-Path -LiteralPath $venvPython) -and (Test-Path -LiteralPath $doctor)) {
        Write-Output ""
        Write-Output "--- Shipped doctor on the installed data root ---"
        $doctorJson = & $venvPython -B $doctor --data-root $DataRoot --system-assets $assets --workspace $DataRoot --json | Out-String
        $doctorReport = $doctorJson | ConvertFrom-Json
        foreach ($check in $doctorReport.checks) {
            $firstLine = ($check.detail -split "`n" | Select-Object -First 1)
            Check "doctor $($check.id)" ($check.status -ne "fail") "$($check.status): $firstLine"
        }
    }
}

# ── 4. Engine smoke: a Node from the Backend catalog ────────────────────────
if ($EngineSmoke) {
    Write-Output ""
    Write-Output "--- Engine smoke (Backend topindex node, Run root outside the install) ---"
    $venvPython = Join-Path $DataRoot "backend/runtime/venv/Scripts/python.exe"
    $catalogRoot = Join-Path $DataRoot "backend/nodes"
    if (-not (Test-Path -LiteralPath $venvPython)) {
        Check "engine smoke" $false "installed backend python missing: $venvPython"
    } else {
        $runRoot = Join-Path $env:TEMP "tdease-install-smoke-$PID"
        Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $runRoot | Out-Null

        # 4a. The installed backend resolves a node binding the way the worker
        # does: the engine config carries absolute catalog paths
        # (config["nodes"]) and nothing node-related is written under the Run.
        $linkProbe = @'
import json, os, sys
from pathlib import Path
from types import SimpleNamespace
install, data_root, run_root = (Path(argument) for argument in sys.argv[1:4])
sys.path.insert(0, str(install / "resources" / "backend"))
from src.services.node_catalog import scan_nodes, resolve_bindings, bound_node_paths
catalog = data_root / "backend" / "nodes"
nodes, errors = scan_nodes(catalog)
resolved = resolve_bindings(catalog, [SimpleNamespace(id="toppic")])
paths = bound_node_paths(resolved)
package = Path(paths["toppic"])
report = {
    "packages_found": len(nodes),
    "binding_resolves": package.is_dir(),
    "rules_resolves": (package / "rules.smk").is_file(),
    "binary_resolves": (package / "topindex.exe").is_file(),
    "path_points_at_catalog": str(package).lower().startswith(str(catalog).lower()),
    # The Run directory must stay free of node material: the engine reaches
    # the catalog through the config mapping, never through Run-local copies.
    "run_root_has_no_nodes": not (run_root / "nodes").exists(),
}
print(json.dumps(report))
'@
        $probe = & $venvPython -B -c $linkProbe $install $DataRoot $runRoot | Out-String
        $linkReport = $probe | ConvertFrom-Json
        Check "catalog scans cleanly with toppic present" ($linkReport.packages_found -ge 1)
        Check "shipped backend resolves the toppic binding" $linkReport.binding_resolves
        Check "catalog rules.smk resolves through the binding" $linkReport.rules_resolves
        Check "catalog topindex.exe resolves through the binding" $linkReport.binary_resolves
        Check "engine config points at the catalog" $linkReport.path_points_at_catalog
        Check "no node material written under the Run" $linkReport.run_root_has_no_nodes

        # 4b. A real engine run in that Run root, with the installed venv's
        # Snakemake, through the same config-based binding the worker injects.
        # topindex's rule ships in the topindex package; its topindex.exe ships
        # inside the toppic suite package — two bindings, one config mapping.
        $toppicDir = (Join-Path $catalogRoot "toppic")
        $topindexDir = (Join-Path $catalogRoot "topindex")
        Set-Content -LiteralPath (Join-Path $runRoot "database.fasta") -Encoding ascii `
            -Value ">protein_a`nMPEPTIDEKPEPTIDE`n>protein_b`nMACDEFGHIK"
        Set-Content -LiteralPath (Join-Path $runRoot "Snakefile") -Encoding utf8 -Value @'
_TOPINDEX = (config.get("nodes") or {}).get("topindex")
if not _TOPINDEX:
    raise FileNotFoundError("topindex node is not bound")
include: _TOPINDEX + "/rules.smk"

rule all:
    input:
        ".tdease/topindex/database.fasta.complete"
'@
        $nodesConfig = "nodes={""toppic"": ""$($toppicDir.Replace('\', '/'))"", ""topindex"": ""$($topindexDir.Replace('\', '/'))""}"
        $output = & $venvPython -B -m snakemake --snakefile (Join-Path $runRoot "Snakefile") `
            --directory $runRoot --cores 2 --printshellcmds --config $nodesConfig 2>&1 | Out-String
        $ran = Test-Path -LiteralPath (Join-Path $runRoot ".tdease/topindex/database.fasta.complete")
        Check "engine run succeeded" $ran ($output.Trim() -split "`n" | Select-Object -Last 1)
        # topindex.exe ships inside the toppic package and the Run reaches it
        # only through the injected absolute catalog path — the Run root must
        # stay free of node material. Path may print with either separator.
        $toppicFwd = [regex]::Escape($toppicDir.Replace('\', '/'))
        $toppicBak = [regex]::Escape($toppicDir.Replace('/', '\'))
        $printedCatalogPath = ($output -match $toppicFwd) -or ($output -match $toppicBak)
        Check "printed command resolves the node through the catalog binding" $printedCatalogPath
        Check "engine wrote no node material under the Run" (-not (Test-Path -LiteralPath (Join-Path $runRoot "nodes")))
        # Boundary-aware: the install dir C:\TDEaseNexus is a strict prefix of the
        # data root C:\TDEaseNexus-Data — a sibling root is not a leak. A real leak
        # continues with a path separator, which the lookahead still flags.
        # The catalog path itself is expected: tool binding IS the catalog.
        $leaked = @()
        $forbiddenList = @($install)
        foreach ($forbidden in $forbiddenList) {
            if ($forbidden -and $output -match ([regex]::Escape($forbidden) + "(?![-\w])")) { $leaked += $forbidden }
        }
        $leakedLines = @(
            foreach ($line in ($output -split "`n")) {
                foreach ($forbidden in $forbiddenList) {
                    $trimmed = $line.Trim()
                    if ($forbidden -and $trimmed -match ([regex]::Escape($forbidden) + "(?![-\w])")) {
                        $trimmed.Substring(0, [Math]::Min(200, $trimmed.Length))
                        break
                    }
                }
            }
        )
        Check "printed command leaks no install path" ($leaked.Count -eq 0) (($leakedLines | Select-Object -First 2) -join ' | ')
        Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── 5. Packaged hygiene ──────────────────────────────────────────────────────
# The checks above exercise the installed Python (backend CLI, doctor, engine),
# so this runs last: it proves the product leaves its own install untouched.
# Bytecode, virtualenvs and caches in a packaged source tree carry the
# builder's Python and absolute paths, and the extraResources filters exist to
# keep them out; a product that writes __pycache__ into its install would
# mutate what the installer delivered (and fail on a read-only mount).
# Exception: the bundled interpreter's stdlib is PRECOMPILED at release time
# (build Phase 0.8), so bytecode inside runtime/cpython-* is a shipped
# artifact, not residue — anything else under it still is.
Write-Output ""
Write-Output "--- Packaged hygiene (after the checks above ran) ---"
$shippedBytecodeRoot = Join-Path $backend "runtime/cpython-"
$residue = @()
foreach ($root in @($backend, $assets, (Join-Path $install "resources/native"))) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $residue += @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $isBytecode = $_.Name -eq "__pycache__" -or $_.Name -like "*.pyc"
            if ($isBytecode -and $_.FullName -like "$shippedBytecodeRoot*") { return $false }
            $_.Name -in @("__pycache__", ".venv", ".pytest_cache", ".DS_Store") -or
            $_.Name -like "*.pyc" -or $_.Name -like "*.egg-info"
        })
}
Check "no bytecode/venv/cache residue" ($residue.Count -eq 0) `
    (($residue | Select-Object -First 5 -ExpandProperty FullName) -join '; ')

Write-Output ""
if ($script:failures -gt 0) {
    Write-Output "=== $($script:failures) check(s) FAILED ==="
    exit 1
}
Write-Output "=== all checks passed ==="
