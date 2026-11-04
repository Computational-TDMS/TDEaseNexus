---
title: "UniProt query capability — comparison with the official-site contract and the pass-through layers"
date: 2026-08-02
module: native-capabilities
problem_type: reference
component: reference_commands
severity: advisory
applies_when:
  - You need to know what TDEase's uniprot query can and cannot do
  - Extending uniprot.query parameters (fields/sort/includeIsoform…)
  - Comparing query freedom against the UniProt website/API
related_components: [reference_command_port, uniprot_read_through, agent_tools]
tags: [uniprot, reference, query, rest-api]
---

# UniProt query capability

> UniProt stays in the TS layer (D18 decision, no chemistry coupling) and is exposed
> through the read-through store of `reference-command-port.ts`. This document records its
> **full query capability**, the comparison against the official REST API contract, and
> how parameters pass through each layer — for reference when extending later, so it is
> not re-derived.

## 1. Command surface

Five `tdease.uniprot.*` commands (registered in `src/studio/commands/definitions.ts`):

| Command | Purpose |
|---|---|
| `uniprot.get` | Single entry: resource + id + fields + format + sourcePolicy (5 resources) |
| `uniprot.query` | Set query: structured query / advancedQuery + fields + format + mode + cursor/pageSize + includeIsoform + homology |
| `uniprot.map` | ID mapping: from/to/ids (async lifecycle) |
| `uniprot.note` | Local annotation (does not overwrite authority; overlay) |
| `uniprot.revise` | Revise a note (value/verdict/evidence/retract) |

Resources: `uniprotkb` | `uniref` | `uniparc` | `proteomes` | `taxonomy` | `homology`.

## 2. Comparison with the official API contract (2026-08-02 firecrawl research)

Official UniProt REST search API parameter table
(**rest.uniprot.org/{resource}/search?…**):

| Official parameter | TDEase pass-through | Notes |
|---|---|---|
| `query` | ✅ `advancedQuery` (verbatim) + structured `query` | Full official syntax in §3 |
| `format` | ✅ | json/tsv/fasta/xml/txt/gff/rdf/normalized |
| `fields` | ✅ | Comma-separated; json/tsv/xlsx only |
| `size` | ✅ `pageSize` | Results per page |
| `cursor` | ✅ | Pagination |
| `includeIsoform` | ✅ `includeIsoform` (added 2026-08-02) | UniProtKB only, default false |
| `compressed` | ❌ Not passed through | gzip; client HTTP compression already covers it, low ROI |

**There is no sort and no facets** — the official site UI's sorting/grouping is a display
layer, not API parameters. Sorting must be done client-side (the official Python examples
do exactly that). TDEase should not add these two "parameters" either; that would
misread the API contract.

## 3. Query syntax (official text-search)

`advancedQuery` passes the official syntax through verbatim; all of it works:

```
gene:H2AFX AND organism_id:10090      boolean AND/OR/NOT, parenthesized grouping
anti* / *kinase*                      wildcards
length:[100 TO *]                     range query
lit_author:Arai                       field:value
human -antigen / !antigen             exclusion
gene:L\(1\)2CB                        escaping (special chars: + - && || ! ( ) { } [ ] ^ " ~ * ? : \)
reviewed:true                         boolean field
cc_function:*                         existence
```

The **structured `query` parameter** (the type-safe simple path) supports only
`{ field, eq?|exists? }` combined with all (AND)/any (OR); NOT/ranges/wildcards require
`advancedQuery`.

## 4. Pass-through layers (changing a parameter pierces 5 layers)

Using `includeIsoform` as the example, one query parameter travels from agent to HTTP:

```
1. agent tool call tdease.uniprot.query { includeIsoform: true }
2. definitions.ts  args schema + buildUniProtQueryInput(args)  -> UniProtQueryInput
3. ports/reference-command-port.ts  UniProtQueryInput.includeIsoform?: boolean
4. uniprot-read-through.ts  query() -> client.search(..., input.includeIsoform, signal)
5. uniprot-client.ts  buildSearchUrl() -> params.set('includeIsoform','true')
   -> https://rest.uniprot.org/uniprotkb/search.json?query=...&includeIsoform=true
```

Checklist for adding/changing a query parameter:
- `ports/reference-command-port.ts` types
- `definitions.ts` args schema + `buildUniProtQueryInput` pass-through (use
  `optionalBoolean` for booleans)
- `uniprot-client.ts` `search()` signature + `buildSearchUrl` assembly
- `uniprot-read-through.ts` query() call-site argument
- Tests: reference-command-port.test.ts asserts the URL

## 5. Cache and snapshots

The read-through store (`uniprot.sqlite`) has five tables:

| Table | Purpose |
|---|---|
| `remote_snapshots` | Immutable snapshots, addressed by digest |
| `entries` | Rebuildable projection, keyed by (resource, primary_id) |
| `query_coverage` | Set-query completeness (completed + cursorExhausted) |
| `user_assertions` | note/revise overlay |
| `schema_metadata` | Migration version |

- `get`: local hit (snapshot unexpired, <30 days) returns directly, `localHit: true`.
- `query`: local hit only when `query_coverage` marks it complete; otherwise pulls all
  pages and merges snapshots.
- `pinned` mode: locks the version by digest, never goes online.

## 6. References

- Official API: https://www.uniprot.org/help/api_queries
- Official query syntax: https://www.uniprot.org/help/text-search
- Official field table: https://www.uniprot.org/help/query-fields
- Advanced search: https://www.uniprot.org/help/advanced_search
