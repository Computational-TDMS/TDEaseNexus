/**
 * useMentionCandidates — the renderer-side data source for the composer's
 * @-mention picker.
 *
 * Aggregates the two @-mentionable entity kinds (runs, workspace files) into
 * one flat `MentionCandidate[]` the picker renders. Skills live
 * behind their own `$` trigger (see SlashInput's `rankedSkills`), not here.
 * This is UI-side, so it is allowed to touch Pinia and the filesystem — unlike
 * `src/agent/mention/`, which stays headless.
 *
 * Sources are lazy and reactive: runs and the full recursive file
 * listing load when the workspace is attached, derived from one depth-
 * complete listing (not the navigator's lazy fileTree) so a freshly opened
 * workspace offers every @run and @file without expanding anything first. The
 * file listing is depth-complete (one recursive-glob bind) so deep paths like
 * `@file:runs/rev-2/proteoform.tsv` are suggestable without first expanding
 * every directory in the navigator. A flat list keeps the picker simple —
 * type-filtering happens by the query the user types after `@` (e.g. `@run`,
 * `@file:report`), scored subsequence-style the way `palette.ts` already scores
 * its candidates.
 */

import { computed, ref, watch, type Ref } from 'vue'
import type { MentionKind, MentionToken } from '@/agent/mention'
import { useWorkspaceStore } from '@/stores/workspace'
import { getViewsFS } from '@/services/workspace/views-fs'

/** A single pickable row in the @-mention picker. */
export interface MentionCandidate {
  readonly token: MentionToken
  /** Primary label shown (a Run title, a filename). */
  readonly label: string
  /** Secondary detail (status, path, scope). */
  readonly detail: string
  readonly kind: MentionKind
}

export interface MentionCandidatesResult {
  /** Flat candidate list across all kinds (reactive). */
  readonly candidates: Readonly<Ref<ReadonlyArray<MentionCandidate>>>
  /** True while an async source (files) is loading. */
  readonly loading: Ref<boolean>
}

/**
 * @param _skills retained for call-site compatibility but unused — skills moved
 *        to the `$` picker. Kept as an optional param so SlashInput's existing
 *        `useMentionCandidates(skillsRef)` call does not need a separate wiring
 *        change in this pass.
 *        composable does not couple to `useAgentTurn`'s private session map.
 */
export function useMentionCandidates(_skills?: Ref<ReadonlyArray<{ name: string; description?: string }> | undefined>): MentionCandidatesResult {
  const workspaceStore = useWorkspaceStore()
  const loading = ref(false)

  // Run ids (the immediate child dirs of `runs/`), derived from the listing so
  // the picker does not wait on the navigator's lazy `fileTree` — a freshly
  // bound workspace offers @run the moment its files are indexed, before anyone
  // has expanded `runs/` in the tree.
  const runs = ref<string[]>([])
  // All workspace files (depth-complete) — the picker offers `@file:<path>`
  // for anything in the workspace: `data/`, `runs/`, config, source. Internal
  // dot-dirs (`.tdease/` session snapshots, `.git/`) are excluded so the picker
  // is not flooded with non-user content. The navigator's fileTree stays lazy
  // for UI; this listing is the picker's own depth-complete view, populated
  // once per workspace bind.
  const files = ref<ReadonlyArray<{ name: string; path: string }>>([])

  async function refreshAsyncSources() {
    const root = workspaceStore.workspacePath
    if (!root) { runs.value = []; files.value = []; return }
    loading.value = true
    try {
      // Full recursive listing. `**/*` (not `*`) — the FS glob compiles a bare
      // `*` to `[^/]*`, which would stop at the first `/` and never surface
      // `runs/run-1/x.tsv`. Both runs/ and files/ candidates derive from this
      // listing, independent of whether the navigator has expanded `runs`, so a
      // freshly opened workspace offers @run and @file without a manual expand.
      const allPaths = await getViewsFS().listFiles('**/*', root).catch(() => [] as string[])
      runs.value = extractRunNames(allPaths)
      files.value = pickWorkspaceFiles(allPaths)
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p }))
        .sort((a, b) => a.path.localeCompare(b.path))
    } catch {
      files.value = []
    } finally {
      loading.value = false
    }
  }

  watch(() => workspaceStore.workspaceId, async (id) => {
    if (!id) return
    await refreshAsyncSources()
  }, { immediate: true })

  const candidates = computed<ReadonlyArray<MentionCandidate>>(() => {
    const out: MentionCandidate[] = []

    // Runs are Workspace divisions, not Backend records. Enumerate the local
    // canonical runs/<run>/ directories from the listing so drafts and completed
    // Runs behave identically and autocomplete never depends on connectivity or
    // on the navigator having expanded `runs/`.
    for (const runId of runs.value) {
      out.push({
        token: { kind: 'run', refId: runId },
        label: runId,
        detail: `Local draft · runs/${runId}`,
        kind: 'run',
      })
    }

    // Files: every workspace file (depth-complete). The picker offers
    // `@file:data/raw/sample.mzml`, `@file:runs/run-1/out.tsv`, etc. — anything
    // the user might point the Agent at. Internal dot-dirs are already filtered
    // upstream by `pickWorkspaceFiles`.
    for (const file of files.value) {
      out.push({
        token: { kind: 'file', refId: file.path },
        label: file.name,
        detail: file.path,
        kind: 'file',
      })
    }

    return out
  })

  return { candidates, loading }
}

