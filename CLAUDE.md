# TDEase developer cheat-sheet

Development rules (binding, in Chinese): [`AGENTS.md`](AGENTS.md).
Documentation authority order and per-document ownership: [`docs/README.md`](docs/README.md).

## Mental model

Three products, one desktop app:

- **Desktop** (`TDEase-FrontEnd/`) — Electron shell + Vue3 UI. Owns the Agent
  experience, the Studio command surface (`tdease.*` tools), visualization,
  permissions and process supervision. `electron/` is the composition root.
- **Backend** (`tdease-backend/`, submodule) — Python/FastAPI. Owns Run
  lifecycle, execution, storage, server policy.
- **Scientific system** (`tdease-ai-capability/`, submodule) — Rust mass-spec
  kernel (`tdeasenexus-toolbox` CLI under `rust/`), plus `system/`: skills, internal
  prompts, templates, wiki assets.

Dependency direction: Desktop → Backend → Scientific system; Desktop may also
call the scientific system directly. `data/` is local runtime state simulating a
real install — development fixture, never a source of truth.

## Entry points by task

| Task | Read |
|---|---|
| What exists today | `docs/STATUS.md` |
| Backend HTTP / Run lifecycle | `docs/spec/WORKFLOW-RUN.md` |
| Agent tool surface / permissions | `docs/spec/AGENT-CONTRACT.md` |
| Event & failure model | `docs/design/CORE-ARCHITECTURE.md` |
| Frontend module boundary | `docs/design/STUDIO-FRONTEND-BUSINESS-LOGIC.md` |
| Rust `tdeasenexus-toolbox` CLI contract | `docs/design/tdeasenexus-toolbox-native-adapter.md` |

## Commands

```bash
# Frontend (in TDEase-FrontEnd/)
pnpm test:run     # vitest — the quality bar
pnpm build        # vue-tsc + electron typecheck + gates + vite build + contrast
pnpm lint         # eslint over src + electron (warnings tolerated, errors block)
pnpm test:e2e:desktop   # real Electron app vs real Backend (Playwright desktop)
pnpm test:e2e     # renderer surfaces in Chromium (Playwright)

# Backend (in tdease-backend/)
uv run pytest

# Root contract/E2E suite (repo root) — the conftest imports the backend's
# src/ package, so it runs under the backend venv with PYTHONPATH
PYTHONPATH=tdease-backend tdease-backend/.venv/Scripts/python.exe -m pytest tests/

# Rust kernel (in tdease-ai-capability/rust/)
cargo test

# One-time per clone — enable the pre-commit gate (node --check + eslint
# on staged files; zero dependencies, plan: docs/HARNESS-ENGINEERING-PLAN.md)
git config core.hooksPath githooks
```

Work happens on `main` directly — no branches. End-to-end evidence beats unit
tests; do not add test ceremony.
