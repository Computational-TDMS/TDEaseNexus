---
type: design
title: Model/provider seam & usage accounting
description: Model capability resolution precedence, the provider credential/atomic-write seam, custom providers, the usage ledger and its aggregate surfaces.
status: implemented
---

# Model/provider seam & usage accounting

> Everything between "a provider credential exists" and "a resolved model runs
> in a session, and its consumption is counted" — `electron/agent/model-capabilities.ts`,
> `electron/agent/model-catalog-refresher.ts`, `electron/atomic-write.ts`,
> `src/ai/core/usage-ledger.ts`, `src/ai/core/usage-stats.ts`.

## Capability resolution: one seam, explicit precedence

`model-capabilities.ts` is the one layer a resolved model crosses into a
session. Precedence, highest first:

1. settings metadata (`providers.<id>.models.<modelId>`, the frozen per-model
   facts — a hand edit outranks every layer below);
2. API-verified family corrections;
3. the models.dev catalog card (warm cache, digested by the refresher);
4. the standard conservative map.

Semantics are CEILING: an unsupported thinking level resolves DOWNWARD, never
promoted. The catalog refresher digests models.dev per-model facts (reasoning /
modalities / limits / cost) into its warm cache; SessionHost freezes the
answer into settings.json through the registry's atomic `persistModelMeta`
(field-level merge — sibling models and sibling fields are never clobbered).

## settings.json is written through one seam

`electron/atomic-write.ts` is the one serialized read-modify-write seam for
settings.json (per-path queue + Windows rename retry). Provider credentials,
MCP config, sharing config, model digests and per-model pricing all route
through it — no second writer exists. A credential clear keeps the provider's
`models` map (frozen digests survive); deleting a whole custom provider entry
is the distinct operation that takes them away.

## Custom providers

User-defined OpenAI-compatible endpoints live under `providers["custom-*"]`
(name, api `openai-completions`, baseUrl, apiKey). The settings store projects
them as synthetic catalog entries, so every picker (General settings, agent
tabs, composer conversation label) sees them without per-surface wiring; the
runtime needed no changes (the provider registry resolves any settings.json
providers key). Settings surface: create dialog, "Custom" list badge,
name/baseUrl/key editing, manual model-id entry (sibling-safe
`settings:add-provider-model`), whole-entry delete
(`settings:delete-agent-provider`), and local-inference presets (LM Studio /
llama.cpp / vLLM / Jan) that prefill name+baseUrl.

**Endpoint validation** (`src/services/catalog/provider-endpoint.ts`, one
shared core): operation-endpoint pastes (`/chat/completions`, `/responses`,
`/messages`, `/models`) are trimmed to the service root with a visible "saved
as" preview; inline credentials, query strings and fragments are rejected with
a per-reason message; the detail editor disables save while the URL is invalid.

**Test connection** (`settings:test-provider` → the refresher's `test()`)
probes the provider's own listing endpoint with its stored credential — 8 s
timeout, no cache write, no models.dev fallback (it tests the user's endpoint,
not the aggregator) — and renders a typed verdict: configuration faults named
with zero wire traffic (`no_key` / `no_config` / `unsupported`); wire faults
mapped to unauthorized / rate_limited / not_found / server / timeout / network.
A save invalidates the verdict. Live `/models` discovery works against the
stored config. Removing the active custom provider falls back to the default
pair.

**Per-model pricing**: custom providers may declare a per-model `cost`
(USD/1M tokens) in the provider detail. It rides the EXISTING chain —
`providers.<id>.models.<modelId>.cost` → `resolve().modelMeta` →
`toCostRates` → ledger `costTotal` — through the sibling-safe
`settings:set-provider-model-pricing` IPC (null clears; unregistered models
are rejected, no ghost entries), so cost statistics are real for
OpenAI-compatible relays and local servers.

## Usage ledger

The ledger is bounded and honest about it: FIFO cap 20,000 entries (inside the
blast radius of a heavy daily driver's "30d" range); persistence is debounced —
a streaming burst coalesces into ONE atomic minified rewrite, reads stay exact
from memory, `clear()` flushes inline, and `before-quit` flushes the tail.
`UsageStats.oldestAt` feeds a coverage line ("data since …") in the statistics
panel, so a bounded ledger is declared, never silent.

## Aggregation happens in the main process

Every consumption number comes from `usage-ledger:stats`: the main process
aggregates the FULL ledger through the pure core `src/ai/core/usage-stats.ts` —
consumption counts ok-only with attempts/errors in the denominator, weighted
cache hit, per-bucket trends (hourly for the 5h/today ranges, daily otherwise,
capped at 90 days for "all"). No vendor quota is fabricated, and no
renderer-side capped-page under-count exists.

Surfaces on that one IPC:

- **StatisticsPanel** — range tabs 5h/today/7d/30d/all over range-scoped hero
  cards (tokens / cost / requests / cache hit / error rate / avg output tok/s);
  a token-composition strip (input/output/cacheRead/cacheWrite over the
  ledger's own four-term algebra; reasoning annotates the legend as a vendor
  subset of output, never a fifth segment); trend bars with a
  tokens/cost/requests metric toggle; by-provider and by-model distributions
  with requests and cost columns; a newest-first recent table (cost + duration
  columns); JSON export of the scoped raw entries plus CSV export (BOM, quoted
  cells); a two-step clear (`usage-ledger:clear`).
- **ContextUsagePanel** (the composer's context ring; always-on, warning at
  ≤25% remaining, critical at ≤10%) — remaining tokens + %, window usage, the
  latest settled request's total + generation speed (tokens/s), its
  provider-reported breakdown (input/output/reasoning/cache read/hit
  rate/cache write, shown only when reported), cache hit rates (latest +
  recent weighted ratio), and the ledger's 5h/7d windows with real cost. It
  rides the same IPC with a debounced live subscription, so a panel held open
  across a turn settles with the ledger instead of freezing at mount-time
  numbers.

## Alternatives considered

- **Renderer-side aggregation over the in-memory page** — lost: the renderer
  sees a capped slice, so every total under-counted exactly when usage was
  heavy; the main process owns the full ledger and the aggregates.
- **Unbounded ledger** — lost: memory and persistence cost grow with every
  turn forever; the FIFO cap plus a visible coverage line keeps the bound
  declared instead of silent.
- **Fabricated vendor quota meters** — declined: providers do not expose a
  trustworthy spend API uniformly; showing invented percentages would break
  the "measured data only" rule the context popover is named for.
