/**
 * Node-side PromptPipeline: resolves @-references, assembles the frozen
 * per-run system prompt, and snapshots each provider request's context.
 *
 * This module owns no filesystem, no Electron, no Pi. It composes the pure
 * logic that already lives under src/agent/:
 *   - mention parsing/resolution (mention-token, mention-source)
 *   - system prompt assembly (SystemPromptAssembler, reused, not reimplemented)
 *   - the SHA-256 digest port (webcrypto-backed)
 *
 * Persistence of the assembled snapshot is deliberately NOT done here. The
 * composition root wires a SessionStore; calling `assemble` (not
 * `assembleAndPersist`) keeps this class pure: it returns the bytes and
 * digest, and the root decides where they land on disk. That separation is
 * what lets the same assembly feed a replay path that writes to a different
 * content-addressed store (AGENT-CONTRACT.md §2, "two states, one assembly").
 */

import type { ModelSelector, ThinkingLevel } from '../../src/contracts/agent-runtime'
import type {
  AssembledSystemPrompt,
  PromptAssetReader,
  PromptCapabilities,
  PromptFragment as AssemblerFragment,
  PromptSkillScope,
  PromptSkillText,
  Sha256Digest,
} from '../../src/agent/prompt/types'
import type { ResolvedReference, PromptPipeline, AssembledPrompt, PromptFragment } from './contracts'
import type { AgentRunDefinition, ProviderRequestSnapshot, SessionBinding } from './turn-definition'
import type { MentionSources, ResolvedMention } from '../../src/agent/mention/mention-source'
import type { MentionToken } from '../../src/agent/mention/mention-token'
import type { RunInfo } from '../../src/services/backend/client-contracts'
import type { RunResultEntry } from '../../src/services/backend/backend'

import { createHash } from 'node:crypto'

import { SystemPromptAssembler } from '../../src/agent/prompt/system-prompt'
import { createWebCryptoSha256Digest } from '../../src/agent/prompt/digest'
import { imageMimeType } from './image-attachment'
import { composeReferencedContext } from '../../src/agent/mention/mention-context'
import {
  resolveMentions,
  capFileBody,
  notFoundLabel,
} from '../../src/agent/mention/mention-source'
import { parseMentions } from '../../src/agent/mention/mention-token'
import { canonicalJson } from './turn-definition'

// ── Slot mapping ─────────────────────────────────────────────────────────────
//
// The assembler's PromptFragment.kind is an implementation vocabulary that must
// not leak into the durable contracts.ts `slot` enum. This table is the single
// translation point, so the two sides can evolve independently — the assembler
// splits `default_tool_policy` into a tool-policy family (tool_policy /
// native_toolchain / scientific_honesty / analysis_layout), all mapping to the
// same external `tool-policy` slot. `skill` here means the assembler's assembled skill block; the
// contracts reserve `referenced-skill` for the same content because every skill
// fragment this pipeline ever freezes came from an explicit @-reference.
const SLOT_BY_KIND: Readonly<Record<AssemblerFragment['kind'], PromptFragment['slot']>> = Object.freeze({
  base_role: 'base-role',
  tool_policy: 'tool-policy',
  bash_policy: 'tool-policy',
  capability_notice: 'tool-policy',
  wiki_policy: 'tool-policy',
  native_toolchain: 'tool-policy',
  scientific_honesty: 'tool-policy',
  terminology: 'tool-policy',
  analysis_layout: 'tool-policy',
  delegation_policy: 'delegation-policy',
  ptc_policy: 'ptc-policy',
  inline_visualization: 'inline-visualization',
  mode: 'mindset',
  safety_policy: 'safety',
  subagent_role: 'subagent-role',
  skill_index: 'skill-index',
  skill: 'referenced-skill',
  workspace_context: 'workspace-context',
})

/**
 * Dependency surface for the pipeline. Every reader is a function (not a store
 * object) so the wiring root can pass thin closures over Node fs / Electron IPC
 * without the pipeline taking a hard dependency on either — keeping it unit
 * testable with stubs, exactly like the headless src/agent/ modules.
 */
