<p align="center">
  <img src="assets/logo.png" width="128" alt="TDEaseNexus logo">
</p>

<h1 align="center">TDEaseNexus</h1>

<p align="center"><em>AI-first desktop workbench for top-down mass spectrometry.</em></p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.11.0--beta-orange">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey">
  <img alt="license" src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue">
</p>

State a proteoform analysis goal on the Agent page. The agent picks a workflow
template, runs the native pipeline (MSConvert → TopFD → TopPIC), supervises
execution, and keeps every intermediate result stored, re-readable, and
cross-checkable.

## Install

**[Download the latest release ↗](https://github.com/Computational-TDMS/TDEaseNexus-Releases/releases/latest)** —
Windows x64 (NSIS, per-user). A Linux AppImage can be built from source with
`scripts/release/build-desktop-linux.sh`.

The installer bundles the compute-node catalog (TopPIC, MSConvert,
Informed-Proteomics, TopIndex, PRIDE); the first launch unpacks it and builds the
backend Python environment, which takes a few minutes. No model provider key ships
with the app — add your own under **Settings → Model providers**; keys are stored
encrypted locally.

## Build from source

Requires Node ≥24.12 + pnpm 10, Python ≥3.11 with [uv](https://docs.astral.sh/uv/),
and Rust ≥1.97.

```bash
git clone --recurse-submodules https://github.com/Computational-TDMS/TDEaseNexus.git
cd TDEaseNexus/TDEase-FrontEnd
pnpm install
pnpm desktop:dev      # Electron + Vite dev loop
pnpm build            # typecheck + gates + production build
pnpm test:run         # unit tests

cd ../tdease-backend && uv sync
cd .. && uv run --project tdease-backend pytest tests/   # root contract/E2E suite
cd tdease-ai-capability/rust && cargo test               # Rust kernel
```

Both submodules are required. If you cloned without `--recurse-submodules`, run
`git submodule update --init --recursive`.

## Architecture

```text
TDEase-FrontEnd ──→ tdease-backend ──→ tdease-ai-capability
        └────────────────────────────────────────────↗
```

- **Desktop** (`TDEase-FrontEnd/`) — Electron shell + Vue 3 UI. Owns the agent
  experience, visualization, permissions, and process supervision.
- **Backend** (`tdease-backend/`, submodule) — Python/FastAPI. Owns Run lifecycle,
  Snakemake execution, storage, and server policy.
- **Scientific system** (`tdease-ai-capability/`, submodule) — Rust
  `tdeasenexus-toolbox` CLI, skills, prompts, and reference data.

## Documentation

| Topic | Document |
|---|---|
| What works today | [docs/STATUS.md](docs/STATUS.md) |
| Run lifecycle and HTTP API | [docs/spec/WORKFLOW-RUN.md](docs/spec/WORKFLOW-RUN.md) |
| Agent tools and permissions | [docs/spec/AGENT-CONTRACT.md](docs/spec/AGENT-CONTRACT.md) |
| Architecture and failure model | [docs/design/CORE-ARCHITECTURE.md](docs/design/CORE-ARCHITECTURE.md) |
| Release history | [CHANGELOG.md](CHANGELOG.md) |

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Citation metadata in
[CITATION.cff](CITATION.cff); contribution rules in [CONTRIBUTING.md](CONTRIBUTING.md).
