# Headless audit of an installed TDEaseNexus against the release design
# targets. No UI, no app launch — safe to run in CI / from a release gate.
#
# Checks, each traceable to its design owner:
#   A. Node catalog == committed seed manifest set parity
#      (owner: scripts/release/node-seed.manifest.json — the shipped SET is a
#      function of the commit, never of the machine: no residue, no gaps).
#   B. Node packages: rules.smk + README.md per manifest "required", no
#      hardcoded absolute host paths in rules.smk, every binary referenced by
#      rules.smk `bin:` declarations ships beside the package
#      (owner: spec WORKFLOW-RUN "rules.smk-as-contract", NODES packaging).
#   C. Binary inventory for the authoritative toolchain
#      (owner: STATUS "Node catalog": toppic 1.8.1 authoritative, msconvert,
#      informed-proteomics MSPathFinderT/ProMex).
#   D. System assets: 16 skills (SKILL.md each), 15 frozen prompt artifacts,
#      reference databases, templates
#      (owner: spec AGENT-CONTRACT §5, STATUS "System assets").
#   E. Packaged hygiene: no __pycache__/.pyc/venv/cache residue in the
#      packaged trees
#      (owner: RELEASE-VM.md final section).
#
# Usage:
#   pwsh -File audit-installed-assets.ps1 -InstallDir <app> -DataRoot <data> [-Json]
# Exit 0 = all checks passed; 1 = failures (listed on stdout / in JSON).

param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [string]$RepoRoot = "C:/TDEase/TDEase-nexus",
    [switch]$Json = $false
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$install = [System.IO.Path]::GetFullPath($InstallDir)
$data = [System.IO.Path]::GetFullPath($DataRoot)
$catalog = Join-Path $data "backend/nodes"
$assets = Join-Path $install "resources/app/assets"
$repo = [System.IO.Path]::GetFullPath($RepoRoot)

$pass = # List[object], NOT List[hashtable]: a hashtable entry type would coerce
# the [ordered] dicts back, and .NET randomizes string hashing per process,
# so hashtable enumeration order (and thus JSON member order) varies across
# processes. Pinned by test-audit-idempotency.ps1.
[System.Collections.Generic.List[object]]::new()
$fail = # List[object], NOT List[hashtable]: a hashtable entry type would coerce
# the [ordered] dicts back, and .NET randomizes string hashing per process,
# so hashtable enumeration order (and thus JSON member order) varies across
# processes. Pinned by test-audit-idempotency.ps1.
[System.Collections.Generic.List[object]]::new()
function Check([string]$Id, [string]$Name, [bool]$Ok, [string]$Detail) {
    $entry = [ordered]@{ id = $Id; name = $Name; ok = $Ok; detail = $Detail }
    if ($Ok) { $pass.Add($entry) } else { $fail.Add($entry) }
    if (-not $Json) {
        $mark = if ($Ok) { "[ok]" } else { "[FAIL]" }
        Write-Output "$mark $Id $Name — $Detail"
    }
}

foreach ($root in @($install, $data, $catalog, $assets)) {
    if (-not (Test-Path -LiteralPath $root)) { throw "required root missing: $root" }
}

# ── A. Catalog == committed manifest set parity ──────────────────────────────
# `.seed-manifest.json` is the seed's own ownership marker written into the
# catalog at first launch (node_catalog_seed.cjs MANIFEST_NAME) — by design.
$manifestPath = Join-Path $repo "scripts/release/node-seed.manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$expected = @($manifest.entries | ForEach-Object { $_.name }) | Sort-Object
$actual = @(Get-ChildItem -LiteralPath $catalog | ForEach-Object { $_.Name } |
    Where-Object { $_ -ne ".seed-manifest.json" }) | Sort-Object
$missing = @($expected | Where-Object { $_ -notin $actual })
$residue = @($actual | Where-Object { $_ -notin $expected })
Check "nodes.set-parity" "catalog == seed manifest" `
    ($missing.Count -eq 0 -and $residue.Count -eq 0) `
    "expected $($expected.Count), actual $($actual.Count); missing=[$($missing -join ',')] residue=[$($residue -join ',')]"

