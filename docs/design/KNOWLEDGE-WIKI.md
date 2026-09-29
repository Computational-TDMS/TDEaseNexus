---
type: design
title: KNOWLEDGE-WIKI
description: The lab wiki — plain markdown in two scopes (system + workspace), co-written by human and Agent, wikilinked, with no dedicated tool surface.
status: implemented
---

# KNOWLEDGE-WIKI

> Status: implemented (2026-08-31), superseding `KNOWLEDGE-WIKI-OKF.md`
> (git history retains the OKF design). One-liner: **the wiki is plain files;
> the Agent reaches it with the ordinary file tools; governance is prompt
> policy, not machinery.**

## 1. What the wiki is

A knowledge base the user and the Agent co-write. Two scopes, both plain
markdown files on disk:

| Scope | Root | Holds |
|---|---|---|
| **workspace** | `<workspace>/wiki/` | Case-specific working knowledge: what this sample, Run, or instrument state showed. Evidence-linked facts while the case is alive. |
| **system** | `<System>/wiki/` | The archive: knowledge that outlives one workspace — instrument notes, method recipes, pitfalls with bounds, reference facts. Must stay free of case-specific detail. |

A workspace conclusion that generalizes is distilled into the system wiki
(generalized, run names and sample ids stripped); the case-specific version
stays in the workspace wiki. Nothing moves automatically — distillation is a
deliberate writing act by either party.

## 2. No dedicated tool surface

The former `wiki.*` command family (list/search/read/propose/accept/lint),
the FTS5 index and the propose/accept machinery were removed. The Agent reads
wiki pages with `read`/`grep` and writes them with `write`/`edit` — the same
tools, the same permission actions (`workspace.read` / `workspace.write`),
the same approval UX as every other file.

The one boundary change that makes this work: the permission gateway
(`electron/agent/permission-gateway.ts`) resolves the virtual prefix
**`system-wiki/`** onto `<System>/wiki/` with the identical realpath-checked
containment used for workspace paths. It is a virtual namespace (like the
renderer's `run-files/`): it never resolves inside the workspace, even if a
directory of that name exists there. Reads and writes are both permitted
through the prefix, gated by the same two permission actions. `bash` keeps
its workspace-only cwd containment — file tools are the wiki access path.

Explorer-mindset sessions read both scopes (read tools are always present);
writing stays an executor capability, consistent with the existing
write/edit gating.

## 3. Page format

Markdown, hand-editable and diffable, no YAML parser:

```markdown
---
title: TopFD
kind: method
updated: 2026-08-31
tags: [topfd, deconvolution]
---

Body. One concept per page.
```

The front matter is tolerated, not enforced: the UI parses it for display
(title/tags/status), a page without one still renders and lists (title falls
back to the first `#` heading, then the filename). There is no status
vocabulary and no mandatory sections in code — what a page *should* carry is
prompt policy (`system/prompts/internal/wiki_policy.md`): a claim states its
bounds next to the claim; system pages stay generalizable.

A page may also be **`.txt`**: plain text, listed/editable/linkable-to like
any page, but shown verbatim — no markdown rendering, no front matter, and
its content is never parsed as link sources. The type tokens carry every
size in the wiki surfaces, so the user font scale (`--font-scale`) applies
everywhere including the CodeMirror editor.

## 4. Wikilinks

Obsidian's documented syntax, our own resolution:

- `[[Target]]`, `[[Target|label]]`, `[[Target#heading]]`.
- `![[Target]]` embeds a Workspace file by its type (media renders inline; `.md`/`.txt`
  stay links). Workspace file references are syntax-agnostic — both `[[path]]` and
  `![[path]]` resolve to something clickable, never literal text.
- A bare target resolves by **file name** (`.md` optional, case-insensitive):
  linking scope first, then the other scope, then the shortest path. A target
  whose first segment is `system/` or `workspace/` is pinned to that scope.
- Rendering: a small markdown-it inline rule (`src/utils/markdown.ts`) emits
  an inert `<a class="wikilink" data-wikilink-target=...>`; the wiki document
  resolves on click and adds `wikilink-unresolved` for dead targets. The
  sanitizer allowlist carries the class names and the two data attributes.
- Backlinks are computed by a straight scan of both scopes — no derived index
  to rebuild or go stale.
- In the editor, `[[...]]` spans are highlighted by a CodeMirror decoration.

A dead link opens the page document in its create flow; saving the new page
resolves every link that pointed at it.

## 5. UI surfaces

- **`wiki` document** — one page per tab: rendered view (`MarkdownContent`
  over the existing markdown-it pipeline), raw-text edit (CodeMirror 6, the
  Client's one rich editor), front-matter chips, backlinks section,
  Ctrl/Cmd+S save with the standard dirty-tab guard.
- **`wiki-index` document** — both scopes listed and searched (straight
  substring scan over title/tags/body), create control.
- **Navigator Wiki section** — flat lists of both scopes; every entrance
  routes through `documentsStore.openWiki`, and `openWorkspaceFile` role-
  dispatches `wiki/**.md` to the wiki document.
- System scope requires the desktop bridge (`systemData` IPC, existing);
  in a browser dev session the system scope is absent and the workspace wiki
  still works.

## 6. Agent prompt policy

`prompts/internal/wiki_policy.md` (assembled into every session, both
mindsets) declares only what cannot be discovered at runtime: the two
locations, the `system-wiki/` prefix, what the wiki accumulates —
**experience** (strategy, judgment rules, pitfalls with bounds), not case
findings — and one pointer: durable conversion runs through the `evolution`
skill. Slimmed 2026-09-04; the page conventions (naming, front matter,
wikilinks, extend-don't-fork, bounds-next-to-claims) moved into
`evolution/SKILL.md`, which is the single conversion gate with its own
evidence grading (`confirmed` ≥2 reproductions; `single-scan` stays
case-local; `hypothesis` never lands). The workspace `wiki/` is alive-case
scratch, not accumulation. The knowledge-quality surface is now evolution's
evidence gate plus the human reading the wiki directly.

## Alternatives considered

- **Keep the OKF tool surface (propose/accept, FTS5 search, type/subject
  schemas)** — lost: it duplicated the permission system's job (a parallel
  write gate, a parallel search index, a parallel action `knowledge.write`),
  was UI-less (accept existed only as a tool call), and defaulted off, so it
  almost never entered a session's context. Governance moved to prompt
  policy + the human reading the wiki directly.
- **Copy Obsidian's implementation** — lost: proprietary code; only the link
  syntax was worth taking (documented behavior), and the editor底座 choice
  lands on the same CodeMirror 6 Obsidian uses anyway.
- **Adopt a markdown-it wikilink package** — lost: the grammar is a ~40-line
  inline rule, and every package would still need custom scope-resolution
  wiring; owning the rule keeps parser, sanitizer and editor highlighting in
  one vocabulary.
- **Give the Agent a dedicated write channel into the System root** — lost:
  the `system-wiki/` prefix inside the existing gateway reuses containment,
  freezing and approval flow; a separate channel would be a second boundary
  to secure.
