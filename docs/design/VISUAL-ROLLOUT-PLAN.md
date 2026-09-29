# TDEase Visual-System Rollout Plan (execution edition)

> Reader: the executing agent (not humans). This file is the single source of truth for
> the task.
> Strategy: `../../TDEase-FrontEnd/PRODUCT.md`; the full visual rules: `../../TDEase-FrontEnd/DESIGN.md`.
> Single source of truth for design tokens: `src/styles/unified-design-tokens.css`.
> **Token vocabulary correction (2026-09-05):** the `--lab-*` token family was renamed —
> `--lab-live` → `--color-live`, `--lab-live-glow` → `--color-live-glow` (the `-soft`
> variant is gone; use `--color-primary-soft`), `--lab-panel-border` → 
> `--color-border-panel`, panel backgrounds → the `--elev-N-bg` ladder (`--elev-*`
> survives unchanged). Token names below read under the old vocabulary; the tokens file
> is authoritative.
> Completed pilot: the Agent conversation surface (see §0) — it is the reference
> implementation for all subsequent work: follow it first; on conflict, the pilot wins.

---

## §0 The completed reference implementation (do not redo)

The Agent conversation surface has been converted to the new system; the following
files are living samples of "the right way":

- `src/components/agent/AgentPage.vue` — Composer anchor container, edge indicator (the
  acting state uses `--color-live` + glow)
- `src/components/agent/Composer.vue` — floating control: `var(--elev-2-bg)` +
  `var(--elev-2)` shadow, no outline
- `src/components/agent/PermissionCardDock.vue` — the approval card as an overlay
  (`position: absolute; bottom: 100%`)
- `src/components/agent/SessionBar.vue`, `Transcript.vue` —
  tonal layering, no hairline outlines
- `src/components/primitives/StatusMark.vue` — running-state breathing halo
- `unified-design-tokens.css` Layer 4 — `--color-live` / `--color-live-glow` defined

---

## §1 Core conventions (must not be violated)

### 1. Tonal layering (The Tonal Layering Rule)

- Hierarchy is expressed by surface **lightness steps**, not by 1px outlines. The
  ladder: shell darkest → content area one step lighter → floating controls one step
  lighter again.
