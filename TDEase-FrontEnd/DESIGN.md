---
name: TDEase Celadon Mist
description: A lively assistant beside the mass-spec / proteomics researcher — warm, trustworthy, alive.
colors:
  # —— The Two Celadons ——
  # Celadon has two layers in the system, with strictly separated duties:
  #   1) brand-graphic glaze (--tde-celadon / --color-brand-accent): #6DB9C8
  #      A kiln-bright celadon reserved for graphics — spectrum peaks, progress bars,
  #      glows, live-channel pulses, the logo, the splash animation.
  #      Only 2.05:1 on paper; must NOT be used for text or solid buttons with white labels.
  #   2) text/primary lead voice (--tde-teal / --color-primary): #2A7483
  #      A deep petrol teal that carries all text, primary buttons, focus rings, status dots — 4.92:1 on paper, passes AA.
  # This mirrors the brand animation itself: peaks/progress/glows use #6DB9C8, all text uses ink #4A4D5C.
  sky-cyan: "#6DB9C8"            # brand-graphic glaze (graphics only)
  sky-cyan-hover: "#5AA9B8"
  sky-cyan-active: "#4A96A5"
  sky-cyan-raised: "#8ECBD6"
  sky-cyan-wash: "rgba(109, 185, 200, 0.12)"
  primary-teal: "#2A7483"        # text/primary lead voice (AA text/controls)
  primary-teal-hover: "#256F7D"
  on-accent: "#ffffff"
  lotus-pink: "#C9A3B4"
  lotus-pink-wash: "rgba(201, 163, 180, 0.12)"
  signal-amber: "#D89A5A"
  # —— Status vocabulary (canonical values after latte contrast correction) ——
  channel-green: "#4A9A5E"
  caution-ochre: "#C58A3A"
  alarm-red: "#C84A5E"
  telemetry-cyan: "#4A9EAE"
  status-queued: "#8A8D99"
  status-running: "#2A7483"      # AA guard: the running status dot is guarded by check-contrast.mjs and uses the petrol lead voice
  status-succeeded: "#4A9A5E"
  status-failed: "#C84A5E"
  status-cancelled: "#8A8D99"
  # —— Neutral (rice-paper misty surfaces) ——
  ink: "#4A4D5C"
  ink-secondary: "#5C5F6E"
  ink-muted: "#6E7180"
  ink-faint: "#9CA0B0"
  paper-base: "#F7F5F2"
  panel-mantle: "#EEEDE9"
  well-crust: "#E6E4DF"
  bench-shell: "#EDEAE6"
  panel-surface: "#EBE9E5"
  panel-raised: "#E0DDD8"
  control-surface: "#F0EEEA"
  control-hover: "#E5E3DE"
  control-active: "#D9D7D2"
  control-disabled: "#E2E0DB"
  seam-light: "#DDDAD5"
  seam-hairline: "#B8B5B0"
  seam-structure: "#8A8782"
  surface-0: "#D5D2CC"
  surface-1: "#C5C2BC"
  surface-2: "#B5B2AC"
  # —— Domain (scientific-data semantics; must not be borrowed by UI chrome) ——
  protein-blue: "#4A7FC9"
  peptide-mauve: "#8B6DB8"
  ptm-pink: "#C97AA6"
  massspec-green: "#4A9A5E"
  evalue-amber: "#D89A5A"
  confidence-sky: "#4A9EAE"
  ion-a: "#8B5FBF"
  ion-b: "#4A7FC9"
  ion-c: "#4A9EAE"
  ion-x: "#C97A3A"
  ion-y: "#4A9A5E"
  ion-z: "#B85A7A"
