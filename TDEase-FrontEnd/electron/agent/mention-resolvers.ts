/**
 * Mention resolvers — the impure adapters behind the prompt pipeline's
 * @-reference slots. `NodePromptPipeline` is deliberately filesystem-free and
 * client-free (see its header): it takes `resolveRunReference` as an option,
 * and THIS is the production adapter the composition root supplies. It owns
 * the Backend client — everything the pipeline itself must not know about.
 */

import { TDEaseClient } from '../../src/services/backend/backend'
import { formatRunReference } from './prompt-pipeline'

/**
 * Resolve an `@run:<refId>` reference to the display name, status, and body
 * frozen under the token. Exact run-ID match first; when the refId is not a
 * real `run_id` (e.g. `@run:histone48-mouse` while the Run's id is
 * `histone48-mouse-v2-20260728`), fall back to matching the Run's
 * workspace run path (`runs/<refId>`), its name, or a `labels.name` alias.
 * The fallback resolves through the matched Run's real id so the body carries
 * the canonical projection (results, revision, labels), never a synthetic one.
 */
export async function resolveRunReference(options: {
  client: TDEaseClient
  runId: string
  workspaceId: string
}): Promise<{ name: string; status: string; body?: string } | undefined> {
  const exact = await resolveRunById(options.client, options.runId)
  if (exact) return exact
  const runs = await options.client.list(options.workspaceId).catch(() => undefined)
  if (!runs) return undefined
  const byPath = runs.find((run) => run.workspace_run_path === `runs/${options.runId}`)
  const byName = byPath ?? runs.find((run) => run.name === options.runId)
  const matched = byName ?? runs.find((run) => run.labels?.name === options.runId)
  if (!matched) return undefined
  return resolveRunById(options.client, matched.run_id)
}

async function resolveRunById(
  client: TDEaseClient,
  runId: string,
): Promise<{ name: string; status: string; body?: string } | undefined> {
  try {
    // status() is authoritative; listResults() is enrichment. A Run that
    // exists but has no Published Results still resolves (found:true) —
    // only a missing/unreachable Run yields undefined → found:false.
    const run = await client.status(runId)
    let results: Awaited<ReturnType<typeof client.listResults>> = []
    try { results = await client.listResults(runId) } catch { results = [] }
    return { name: run.name, status: run.status, body: formatRunReference(run, results) }
  } catch { return undefined }
}
