# Contributing to TDEaseNexus

## Read first

1. [AGENTS.md](AGENTS.md) — the binding development rules, architecture
   mental model and the command cheat-sheet.
2. [docs/README.md](docs/README.md) — which document owns which fact.

## The rules that matter most

- **Development happens on `main`** — no feature branches.
- **End-to-end evidence beats unit tests.** The root contract/E2E suite is the
  core; do not pile up unit tests, and do not add test ceremony.
- **When code contradicts a tier 2–4 doc**, either the doc is stale (fix it) or
  the code is defective — record which in `docs/STATUS.md`; never leave the
  conflict unresolved.
- **No speculative documents.** Code and tests are the deliverable; documentation
  is written on demand.

## Test suites (the quality bar)

| Suite | Command |
|---|---|
| Frontend unit | `pnpm test:run` (in `TDEase-FrontEnd/`) |
| Desktop E2E (real Electron + real Backend) | `pnpm test:e2e:desktop` |
| Backend | `uv run pytest` (in `tdease-backend/`) |
| Root contract/E2E | `PYTHONPATH=tdease-backend tdease-backend/.venv/Scripts/python.exe -m pytest tests/` |
| Rust kernel | `cargo test` (in `tdease-ai-capability/rust/`) |

Enable the zero-dependency pre-commit gate once per clone:
`git config core.hooksPath githooks`.

## Commits

Short, prefixed, factual — the existing history is the style guide:
`[feat] …`, `[fix] …`, `[chore] …`. The repository's three products live in
this repo and two submodules (`tdease-backend`, `tdease-ai-capability`);
commit inside the submodule first, then pin the new submodule commit here.

## License

By contributing you agree that your contributions are licensed under
GPL-3.0-or-later.