typography:
  display:
    fontFamily: "Inter, 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "calc(20px * var(--font-scale))"
    fontWeight: 600
    lineHeight: "calc(28px * var(--font-scale))"
  headline:
    fontFamily: "Inter, 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "calc(17px * var(--font-scale))"
    fontWeight: 600
    lineHeight: "calc(24px * var(--font-scale))"
  title:
    fontFamily: "Inter, 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "calc(15px * var(--font-scale))"
    fontWeight: 600
    lineHeight: "calc(22px * var(--font-scale))"
  body:
    fontFamily: "Inter, 'SF Pro Text', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "calc(13px * var(--font-scale))"
    fontWeight: 400
    lineHeight: "calc(20px * var(--font-scale))"
  label:
    fontFamily: "Inter, 'SF Pro Text', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "calc(11px * var(--font-scale))"
    lineHeight: "calc(14px * var(--font-scale))"
    letterSpacing: "0.06em"
  mono:
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, Monaco, monospace"
    fontSize: "calc(12px * var(--font-scale))"
    fontWeight: 400
    lineHeight: "calc(18px * var(--font-scale))"
rounded:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
spacing:
  space-1: "4px"
  space-1-5: "6px"
  space-2: "8px"
  space-2-5: "10px"
  space-3: "12px"
  space-4: "16px"
  space-5: "24px"
  space-6: "32px"
components:
  button-primary:
    backgroundColor: "{colors.sky-cyan}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "{colors.sky-cyan-hover}"
  button-primary-active:
    backgroundColor: "{colors.sky-cyan-active}"
  button-default:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "28px"
  button-subtle:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "28px"
  button-danger:
    backgroundColor: "{colors.alarm-red}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "28px"
  chip-filter:
    backgroundColor: "{colors.sky-cyan-wash}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "26px"
  chip-neutral:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "26px"
  field-input:
    backgroundColor: "{colors.control-surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "28px"
  panel-card:
    backgroundColor: "{colors.panel-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "16px"
---

# Design System: TDEase Celadon Mist

## 1. Overview

**Creative North Star: "The celadon sky awaits the misty rain."**

TDEase is no longer a cold instrument — it is a lively assistant seated beside the researcher. She is gentle, trustworthy, and alive — like Ru-kiln celadon waiting in the misty rain for its firing, like ink blooming on rice paper, like a knowledgeable Jiangnan woman quietly handing you the answer just when you need it.

A researcher sits in front of it for hours at a time: letting the Agent run an identification pipeline, orchestrating workflows on the canvas, studying spectra to make judgments. The interface's first duty is to **make people feel at ease**; its second duty is to make "what is moving" visible at a glance while the system runs. The whole interface is matte, neutral, and rhythmic — only "living" channels (running tasks, streaming output, pending approvals) are granted soft glows and breathing animations.

Aesthetically it inherits three bloodlines: the warm hue of Ru-kiln celadon, the whitespace and layering of Jiangnan gardens, and the decisive feedback of modern assistant interfaces. Density is a virtue — scientific data needs density, but there must be a breathing rhythm between densities. The conversation is not a chat window; it is an extension of the researcher's train of thought: a centered 720px conversation column, with tool cards gathered into a 348px rhythm.

This system explicitly rejects: SaaS landing-page clichés (hero numbers, marketing eyebrows, gradient text), "chain-link fence" interfaces (rigid panels where every hierarchy is divided by 1px outlines), the whole AI-slop bundle (decorative frosted glass, oversized radii, uniform card grids, emoji icons), and all decoration that is lively for liveliness's sake — liveliness may only come from light and motion, never from stickers.

**Key Characteristics:**
- Matte neutral chrome + celadon accent; color belongs only to data and status
- Four token layers + a reconciliation glaze: components reference semantic tokens only; raw material (`--ctp-*`) never enters chrome
- The yellow family is shifted wholesale to amber-ochre — no lemon-yellow/neon exists in any theme
- Two voices: celadon lead voice (action) + interaction harmony (response), two independent timbres
- Misty layering instead of lines; outlines are reserved for true structural seams
- Density first but with breathing room: 28px controls, 13px body text, 4px grid (with 6px/10px half-steps)
- Light and motion are granted only to "living" states; the resting interface stays quiet
- Tabular numerals are the first typographic discipline of a scientific tool
- Five isomorphic themes: celadon (default · light · warm rice-paper) / latte (standard Catppuccin · light · cool) / frappe / macchiato / mocha (dark); WCAG AA is mechanically enforced by script
- Component discipline: every radius, spacing, shadow, and frosted-glass effect must come from tokens