export interface PromptPipelineOptions {
  /** Reads prompts/internal/*.md from the System root (base role, policy, mode). */
  readonly systemAssets: PromptAssetReader
  /** Absolute Workspace root; used only for skill-path derivation, never reads. */
  readonly workspaceRoot: string
  /** Contained Workspace read (the file resolver applies its own byte cap). */
  readonly workspaceReadText: (relative: string) => Promise<string>
  /** Contained Workspace directory listing, used by the skill resolver. */
  readonly workspaceListDir?: (relative: string) => Promise<ReadonlyArray<{ name: string; isDir: boolean }>>
  /** System skill read: `<systemRoot>/skills/<name>/SKILL.md`. */
  readonly systemReadText: (relative: string) => Promise<string>
  /**
   * Resolve a @run reference to its display name, status, and the markdown body
   * the snapshot freezes under the @run token (so the model sees what the Run
   * actually is — its status, declared outputs, and Published Results — not just
   * a bare label). Optional: absent, the resolver yields a found:false
   * placeholder and the turn still sends.
   */
  readonly resolveRunReference?: (runId: string) => Promise<{ name: string; status: string; body?: string } | undefined>
  /**
   * List available skills for the compact `## Available skills` index
   * (progressive disclosure, layer 1). Names are scope-prefixed
   * (`system:qc` / `workspace:qc`). Optional; a throw or absence omits the
   * section — the turn must never fail because the index could not be built.
   */
  readonly listSkillIndex?: () => Promise<ReadonlyArray<{ name: string; description?: string }>>
  /**
   * The capability booleans the assembler conditions fragments on, derived by
   * the composition root from the SAME resolved AgentToolProfile the gateway
   * gates with. Frozen per binding, exactly like the profile itself.
   */
  readonly capabilities?: PromptCapabilities
  /** Injectable digest; defaults to webcrypto (Node has globalThis.crypto). */
  readonly digest?: Sha256Digest
}

export class NodePromptPipeline implements PromptPipeline {
  private readonly assembler: SystemPromptAssembler
  private readonly digest: Sha256Digest
  private readonly options: PromptPipelineOptions

  constructor(options: PromptPipelineOptions) {
    this.options = options
    this.digest = options.digest ?? createWebCryptoSha256Digest()
    this.assembler = new SystemPromptAssembler({ assets: options.systemAssets, digest: this.digest })
  }

  async resolveReferences(message: string): Promise<ReadonlyArray<ResolvedReference>> {
    if (!message || !message.includes('@')) return []
    const tokens = parseMentions(message)
    if (tokens.length === 0) return []
    const sources: MentionSources = {
      resolveRun: (refId) => this.resolveRun(refId),
      resolveFile: (refId) => this.resolveFile(refId),
      resolveSkill: (refId) => this.resolveSkill(refId),
    }
    const resolved = await resolveMentions(tokens, sources)
    return resolved.map(toResolvedReference)
  }

  async assembleForRun(
    binding: SessionBinding,
    run: AgentRunDefinition,
    references: ReadonlyArray<ResolvedReference>,
  ): Promise<AssembledPrompt> {
    // Skills the user explicitly @-mentioned become first-class prompt skills.
    // Workspace skills sort ahead of System skills (assembler sorts by scope),
    // mirroring the precedence the renderer-side assembler already enforced.
    const skills: PromptSkillText[] = []
    for (const reference of references) {
      if (reference.kind !== 'skill' || !reference.found || !reference.body) continue
      const parsed = parseSkillRefId(reference.refId)
      if (!parsed) continue
      skills.push({ id: reference.refId, scope: parsed.scope, content: reference.body })
    }

    // Only NON-skill references (run/file/canvas) plus not-found skills belong
    // in the Referenced block: found skills are already first-class fragments
    // above, so including them here would inject the SKILL.md body twice and
    // move the digest for no semantic change. composeReferencedContext returns
    // undefined for an empty list, so a reference-less run assembles the
    // byte-identical prompt it always did.
    const referencedMentions = references
      .filter((reference) => reference.kind !== 'skill' || !reference.found)
      .map(toResolvedMentionShape)
    const referencedContext = composeReferencedContext(referencedMentions)

    const assembled = await this.assembler.assemble({
      mindset: run.mindset,
      capabilities: this.options.capabilities,
      skills: skills.length ? skills : undefined,
      skillIndex: await this.listSkillIndex(),
      workspaceContext: referencedContext,
      // A subagent child's role briefing rides the binding; parents leave it
      // undefined and the default assembly is byte-identical to before.
      subagentRole: binding.systemPromptOverride,
      // PTC fragment + tdease.ptc.exec surface are gated by their own flag.
      ptcEnabled: binding.ptcEnabled === true,
      // Turn-scoped composer toggle, frozen into this run's definition.
      inlineVisualization: run.inlineVisualization === true,
    })

    return toAssembledPrompt(assembled, this.digest)
  }

