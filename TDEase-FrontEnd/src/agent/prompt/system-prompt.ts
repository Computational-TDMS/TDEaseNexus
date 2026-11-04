import { assertSha256 } from './digest'
import {
  DEFAULT_MODE_PROMPTS,
  PROMPT_ASSETS,
  type AssembledSystemPrompt,
  type MindsetId,
  type ModePromptMap,
  type PromptAssetPath,
  type PromptAssetReader,
  type PromptFragment,
  type PromptCapabilities,
  type PromptSkillIndexEntry,
  type PromptSkillScope,
  type PromptSkillText,
  type PromptSnapshot,
  type PromptSnapshotStore,
  type Sha256,
  type Sha256Digest,
  type SystemPromptInput,
} from './types'

const SECTION_SEPARATOR = '\n\n---\n\n'

/** Progressive-disclosure caps for the compact skill index. */
const SKILL_INDEX_LIMIT = 50
const SKILL_INDEX_DESCRIPTION_LIMIT = 120

const ASSET_SEQUENCE: ReadonlyArray<{
  kind: Extract<PromptFragment['kind'], 'base_role' | 'safety_policy'>
  asset: PromptAssetPath
}> = Object.freeze([
  { kind: 'base_role', asset: PROMPT_ASSETS.baseRole },
  { kind: 'safety_policy', asset: PROMPT_ASSETS.safetyPolicy },
])

/**
 * A fragment's applicability has two optional gates, both must pass:
 *  - `mindsets` — the working-mode gate that has always existed;
 *  - `requires` — a predicate over the resolved PromptCapabilities, so a
 *    fragment can only assert what the tool gate guarantees this turn (shell
 *    off ⇒ no bash doctrine; write+shell off ⇒ no wiki write loop; a narrowed
 *    child without subagent.* ⇒ no delegation guidance).
 * Absent capabilities = no capability narrowing (legacy callers, tests).
 */
function fragmentApplies(
  spec: { mindsets?: readonly MindsetId[]; requires?: (capabilities: PromptCapabilities) => boolean },
  input: SystemPromptInput,
): boolean {
  if (spec.mindsets && !spec.mindsets.includes(input.mindset)) return false
  if (spec.requires && input.capabilities && !spec.requires(input.capabilities)) return false
  return true
}

/**
 * The tool-policy family, split from the former monolithic default_tool_policy.
 * The fragments are assembled in this fixed order between base_role and
 * delegation_policy. The analysis-only fragments (native_toolchain,
 * analysis_layout) are gated by mindset: workflow drives
 * `tdease.workflow.run` and does not carry the tdeasenexus-toolbox chemistry
 * usage or the analysis slug layout. Capability predicates carry the rest:
 * bash_policy and native_toolchain need the bash builtin, and wiki_policy
 * needs some write path. All map to the same external 'tool-policy' slot in
 * prompt-pipeline's SLOT_BY_KIND.
 */
const TOOL_POLICY_SEQUENCE: ReadonlyArray<{
  kind: Extract<PromptFragment['kind'], 'tool_policy' | 'bash_policy' | 'wiki_policy' | 'native_toolchain' | 'scientific_honesty' | 'terminology' | 'analysis_layout'>
  asset: PromptAssetPath
  mindsets?: readonly MindsetId[]
  requires?: (capabilities: PromptCapabilities) => boolean
}> = Object.freeze([
  { kind: 'tool_policy', asset: PROMPT_ASSETS.toolPolicy },
  { kind: 'bash_policy', asset: PROMPT_ASSETS.bashPolicy, requires: (capabilities) => capabilities.shell },
  // wiki_policy is no longer injected: recording a wiki note is opt-in (one
  // line in base_role), never a mandated deliverable — forced case cards made
  // agents write documentation instead of finishing the work.
  { kind: 'native_toolchain', asset: PROMPT_ASSETS.nativeToolchain, mindsets: ['analysis'], requires: (capabilities) => capabilities.shell },
  { kind: 'scientific_honesty', asset: PROMPT_ASSETS.scientificHonesty },
  { kind: 'terminology', asset: PROMPT_ASSETS.terminology },
  { kind: 'analysis_layout', asset: PROMPT_ASSETS.analysisLayout, mindsets: ['analysis'] },
])

