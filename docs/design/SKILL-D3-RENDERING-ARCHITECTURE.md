# Scientific Figure Architecture

Status: accepted and implemented for the runtime figure path.

## Problem

TDEase must turn scientific artifacts into figures without creating a second
source of scientific truth, depending on a developer checkout, or delivering an
HTML file that built successfully but fails when opened.

Success means:

- the plotted values remain traceable to a source artifact;
- one shipped compiler owns reusable figure rendering;
- every output opens offline and fails visibly when invalid;
- the complete runtime path is acceptance-tested in a browser.

## Ground Truths

1. A figure presents derived values; it does not own chemistry or statistics.
2. The exact plotted data must travel with the figure.
3. Product Skills can depend only on shipped System Skills, not `.agents/skills`.
4. Compilation success is insufficient; the browser-rendered result is the output.
5. Provenance and errors must remain visible to both the user and the Agent.

## Architecture

```text
source artifact
  -> domain skill adapter / template gen-data.py
       owns parsing, derivation, assertions, source identity
  -> {data, meta} JSON contract
  -> chart-forge build.py
       validates example/build.json and compiles vendored assets
  -> self-contained HTML + one manifest
  -> Chromium acceptance gate
       page errors, external requests, readiness, bounds, export
  -> optional PNG/SVG
```

`tdease-ai-capability/system/skills/chart-forge/` is the runtime authority.
Its shipped examples are maintained template packages, not a loose gallery.
Every package has `chart.js`, representative `data.json`, and `build.json`.

The only renderer exception is 3Dmol for molecular structure. It still uses the
same contract, compiler, offline-output, and browser-gate path.

## Ownership

| Layer | Owns | Must not own |
|---|---|---|
| Domain adapter | parsing, chemistry/statistics, assertions, rich provenance | visual layout |
| Contract | exact chart-ready values and interpretation metadata | hidden source reconstruction |
| Template | scales, marks, labels, interaction | scientific inference |
| Compiler | dependency resolution, safe injection, offline assembly, generic manifest | data repair |
| Browser gate | runtime errors, readiness, concrete graphic, export | scientific acceptance |

Domain adapters that need a richer scientific manifest call the compiler with
`--no-manifest` and write one authoritative sidecar. Direct chart-forge builds
receive the compiler's generic manifest. Two manifests never compete.

## Failure Contract

Compiler and browser failure behavior is the runtime contract in
`tdease-ai-capability/system/skills/chart-forge/references/engineering-contract.md`.
Architecturally, invalid input or presentation must fail where the Agent can see
it; no layer guesses a replacement or downgrades an explicit export failure.

## Extension Rule

A new reusable figure enters through one template package. Domain-specific
derivation stays in its producing skill; generic visual mechanics may be promoted
to a component only after a second real consumer exists. The operational addition
gate lives in the chart-forge engineering contract.

## Alternatives considered

- **Independent matplotlib/Plotly renderers in each runtime Skill.** Rejected for
  interactive runtime figures because dependencies, tokens, export behavior, and
  error handling diverged. Frozen paper-only plotting remains outside this path.
- **Use `.agents/skills/chart-forge` as the full fallback gallery.** Rejected because
  it is not a deployed Skill root and makes runtime behavior depend on a developer
  checkout.
- **Accept arbitrary JSON and infer its shape.** Rejected because silent wrapping
  hides adapter defects and makes provenance and template compatibility ambiguous.
- **Treat build completion as acceptance.** Rejected because missing providers and
  runtime JavaScript failures can still produce a plausible HTML file.