# ── B. Package contract ──────────────────────────────────────────────────────
foreach ($entry in ($manifest.entries | Where-Object { $_.kind -eq "package" })) {
    $dir = Join-Path $catalog $entry.name
    foreach ($required in $entry.required) {
        Check "nodes.required:$($entry.name)" "$($entry.name)/$required" `
            (Test-Path -LiteralPath (Join-Path $dir $required)) (Join-Path $dir $required)
    }
    $rules = Join-Path $dir "rules.smk"
    if (Test-Path -LiteralPath $rules) {
        $text = Get-Content -LiteralPath $rules -Raw
        # drive-letter paths only: a letter preceded by another letter or digit
        # (e.g. "https://") is not a drive — the lookbehind keeps URLs out.
        $abs = [regex]::Matches($text, "(?<![A-Za-z0-9])[A-Za-z]:[\\/]") | ForEach-Object { $_.Value }
        Check "nodes.portable:$($entry.name)" "no hardcoded drive paths" `
            (@($abs).Count -eq 0) "hits: $(@($abs).Count)"
        # Referenced-binary shipping is audited by verify-install.ps1's catalog
        # section, which reads the real bin declarations and the bin_dir
        # override contract (topindex ships inside toppic on purpose).
    }
}

# ── C. Binary inventory ──────────────────────────────────────────────────────
$inventory = @(
    @{ Path = "toppic/topfd.exe"; Label = "TopFD" },
    @{ Path = "toppic/toppic.exe"; Label = "TopPIC" },
    @{ Path = "toppic/topindex.exe"; Label = "TopIndex" },
    @{ Path = "msconvert/msconvert.exe"; Label = "msconvert" },
    @{ Path = "informed-proteomics/MSPathFinderT.exe"; Label = "MSPathFinderT" },
    @{ Path = "informed-proteomics/ProMex.exe"; Label = "ProMex" }
)
foreach ($item in $inventory) {
    $p = Join-Path $catalog $item.Path
    $present = Test-Path -LiteralPath $p
    $detail = if ($present) {
        $v = (Get-Item -LiteralPath $p).VersionInfo.ProductVersion
        "$p (version: $v)"
    } else { "missing: $p" }
    Check "inventory.$($item.Label)" $item.Label $present $detail
}

# ── D. System assets ─────────────────────────────────────────────────────────
$skillsDir = Join-Path $assets "skills"
$skillNames = @("chart-forge", "evolution", "isoforma", "massql", "ptm-database",
    "spectral-evidence", "structure-evidence", "packages", "tdeasenexus-docs",
    "tdp-copilot", "tdp-opensearch", "tdp-execution", "toppic-suite",
    "toppicr-py", "unidec", "workflow")
$skillOk = @($skillNames | Where-Object { Test-Path -LiteralPath (Join-Path $skillsDir "$_/SKILL.md") })
Check "assets.skills" "16 skills with SKILL.md" `
    ($skillOk.Count -eq 16) "$($skillOk.Count)/16; missing=[$(@($skillNames | Where-Object { $_ -notin $skillOk }) -join ',')]"

$promptCount = @(Get-ChildItem -LiteralPath (Join-Path $assets "prompts/internal") -File -ErrorAction SilentlyContinue).Count
Check "assets.prompts" "15 frozen prompt artifacts" ($promptCount -eq 15) "$promptCount files"

$reference = @("unimod.sqlite", "psimod.sqlite", "knowledge.db", "PSI-MOD.obo")
$refDir = Join-Path $assets "reference"
$refMissing = @($reference | Where-Object { -not (Test-Path -LiteralPath (Join-Path $refDir $_)) })
Check "assets.reference" "reference databases" ($refMissing.Count -eq 0) "missing=[$($refMissing -join ',')]"

Check "assets.templates" "templates dir" `
    (Test-Path -LiteralPath (Join-Path $assets "templates")) (Join-Path $assets "templates")

# ── E. Packaged hygiene ──────────────────────────────────────────────────────
# Scope mirrors verify-install.ps1 §5: the bundled interpreter's stdlib is
# PRECOMPILED at release time (shipped artifact, not residue) and
# app.asar.unpacked/node_modules is electron-builder's native-module unpack —
# both by design. Anything else under the packaged trees is residue.
$shippedBytecodeRoot = Join-Path $install "resources/backend/runtime/cpython-"
$residue = @(Get-ChildItem -LiteralPath $install -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object {
        $isBytecode = $_.Name -eq "__pycache__" -or $_.Name -like "*.pyc"
        if ($isBytecode -and $_.FullName -like "$shippedBytecodeRoot*") { return $false }
        $_.Name -in @("__pycache__", ".venv", ".pytest_cache") -or
        $_.Name -like "*.pyc" -or $_.Name -like "*.egg-info"
    })