const SKILL_SCOPE_ORDER: Readonly<Record<PromptSkillScope, number>> = Object.freeze({
  system: 0,
  workspace: 1,
})

export class PromptAssemblyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromptAssemblyError'
  }
}

export class PromptSnapshotIntegrityError extends Error {
  constructor(expected: Sha256, actual: Sha256) {
    super(`Prompt snapshot ${expected} did not match its stored content (computed ${actual})`)
    this.name = 'PromptSnapshotIntegrityError'
  }
}

export interface SystemPromptAssemblerOptions {
  assets: PromptAssetReader
  digest: Sha256Digest
  modePrompts?: Partial<ModePromptMap>
}

/**
 * Builds the single frozen prompt a model acts on in one turn. It reads every
 * System asset exactly once per assembly, then no later file change can alter
 * the returned snapshot.
 */
export class SystemPromptAssembler {
  private readonly assets: PromptAssetReader
  private readonly digest: Sha256Digest
  private readonly modePrompts: ModePromptMap

  constructor(options: SystemPromptAssemblerOptions) {
    this.assets = options.assets
    this.digest = options.digest
    this.modePrompts = Object.freeze({ ...DEFAULT_MODE_PROMPTS, ...options.modePrompts })
  }

  async assemble(input: SystemPromptInput): Promise<AssembledSystemPrompt> {
    const modeAsset = this.modeAssetFor(input.mindset)
    const fragments: PromptFragment[] = []

    const [baseRole, safetyPolicy] = ASSET_SEQUENCE
    fragments.push(await this.readFragment(baseRole.kind, baseRole.asset))

    // Tool-policy family: every session reads the universal fragments; the
    // analysis-only fragments are gated by mindset, and shell/write-dependent
    // doctrine by the resolved capabilities — a fragment may only assert what
    // the tool gate guarantees this turn.
    for (const spec of TOOL_POLICY_SEQUENCE) {
      if (!fragmentApplies(spec, input)) continue
      fragments.push(await this.readFragment(spec.kind, spec.asset))
    }

    // The negative half of the capability seam: omitted doctrine prevents
    // false assertions, but the model must also be TOLD the boundary exists —
    // otherwise it promises script execution a loaded Skill describes, then
    // discovers mid-task the tool is absent. Only material boundaries are
    // stated; a disabled write/edit with bash still on leaves writing
    // materially possible and needs no notice.
    const boundaries = capabilityBoundaries(input.capabilities)
    if (boundaries !== undefined) {
      fragments.push(freezeFragment({ kind: 'capability_notice', content: boundaries }))
    }

    // Inline-visualization answers: turn-scoped. The composer toggle rides the
    // dispatch, so exactly the turns sent with it carry the doctrine — and
    // because every turn's prompt is frozen at assembly, later toggles never
    // rewrite a settled turn. Sits in the policy zone (not the head): it
    // modifies HOW to answer, after the tools and before the working loop.
    if (input.inlineVisualization) {
      fragments.push(await this.readFragment('inline_visualization', PROMPT_ASSETS.inlineVisualization))
    }

    // Delegation guidance sits between the tool policy (which introduces the
    // tool families) and the mindset, so a session with the subagent surface
    // learns that interface before it picks a working loop. A child narrowed
    // to a tool allowlist without subagent.* never sees the guidance.
    if (fragmentApplies({ requires: (capabilities) => capabilities.subagents }, input)) {
      fragments.push(await this.readFragment('delegation_policy', PROMPT_ASSETS.delegationPolicy))
    }

    // PTC policy is opt-in by `ptcEnabled` AND Analysis-only: the
    // tdease.ptc.exec surface is analysis exposure, so workflow must never
    // hear guidance for a tool its profile cannot carry.
    if (input.ptcEnabled && input.mindset === 'analysis') {
      fragments.push(await this.readFragment('ptc_policy', PROMPT_ASSETS.ptcPolicy))
    }
    fragments.push(await this.readFragment('mode', modeAsset))
    fragments.push(await this.readFragment(safetyPolicy.kind, safetyPolicy.asset))

    // A subagent child carries its role briefing as an extra fragment, placed
    // after the common safety policy so the role guidance is the last general
    // instruction before the concrete skills/context of the turn.
    if (typeof input.subagentRole === 'string' && input.subagentRole.trim()) {
      fragments.push(freezeFragment({ kind: 'subagent_role', content: input.subagentRole }))
    }

    const skillIndex = renderSkillIndex(input.skillIndex ?? [])
    if (skillIndex !== undefined) {
      fragments.push(freezeFragment({ kind: 'skill_index', content: skillIndex }))
    }

    const skills = freezeSkills(input.skills ?? [])
    for (const skill of skills) {
      fragments.push(freezeFragment({
        kind: 'skill',
        content: `## Skill: ${skill.id}\n\n${skill.content}`,
      }))
    }

    if (input.workspaceContext !== undefined) {
      if (typeof input.workspaceContext !== 'string') {
        throw new PromptAssemblyError('workspaceContext must be a string when supplied')
      }
      fragments.push(freezeFragment({
        kind: 'workspace_context',
        content: `## Workspace Context\n\n${input.workspaceContext}`,
      }))
    }

    const content = fragments.map((fragment) => fragment.content).join(SECTION_SEPARATOR)
    const digest = await this.digest.sha256(content)
    assertSha256(digest)

    return Object.freeze({
      digest,
      content,
      fragments: Object.freeze(fragments),
      skills,
    })
  }

