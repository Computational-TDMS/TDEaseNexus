# TDEaseNexus · TD通

AI-first top-down mass spectrometry (TD-MS) analysis desktop workbench. A researcher
states an analysis goal; the built-in agent selects templates and managed capabilities,
runs the native workflow (MSConvert → TopFD → TopPIC), supervises execution, and helps
inspect results — with every intermediate result stored, re-readable, and cross-checkable.

Calm, precise, forgiving: quiet during routine work, explicit when decisions or failures
need attention. It refuses to be a node-editor, a parameter-wizard maze, a card-grid
dashboard, or opaque AI.

**Status: `0.10.0-beta`** ([changelog](CHANGELOG.md)) · License: GPL-3.0-or-later

## Repository layout

Three independent products, one dependency direction:

```text
TDEaseNexus/
├─ TDEase-FrontEnd/        Desktop UI, Electron host, Agent experience (this repo)
├─ tdease-backend/         Submodule: Python/FastAPI service, Snakemake engine
├─ tdease-ai-capability/   Submodule: Rust scientific kernel + domain Skills + prompts
├─ data/                   Local development runtime data (simulated client install)
├─ docs/                   Product contracts (spec/), designs, current status
└─ tests/                  Root contract/E2E suite (backend + skills)
```

```text
Desktop -> Backend -> Scientific System
Desktop ------------> Scientific System
```

- Desktop owns UX, sessions, permissions, visualization, process supervision.
- Backend owns Run lifecycle, execution, storage, synchronization, server policy.
- Scientific System owns Skills, scientific assets, and Rust computation
  (`tdeasenexus-toolbox`).

## Install

End users: download the Windows installer from
[GitHub Releases](https://github.com/Computational-TDMS/TDEaseNexus/releases). The
installer bundles the Python runtime and fetches third-party workflow binaries
(TopPIC Suite, ProteoWizard, Informed-Proteomics) on demand.

Development:

```bash
git clone --recurse-submodules https://github.com/Computational-TDMS/TDEaseNexus.git
cd TDEaseNexus

# prerequisites: Node >= 24.12 <25 + pnpm, Python 3.11+ + uv, Rust toolchain

# Frontend (TDEase-FrontEnd/)
pnpm install
pnpm dev            # vite dev server
pnpm build          # typecheck + gates + production build

# Backend (tdease-backend/)
uv sync

# Root contract/E2E suite (repo root; run under the backend venv)
PYTHONPATH=tdease-backend tdease-backend/.venv/Scripts/python.exe -m pytest tests/

# Rust kernel (tdease-ai-capability/rust/)
cargo test

# one-time: enable the zero-dependency pre-commit gate
git config core.hooksPath githooks
```

## Documentation

Authoritative order lives in [docs/README.md](docs/README.md): iron rules
([AGENTS.md](AGENTS.md)) → accepted contracts (`docs/spec/`) → designs (`docs/design/`)
→ [docs/STATUS.md](docs/STATUS.md) (what is implemented today). Agent tool surface:
`docs/spec/AGENT-CONTRACT.md`; Run lifecycle: `docs/spec/WORKFLOW-RUN.md`; Rust CLI
contract: `docs/spec/RUST-MS-CONTRACT.md`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: development happens on `main`,
end-to-end evidence beats unit tests, and documentation is written only when asked for.

## Citing

If you use TDEaseNexus, please cite this repository (see
[CITATION.cff](CITATION.cff)) and the companion manuscript. Versioned software DOI
(Zenodo–GitHub integration) and data-repository DOIs (frozen reproduction package and
certified agent-session trajectories) will be added here upon deposit.

## License

Licensed under the [GNU General Public License v3.0](LICENSE) or later
(GPL-3.0-or-later), matching all three repositories.
