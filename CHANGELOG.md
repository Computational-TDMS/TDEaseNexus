# Changelog

All notable changes to TDEaseNexus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the
desktop artifact versions (`TDEase-FrontEnd/package.json`).

## [Unreleased]

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
  auth), Rust kernel `tdeasenexus-toolbox` 0.1.0 (22 subcommands, evidence
  lattice `mass ⊂ composition ⊂ identity`), and the 16-skill scientific library
  (open search census, TDP-Copilot, IsoForma, TopPICR-based quantification,
  spectral/structure evidence, chart-forge, PTM database).

[Unreleased]: https://github.com/Computational-TDMS/TDEaseNexus/compare/0.9.0-beta...HEAD
[0.10.0-beta]: https://github.com/Computational-TDMS/TDEaseNexus/compare/0.9.0-beta...HEAD
[0.9.0-beta]: https://github.com/Computational-TDMS/TDEaseNexus/releases/tag/0.9.0-beta