  async assembleAndPersist(
    input: SystemPromptInput,
    store: PromptSnapshotStore,
  ): Promise<AssembledSystemPrompt> {
    const snapshot = await this.assemble(input)
    await this.persist(snapshot, store)
    return snapshot
  }

  async persist(snapshot: PromptSnapshot, store: PromptSnapshotStore): Promise<void> {
    assertSha256(snapshot.digest)
    if (typeof snapshot.content !== 'string') {
      throw new PromptAssemblyError(`Prompt snapshot ${snapshot.digest} must contain text`)
    }
    const actual = await this.digest.sha256(snapshot.content)
    assertSha256(actual)
    if (actual !== snapshot.digest) throw new PromptSnapshotIntegrityError(snapshot.digest, actual)
    await store.write(snapshot.digest, snapshot.content)
  }

  /** Resolve a stored snapshot and verify that its address still matches its content. */
  async resolve(digest: Sha256, store: PromptSnapshotStore): Promise<PromptSnapshot | undefined> {
    assertSha256(digest)
    const content = await store.read(digest)
    if (content === undefined) return undefined
    if (typeof content !== 'string') {
      throw new PromptAssemblyError(`Prompt snapshot store returned non-text content for ${digest}`)
    }
    const actual = await this.digest.sha256(content)
    assertSha256(actual)
    if (actual !== digest) throw new PromptSnapshotIntegrityError(digest, actual)
    return freezeSnapshot(digest, content)
  }

  private modeAssetFor(mindset: MindsetId): PromptAssetPath {
    const asset = this.modePrompts[mindset]
    if (!asset) throw new PromptAssemblyError(`No prompt asset is mapped for mindset ${JSON.stringify(mindset)}`)
    return asset
  }

  private async readFragment(kind: PromptFragment['kind'], asset: PromptAssetPath): Promise<PromptFragment> {
    const content = await this.assets.readText(asset)
    if (typeof content !== 'string' || !content.trim()) {
      throw new PromptAssemblyError(`Prompt asset ${asset} must contain non-empty text`)
    }
    return freezeFragment({ kind, asset, content })
  }
}

