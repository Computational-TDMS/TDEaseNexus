1. Develop entirely on main — no branches! AI development does not need branches!
2. End-to-end tests are the core. Otherwise you pile up unit tests while the code drifts off who-knows-where, and it all ends up as garbage! Never write too many tests!
3. When an error occurs, look outward: is there an extra garbage layer in the architecture? Don't patch — fix the robustness of the code. Otherwise maintenance gets even harder later!
4. Architecture design must absolutely hold to First Principles!
5. Go straight at the goal and the core requirement — take the shortest path instead of doing a pile of trivia!
6. Write no documents unless the user explicitly instructs it! No proactive edits to `STATUS.md`, `docs/`, or any `*.md` — no status snapshots, no change logs, no summaries, no "notes for future sessions". Code and tests are the deliverable; the user asks, only then you write.

## Documentation system (progressive disclosure)

Open documents on demand; do not read everything at once. The authoritative order is in [`docs/README.md`](docs/README.md).

- This file = iron rules of development (must not be violated)
- `docs/spec/` = accepted contracts; the single authority, must not be violated
- `docs/design/` = designs; parts may be unimplemented — status is governed by `docs/STATUS.md`
- `docs/STATUS.md` = what is currently implemented. It is a **snapshot, not a log**: rewrite it, never append process narrative. Logs (git history, archived process records under `archive/`, case RECORD files) record what happened; they are never a source of current truth. See `docs/README.md` § Status vs process records.
- `data/` holds the three-layer data folders, used during development to simulate real client installation and usage

When code conflicts with tier 2-4 docs: either the doc is stale and must be corrected, or the code is defective. Record which one it is in `STATUS.md` — never leave unresolved conflicts.

## Mental model (merged from the former CLAUDE.md)

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

### Entry points by task

| Task | Read |
|---|---|
| What exists today | `docs/STATUS.md` |
| Backend HTTP / Run lifecycle | `docs/spec/WORKFLOW-RUN.md` |
| Agent tool surface / permissions | `docs/spec/AGENT-CONTRACT.md` |
| Event & failure model | `docs/design/CORE-ARCHITECTURE.md` |
| Frontend module boundary | `docs/design/STUDIO-FRONTEND-BUSINESS-LOGIC.md` |
| Rust `tdeasenexus-toolbox` CLI contract | `docs/design/tdeasenexus-toolbox-native-adapter.md` |

### Commands

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
# src/ package, so it runs under the backend project env
uv run --project tdease-backend pytest tests/

# Rust kernel (in tdease-ai-capability/rust/)
cargo test

# One-time per clone — enable the pre-commit gate (node --check + eslint
# on staged files; zero dependencies, plan archived 2026-09-29)
git config core.hooksPath githooks
```

Work happens on `main` directly — no branches. End-to-end evidence beats unit
tests; do not add test ceremony.
