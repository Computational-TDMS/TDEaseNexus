# TDEase Visual-System Rollout Plan (execution edition)

> **Pruned 2026-10-12.** The rollout checklist (§2 execution order, §3
> acceptance gate, §4 closing record) is archived at
> `archive/docs-prune-2026-10-12/docs/design/VISUAL-ROLLOUT-PLAN-archived-sections.md`
> — every phase in it is done, assessed-closed, or tracked elsewhere. The
> binding conventions moved to `TDEase-FrontEnd/DESIGN.md` §8 (Engineering
> conventions). What remains here is the pointer to the reference
> implementation.

Strategy: `../../TDEase-FrontEnd/PRODUCT.md`; the full visual rules:
`../../TDEase-FrontEnd/DESIGN.md` (§8 carries the former §1 core conventions).
Single source of truth for design tokens: `src/styles/unified-design-tokens.css`.

## The completed reference implementation (do not redo)

The Agent conversation surface is the reference implementation of the visual
system — follow it first; on conflict, the pilot wins:

- `src/components/agent/AgentPage.vue` — Composer anchor container, edge indicator
  (the acting state uses `--color-live` + glow)
- `src/components/agent/Composer.vue` — floating control: `var(--elev-2-bg)` +
  `var(--elev-2)` shadow, no outline
- `src/components/agent/PermissionCardDock.vue` — the approval card as an overlay
  (`position: absolute; bottom: 100%`)
- `src/components/agent/SessionBar.vue`, `Transcript.vue` — tonal layering, no
  hairline outlines
- `src/components/primitives/StatusMark.vue` — running-state breathing halo
- `unified-design-tokens.css` Layer 4 — `--color-live` / `--color-live-glow` defined

## Alternatives considered

- **Globalize tonal layering across all four themes**: lost — physically
  impossible without violating the Catppuccin constraint (luminance analysis in
  `DESIGN.md` §8's closed record); the pilot's shell outlines were the only
  safe deletion.