/**
 * Render the compact skill index (progressive disclosure, layer 1). One line
 * per skill, `- <scoped-name> — <one-line description>`; descriptions are
 * flattened to a single line and truncated. Returns undefined when there are
 * no skills so the section simply does not exist in the frozen prompt. The
 * index NEVER carries SKILL.md content — full text loads only via @skill.
 */
function renderSkillIndex(entries: ReadonlyArray<PromptSkillIndexEntry>): string | undefined {
  const usable = entries.filter((entry) => typeof entry.name === 'string' && entry.name.trim())
  if (usable.length === 0) return undefined
  const shown = usable.slice(0, SKILL_INDEX_LIMIT)
  const lines = shown.map((entry) => {
    const name = entry.name.trim()
    const description = entry.description?.replace(/\s+/g, ' ').trim()
    if (!description) return `- ${name}`
    const truncated = description.length > SKILL_INDEX_DESCRIPTION_LIMIT
      ? `${description.slice(0, SKILL_INDEX_DESCRIPTION_LIMIT).trimEnd()}…`
      : description
    return `- ${name} — ${truncated}`
  })
  if (usable.length > shown.length) lines.push(`… and ${usable.length - shown.length} more`)
  return `## Available skills\n\nUse the exact scoped id with \`skill.read\` when you need a skill's instructions.\n\n${lines.join('\n')}`
}

function freezeSkills(input: ReadonlyArray<PromptSkillText>): ReadonlyArray<PromptSkillText> {  const frozen = input.map((skill) => freezeSkill(skill))
  const ordered = frozen.map((skill, index) => ({ skill, index })).sort((left, right) => {
    const scopeOrder = skillScopeOrder(left.skill.scope) - skillScopeOrder(right.skill.scope)
    return scopeOrder || left.index - right.index
  })

  return Object.freeze(ordered.map(({ skill }) => skill))
}

function freezeSkill(skill: PromptSkillText): PromptSkillText {
  if (!skill || typeof skill.id !== 'string' || !skill.id.trim()) {
    throw new PromptAssemblyError('Every frozen skill needs a non-empty id')
  }
  if (typeof skill.content !== 'string' || !skill.content.trim()) {
    throw new PromptAssemblyError(`Frozen skill ${JSON.stringify(skill.id)} needs non-empty content`)
  }
  skillScopeOrder(skill.scope)
  return Object.freeze({
    id: skill.id,
    scope: skill.scope,
    content: skill.content,
  })
}

function skillScopeOrder(scope: PromptSkillScope): number {
  const order = SKILL_SCOPE_ORDER[scope]
  if (order === undefined) throw new PromptAssemblyError(`Unknown skill scope ${JSON.stringify(scope)}`)
  return order
}

function freezeFragment(fragment: PromptFragment): PromptFragment {
  return Object.freeze({ ...fragment })
}

/**
 * Render the "## Capability boundaries" notice for the capabilities this
 * session lacks. Undefined when capabilities are absent (legacy callers) or
 * nothing material is turned off.
 */
function capabilityBoundaries(capabilities: PromptCapabilities | undefined): string | undefined {
  if (!capabilities) return undefined
  const lines: string[] = []
  if (!capabilities.shell) {
    lines.push(
      '- The bash tool is unavailable. Use only the execution tools actually',
      '  listed for this session; Skill instructions do not enable missing tools.',
    )
  }
  if (!capabilities.write && !capabilities.shell) {
    lines.push(
      '- write, edit and bash are unavailable. Other registered tools may write',
      '  their documented outputs; otherwise deliver the result in the conversation.',
    )
  }
  // No subagents line: both parent mindsets carry the delegation surface. The
  // only sessions without it are allowlist-narrowed children, whose prompt
  // never proposes delegation — announcing its absence would deny a capability
  // the prompt never suggested.
  if (lines.length === 0) return undefined
  return `## Capability boundaries (this session)\n\n${lines.join('\n')}`
}

function freezeSnapshot(digest: Sha256, content: string): PromptSnapshot {
  return Object.freeze({ digest, content })
}
