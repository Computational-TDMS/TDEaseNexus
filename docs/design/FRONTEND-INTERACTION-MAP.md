# Frontend Interaction Map

> **Document position**: describes the current, implemented state of frontend interactions (buttons, states, shortcuts, animations).
> **Not a spec** (it does not constrain the future) — a design reference: a single entry point of "where to click, what happens, and why" for you, newcomers, and reviewers.
> **Authoritative source**: when this document conflicts with the code, the code is right; this document records the conflict and notes it in `STATUS.md`.
> Rewritten 2026-09-04 against the post-simplification shell (2026-09-01) and the
> 2026-08-16 turn-phase vocabulary. Superseded text (TitleBar/ActivityRail, the
> AgentInspector/AgentDock era, the three-tab Navigator) is git history, not kept here.

---

## Table of contents

- [1. Global shell](#1-global-shell)
- [2. Agent page](#2-agent-page)
- [3. Input and autocompletion](#3-input-and-autocompletion)
- [4. Tool calls / thinking / permission rendering](#4-tool-calls--thinking--permission-rendering)
- [5. Session management](#5-session-management)
- [6. Right-rail surfaces (tabs, capsule, subagents, jobs)](#6-right-rail-surfaces-tabs-capsule-subagents-jobs)
- [7. Workbench and documents](#7-workbench-and-documents)
- [8. Global shortcut summary](#8-global-shortcut-summary)
- [9. Status vocabulary](#9-status-vocabulary)
- [10. Animation / transitions / reduced motion](#10-animation--transitions--reduced-motion)
- [11. Accessibility (a11y) status](#11-accessibility-a11y-status)

---

## 1. Global shell

**Components**: `workbench/AppShell.vue` · `workbench/SideBar.vue` ·
`workbench/PageHandle.vue` · `workbench/WorkbenchPage.vue` · `workbench/StatusBar.vue`

The app is a two-page shell: `workbench` (runs/wiki/files/documents) and
`agent` (conversation), shown by one sliding two-slot track. The **page
handle** (`PageHandle.vue`) is the ONE page control and it FOLLOWS the Agent
window: it hangs on the RIGHT window edge while the Agent is the Workbench's
right-docked sidebar, and on the LEFT edge on the full Agent page. A tap
animates the slide; dragging pulls the track 1:1 (release past the midpoint
or with a flick commits; otherwise it springs back). Both pages stay mounted
(`v-show` slots). The Workbench page is
Navigator | (editor group tree over a movable panel | Agent sidebar).

### 1.1 SideBar, page handle and workbench docks

| Element | Interaction | Behavior |
|---|---|---|
| Workspace button (rail top) | click | opens the workspace switcher (refresh / switch / forget / open folder) |
| Settings / density / language / theme (rail bottom) | click | Settings modal (the page slides back to Workbench first), density toggle, `zh-CN`/`en-US`, four themes |
| Page handle | click | slides the track to the other page; the handle hangs on the edge facing the Agent (right on Workbench, left on Agent) |
| Page handle | drag | pulls the track 1:1; release past the midpoint — or with a flick — commits, otherwise it springs back; the handle leans into the pull (≤6px) |
| Navigator / Agent-sidebar / panel sashes | drag / double-click / arrows | resize with clamped bounds; `data-sash-state` dims the bar at a bound and the cursor names the only live direction; a dock dragged past `min − min/2` snaps closed (drag back past `min/2` re-opens); double-click resets; Alt drags at half rate. Dock size memory (durable proportion + live px) lives in the `dockLayout` module — `stores/dockLayout.ts`, composed by uiLayout |
| Panel header (Runs/Logs dock) | click | position (bottom↔right), maximize over the center, close |
| Agent-sidebar toggle (editor group header actions) | click | expands/collapses the Workbench's right-docked Agent sidebar (the directional-split buttons are gone — tab drag to an edge splits, `Ctrl+\` clones; drop zones follow VS Code: the body's inner 80% merges, the outer 10% ring splits by the preferred-axis thirds, `Alt` forces merge, `Ctrl` copies) |
| Editor group tree (DocumentHost) | split / drag / close | a recursive binary layout tree (`stores/editorLayout.ts` — the pure tree module; `documents` store owns the reactive root); no tab-count ceiling — tabs shrink to their floor and the strip scrolls |
| New session (Agent sidebar header) | click | starts a fresh session in the shared conversation |
| Agent sidebar (right-docked) | toggle / drag | the Workbench's right-docked Agent view (240–440px, closed by default, resizable like any dock). It is a second VIEW of the SAME conversation: one shared singleton (`agentConversation.ts`) — one turn runtime, one composer draft, one slash registry — so both views always agree. It has a live composer and no upload UI, and its header carries a single 新会话 action; the approval dock stays on the full Agent page (the sidebar shows a pull-the-door strip instead) |

### 1.2 StatusBar (bottom bar)

| Element | Interaction | Behavior |
|---|---|---|
| Brand wordmark (left edge) | read-only | the fixed `TDEaseNexus` wordmark — product identity on every screen |
| Backend status text | read-only | seven states: `online` / `degraded` / `upgrading` / `reconnecting` / `incompatible` / `offline` / `disabled` |
| Reconnect button | click | `connectBackend()`; disabled + spinning icon while connecting |
| Runs / Logs toggles (right side) | click | panel-toggle convention: opens the panel on that tab; clicking the active toggle again closes it. The Runs toggle carries a live running-count badge (`runsStore.runningCount`) |

The toggles are fixed chrome, never floating reopen buttons; a closed panel
leaves no slab (the split bounds open to zero).

### 1.3 Layout keys (font zoom, panel, splits)

- `Ctrl+=` / `Ctrl+-` / `Ctrl+0` → zoom in / out / reset. Deliberately **not** guarded
  against typing targets (browser convention: zoom always works). A `role="status"`
  percentage-readout pill appears bottom-center and fades after ~1s.
- Workbench-page scope: `Ctrl+B` toggles the Navigator, `Ctrl+J` the panel,
  `Ctrl+Alt+B` the Agent sidebar, `Ctrl+Shift+J` maximizes/restores the panel.
- `Ctrl+\` clones the active Workbench document into a second editor group
  (`documentsStore.splitEditor('horizontal')`) — see §7.3.

### 1.4 CommandPalette (`Ctrl+K`)

Global toggle; see §7.6 for the in-palette keys.

---

## 2. Agent page

**Components**: `agent/AgentPage.vue` · `agent/SessionList.vue` · `agent/SessionBar.vue` ·
`agent/Transcript.vue` · `agent/ActivityCapsule.vue` · `agent/ProcessFold.vue` ·
`agent/TaskTreeCard.vue` · `agent/MindsetHero.vue` · `agent/PermissionCardDock.vue` ·
`agent/Composer.vue`

The Agent is a **full page** (the 2026-09-01 simplification removed the Workbench's
right Agent/inspector column). Layout:

```text
edge indicator (2px, page left)
ResizableSplit ── SessionList (left column)
              └─ conversation row
                   ├─ conversation column: SessionBar → Transcript → composer anchor
                   │     (PermissionCardDock floats above the Composer inside the anchor)
                   └─ right rail: ResizableSplit (280–520, persisted agentTabsWidth)
                        └─ SubagentPanel | JobPanel | AgentTabHost
                   ActivityCapsule (sibling below the split, default surface)
```

A 2px **edge indicator** on the page's left expresses turn state — the single global
signal that "the Agent is moving".

**MindsetHero** (`agent/MindsetHero.vue`, inside `EmptyState.vue`) is the empty
conversation's centerpiece: the mindset emblem as the identity of the resting surface —
a trident (workflow: one source fanning into three parallel tines) or a scanning glass
(analysis), crossfading on a mindset flip. Pure decoration (`aria-hidden`,
`pointer-events: none`); `prefers-reduced-motion` freezes it into the static mark.

### 2.1 Edge indicator (the left 2px vertical bar)

Five states; "stillness is the design" — `suspended` freezes at the current gradient
position without animating, which is exactly what makes it read as "waiting for you"
rather than "still running":

| State | Visual |
|---|---|
| `idle` | transparent |
| `acting` | gradient flowing up and down, 2.4s loop |
| `suspended` | warning-colored gradient segment fixed at some position (**no animation**) |
| `halted` | static muted color |
| `failed` | static danger color |

- Under `prefers-reduced-motion`, `acting` becomes a static solid primary bar (the color
  signal kept, the animation removed).

### 2.2 SessionBar (session title bar)

| Element | Interaction | Behavior |
|---|---|---|
| Title button (current session name) | click | expands/collapses the session dropdown menu (`aria-expanded` + `aria-haspopup`) |
| Model pill | click | opens the cascading `ModelPickerMenu` popover: current provider/model pair on top, then one row per **configured** provider (the store's single `isProviderConfigured` rule — no-key providers never offer models that cannot bind), each expanding a left flyout of that provider's merged model list (curated + frozen + discovered); a pick writes the pair atomically via `setModelFor`. Footer: 运行设置 (opens the `agent-settings` drawer) and 管理模型 (opens Settings → Providers). Shows the active `provider/model` string and a pressed state while the menu is open |
| SessionList inside the dropdown | see §5 | switch / new / fork |

### 2.3 Transcript (the conversation scroll body)

| Element | Interaction | Behavior |
|---|---|---|
| User bubble | hover | a copy button appears at the bottom-right corner (`opacity 0.6`) |
| Copy button | click | `navigator.clipboard.writeText`; turns green for 1400ms on success |
| Bottom "jump to bottom" pill | click (appears only when scrolled >80px) | smooth-scrolls to the bottom |
| "Jump to reply" pill | click (appears only after the turn ends and the user has scrolled away) | scrolls to that assistant message; auto-disappears after 8s |
| TaskTreeCard | see §2.5 | sequenced **in the message flow** as the turn's `bubble-plan` block (the todo tree whose branches are the produced runs/subagents/jobs/files) |
| Compaction divider | read-only | a quiet "context compacted" rule with the run's own token delta (`context.compacted` event, AGENT-EVENTS §2); while a manual `/compact` is summarizing, a live "compacting" divider (working dots) sits at the tail and hard-swaps into the settled marker when the event lands |

- The copy button gets 0.6 opacity via `.transcript__user-bubble:focus-within`, keeping
  it keyboard-reachable.
- There is an `aria-hidden` fade mask at the top and bottom each, appearing only when
  content overflows.

### 2.4 The turn status line (ActivityCapsule HUD)

While a turn runs, the HUD renders `phase · act N · calls · elapsed/deadline · [Stop]`,
derived per AGENT-LOOP.md §7:

| Phase | Meaning |
|---|---|
| `waiting` | provider boundary — turn live, no first token yet |
| `thinking` | reasoning deltas arriving |
| `responding` | text deltas arriving |
| `executing` | a tool call in flight; `activity` names which tool |

- Elapsed turns warning at 80% of the deadline; during `suspended` it reads
  "waiting for you" (§6 of AGENT-LOOP — the clock pauses for the user).
- The HUD is purely presentational over the runtime state object; the phase map lives
  in one module (`src/agent/turn-phase.ts`).

### 2.5 TaskTreeCard (the turn's plan tree — the default face of the Agent's work)

Rendered by `ProcessFold` as the turn's `bubble-plan` block inside the message flow
(§4.1). Reasoning is hidden; every act folds behind one line, and progress reads from
this card. Branches are the artifacts the plan produced: runs, subagents, jobs and
files hang off their todo items.

| Element | Interaction | Behavior |
|---|---|---|
| Header button | click | expands/collapses the todo list, `aria-expanded` |
| Progress bar | read-only | `completed/total` ratio, width transition |
| Individual todo | read-only | three-state visuals: pending (empty circle) / in_progress (primary circle + pulse) / completed (green fill + strikethrough) |

- Auto-**expands** when there is an `in_progress` todo; auto-**collapses** when all are
  completed.
- The collapse animation uses `grid-template-rows: 0fr ↔ 1fr` (not height, avoiding
  layout jitter).
- Each todo has visually-hidden status text for screen readers.
- The plan is also readable in its own right as the `agent-plan` tab (§6.2), where the
  standalone `SessionTodoCard.vue` (the older pinned-bar form, no longer rendered in
  the transcript) survives.

### 2.6 PermissionCardDock (live permission-decision bar)

Permission decisions are small and urgent, so they **float above the Composer**
(`position: absolute; bottom: 100%` — overlay, never reflow: an arriving approval does
not insert a flex child, so the transcript's geometry never changes).

| Element | Interaction | Behavior |
|---|---|---|
| Esc (global) | press | denies the current head approval (never leaves the turn hanging forever) |
| New approval lands | automatic | focuses the first focusable element, so keyboard users can decide immediately |
| Queue-depth hint | read-only | when `queueDepth > 1`, shows "N more pending" |

- Renders only the queue head (approvals are serial, one at a time).
- Internally reuses `PermissionCard` (see §4.3).

### 2.7 Composer (input card)

| Element | Interaction | Behavior |
|---|---|---|
| Mindset toggle | click / arrow keys | `workflow` ↔ `analysis` (radiogroup + roving tabindex; Workflow leads and is the default) |
| Permission mode | click → dropdown | `auto` / `ask` (menuitemradio; Auto leads and is the default) |
| Thinking level | `<select>` | `off` / `low` / `medium` / `high` / `xhigh` / `max` |
| Context gauge | click / hover (`role="img"`) | SVG ring + "used / total"; neutral/warning/danger by fill ratio; always-on (shows 0/total before data lands). Click opens `ContextUsagePanel`: remaining tokens + %, window usage, the latest settled request's total + generation speed (tokens/s), its provider-reported breakdown (input/output/reasoning/cache read/hit rate/cache write — only when reported), cache hit rates (latest + recent weighted), and the usage ledger's 5h/7d windows with real cost — all aggregates from `usage-ledger:stats` in the main process (`design/MODEL-PROVIDER-SEAM.md`), with a debounced live subscription so an open panel settles with the ledger instead of freezing at mount-time numbers |
| Send button | click | disabled on empty input |
| Enqueue button | click (busy + non-empty input only, beside stop) | same as Enter-while-busy: joins the session's prompt queue |
| Stop button | click (replaces send when busy) | emits `stop` |
| Queued-message chips | read-only text, `×` per chip | typed-ahead messages waiting for the busy session; `×` removes one before its turn starts |
| Drag and drop | drag files onto the input | file mentions |
| Shortcut hint | read-only | Enter sends (idle) / queues (busy), Shift+Enter newline |

**Prompt queue** (`stores/agent.ts` per-session `queuedPrompts`): a message sent
while the session's turn is in flight is ENQUEUED — never refused, never
dropped (the old `if (sending) return` swallowed it). Chips render above the
attachments row. Draining is `useAgentTurn.runTurn`'s job: when a turn settles
`resolved`/`blocked`, the queue head runs as the next turn on its owning
session (even if the user is viewing another session). A turn that settles
`halted`/`cancelled`/`failed` keeps the queue — a stop is the user seizing
control, so no turn may auto-start behind it. Queued messages enter the
transcript only when their turn actually starts (the event log is the record,
not the queue).

- The toolbar's left cluster is the per-turn behavior switches; the right cluster is
  hint + gauge + send/stop. Slash/mention/skill popups live inside `SlashInput` (§3).
- The card is the only bordered surface; the textarea inside is **frameless** (avoiding
  nested cards).
- `:focus-within` gives the whole card a primary ring; when busy, the focus-within ring
  is **kept** (the user may be editing the next prompt mid-turn).

### 2.8 Conversation export (`/export [pdf]`)

`/export` writes ONE standalone HTML file per session through the workspace
bridge to `exports/<stamp>-<title>.html` — a real Workspace file, visible in
the Files navigator — and opens it in the same agent-file HTML viewer
artifacts use. `/export pdf` prints the SAME document to
`exports/<…>.pdf` through the `conversation:print-pdf` channel (hidden
chrome-less window, Electron `printToPDF`, no preload) and opens it in the OS
default viewer. Both formats are built by the pure `conversation-export.ts`
serializer from the store's log projection: markdown through the shared
`renderMarkdown` (sanitized), thinking collapsed into `<details>`, one status
line per tool call, math rendered for real and fully offline
(`katex.renderToString` at export time, stylesheet + all 20 woff2 fonts
inlined as data URIs in a lazy chunk loaded only when the export contains
math). The export title is the session's FIRST user message (the
untitled-naming rule). Media embedding: the serializer takes an optional
`readFile` resolver (wired in `agentConversation.ts` via `readWorkspaceBlob`)
and inlines workspace-cited images and HTML reports as data URIs — `<img
src="data:…">` for images, a `sandbox="allow-scripts"` iframe (opaque origin,
no parent-DOM access) for HTML — under a 12 MB per-file / 64 MB total budget;
a file that fails to read or blows the budget degrades to its file-name card.
Export containment: the `readFile` resolver refuses runtime-private Workspace
paths before any read (`isRuntimePrivateWorkspacePath`,
`src/studio/domain/runtime-private-path.ts` — `.tdease` settings/permissions
and session/run state; the user-owned `.tdease/skills|agents|commands` assets
stay embeddable), so a transcript-cited private file degrades to the same
fallback card as a missing one instead of riding into the share. The iframe
sandbox policy has one owner: the renderer utils module
`src/utils/iframe-sandbox-policy.ts` exports `IFRAME_SANDBOX_ATTRIBUTE`
(`allow-scripts`), and both the online hydration frames (markdown-hydration)
and the export frames reuse it rather than restating the string.
Tool outputs render as `<details>` previews, approval decisions annotate the
tool rows, and compaction dividers carry the token delta. Long-PNG export is
deliberately NOT built: faithful full-transcript rasterization needs a heavy
capture dependency and still mistranslates code/math blocks; PDF via
printToPDF covers the fixed-layout share need dependency-free.

---

## 3. Input and autocompletion

**Components**: `agent/SlashInput.vue` · `CompletionPopup.vue`

The textarea inside the Composer drives **three independent autocompletions** at once,
distinguished by trigger character, sharing the `CompletionPopup` primitive. All three
popups and the key handling live inside `SlashInput`.

### 3.1 The three completions

| Trigger | Completion type | Data source |
|---|---|---|
| `/` at line start | slash commands | `slashRegistry` (`new`/`fork`/`compact`/`export [pdf]`/`stop`/`mcp`) |
| `@` mid-text | run / file | workspace + runs store |
| `$` mid-text | skill | live Pi-session skills |

An `@run:<id>` / `@file:<path>` / `@skill:<id>` token survives
verbatim into the turn's prompt and is resolved + frozen by the Client under a
`### Referenced` heading (AGENT-CONTRACT.md §3, Scope).

**Decoration is the mirror, not badges.** No trigger badge is drawn while
typing (the decorative `/`/`@`/`$` glyph over the textarea painted a second
copy of the character and was removed). Until a token is confirmed, typing
renders as plain text. The only decoration is an `aria-hidden` mirror above
the textarea that re-renders **confirmed** mention tokens (`@kind:refId`,
confirmed via Tab/Enter) as inline accent text — a Lucide kind icon (skill =
wand, run = play, file = document) + a short label; the
raw glyphs are hidden by an invisible patch of the textarea's own background,
and a hidden raw-text copy keeps the caret aligned. `/` commands get no
decoration at all. The mirror's box metrics (padding/font/line-height/border
inset) are **measured** from the textarea's computed style at runtime — a
cascade override that shrinks the textarea must shrink the mirror with it.

### 3.2 Completion keys (while any popup is open)

| Key | Behavior |
|---|---|
| `↑` / `↓` | move the highlight up/down (wraps) |
| `Tab` / `Enter` | confirm the selection (when no Ctrl/Shift) |
| `Esc` | close that popup |
| `Enter` (no popup) | send; a line-leading `/cmd` goes through the slash channel |
| `Shift+Enter` | native newline (not intercepted) |

- Popup close is delayed 150ms after blur (preventing accidental close on focus switch).
- The highlighted item is auto-scrolled into view via `scrollIntoView({ block:
  'nearest' })`.

### 3.3 CompletionPopup (shared primitive)

- `role="listbox"`, each item `role="option"` + `aria-selected`.
- Direction can be `up` / `down` (default up, popping above the Composer).
- Enter/exit animation: `popup-enter` opacity + translateY 4px, `--dur-fast`.

### 3.4 The `$`-skill picker

The skill completion is its own popup instance fed by the live Pi-session skill list
(forwarded from the Composer as `skills`); `@`-mention candidates aggregate runs and
the recursive workspace file tree independently (`useMentionCandidates.ts`).

---

## 4. Tool calls / thinking / permission rendering

**Components**: `ProcessFold.vue` · `fold-items.ts` · `ContentBlockView.vue` ·
`ToolGroupBlock.vue` · `ThinkingBlock.vue` · `PermissionCard.vue` · `BlockedCard.vue` ·
`TurnOutcomeCard.vue` · `SubAgentCard.vue` · `TaskTreeCard.vue` · `Collapse.vue` ·
`MarkdownContent.vue`

This is the in-transcript hierarchy of "how one assistant message unfolds". The render
walk lives in ONE place: `fold-items.ts` performs the single ordered walk over
`message.blocks`, and `ContentBlockView.vue` is the single block→renderer dispatch.

### 4.1 ProcessFold (the message-level outer fold)

Once a turn settles **resolved**, its process trace (thinking + tool groups) folds
behind a summary line. The fold is **reactive on the settlement** — never latched at
mount, never mid-stream: during output there is no settlement, so the process stays
fully visible and the fold appears exactly when the settlement lands. A resolved turn
folds even if some of its tools failed — the failure count rides the fold line instead
of keeping the whole process expanded.

Fold geometry (the interleaved walk): the fold summary is placed before the FIRST
process run, so text emitted before any work sits above the summary; each process run
is its own per-run `Collapse` panel, and text blocks render **in place between** the
panels. The old "one process panel, then all text" shape is gone.

| Element | Interaction | Behavior |
|---|---|---|
| fold summary | click | expand/collapse, `aria-expanded` + `aria-controls`; reads "✓ worked · duration · N calls [· X failed]" |
| fold state | persisted | stored in a transcript-wide map keyed by the settled message id, so scroll-recycling and projection swaps never lose the user's expansion |

- Collapsed by default once resolved; text blocks are never folded (text always shows).
- Blocked/halted turns do not fold this way — they emit their own outcome card (§4.5).
- Store-side arrival order is locked by `stores/agent-live-blocks.test.ts`.

### 4.2 ToolGroupBlock (a group of same-kind tool calls)

| Element | Interaction | Behavior |
|---|---|---|
| group summary | click | expand/collapse, `aria-expanded` |
| detail span | hover | `title` shows the full parameters |
| error span | hover | `title` shows the full error |
| approval reason | hover | `title` shows the reason |

States (the summary line): a settled group shows a green `✓` (all done) or a red `✗`
(any failures); a running group shows shimmer dots. The summary text is the one-line
essence — tool name + truncated detail (`title` hover shows the full text); the
expanded body adds the un-truncated detail + error.

Default open/closed: **every group defaults collapsed; one click expands it** (the old
auto-expand rules are gone — failures stay announced by the `✗` glyph and the fold
line's failure count, not by force-expanding).

- Left border color by category (Phase D-20 palot pattern; the first tool's category
  wins for a mixed group): edit / run / read / search / plan / other →
  `--tool-cat-*` tokens.

### 4.3 PermissionCard (the permission-decision core)

Shared by PermissionCardDock (live) and ProcessFold (historical replay).

| Element | Interaction | Behavior |
|---|---|---|
| Deny | click | resolve `'deny'` |
| Allow for session | click (inline tier only) | resolve `'allow_session'`; records a session-level grant (AGENT-CONTRACT §3: a grant is runtime state, never a decision value) |
| Allow once | click | resolve `'allow'` |

Three tiers of strictly increasing visual weight: Deny (`subtle`) → Allow session
(`default`) → Allow once (`primary`). At document tier, Allow once becomes the `danger`
variant (signaling a heavy decision).

- "It renders args, not intent": always shows the full parameters (SchemaForm readonly),
  not the model's self-description.
- Document tier additionally shows a "requires a review surface" hint, with body weight
  non-muted (must be read).

### 4.4 ThinkingBlock (thinking-process fold)

A `<details>` primitive + custom summary.

| Element | Interaction | Behavior |
|---|---|---|
| summary | click | expands/collapses the thinking content |

- `sealed=false`: label "Thinking…" + CSS shimmer dots (`::after` width animation,
  **not setInterval**).
- `sealed=true`: label "Thought" + no dots.
- Arrow rotation transition.

### 4.5 Outcome rendering (show-once settlements)

Outcome feedback is **show-once** (2026-09-06 rule): every non-resolved
settlement's feedback — the failed/blocked/halted card, or the
cancelled/failed chip on the turn's own user bubble — renders only while that
turn is the **live tail**, and leaves the transcript the moment a newer user
message exists (live or projected; `supersedeOpenTurn` retracts the card and
strips the chip in the same projection pass). Records persist in the event
log — the transcript keeps no debris of settled interactions.

- A clean resolved turn emits no separate outcome block (its ProcessFold
  summary already says "worked").
- **TurnOutcomeCard** (blocked/halted while live): `?` blocked (primary,
  embedding a BlockedCard) / `⊘` halted (muted, **never** styled as failure;
  shows a "continue in a new turn" button).
- **BlockedCard** is answerable in place: when the blocked report carried
  `options` (2–4 short self-contained answers), they render as one-tap reply
  buttons; the card also carries its own manual-answer input. Either sends the
  answer as the next turn without touching the Composer.
- **Cancelled turns** show a muted chip on the user bubble — history, not an
  alert; abort is a normal way for a turn to end, so it earns neither a card
  nor a glyph.
- Provider failures render a failed card while live; once superseded they
  retract by the same show-once rule (the full error remains in the event log
  and the trajectory inspector).

### 4.6 SubAgentCard (the in-transcript subagent card)

Three states: running (purple border + pulse + live elapsed) / settled (collapsed to a
one-line summary) / blocked (amber, expanded).

| Element | Interaction | Behavior |
|---|---|---|
| Header button | click | collapses/expands the body, `aria-expanded` |
| Cancel button (when running) | click | cancels that subagent |

- The collapse arrow is a **single rotating chevron** (`-90deg` collapsed / `0deg`
  expanded) with an animated transition.
- Pinned expanded while running; other states can be collapsed manually.
- The body always has content (at least the task), so collapsing is always actionable.

### 4.7 MarkdownContent (markdown rendering + interactions)

| Element | Interaction | Behavior |
|---|---|---|
| Code block "wrap" button | click | toggles `data-wrap`; `aria-pressed` reflects it |
| Code block "copy" button | click | copies the code; turns green for 1500ms; temporarily changes `aria-label` |
| Artifact card | click / Enter / Space | emits `open-artifact` (opens into the document area) |
| `#` anchor links | click | default navigation |
| Workspace-relative links | click | contained open (segment-fenced before `shell.openPath`) |
| External links | click | allowlisted scheme via `shell.openExternal` (`http`/`https`/`mailto`) |

- While streaming, the trailing N graphemes use `stream-tail-pulse` (opacity + blur
  pulse).
- Artifact cards get `role="button"` + `tabindex="0"` injected by markdown.ts; this
  component handles Enter/Space.
- Mermaid is auto-rendered when present + watched by a MutationObserver; KaTeX renders
  math.

**Streaming render pipeline**: markdown is split into top-level blocks
(`utils/markdown-blocks.ts`, fence-aware, prefix-stable) and cached per message
id — an appended chunk re-parses only the tail block, so a 60 KB stream
produces zero long tasks (the pre-cache baseline was 59–141 ms re-parse
hitches). Code blocks hydrate with a lazy shiki singleton (JS regex engine,
dual catppuccin themes via CSS vars) in settle-time slices; blocks carry a
language-labeled toolbar (wrap/copy). Collapsed thinking shows a live intent
line (the whitespace-collapsed tail of the stream); a compacting turn suspends
the livetail pill so the compaction divider never animates twice.

**Workspace citations**: a Workspace file citation in assistant text renders
by file type in all four syntaxes (`![](p)` / `[](p)` / `![[p]]` / `[[p]]`).
Embeds of images/SVG/HTML present inline (lazy blob/iframe hydration); every
file link — including images — renders as the compact artifact card
(`utils/markdown.ts` `linkCardKindOf`). A workspace-relative anchor is not an
option: the sanitizer strips non-protocol hrefs, which made an anchor flip
between dead text and live link depending on whether the rest of the message
contained raw HTML. Extensionless targets stay wiki links. `stores/agentFiles.ts`
derives the `agent-files` tab gallery from the SAME citations across BOTH
conversation layers of a session — main-session messages plus each subagent child's
session log (read-only through the storage bridge, re-read on child state change) —
grouped by the producing exchange: main turns in message order ("第 N 轮" +
first-line snippet), then one group per subagent in spawn order
("子代理 · role"); dedup by path, first citation owns the file.

### 4.8 Collapse (the fold primitive)

`grid-template-rows: 0fr ↔ 1fr` transition (140ms); content is unmounted after closing.
Shared by ToolGroupBlock / SessionTodoCard / ProcessFold.

---

## 5. Session management

**Components**: `SessionList.vue` · `SessionBar.vue`

### SessionList (session list)

The Agent page's **left column** (a resizable, collapsible split pane) — page-scoped,
not global chrome; it also tucks into the SessionBar dropdown.

| Element | Interaction | Behavior |
|---|---|---|
| "New" button | click | emits `new` |
| Session item | click / Enter / Space | `selectSession` |
| Fork button (active item only) | click | emits `fork` |
| Archive button | click | `archiveSession` |

- Session items are `role="button"` + `tabindex="0"` + `aria-current="page"` (when
  active).
- Runtime state per session: running = a rotating arc spinner (motion IS the
  signal), a finished-but-unseen result = a solid dot, failed = a solid
  error-coloured dot; idle stays quiet.
- Action buttons default to `opacity: 0`, appearing on item hover/focus-within.

---

## 6. Right-rail surfaces (tabs, capsule, subagents, jobs)

The Agent page's right rail has, in precedence order: the floating **SubagentPanel**
(when open) → the **JobPanel** (when open) → the **AgentTabHost** (when any tab is
open) → the **ActivityCapsule** (default). Since the 0.11 rail rework the rail proper
is itself a drag-resizable split (280–520 px, persisted per workspace as
`agentTabsWidth` via the shared `ResizableSplit`, collapsed when no panel/tab is
open); the capsule is a sibling below the split, floating over the conversation's
right edge taking no layout width. A live turn auto-expands the capsule so progress
is legible. The split's drag handle is inert (`tabindex="-1"`) in the parent-collapsed
non-collapsible configuration — a deliberate exception to the handle's usual roving
tabindex.

### 6.1 ActivityCapsule (the collapsed activity surface)

An asset-summary capsule: **Runs** row (only the runs THIS conversation dispatched —
the `sessionRuns` store mirror of the `session-run:changed` push; each entry opens the
Workbench's real `RunDocument` as an `agent-run` tab), subagent and job rows, plus the
turn HUD (§2.4) and the last outcome. Entries open the corresponding tab on click;
`@open-jobs` opens the JobPanel.

### 6.2 AgentTabHost (nine tab kinds)

`src/studio/domain/agent-tab.ts` + `agentTabRegistry.ts` — deliberately a different
kind set from the Workbench's `DocumentKey`:

| Tab kind | Content |
|---|---|
| `agent-file` | FileDocument with `citedByAgent` provenance |
| `agent-subagent` | SubagentConversation (live child turn events routed to the parent's renderer) |
| `agent-run` | the Workbench's real RunDocument (runs are workspace data, not subagents) |
| `agent-files` | AgentFileList — the citation-derived file gallery (§4.7) |
| `agent-plan` | SessionTodoCard |
| `agent-evidence` | EvidencePanel |
| `agent-side-chat` | SideChatTab — a selection-flow child conversation: draft a selection into a side thread (`side-chat-drafts.ts`), converse in isolation from the main session, and promote results back |
| `agent-settings` | AgentSettingsTab — provider/model (full catalog incl. unconfigured providers, the management surface; quick switching lives in the SessionBar's ModelPickerMenu), reasoning effort, context readout, and the PTC capability toggle (the `experience` switch lives in Settings → Agent Tools) |
| `agent-trajectory` | TrajectoryTab — the derived per-turn projection (AGENT-EVENTS §5) |

The Workbench's viewers are reused (one viewer per concern); closing the last tab
returns to the capsule automatically.

### 6.3 SubagentPanel (the floating delegation panel)

NOT a tab — subagents are an ambient activity stream (`Ctrl+Shift+D` or the capsule's
subagents row toggles it). Four zones: parallel groups/fleet (aggregated by `groupId`),
the run list (`SubagentList.vue`, cancel), the result envelope of a selected child
(`findings/evidenceLinks/confidence/openQuestions`), and conversation peek
(`recentTools`/`lastAssistantSnippet`). Full contract: SUBAGENT-RUNTIME.md §9.

### 6.4 JobPanel

Background jobs (`tdease.job.*`); mutually exclusive with the SubagentPanel.

---

## 7. Workbench and documents

**Components**: `WorkbenchPage.vue` · `ResizableSplit.vue` · `NavigatorPanel.vue` ·
`DocumentGroup.vue` · `DocumentTabs.vue` · `DocumentHost.vue` · `ActivityDock.vue` ·
`CommandPalette.vue` · `WelcomeDocument.vue`

### 7.1 Layout (two nested splits)

`Navigator (240–420) | [document area over ActivityDock (120–480)]`. The Workbench's
old right Agent/inspector column is **gone** — the document surface always spans the
full width, and fit-to-view zooms never inherit chrome whitespace. Collapse semantics
live in the layout layer: collapsed = size 0 + `v-if` truly unmounting; the StatusBar's
Runs/Logs toggles reopen it (§1.2).

**ResizableSplit handles**:
- Drag (pointer, rAF-coalesced commits)
- Double-click → reset
- Keyboard: `←/↑` -16px (Shift ×4), `→/↓` +16px, `Home` min, `End` max, `Enter`
  collapse
- `role="separator"` + full aria-value* + `tabindex="0"`
- Optional `storageKey` persists to localStorage (debounced 200ms)

### 7.2 NavigatorPanel (three sections)

`runs` / `wiki` / `files` (`src/stores/uiLayout.ts`). The experimental canvases &
evidence sections were removed (evidence surfaces live on the Agent page's tab host).
Refresh button (Files only + not collapsed + a
workspace exists); collapse button.

### 7.3 DocumentTabs and the split editor

One shared tab list with two group viewpoints (`primary` / `secondary`):

| Element | Interaction | Behavior |
|---|---|---|
| tab | click | selects in that group |
| tab-strip action / `Ctrl+\` | — | clones the active document into the second group, side-by-side or stacked; the split ratio persists |
| tab | double-click | preview → open (`keep()`) |
| pin button | click | pin/unpin |
| close button | click | close; confirmation dialog when dirty; closing a document closes the secondary viewpoint |
| dirty dot | click | close-confirmation dialog |
| overflow dropdown | click | hidden tabs in MRU order |

- `Ctrl+Tab` / `Ctrl+Shift+Tab` walk MRU order (not the strip's spatial order).
- Three tab states — pinned (icon only, leftmost) / preview (italic; the next preview
  replaces it rather than accumulating) / open — plus the per-group active selection.
  A dirty document shows a filled dot instead of a close affordance and cannot be
  closed silently (confirm dialog); overflow collapses into a `»` menu ordered by
  recency. The tablist follows the WAI-ARIA tabs pattern (active tab is the only one
  in tab order; Left/Right move focus and activate).

Document kinds (workbench `DocumentKey`, 9): `run-index`, `run`, `result`,
`evidence-graph`, `file`, `wiki` (scope system|workspace), `wiki-index`,
`analysis-review` (the one registered NotBuilt kind), `settings` (retained but
not an entry point — already-open legacy tabs keep rendering; every entry
point opens the Settings modal, §7.7). Not-built documents
carry unique i18n copy and are machine-queryable via `registry.notBuilt()`.

### 7.4 ActivityDock

Two tabs: **Runs** / **Logs** (the Transfers tab is gone). Starts collapsed; the
StatusBar toggles open/aim/close it. Run item: click selects, double-click/Enter opens
as a document, a "View Log" link switches to Logs. Logs has a refresh button.

### 7.4a FileDocument render targets

A file document offers peer render targets in its header tab strip. `.feature` offers
Table / Feature map / Source. TopPIC prsm/proteoform TSVs (`*_prsm.tsv`,
`*_proteoform[_single].tsv`) offer Table (default) / Variants / Source. The Variants
target lazily loads the sibling FASTA (the preamble's `Protein database file:` name
wins) and renders the identified proteins as a reference-based multiple alignment:
consensus row, mismatch/gap coloring, identified-row tint, theoretical monoisotopic
mass per row, per-block conservation strip, and a family filter. Workspace FASTAs above
8 MB stream through byte-range reads (`workspace:read-byte-range` IPC; multi-GB-safe —
whole-file bytes never cross IPC). `.msalign` and `.mzML`/`.mzML.gz` share one
spectrum-list browser (multi-dimension filtering; only the selected row renders in the
SpectrumViewer; list capped at 2000; mzML parsed streaming with an on-demand
byte-offset decode).

### 7.5 Welcome / guide surface

The Workbench's no-tab surface, not a document: `DocumentGroup.vue` renders
`WelcomeDocument.vue` whenever no document resolves, so an empty workbench is never a
blank pane and there is no first-run flag or Welcome tab to manage. It shows the living
spectrum (`WelcomeSpectrum.vue`, ported from `electron/splash.html`): tokenized,
rAF-suspended offscreen, static under `prefers-reduced-motion`. Below it, three
action cards — 打开工作区文件夹 (raises the top-left Workspace rail popover,
shared `useWorkspaceRailPanel` state), 让 AI Agent 分析数据, 配置 AI 模型 — each
executing the navigation its label names.

### 7.6 CommandPalette (`Ctrl+K`)

| Key | Behavior |
|---|---|
| `Ctrl+K` | global toggle |
| `↑/↓` | move up/down |
| `Home/End` | first/last |
| `Enter` | activate |
| `Ctrl+Enter` | parameter-step submit |
| `Esc` | parameter-step back / close (keeping the query) |

- Prefix filters: `>` commands, `@` runs.
- Three groups (`stores/palette.ts`): commands / open documents / Runs, ranked by a
  no-dependency subsequence matcher.
- The documents group reaches SECTIONS, not just documents: per-section Settings
  entries ("Settings: Statistics" … all eight palette sections — `about` lives
  only inside the modal) open the Settings modal
  FOCUSED on the section through a one-shot `requestedSettingsSection` ref in the
  documents store — section is view state, never document identity (§7.7); re-focusing
  works while the modal is already open. Run Index and the workspace Evidence Graph
  sit in the same group.
- `role="combobox"` + `aria-expanded` + `aria-activedescendant` + `role="listbox"`.
- Blocked items show a blocked label — four reasons: no workspace / needs review / no
  result surface / a session capability is off.

### 7.7 Settings modal

Settings opens as ONE centered, append-to-body modal (`SettingsModal.vue`,
bound to the documents store's `settingsModalOpen`) whose body is the
unchanged `SettingsDocument.vue` with NINE real sections: General, Providers,
MCP, Statistics, Permissions, Agent Tools, Sharing, Appearance, About (no
Advanced section exists). A modal, not a document tab: the settings surface
nests its own dialogs (custom provider), and a dialog inside a
movable/splittable tab container mispositions — one fixed surface that
teleports to body is the honest host. The section is VIEW STATE, not
identity: the `settings` key carries no section field, and the palette's
per-section entries consume a one-shot `requestedSettingsSection` ref (a
fresh "open Settings" never lands on a stale section). The `settings`
document definition stays registered so already-open legacy tabs keep
rendering; no entry point opens a new settings tab.

Section-specific behavior with a home elsewhere: Statistics, custom-provider
management, per-model pricing and the update row (`design/MODEL-PROVIDER-SEAM.md`,
`design/DESKTOP-PACKAGING.md`), the Sharing invitation manager
(`design/WEB-SHARING.md`), and the About group's license text
(`design/DESKTOP-PACKAGING.md` §License). The two sections with local
interaction contracts:

- **Permissions — workspace-overrides editor**: v2 rule rows
  `{action, decision, match?, priority?, note?}` over the registered action
  set (match: command regex for bash, path globs for file tools). The preview
  runs the runtime's OWN evaluator (`contextFor(mode)` + coarse ladder +
  `evaluatePermissionDecision` on a sample command/path — identical to the
  bind-time freeze), so what you see is what a session would enforce.
  Persistence goes through the existing gated workspace atomic-write IPC (no
  new channel); save round-trips the runtime parser, so the editor cannot emit
  a file a bind would reject; v1 files still load. The decision semantics are
  `spec/AGENT-CONTRACT.md` §3.
- **General — Network proxy card, Diagnostics row, Backend connection**: proxy
  (`settings.json` `network.proxy {url, noProxy}`) applies immediately on save
  — env for uv/pypi/backend children, the bundled undici dispatcher for vendor
  LLM/OAuth/models.dev, a session proxy rule for electron-updater's own
  partition; loopback is always bypassed. Diagnostics opens the logs folder
  (`desktop:open-logs`). The backend mode switch (local/remote/disabled)
  applies live — the embedded backend stops/restarts through the shared
  `startEmbeddedBackend`; the remote form sends typed values through
  `backend:configure` (an EMPTY token field KEEPS the persisted bearer token —
  it never leaves main-process settings.json) and re-hydrates through the
  `backend:connection` handshake.

---

## 8. Global shortcut summary

All registered via `window.addEventListener('keydown')`, typing-guarded unless noted:

| # | Component | Combo | Scope | Behavior |
|---|---|---|---|---|
| 1 | AppShell | `Ctrl+=` / `Ctrl++` | always | font zoom in (no typing guard, by design) |
| 2 | AppShell | `Ctrl+-` | always | font zoom out (no typing guard) |
| 3 | AppShell | `Ctrl+0` | always | font reset (no typing guard) |
| 4 | AppShell | `Ctrl+\` | always | split editor (clone active document) |
| 4a | AppShell | `Ctrl+B` | always | toggle the left side bar |
| 4b | AppShell | `Ctrl+J` | always | toggle the panel |
| 4c | AppShell | `Ctrl+Alt+B` | always | toggle the auxiliary bar |
| 4d | AppShell | `Ctrl+Shift+J` | always | maximize/restore the panel |
| 5 | CommandPalette | `Ctrl+K` | always | toggle the command palette |
| 6 | CommandPalette | `Esc` | palette open | close/back |
| 7 | DocumentTabs | `Ctrl+Tab` / `Ctrl+Shift+Tab` | always | MRU tab forward/backward |
| 8 | AgentPage | `Ctrl+L` | wherever the Agent lives | focus the Composer |
| 9 | AgentPage | `Ctrl+Shift+D` | wherever the Agent lives | toggle the SubagentPanel |
| 10 | AgentPage | `Ctrl+N` | Agent page visible | new session |
| 11 | AgentPage | `j` / `k` (no modifier) | Agent page visible | next / previous session |
| 12 | AgentPage | `Esc` (double-press) | Agent page visible, turn live | abort the current turn |
| 13 | PermissionCardDock | `Esc` | pending approval present | deny the head approval |

**Potential conflicts**: `Esc` is handled by several components (palette / dock /
agent) — they coexist via their scopes; a single Esc is left alone so it can close a
menu or blur the composer. `Ctrl+N` may conflict with the browser's "new window" (the
page preventDefaults it).

---

## 9. Status vocabulary

Globally shared status colors and semantics:

| Status | Color token | Where used |
|---|---|---|
| queued | `--status-queued` | run/subagent waiting |
| running | `--status-running` (= `--color-primary`) | running: edge / dot / subagent border |
| succeeded | `--status-succeeded` | success: outcome glyph / tool ✓ |
| failed | `--status-failed` | failure: edge / tool ✗ |
| cancelled | `--status-cancelled` | cancelled (neutral, not failure) |

**The five turn states** (edge indicator): idle / acting / suspended / halted / failed.
**The four turn-phase labels** (HUD, AGENT-LOOP §7): waiting / thinking / responding /
executing.
**The approval five states**: pending / confirmed / rejected / timeout / aborted.
**The subagent four states**: running / returned / blocked / cancelled.

---

## 10. Animation / transitions / reduced motion

**Durations**: `--dur-instant` 90ms / `--dur-fast` 140ms / `--dur-normal` 220ms /
`--dur-slow` 320ms.
**Easing**: enter `--ease-out`, exit `--ease-in`, move `--ease-inout`. **No bounce /
elastic**.
**Layering**: one stacking ladder — `--z-*` tokens in `unified-design-tokens.css`
(content 0 … handle 40, floating 100, modal 2000); no literal z-index remains in `src/`.

**Global guard**: at the end of `unified-design-tokens.css` there is an `@media
(prefers-reduced-motion: reduce)` that reduces all `*` animations/transitions to
0.01ms.

**Extra per-component guards** (finer): Transcript / ThinkingBlock / ToolGroupBlock /
Collapse / SubagentList / SessionBar / SessionTodoCard / Composer / StatusBar /
AppShell / CommandPalette / ResizableSplit / PermissionCardDock / WelcomeSpectrum all
have one.

> The animation and a11y gap trackers that used to live in §10/§11 moved to
> `docs/STATUS.md` Open items (2026-10-12) — trackers are status, not
> reference. The implemented a11y facts: roving tabindex on ModeSelector /
> AgentTabHost / ResizableSplit handles / DocumentTabs; `aria-expanded` /
> `aria-controls` on ProcessFold / PermissionModeButton / StatusBar toggles;
> `role="status"` on HUD phase / TurnOutcomeCard / AppShell zoom readout;
> focus-visible rings on AppButton / split handles / Composer chip-remove;
> screen-reader-only todo status on the plan card.

*Last verified: 2026-10-12 against the 0.11.0-beta working tree (nine-tab rail,
TaskTreeCard/ContentBlockView/fold-items rework, export media embedding, resizable
rail).*