  /**
   * Build the compact skill index once per assembly. The catalog behind the
   * injected lister caches per root, so repeat runs in a session re-read disk
   * only when the catalog itself invalidates — no new watcher lives here. A
   * listing failure degrades to "no index section", never a failed turn.
   */
  private async listSkillIndex(): Promise<ReadonlyArray<{ name: string; description?: string }> | undefined> {
    if (!this.options.listSkillIndex) return undefined
    try {
      const entries = await this.options.listSkillIndex()
      return entries.length ? entries : undefined
    } catch {
      return undefined
    }
  }

  snapshotProviderRequest(
    turnId: string,
    requestSeq: number,
    systemPromptDigest: string,
    messages: unknown,
    activeTools: ReadonlyArray<string>,
    model: ModelSelector,
    thinkingLevel: ThinkingLevel,
  ): ProviderRequestSnapshot {
    // Pure and synchronous: digests only, no disk. The bytes themselves never
    // leave Node; the composition root emits the model.request.prepared event
    // and persists the snapshot content via SessionStore. canonicalJson gives
    // key-order-stable input so two identical payloads hash identically across
    // runs.
    //
    // Node's sync crypto.createHash is used (not the async webcrypto digest the
    // assembler uses) because the contract declares this method synchronous —
    // the `context` hook calls it inline to stamp each provider request and
    // must not yield back to Pi's event loop mid-stamp.
    const contextDigest = sha256Sync(canonicalJson(messages))
    const activeToolsDigest = sha256Sync(canonicalJson([...activeTools]))
    return Object.freeze({
      turnId,
      requestSeq,
      systemPromptDigest,
      contextDigest,
      activeToolsDigest,
      model,
      thinkingLevel,
    })
  }

  // ── Reference resolvers ───────────────────────────────────────────────────
  //
  // Each returns null on not-found (not throw); resolveMentions substitutes a
  // found:false placeholder. A missing file must never fail the turn — the
  // message still sends, the @token stays in the text, and the snapshot tells
  // the model plainly that the entity could not be found.

  private async resolveFile(refId: string): Promise<ResolvedMention | null> {
    const token: MentionToken = { kind: 'file', refId }
    // Binary images never ride the UTF-8 text path — reading their bytes as
    // text would inject mojibake into the context. The pixels travel via
    // session-host's image recognition (the @file token is one of its marker
    // forms, gated on the model declaring image input); here the reference is
    // only recorded so the Referenced section states what the file is.
    if (imageMimeType(refId)) {
      return {
        token,
        label: refId,
        body: 'binary image file — delivered to the model as image content when the model supports vision',
        found: true,
      }
    }
    try {
      const text = await this.options.workspaceReadText(refId)
      // capFileBody marks the truncation point so the model can tell a partial
      // file from a complete one — lying by silent truncation is worse than the
      // truth of an explicit "... (truncated)" marker.
      return { token, label: refId, body: capFileBody(text), found: true }
    } catch {
      return null
    }
  }

  private async resolveRun(refId: string): Promise<ResolvedMention | null> {
    if (!this.options.resolveRunReference) return null
    try {
      const summary = await this.options.resolveRunReference(refId)
      if (!summary) return null
      const token: MentionToken = { kind: 'run', refId }
      return { token, label: `${summary.name}, status ${summary.status}`, body: summary.body, found: true }
    } catch {
      return null
    }
  }

  private async resolveSkill(refId: string): Promise<ResolvedMention | null> {
    const parsed = parseSkillRefId(refId)
    if (!parsed) return null
    const token: MentionToken = { kind: 'skill', refId }
    try {
      const body = parsed.scope === 'system'
        ? await this.options.systemReadText(`skills/${parsed.name}/SKILL.md`)
        : await this.options.workspaceReadText(`.tdease/skills/${parsed.name}/SKILL.md`)
      if (!body || !body.trim()) return null
      return { token, label: parsed.name, body, found: true }
    } catch {
      return null
    }
  }
}

