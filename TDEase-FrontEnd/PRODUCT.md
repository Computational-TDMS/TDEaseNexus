# Product

<!-- impeccable:product-schema 1 -->

## Register

product

## Platform

web

(Electron desktop app; the rendering layer is a Vite + Vue 3 SPA; the window is resizable; there is no mobile form.)

## Users

The primary users are researchers in proteomics / mass spectrometry. They sit at the bench analyzing experimental data, with sessions lasting hours at a time: letting the Agent pick and run analysis workflows, studying spectra and evidence charts to make judgments. They are not "browsing" — they are working alongside a trusted assistant. The interface's first duty is to reassure and not disturb; its second duty is to make "what is moving" visible at a glance while the system runs.

## Product Purpose

TDEase is an AI-first analysis workbench for top-down mass-spectrometry and proteomics research. The researcher describes an analysis goal; the Agent selects a template and managed capabilities, configures and validates the native workflow, submits a Run, supervises execution, and helps inspect the results — the journey from raw MS data to an explainable conclusion never leaves one window. Success looks like: users trust this interface the way they trust a gentle, professional research assistant — precise readouts, transparent state, predictable responses, and never cold.

## Positioning

The conversation is not a chat window; it is an extension of the researcher's train of thought — a lively assistant working alongside research data. The primary path is intent → Agent → verified Run → inspectable result, and the Run is the primary operational object: the Agent — not the user — assembles, dry-runs and verifies the native workflow before anything executes, and its template, dry-run and execution facts stay inspectable. A neighboring workflow tool cannot truthfully copy that coupling of agent autonomy with native, user-owned workflows. It refuses to be: a node editor requiring visual workflow construction; a parameter-wizard maze exposing engine config before user intent; a card-grid dashboard competing with the real results; opaque AI.

## Operating Context

Hours-long bench sessions on a Windows desktop install, beside the researcher's own folders: raw MS data, scripts, documents and results live in ordinary user-owned files the app never walls off; advanced users are never forced out of the workbench to reach them.

## Capabilities and Constraints

- Primary path: intent → Agent → verified Run → inspectable result. The Run is the primary operational object; workspace files stay user-owned and native.
- The Agent selects templates and managed capabilities (served by `/api/capabilities`) and validates a workflow with a dry-run before commit; it never hides its template, dry-run or execution facts.
- Orchestration runs on the Snakemake engine behind the Python/FastAPI backend; the mass-spec kernel is Rust (`tdeasenexus-toolbox`). Wire contracts live in `docs/spec/`.
- Shared vocabulary: Run, template, capability, dry-run, Published Results, workspace.
- Open decision (2026-09-10): the installed exe/data-directory name `TDEaseNexus` may still be renamed; a rename moves the install dir, exe and data root, so it is deliberately deferred.

## Brand Commitments

**Name and lockup.** User-visible surfaces read **TDEaseNexus · TD通** (window title, splash wordmark, welcome page, tray; the Chinese name renders in a kai face). The installed artifact keeps the name **TDEaseNexus** (installer, appId, exe, data directory) until a rename is decided. **TDEase** is repo/docs shorthand, not a user-facing wordmark. The app icon is the celadon tile logo the boot splash draws. The brand intro on splash and Welcome is the fixed sentence **"Your 24/7 assistant for top-down MS data analysis"** — one positioning sentence everywhere, not paraphrased per surface.

**Personality — gentle, trustworthy, lively.**

Reference: the restraint and whitespace of "the celadon sky awaits the misty rain", the gentle reliability of a Jiangnan woman, openhanako's sense of breathing and life, the matte texture of rice paper and Ru-kiln celadon. Voice and tone: a knowledgeable research assistant — no cuteness, no marketing speak, no imperatives.

**Anti-references.**

- SaaS landing-page clichés (hero numbers, marketing eyebrows, gradient text)
- "Chain-link fence" interfaces: rigid panels where every hierarchy is divided by 1px outlines
- The AI-slop bundle: decorative frosted glass, oversized radii, uniform card grids, emoji icons
- Decoration that is lively for liveliness's sake: liveliness may only come from light and motion, not stickers
- Cold-instrument feel: a static interface should not feel like an indifferent machine

## Design Principles

1. **Gentle trustworthiness over spectacle** — familiarity and reassurance come before visual stimulation; standard affordances are not reinvented for flavor.
2. **Light and motion belong only to "living" states** — running, streaming, and pending elements get glows and motion; the resting interface stays quiet.
3. **Misty layering instead of lines** — hierarchy is expressed through a soft ladder of surface brightness; outlines are reserved for true structural seams.
4. **Breathing comes from rhythm, not emptiness** — scientific data needs density, but controls and panels keep a proper cadence between them.
5. **The color of data is domain semantics** — ion types, confidence, and run states have a fixed vocabulary; the interface chrome itself stays neutral.
6. **Component discipline is the precondition of style** — radii, spacing, shadows, and frosted glass must come from tokens; inventing new forms ad hoc is not allowed.

## Evidence on Hand

Paths are repo-root relative.

- `docs/paper/` — research artifacts and manuscript drafts (frozen figures in `docs/paper/SOFTWARE-FACTS.md`); never marketing claims, never an Agent capability or prompt source.
- `docs/EXPLORATION-LOG.md` — the real scientific loop record (hypothesis → run → verdict); a process record, not marketing material.
- `data/` — simulates a real client installation during development; never a source of truth.
- No testimonials, case studies, benchmarks, press or user quotes exist. None may be invented.

## Accessibility & Inclusion

WCAG AA is the floor, mechanically enforced by `scripts/check-contrast.mjs` across the four themes (latte/frappe/macchiato/mocha). A global `prefers-reduced-motion` fallback already exists; every new motion effect must provide a degradation. Keyboard accessibility is a release gate (the ARIA tabs pattern in DocumentTabs — roving tabindex, arrow keys, visible focus ring, tab↔panel association — is already in place).