- Outlines survive in exactly two places: **draggable structural seams** (split
  handles) and **semantic borders** (e.g., the approval card's warning border).
- New code must not add decorative 1px borders to panels/cards; migrations delete
  borders and switch to lightness differences.
- Implementation: use the `--ctp-base` / `--lab-panel-bg` / `--elev-*-bg` ladder in
  component scoped styles; do **not** globally redefine `--lab-panel-border` (that is a
  full-rollout finishing action, see §3 Phase 4).

### 2. The living color (The Living Channel Rule)

- **Only "alive" states glow**: running, streaming, awaiting-decision. Idle UI stays
  quiet.
- Alive states uniformly use `--color-live` (night-glow cyan); the glow uses
  `--color-live-glow` (formerly `--lab-live*`).
- No glows/luminescence on buttons, badges, empty states, or static panels.
- Every animation must have a `prefers-reduced-motion` downgrade (glow degrades to a
  static outlined ring, see StatusMark.vue).

### 3. Overlay over Reflow

- Temporary, time-sensitive UI (approvals, notifications, confirmations) **never
  inserts into the document flow and pushes existing content aside**.
- Anchor with `position: absolute` next to the related control (see
  PermissionCardDock: `bottom: 100%`); z-index guards semantic hierarchy: content <
  overlays (z≈15) < popovers (≥20). No magic numbers like 999.
- **Layout-property animations are forbidden** (`transition:
  width/height/padding/margin`). Use transform/opacity; height expansion uses
  `grid-template-rows: 0fr→1fr`.
- Existing violations to fix: `SessionTodoCard.vue:174` (width),
  `ResizableSplit.vue:346` (width, height — dragging is the exception; this refers only
  to non-dragging transitions).

### 4. Layout proportions (density alignment)

- **All panel-header heights = `var(--row-h)`**; hardcoded pixels forbidden. Existing
  violations: `NavigatorPanel.vue:163`, `ActivityDock.vue:208`
  (all hardcode 32px); one-off heights `RunWorkflowGraph.vue:101` (38px),
  `CanvasGallery.vue:98` (42px), `SessionBar.vue:101` (36px) — adjacent headers must
  not show two heights.
- Spacing always uses `--space-*` (incl. the 6px/10px half steps); bare px
  padding/margin forbidden.
- Font sizes always use `--text-label/sm/base/md/lg/xl` (carrying `--font-scale`
  scaling); `font-size: NNpx` forbidden.
- Radius cap `--lab-radius-lg` (10px); 999px/50% allowed only for true pills and
  circles.

### 5. Theme compliance

- Every UI chrome color must go through tokens (`--lab-*` / `--color-*`); hardcoded
  hex/rgb(a) forbidden. Domain colors inside data visualizations (ion types, RdYlBu
  heatmaps) are exempt, but axes/labels/panel backgrounds do not count as "data".
- After changes, `node scripts/check-contrast.mjs` must pass all four themes.

### 6. Component vocabulary

- Prefer `primitives/AppButton.vue` for buttons; icon buttons use the shared
  implementation in `primitives/` (if absent, create `IconButton.vue` and reuse it —
  the 94th bare rewrite is forbidden).
- Loading uses shape-matched Skeletons; empty states use `primitives/Empty.vue`;
  generic spinners forbidden.
- Emoji/text glyphs as icons forbidden; uniformly `@element-plus/icons-vue`.

---

## §2 Execution order (by priority; each task independently deliverable)

### Phase 1 — P0: theming the visualization cluster (largest visual debt)

**Problem**: `src/components/visualization/` hardcodes ~145 light hex values (#fff
backgrounds, #111827 text, the whole Tailwind slate family); under the dark themes
(frappe/macchiato/mocha) it is a patch of glaring white boxes.

**Scope** (by severity):
1. `EvidenceGraphViewer.vue:252-273` + `documents/EvidenceGraphDocument.vue:147` (the
   canvas paints `#ffffff` in JS)
2. `MS2SequenceViewer.vue:686-893`
3. `ms2-sequence/AnnotatedSpectrumIPSA.vue:817-959`
4. `FragmentAnnotationViewer.vue:368-431`
5. `ms2-sequence/ModificationEditor.vue:229-325`, `ConfigPanel.vue:89-120`

**Rules**: UI chrome (panel backgrounds, text, borders, hover) → `--lab-panel-*` /
`--color-text*` / `--color-border`; data/ion colors stay as `--domain-*` tokens. JS
fill colors in canvas/SVG switch to reading CSS variables (`getComputedStyle`) or
dispatching by `data-theme`.

**Acceptance**: open each of these viewers under the four themes and compare
screenshots; `check-contrast.mjs` passes; related vitest all green.

### Phase 2 — P1: proportions and jumps

1. **Panel-header height unification**: all violations listed in §1.4 change to
   `var(--row-h)`; after comfortable/compact density switches, all adjacent headers
   align horizontally.
2. **Composer shortcut-hint row overflow**: in a narrow dock (<400px) the hint row is
   cut off by the right edge. Fix: allow wrapping/truncate to ellipsis, or hide hints
   at narrow widths. Also fix the explorer/executor toggle's text squeezing into
   vertical stacking at narrow widths.
3. **Layout-animation cleanup**: the width/height transition violations listed in §1.3.
4. **blocks/ cluster i18n**: `BlockCanvas.vue:10,25`, `DataSourceNode.vue:13,21,50`,
   `ViewerNode.vue:18,23,37`, `CanvasGallery.vue:81` hardcode English; add locale keys
   (zh/en).

### Phase 3 — P1: engineering (entry bundle and component convergence)

1. **Element Plus on demand**: `main.ts:3-4` registers everything → hook
   `unplugin-element-plus` (already in devDependencies) into `vite.config.ts`.
2. **AG Grid deferred registration**: move `main.ts:24`'s
   `ensureAgGridModulesRegistered()` into TableViewer's async chunk.
3. **KaTeX lazy loading**: `utils/markdown.ts:21-23` switches to a dynamic import,
   following the existing lazy pattern in `utils/mermaid-renderer.ts:56`.
4. **Document KeepAlive**: `DocumentHost.vue:65-68` adds `<KeepAlive :max="N">` for
   viewer documents; switching tabs no longer rebuilds Plotly/AG Grid.
5. **Deep-watcher slimming**: `FeatureMapViewer.vue:403`, `SpectrumViewer.vue:249`,
   `PlotlyViewer.vue:188` (the Plotly figure is already a shallowRef; a deep watch is
   double waste), `AgGridTable.vue:416-450` — switch to explicit version-number
   invalidation.
6. **IconButton primitive**: extract `primitives/IconButton.vue` (28px touch target,
   all four states), converging 93 bare buttons; the visualization cluster's el-buttons
   migrate to AppButton.
7. **`--lab-shadow-overlay` undefined bug**: `CanvasDocument.vue:198` and
   `RunDocument.vue:690` reference a nonexistent token; the fallback silently applies.
   Add the token or switch to `--lab-shadow-panel`.

### Phase 4 — P2: finishing (full rollout)

1. **Globalize tonal layering** ⚠️ **assessed; physically impossible to do fully** —
   see the note below.
2. **DocumentTabs keyboard reachability** ✅ **done** (before this commit): roving
   tabindex + arrow keys + the ARIA tabs pattern landed.
3. **Settings-page form labels** ✅ **assessed, effectively done**: the audit found
   GeneralSettings fully migrated to Field during the pilot; McpSettings' scope is a
   radio-group (Field is single-control, not applicable); ThinkingLevelSelector is a
   Composer inline toolbar control (label wrapping a select, already correct). No
   truly unlabeled settings controls remain (verified by aria-label +
   Field-ancestor scanning).
4. **Font-size/spacing sweep** ✅ **mostly done**: only 1 hardcoded `font-size` remains
   (SessionList el-icon 11px, a deliberate shrink to fit a 20px IconButton); bare px
   spacing has been swept down to the remaining files in viz/agent etc.; the kept
   2px/5px/7px are typographic tracking or density fine-tuning (reasons noted).
5. **Emoji glyph purge** ✅ **done**: the UI glyphs in `TreeNode`/`MetricsCard`/
   `MS2SequenceViewer`/`ContextMenu` were replaced with SVG icons;
   `SequenceTrack.vue:588`'s `★/◆/■` are scientific annotation symbols (§1.5 exemption,
   kept).
6. **Fallback-chain cleanup** ✅ **done**: `src/components` now has 0 dead fallback
   chains and 0 `--el-*` references.
7. **Narrow-window narrative** ✅ **solved by the Electron min-width**:
   `electron/main.ts:943` sets `minWidth: 1100` (default 1440×960); desktop users cannot
   compress the window below 1100 — of §4.7's two options, the min-width route has
   landed, and no shell-level CSS collapse rules are needed. Component-level
   responsiveness (FastaViewer@640, CanvasGallery@720, ActivityDock@760) is each
   component's internal density tuning, unrelated to this item.

> **§4.1 Globalize tonal layering — why not (physical-constraint record)**
>
> This item's §1.1 premise ("hierarchy via surface lightness steps, not 1px outlines")
> was tested and **holds only for the latte theme**. The four themes' base→mantle
> lightness steps (WCAG relative luminance):
> - latte 0.065 (distinguishable), frappe 0.009, macchiato 0.006, mocha 0.004
>
> The latter three fall below the eye's ~3-5% discrimination threshold — after deleting
> outlines, dark-theme panels would blur together. §4 also explicitly forbids "changing
> the Catppuccin five-layer token architecture", yet darkening the dark bases is the
> only way pure tonal layering works in dark themes; the two conflict.
>
> Tested conclusion: of the 226 `--lab-panel-border` references, 49 are four-side
> borders; checked one by one, nearly all are **semantic borders** (input
> wells/controls/data regions/clickable cards/dividers), not decoration. Deleting the
> pilot's nav/inspector shell outlines was **the only truly safe layer to delete**, and
> it is done. Further deletions would break the dark themes. **This item is closed as
> "assessed; cannot be safely executed in full"** and no longer hangs as a TODO. If
> §4's Catppuccin constraint is ever relaxed, reopen it.

---

## §3 The common acceptance gate for every task

1. `pnpm vitest run` (relevant test files) all green; if the touched component has
   tests, run them first.
2. `node scripts/check-contrast.mjs` passes the four themes.
3. `pnpm vue-tsc --noEmit` adds no new errors (the existing 3 errors are in
   `AgGridTable.vue` ×2 and `agentSessionStorage.ts` ×1; they are legacy — do not fix
   them in passing).
4. Under the four themes (latte/frappe/macchiato/mocha), spot-check at least one light
   and one dark visually.
5. Every animation must carry a `prefers-reduced-motion` downgrade.
6. No unrelated refactors outside `src/components/visualization/` and
   `src/components/blocks/`; keep the diff minimal.

## §4 Explicitly not done

- Frosted glass (backdrop-filter) is not rolled out. The floating capsule-style
  overlays keep whatever treatment they shipped with; no new ones.
- No direction C (large radii/gradient meshes/organic shapes).
- The Catppuccin five-layer token architecture itself is untouched; only Layer 4 gets
  additions.
- Do not fix legacy vue-tsc errors in passing; do not write new docs (`docs/STATUS.md`
  updates are the human's call).
