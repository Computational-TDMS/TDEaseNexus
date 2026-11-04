# Changelog

All notable changes to TDEaseNexus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the
desktop artifact versions (`TDEase-FrontEnd/package.json`).

## [Unreleased]

## [0.11.0-beta]

### Added

- **Agent conversation render rework**: one ordered render walk (`fold-items.ts`
  + `ContentBlockView.vue`) — text interleaves in place between per-run collapse
  panels; `TaskTreeCard` is the turn's plan block.
- **Side chat**: a selection-flow child conversation in the Agent page's right
  rail (`agent-side-chat` tab).
- **Export media embedding**: `/export` inlines workspace-cited images and HTML
  reports as data URIs (12 MB/file, 64 MB total, sandboxed iframes).
- **Resizable Agent rail**: the right tab host drags between 280–520 px,
  persisted per workspace.

### Changed

- Node binaries bind by `config["nodes"]` absolute-path injection; the Run
  directory no longer carries node content; unbound nodes fail closed at parse
  time with a named error (msconvert host-PATH probe removed).

### Docs

- Spec/distill pass: CLI invocation contract into `RUST-MS-CONTRACT`, skill
  sandbox environment into `AGENT-CONTRACT` §5.1, subagent roles/result envelope
  into §5.2, configuration ownership into `FILE-LAYOUT` §8; stale narrative
  archived (`archive/docs-prune-2026-10-12/`).

## [0.10.0-beta] — 2026-09-29

### Added

- **Agent transparency**: task-tree cards, `view.*` viewports, and native
  mass-shift ledger / MS2 discrimination surfaces
  (`664e9ac`).

### Fixed

- Subagent tool narrowing gains the `viewTools` slot: untested `view.*`
  commands are hard-excluded from the agent's visible tool surface
  (`966f5fc`).

## [0.9.0-beta] — 2026-09-29

### Added

- Initial public release baseline (`ff0434b`): AI-first TD-MS desktop workbench —
  Electron + Vue 3 desktop with the two-mode agent runtime (Explorer/Executor,
  two-tier permissions), FastAPI backend 0.2.0 with the Snakemake 9.23.1
  workflow engine (MSConvert/TopFD/TopPIC node packages, per-launch bearer
  auth), Rust kernel `tdeasenexus-toolbox` 0.1.0 (23 subcommands, evidence
  lattice `mass ⊂ composition ⊂ identity`), and the 16-skill scientific library
  (open search census, TDP-Copilot, IsoForma, TopPICR-based quantification,
  spectral/structure evidence, chart-forge, PTM database).

[Unreleased]: https://github.com/Computational-TDMS/TDEaseNexus/compare/0.9.0-beta...HEAD
[0.10.0-beta]: https://github.com/Computational-TDMS/TDEaseNexus/compare/0.9.0-beta...HEAD
[0.9.0-beta]: https://github.com/Computational-TDMS/TDEaseNexus/releases/tag/0.9.0-beta
