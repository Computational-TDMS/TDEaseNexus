---
title: Product Agent CLI harness
date: 2026-08-10
module: ai-harness
problem_type: acceptance
component: testing
---

# Product Agent CLI harness

`agent:harness` is the only real-model Agent capability harness. It builds and
runs `electron/dist/agent-harness.cjs`, which constructs the production
`createAgentRuntime` with the registered tools, deployed System assets and the
caller-provided Workspace.

In development it resolves the Scientific System through the same
`config/components.dev.json` component manifest as Desktop. `data/system` is
mutable installation state and is never the default product Skill source.
Writable profile assets are not merged into the product catalog; user Skills
belong to the Workspace `.tdease/skills` surface.

It has no task catalog, preset scientific prompt, frozen answer, replay path or
scorer. The caller supplies the same prompt a product user would supply.

```powershell
pnpm run agent:harness -- --workspace <workspace> --prompt "<user request>"
```

The wrapper accepts no runtime-policy overrides. It resolves product settings,
the registered Workspace id, component roots and the default model exactly as
the Desktop composition does, then binds Explorer with auto authority and the
normal Agent tool settings. Any approval request is denied and fails the run.
Evidence is currently absent from the product Agent runtime itself, so Harness
and Desktop expose the same parent and subagent tool surface.

The JSON `HarnessSummary` reports only turn outcomes, observed tool names,
failed-tool count and model usage. Scientific correctness remains visible in
the session record and generated Workspace artifacts; the Harness has no
ownership ledger, storage scanner, result hasher or second evaluator.
