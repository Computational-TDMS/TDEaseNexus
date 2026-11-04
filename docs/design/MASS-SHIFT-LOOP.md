# Mass-Shift Assignment Methodology: One LOOP, Everything in Its Place

> Status: current controller design below; the earlier batch-pipeline proposal is
> retained separately as historical design, not executable workflow or current status.

## Current investigation ownership

`tdp-copilot` owns the scientific loop: anchor scope -> construct complete/open
hypotheses -> measure and present evidence -> interpret -> continue or finish.
`tdp-opensearch` supplies a bounded, source-linked attention set, and
`spectral-evidence` supplies symmetric measurements and standard evidence figures.
A discovery step ending does not end an authorized investigation: Copilot advances
the selected groups without a routine tool-selection question. An explicitly
batch-only request ends with the discovery report. Selection never assigns chemistry.

Each rule has one operational owner: workflow/completion in the Copilot entrypoint;
model inheritance in its model-continuity reference; measurement gates in Spectral
Evidence; commands in tool recipes; figure mapping in the visualization reference;
inline presentation and language in session prompts; report layout in the summary
template. Scientific honesty remains the shared claim boundary. References are read
at the relevant action boundary rather than preloaded as a second workflow.

The completion condition is a measured requested comparison or a named evidence
limit, not chemical certainty. Available useful measurements run before declaring
that limit. Every standard evidence figure is presented with its interpretation;
rendering failure is distinct from measurement failure. Only the human assigns the
final chemistry verdict. Current implementation and validation are in `STATUS.md`.

## Historical batch-pipeline proposal (archived)

The original 2026-08-20/21 methodology — the L1–L10 funnel, the LOOP cycle,
routing rules, natural flow and the three discrimination archetypes — is
archived at
`archive/docs-prune-2026-10-12/docs/design/MASS-SHIFT-LOOP-archived-proposal.md`.
It is retained as historical design: not an executable workflow, not current
status. The operational instructions there are superseded by the ownership
section above and the shipped `tdp-*`/`spectral-evidence` Skills.

## Alternatives considered

- **Add stronger copies of the same rule to every Skill and prompt**: rejected
  because contradictory stop conditions and repeated constraints obscure the next
  action. Keep one rule owner and route to its details at the action boundary.
- **Always ask the user to choose a discovery candidate before measuring**: retained
  only for a discovery-only request or a genuine scope decision; it needlessly stops
  a Run-wide investigation whose bounded attention set is already authorized.

- **Write a dedicated deep-dive script per case**: fails the atomicity principle —
  cases only multiply, dedicated branches add a maintenance surface per case, and they
  cannot be reused by the Agent as a generic capability.
- **Split hypothesis generation into a peer Skill beside measurement**: rejected
  because proposing and expanding hypotheses is the controller's central reasoning
  loop, and a database lookup may answer the immediate question without a second
  workflow. Only spectral measurement is split out as a bounded subskill.
- **Mass-closed-equals-assignment (the mass_closed fast path)**: fails on defects
  exposed in real runs — closure proves conservation, not localization; the path was
  deleted (EXPLORATION-LOG E7).
- **Use TopPIC proteoform grouping for near-neighbor merging**: fails on verified fact
  — TopPIC groups proteoforms by a single shift value, with no near-neighbor
  semantics; merging belongs to the cluster-layer ledger.
- **Write case names into the process/prompts**: acceptance criteria are not a method.
  The process describes only evidence shapes and discrimination methods, referencing
  no concrete case.
