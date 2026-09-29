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