Check "hygiene.no-cache" "no bytecode/venv/cache residue outside shipped artifacts" `
    ($residue.Count -eq 0) "hits: $(@($residue | Select-Object -First 5 -ExpandProperty FullName) -join '; ')"

# ── F. System-asset content parity (repo tree == installed tree, byte-level) ─
# electron-builder.json extraResources maps tdease-ai-capability/system/*
# into app/assets/* with a filter that strips only cache residue
# (__pycache__/.pyc/.venv/.pytest_cache/egg-info/.DS_Store, plus skills' own
# cache/ dirs). Design target: the installed tree IS the repo tree minus
# residue — nothing missing, nothing extra, nothing drifted.
$assetMaps = @(
    @{ Src = "tdease-ai-capability/system/skills";    Dst = "app/assets/skills" },
    @{ Src = "tdease-ai-capability/system/prompts";   Dst = "app/assets/prompts" },
    @{ Src = "tdease-ai-capability/system/templates"; Dst = "app/assets/templates" },
    @{ Src = "tdease-ai-capability/system/reference"; Dst = "app/assets/reference" }
)
$excluded = @("__pycache__", ".venv", ".pytest_cache", ".DS_Store", "cache")
function Test-Excluded([string]$rel) {
    foreach ($part in ($rel -split "[\\/]")) { if ($part -in $excluded) { return $true } }
    return $false
}
foreach ($map in $assetMaps) {
    $srcRoot = Join-Path $repo $map.Src
    $dstRoot = Join-Path $install ("resources/" + $map.Dst)
    if (-not (Test-Path -LiteralPath $srcRoot)) { throw "repo asset source missing: $srcRoot" }
    $srcFiles = @(Get-ChildItem -LiteralPath $srcRoot -Recurse -File |
        Where-Object { -not (Test-Excluded ($_.FullName.Substring($srcRoot.Length + 1))) })
    $missing = @(); $drifted = @(); $checked = 0
    foreach ($f in $srcFiles) {
        $rel = $f.FullName.Substring($srcRoot.Length + 1)
        $installed = Join-Path $dstRoot $rel
        if (-not (Test-Path -LiteralPath $installed)) { $missing += $rel; continue }
        $srcHash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
        $dstHash = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
        $checked++
        if ($srcHash -ne $dstHash) { $drifted += $rel }
    }
    $dstFiles = @(Get-ChildItem -LiteralPath $dstRoot -Recurse -File |
        Where-Object { -not (Test-Excluded ($_.FullName.Substring($dstRoot.Length + 1))) })
    $extra = @($dstFiles | Where-Object {
            $rel = $_.FullName.Substring($dstRoot.Length + 1)
            -not (Test-Path -LiteralPath (Join-Path $srcRoot $rel))
        } | ForEach-Object { $_.FullName.Substring($dstRoot.Length + 1) })
    $problems = @()
    if ($missing.Count) { $problems += "missing=$($missing.Count)[$($missing | Select-Object -First 3 -join ',')]" }
    if ($drifted.Count) { $problems += "drifted=$($drifted.Count)[$($drifted | Select-Object -First 3 -join ',')]" }
    if ($extra.Count) { $problems += "extra=$($extra.Count)[$($extra | Select-Object -First 3 -join ',')]" }
    $ok = ($missing.Count + $drifted.Count + $extra.Count) -eq 0
    Check "assets.parity:$($map.Dst)" "byte parity with repo ($checked files hashed)" $ok `
        ($(if ($ok) { "$checked files identical" } else { $problems -join '; ' }))
}

# ── Report ───────────────────────────────────────────────────────────────────
if ($Json) {
    $report = [ordered]@{
        install = $install
        dataRoot = $data
        passed = $pass.Count
        failed = $fail.Count
        # pscustomobject, not OrderedDictionary: ConvertTo-Json's dictionary
        # serialization has been observed flipping member order across runs
        # when dictionaries sit inside arrays — pscustomobject property
        # order is stable. Pinned by test-audit-idempotency.ps1.
        checks = @($pass + $fail) | ForEach-Object { [pscustomobject]$_ }
    }
    [Console]::Out.WriteLine(($report | ConvertTo-Json -Depth 5))
} else {
    Write-Output ""
    if ($fail.Count -eq 0) {
        Write-Output "=== asset audit: all $($pass.Count) checks passed ==="
    } else {
        Write-Output "=== asset audit: $($fail.Count) FAILED, $($pass.Count) passed ==="
    }
}
if ($fail.Count -gt 0) { exit 1 }