/**
 * Render only compact Run metadata under an @run token. Run references must
 * not become an implicit directory index or analysis narrative.
 *
 * Field-omission is deliberate: empty/absent fields (error, revision, labels)
 * are skipped so a healthy Run stays compact, and the `## Published Results`
 * section appears only when there is at least one result. The label line still
 * carries `name, status <STATUS>`; the body carries the rest.
 */
export function formatRunReference(run: RunInfo, _results: ReadonlyArray<RunResultEntry>): string {
  const lines: string[] = [`## Run ${run.name}`]
  lines.push(`- status: ${run.status}`)
  lines.push(`- cores: ${run.cores}, results: ${run.result_file_count} files`)
  if (run.current_revision) lines.push(`- revision: ${run.current_revision}`)
  if (run.error) lines.push(`- error: ${run.error}`)
  return lines.join('\n')
}

/** Synchronous SHA-256, hex-encoded — for the sync snapshotProviderRequest. */
function sha256Sync(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// ── Shape adapters (pure) ────────────────────────────────────────────────────

function toResolvedReference(resolved: ResolvedMention): ResolvedReference {
  return {
    kind: resolved.token.kind,
    refId: resolved.token.refId,
    label: resolved.label,
    body: resolved.body,
    found: resolved.found,
  }
}

/**
 * Map the contracts ResolvedReference back to the resolver's ResolvedMention
 * shape so composeReferencedContext can render the canonical @-token + label +
 * fenced body. The token text is reconstructed rather than carried: the
 * contract deliberately stores kind+refId, never the rendered token, to keep
 * the durable shape free of the mention grammar.
 */
function toResolvedMentionShape(reference: ResolvedReference): ResolvedMention {
  const token: MentionToken = { kind: reference.kind, refId: reference.refId }
  if (!reference.found) {
    return { token, label: notFoundLabel(reference.kind, reference.refId), found: false }
  }
  return { token, label: reference.label, body: reference.body, found: true }
}

/**
 * A skill refId is `<scope>:<name>` (e.g. `workspace:qc`). The grammar allows
 * the extra `:` only inside a skill token, so here we can split safely. An
 * unknown scope means the refId did not come through the parser; treat it as
 * unresolvable rather than guessing a scope.
 */
function parseSkillRefId(refId: string): { scope: PromptSkillScope; name: string } | null {
  const index = refId.indexOf(':')
  if (index <= 0) return null
  const scope = refId.slice(0, index)
  const name = refId.slice(index + 1)
  if (scope !== 'system' && scope !== 'workspace') return null
  if (!name) return null
  return { scope, name }
}

/**
 * Translate the assembler's internal fragment vocabulary into the contracts.ts
 * `slot` enum, and compute each fragment's origin string for audit. The
 * assembler does not stamp an origin (it has no notion of a Workspace skill vs
 * a System asset beyond the kind), so we derive it from the slot + skill id.
 */
async function toAssembledPrompt(
  assembled: AssembledSystemPrompt,
  digest: Sha256Digest,
): Promise<AssembledPrompt> {
  const fragments: PromptFragment[] = []
  for (const fragment of assembled.fragments) {
    const slot = SLOT_BY_KIND[fragment.kind]
    const origin = fragmentOrigin(fragment)
    const content = fragment.content
    fragments.push({
      slot,
      origin,
      content,
      // Per-fragment digest so a diff between two AssembledPrompts can name the
      // exact contributor that changed without re-hashing the whole prompt.
      digest: await digest.sha256(content),
    })
  }
  return Object.freeze({
    systemPrompt: assembled.content,
    digest: assembled.digest,
    fragments: Object.freeze(fragments),
  })
}

function fragmentOrigin(fragment: AssemblerFragment): string {
  if (fragment.kind === 'skill') {
    // The assembler renders "## Skill: <id>"; the id is the origin we audit.
    const match = /^## Skill:\s*(.+?)\s*$/m.exec(fragment.content)
    return match ? `skill:${match[1]}` : 'skill'
  }
  return fragment.asset ?? fragment.kind
}