/**
 * Subsequence scorer — case-insensitive, returns null when the query is not a
 * subsequence of the target. Copied from `palette.ts`'s proven matcher so the
 * picker ranks the same way the Ctrl+K palette does.
 */
export function scoreCandidate(query: string, target: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  let score = 0
  let consecutive = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      qi += 1
      consecutive += 1
      score += consecutive // reward runs of consecutive chars
    } else {
      consecutive = 0
    }
  }
  return qi === q.length ? score : null
}

/**
 * The distinct run ids — the immediate child directories of `runs/` — extracted
 * from a recursive file listing. Unlike the navigator's lazy `fileTree`, the
 * listing is depth-complete, so this returns every Run the moment the workspace
 * is indexed, before anyone expands `runs/` in the tree. Path-anchored on
 * `runs/`, and the run id is taken as the segment right after it (`runs/run-1/…`
 * → `run-1`), de-duplicated and sorted for stable picker order. Pure so the data
 * source and its test agree on what counts as a Run.
 */
export function extractRunNames(paths: ReadonlyArray<string>): string[] {
  const names = new Set<string>()
  for (const p of paths) {
    if (!p.startsWith('runs/')) continue
    const rest = p.slice('runs/'.length)
    const slash = rest.indexOf('/')
    // A bare `runs/run-1` (no trailing content) is a directory marker, not a file
    // under a Run; `listFiles` returns file paths, so a real entry always carries
    // at least `runs/<run>/file`, but guard anyway.
    const runId = slash === -1 ? rest : rest.slice(0, slash)
    if (runId) names.add(runId)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * Keep every workspace file, dropping only directory markers (paths ending in
 * `/`) and the tool's own internal dot-dirs (`.tdease/` session snapshots,
 * `.git/` version-control internals). @-mentions can point at any user content
 * — `data/`, `runs/`, config, source — but flooding the picker with session
 * snapshots or git objects serves no one. Anchored on the leading segment so a
 * path merely containing the substring (e.g. `other/prerun.tsv`) is unaffected.
 * Pure so the data source and its test agree on what counts as a mentionable file.
 */
export function pickWorkspaceFiles(paths: ReadonlyArray<string>): string[] {
  return paths.filter((p) => {
    if (p.endsWith('/')) return false
    // Exclude internal dot-dirs at the top level: .tdease/, .git/, etc.
    const topSegment = p.slice(0, p.indexOf('/'))
    if (topSegment.startsWith('.')) return false
    return true
  })
}

/**
 * Filter and rank candidates against a query. The query may start with a kind
 * prefix (`run:`, `file:`, `skill:`) to restrict to one kind.
 */
export function rankCandidates(
  candidates: ReadonlyArray<MentionCandidate>,
  query: string,
): ReadonlyArray<MentionCandidate> {
  const trimmed = query.trim()
  let kindFilter: MentionKind | undefined
  let text = trimmed
  const kindMatch = trimmed.match(/^(run|file|skill)(?::(.*))?$/)
  if (kindMatch) {
    kindFilter = kindMatch[1] as MentionKind
    text = kindMatch[2] ?? ''
  }
  const scoped = kindFilter ? candidates.filter((c) => c.kind === kindFilter) : candidates
  if (!text) return scoped
  const scored: Array<{ c: MentionCandidate; s: number }> = []
  for (const c of scoped) {
    const byLabel = scoreCandidate(text, c.label)
    const byDetail = scoreCandidate(text, c.detail)
    const byRefId = scoreCandidate(text, c.token.refId)
    const best = Math.max(byLabel ?? -1, byDetail ?? -1, byRefId ?? -1)
    if (best >= 0) scored.push({ c, s: best })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.map((s) => s.c)
}