## 2. Colors

The palette's character: a workbench covered in rice paper, with a celadon lamp upon it.

### Palette Architecture (Three Layers · Direct CTP Supply)

Color flows through three token layers, and **the official Catppuccin palette does the real work — each theme has its own flair**:

1. **Layer 1 — Official palette (`--ctp-*`)**: the full 26 colors (rosewater/flamingo/pink/mauve/red/maroon/peach/yellow/green/teal/sky/sapphire/blue/lavender + text/subtext/overlay/surface/base/mantle/crust) × 4 standard themes. These are the official values from [catppuccin.com/palette](https://catppuccin.com/palette/), untouched. celadon inherits the latte chromatic colors and only overrides the neutral surfaces with a warm rice-paper tone. **Appears only inside `unified-design-tokens.css`**.
2. **Layer 2 — Semantic tokens (`--color-*`)**: reference official CTP colors directly. `--color-primary: var(--ctp-teal)`, `--color-interact: var(--ctp-rosewater)`, `--color-success: var(--ctp-green)`, etc. Each theme uses its own official colors — latte's teal is `#179299` (deep teal), mocha's is `#94e2d5` (mint); they look completely different.
3. **Layer 3 — Domain tokens (`--domain-*`)**: scientific-data semantics, supplied directly from CTP.

**AA strategy**: chromatic colors on dark themes (frappe/macchiato/mocha) naturally pass AA on dark surfaces, so they are supplied directly. The official light colors on light themes (latte/celadon — rosewater/peach/yellow/green/sky) cannot reach 4.5 on light surfaces — use `color-mix(in srgb, var(--ctp-X) 30%, var(--ctp-text))` to pull them toward the text color; **the hue family stays the same, only darkened to AA**. Semantic colors used for text have `-text` variants (`--color-success-text`, etc.); non-text uses (borders/fills/charts) use the original color.

**Two voices**: `--color-primary` (the action voice, ctp-teal) + `--color-interact` (the response voice, ctp-rosewater). rosewater is each theme's official warm color — latte `#dc8a78` (warm orange), frappe `#f2d5cf` (light pink), mocha `#f5e0dc` (warm pink). The primary/interact split gives "the system is acting" and "the system is responding" independent timbres.

> **Consolidation discipline**: the total token count was cut from 437 to ~265. Any new token must: (1) not be a pure alias of an existing token; (2) have at least one real reference; (3) have a prefix belonging to one of the four layers above. Meaningless `var(--A, var(--B))` fallbacks are forbidden — if A is always defined, the fallback never fires. The one explicit exemption: the `--line-*` seam family (§4 The Seam Contract) shares values with the border family but has an independent role — adjusting lines wholesale must not drag control outlines along, and vice versa.

### Two Light Themes

The two light themes share the same chromatic raw material (official latte colors) but differ in neutral surfaces:

- **celadon (default)**: warm rice-paper white (`#F7F5F2`) + warm ink text (`#4A4D5C`). TDEase's own gentle light theme — warmed neutral surfaces, chromatic colors remain official CTP latte.
- **latte (standard Catppuccin)**: CTP cool white (`#eff1f5`) + blue-gray text (`#4c4f69`). Catppuccin latte as-is — cool neutral surfaces + official chromatic colors.

Switching celadon↔latte shows the warm/cool neutral-surface difference; chromatic colors stay consistent official CTP latte.

### Primary (Action · ctp-teal)
- **`--color-primary` → `var(--ctp-teal)`**: the official teal. Primary buttons, run indicators, live glow, drag, checkbox. Each theme has its own flair: latte `#179299` deep teal → mocha `#94e2d5` mint.

### Interact (Response · ctp-blue)
- **`--color-interact` → `var(--ctp-blue)`**: **CTP Style Guide official: Links, URLs, Tags, Pills = Blue**. This is the blue textual anchor latte was missing. Links, selected text, and tags are all blue — latte `#1e66f5` (assertive blue), mocha `#89b4fa` (soft blue).
- **`--color-interact-text`**: blue darkened to pass AA on light themes (`color-mix(blue 80%, text)`); supplied directly on dark themes.
- **`--color-selection-bg`**: Overlay 2 @ 25% (official CTP Selection Background).

### Hover (Alive · ctp-rosewater)
- **`--color-hover` → `color-mix(rosewater 8%, bg)`**: **CTP Style Guide official: Cursor = Rosewater**. Hover tints with each theme's rosewater warmth — latte `#dc8a78` (terracotta warmth), mocha `#f5e0dc` (warm pink). Lively, not rigid.

### Ring (Focus · ctp-lavender)
- **`--color-ring` → `var(--ctp-lavender)`**: **CTP Style Guide official: Active Border = Lavender**. All focus-visible outlines. latte `#7287fd` (lavender) → mocha `#b4befe` (pale lavender).

### Status (Official CTP Semantics)
- **Success = Green**, **Warning = Yellow** (not peach), **Error = Red**, **Info = Teal**.
- Light-theme light colors cannot pass AA; use `-text` variants (`color-mix(X N%, text)`) darkened. Dark themes supply directly.

### Live (Living-Channel Color)
- **`--color-live` → `--color-primary`**: the carrier of the Living Channel Rule. Glows, pulses, and flowing animations belong only to running, streaming, or pending elements.

### Domain (Scientific-Data Semantics)
- Entities: Protein (ctp-blue), Peptide (ctp-mauve), PTM (ctp-pink), Mass-spec (ctp-green), E-value (ctp-peach), Confidence (ctp-sky).
- Fragment ions (`--domain-ion-a/b/c/x/y/z`).
- **Ink** (`--color-text` `#4A4D5C`): body text, warmer than pure black.
- **Ink Secondary / Muted / Faint**: a three-step ladder for secondary/de-emphasized/disabled text.
- **Paper** (`--color-bg` `#F7F5F2` → `--color-bg-secondary` → `--color-bg-tertiary`): three surface brightness steps.
- **Seam outlines** (`--color-border` → `--color-border-hover` → `--color-border-active`): outlines are a scarce resource, allowed only in the structural-seam sense. Panel-specific outline `--color-border-panel` (light `#857F76` / dark `#9A9792`).

### Named Rules
**The Living Channel Rule.** Only "living" states get to glow. Glows, pulses, and flowing animations belong only to running, streaming, or pending elements; the resting interface stays matte and quiet. Adding a glow to a static panel is like sticking a fluorescent sticker on rice paper — forbidden.

**The Domain-Color-Is-Data Rule.** Color is the property of data, not a toy for chrome. Ion types, confidence, and run states have a fixed vocabulary; the interface shell stays neutral. A domain color appearing on chrome is treated as a bug — it pollutes the user's reading of the data.

**The One Voice Rule.** In any single screen, primary celadon should have only one "loudest" voice (one primary button, or one run indicator). Three solid celadon buttons on one screen means the information architecture is wrong — not that the palette is insufficient.

**The No-Raw-Color Rule.** Components, element-plus, and vueflow must reference semantic tokens (`--color-*` / `--radius-*` / `--font-*` / `--domain-*`, etc.) and never raw `--ctp-*` material directly. `--ctp-*` is allowed only inside `unified-design-tokens.css`. Raw material leaking in is treated as an architecture leak.

## 3. Typography

**Display Font:** Inter (variable, bundled locally, falls back to SF Pro Display / system sans)
**Body Font:** Inter (same family, falls back to SF Pro Text)
**Label/Mono Font:** JetBrains Mono (400/500 two weights, bundled locally, falls back to Fira Code / Consolas)

**Character:** a single humanist sans + an engineering mono, like crisp handwriting on rice paper: no performing, no coyness. Inter carries all interactive text; JetBrains Mono carries all readouts (m/z, paths, IDs, logs). Local bundling is deliberate — scientific tables must render identically offline and on machines without Inter.

### Hierarchy
Seven steps multiplied by the global `--font-scale` (0.85–1.4 user scaling); line-height scales equally, so vertical rhythm is unchanged:
- **Display** (600, 20px, lh 28px): empty-state titles, page-level titles. Nothing in the workbench is larger — hero typography belongs to landing pages.
- **Headline** (600, 17px, lh 24px): document/panel titles.
- **Title** (600, 15px, lh 22px): card titles, section titles.
- **Body** (400, 13px, lh 20px): all body and control text; comfortable density. Compact density drops to 12px. Long descriptive text is limited to 68ch.
- **Label** (11px, lh 14px, +0.06em tracking, all caps): section labels, table headers, chip text, applied by `.text-label`.
- **Mono** (400, 12px, lh 18px): all readouts and identifiers.
- (A dedicated `10px` step exists for canvas-node metadata only — restricted to node-graph chrome, never to spill into ordinary UI.)

### Named Rules
**The Tabular Figures Rule.** Any number that updates, aligns, or stacks in columns must use `tabular-nums` (`.numeric` / table cells have it built in). A column of readouts jittering left and right on refresh is the most basic betrayal of trust a scientific tool can commit.

**The Seven-Slot Rule.** The type scale has exactly seven steps; adding one requires deleting one first. When you feel "a step is missing in between", first check whether weight or color should be used instead of a new size.

## 4. Elevation

This system uses **misty tonal layering**; shadows are auxiliary. Hierarchy is expressed through a soft ladder of surface brightness — base → mantle → crust goes down, surface0 → surface1 → surface2 goes up. In the latte light theme, floating up is assisted by shadows; in dark themes shadows are inverted to zero, replaced by brighter surfaces plus a hairline — a shadow on a dark surface reads as a stain, not elevation.

### Shadow Vocabulary
- **elev-1** (`0 1px 2px 0 rgba(0,0,0,0.04)`, latte): the lightest lift for static cards and panels.
- **elev-2** (`0 4px 8px -1px / 0 2px 4px -2px rgba(0,0,0,0.08)`, latte): hover, dropdowns.
- **elev-3** (`0 10px 16px -3px / 0 4px 6px -4px rgba(0,0,0,0.08)`, latte): popovers, menus.
- **elev-4** (`0 20px 28px -5px / 0 8px 10px -6px rgba(0,0,0,0.08)`, latte): modals.
- **Panel shadow** (`0 10px 24px rgba(0,0,0,0.14)`): floating panels.
- **Overlay shadow** (`0 8px 24px rgba(0,0,0,0.18)`): canvas/run floating documents — denser than a panel, lighter than a modal.
- **Focus ring** (`0 0 0 2px`, 35% transparent ring color): the focus halo — the light of "attention", not decoration.
- **Dark themes (frappe/macchiato/mocha)**: elev-1..4 shadows are all `none`; backgrounds become progressively brighter surface0 blends; elev-1/2 gain the `--hana-panel-border` hairline, elev-3/4 gain `--hana-panel-border-strong`.

### Named Rules
**The Tonal Layering Rule.** Hierarchy comes from the brightness ladder; outlines are reserved for structural seams. If two panels are merely a "logical grouping", change brightness; only true structural boundaries (between a floating layer and the canvas, between a control and its container) deserve a 1px hairline. If you find yourself adding both a shadow and an outline to a static card, stop — pick one.

**The Dark Inversion Rule.** Dark themes must not express elevation with shadows: shadows go to zero; elevation = brighter surface + hairline. Code like `box-shadow: 0 4px 12px rgba(0,0,0,0.4)` on mocha gets rejected outright.

**The Seam Contract.** Every layout line must come from the `--line-*` family; the criterion is "role", not "looks nice":

| Lane | Token | Qualifying question |
|---|---|---|
| Structural seam | `--line-seam` · `--line-w` (1px) | Do two surfaces of **different roles** meet here? (split-view seams, header/footer seams, floating-layer borders, drag handles) |
| Content hairline | `--line-hairline` · `--line-w` (1px) | Does this line **belong to the document content being read**? (markdown tables/code blocks, viewer inner frames, ag-grid row lines) |
| Semantic stripe | semantic color or seam · `--line-stripe-w` (2px) | Is this a **left-edge type marker**? (quotes, thinking, tool-group muted markers, artifact card domain colors; width is uniformly 2px — do not invent 1px/3px) |

Three exempt lines: **control outlines** (AppButton/Chip/inputs/segmented controls) use the `--color-border*` control vocabulary; **data-layer lines** (spectrum annotations, warning dashes, grids) use the domain vocabulary, and dashed lines are allowed only in the data layer; **a callout is a card, not a stripe** — full border + tinted surface, with only a 1px same-frame tint allowed on the left edge. `--line-*` shares values with the border family but has an independent role (this is the explicit exemption to the consolidation discipline's "pure-alias ban": the two vocabularies must be independently adjustable wholesale). Before adding a new line, answer the qualifying question first; a line that cannot be answered for probably should not exist.

## 5. Components

### Buttons
- **Shape:** soft radius (8px), flat and tactile; two heights: standard 28px, compact 24px; horizontal padding 12px / 8px.
- **Primary:** solid Sky Cyan + white label (dark themes flip to a dark crust label). hover/active darken along the same hue (`#5AA9B8` / `#4A96A5`), 90ms `ease-out` transition — decisive yet gentle feedback; no hesitating gradient theatrics.
- **Default:** Control Surface fill + hairline outline; hover darkens and shifts the outline 42% toward cyan.
- **Subtle (ghost):** fully transparent + de-emphasized text; hover reveals a Control Hover fill. The default form inside toolbars.
- **Danger:** solid Alarm Red; semantically reserved for irreversible actions.
- **Focus:** global 2px `--color-ring` outline, offset 2px; keyboard accessibility is a release gate.
- **Loading:** **width never changes** — the label is hidden, not unmounted; the spinner borrows the space the label reserved.

### Chips
- **Style:** 24px tall, 8px radius, 12px text; one neutral shape, only the fill semantics change: filter (cyan 12% wash + cyan 40% outline), dimension (transparent + structural outline + de-emphasized text), binding (cyan 10% fill, same source as the AI user bubble), neutral (control surface).
- **State:** when pinned, the outline is cyan 55%; pin/remove are inline icon buttons whose fill appears on hover. Radius stays 8px — a chip is not a pill.

### StatusMark (signature component)
The only legal renderer of run state, and the most frequently repeated visual element in the product. Each state = a distinct **shape** + hue, readable by the color-blind: queued is a hollow ring, running a 270° rotating arc, succeeded a solid disc + check, failed a solid disc + cross, cancelled a solid disc + slash. `stale` overlays a 6% hatched shadow — it is a fact about "freshness", not a sixth state. Under reduced-motion the rotating arc degrades to a slow breath but **never degrades into a hollow ring**. No document component may invent a second run-state icon.

### Inputs / Fields
- **Style:** Control Surface fill, 8px radius, 1px inset hairline outline (a `box-shadow` inner stroke, not a border).
- **Focus:** the inset stroke becomes 1px primary + a 35% transparent ring halo — focus is the assistant looking up at you.
- **Label:** an 11px all-caps label above the control, secondary ink; the required asterisk uses Alarm Red.
- **Error:** label and error text (12px) turn Alarm Red; error text carries `role="alert"`. Field components force-wire `id` / `aria-describedby` / `aria-invalid` through scoped slots — accessibility is guaranteed by construction.

### Cards / Containers
- **Corner Style:** panels 12px, floating documents/modals 16px. Nothing rounder.
- **Background:** Panel Surface (`#EBE9E5`); floating layers use Panel Raised or the next step up the brightness ladder.
- **Shadow Strategy:** see Elevation — latte uses elev-1..4; dark themes use brightness + hairline.
- **Border:** none by default; only structural seams may use `seam-hairline` 1px.
- **Internal Padding:** 16px (`--space-4`) as the baseline; dense panels may drop to 12px.

### Empty States
An icon (32px, faintest ink) + a one-line title (Display step) + one paragraph (≤68ch) + **exactly one** primary button. An empty state is guidance, not a shrug; there is never a second action, and never a four-character "no data yet" to brush the user off.

### Motion (across all components)
Enter decelerates (`ease-out` cubic-bezier(0.2,0,0,1)), exit accelerates (`ease-in` cubic-bezier(0.3,0,1,1)), movement has both (`ease-inout`); durations come in four steps — 90 / 140 / 220 / 320ms — and **nothing may exceed 320ms**.

**Breath animation** — belongs only to "living" states:
- 3s period, `ease-in-out` infinite
- opacity or box-shadow oscillates between 0.25 ↔ 0.55
- used for: running turns, streaming output cursor, permission cards awaiting approval

A global `prefers-reduced-motion` fallback already exists; every new motion effect must provide a degradation.

## 6. Glassmorphism

Frosted glass is the modern transposition of the "misty rain" imagery, but it must be disciplined.

### Allowed contexts
- Floating Composer card
- Toast / Notification
- Popover / Dropdown backgrounds
- Modal overlays

### Forbidden contexts
- Ordinary buttons
- Input / Field
- Static cards
- Table rows
- Navigation buttons

### Specification
- Background opacity: `rgba(247, 245, 242, 0.72)` (latte) / the corresponding dark-theme value
- Backdrop blur: `blur(12px)`
- Must be paired with a 1px hairline border, otherwise the edge melts into the background
- Text on top must satisfy WCAG AA; when it does not, raise the background opacity

## 7. Do's and Don'ts

### Do:
- **Do** keep only one loudest primary-cyan voice per screen (The One Voice Rule). Mind the two celadons: primary buttons use the petrol lead voice `#2A7483` solid (with white label, passes AA); hover only darkens, never shifts hue (90ms ease-out); the bright celadon `#6DB9C8` (--tde-celadon) is for graphics only — spectrum peaks, progress bars, live-channel glows, the logo, the splash mass-spec animation — never for text or solid buttons.
- **Do** layer with misty tones: base `#F7F5F2` → mantle `#EEEDE9` → crust `#E6E4DF`; floating up goes surface0→2 up the reverse ladder (The Tonal Layering Rule).
- **Do** apply `tabular-nums` to every number that stacks in columns or refreshes (The Tabular Figures Rule).
- **Do** render run states with StatusMark, double-encoded as shape + text; `stale` uses a hatched overlay, not a new color.
- **Do** keep 28px control height, 8px control radius, 4px grid (with 6px/10px half-steps); compact density 24px/12px is a legal step.
- **Do** use the contrast-corrected tokens on the latte theme; all four themes must pass `scripts/check-contrast.mjs`.
- **Do** build new motion on the `--dur-*` / `--ease-*` four steps and provide a `prefers-reduced-motion` degradation.
- **Do** take all radii from tokens: `--hana-radius-xs/sm/md/lg` (4/8/12/16px).
- **Do** restrict frosted glass to floating layers; ordinary controls get no `backdrop-filter`.

### Don't:
- **Don't** use SaaS landing-page clichés (hero numbers, marketing eyebrows, gradient text) — there is no hero in the workbench; the largest type is the 20px Display step.
- **Don't** build "chain-link fence" interfaces: rigid panels where every hierarchy is divided by 1px outlines. Outlines are reserved for structural seams; use brightness for grouping.
- **Don't** touch the AI-slop bundle: decorative frosted glass, oversized radii, uniform card grids, emoji icons. backdrop-filter, 999px pills, rainbow card walls — all forbidden.
- **Don't** add decoration that is lively for liveliness's sake: liveliness may only come from light and motion, not stickers. Glows, pulses, and floating animations on static elements are stickers (The Living Channel Rule).
- **Don't** wear domain colors (protein blue, peptide mauve, signal amber) on chrome; the color of data is domain semantics (The Domain-Color-Is-Data Rule).
- **Don't** express elevation with shadows in dark themes — shadows go to zero; brighter surface + hairline (The Dark Inversion Rule).
- **Don't** let loading change button width; the label is hidden, not unmounted (the price of the Fixed-Footprint rule is layout stability).
- **Don't** add an eighth type step, a second run-state icon, or a second `el-button` wrapper — delete the old one first, then add the new.
- **Don't** use `border-radius: 999px` (true circles use `50%`, and only for dots/avatars).
