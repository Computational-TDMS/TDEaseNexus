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
  kind: Extract<PromptFragment['kind'], 'base_role' | 'delegation_policy' | 'safety_policy'>
  asset: PromptAssetPath
}> = Object.freeze([
  { kind: 'base_role', asset: PROMPT_ASSETS.baseRole },
  // Delegation guidance is a first-class fragment for every session (the main
  // agent must know the subagent interface exists), read once like the others.
  { kind: 'delegation_policy', asset: PROMPT_ASSETS.delegationPolicy },
  { kind: 'safety_policy', asset: PROMPT_ASSETS.safetyPolicy },
])

/**
 * The tool-policy family, split from the former monolithic default_tool_policy.
 * The fragments are assembled in this fixed order between base_role and
 * delegation_policy. The explorer-only fragments (native_toolchain,
 * analysis_layout, evidence_presentation) are gated by mindset: executor
 * drives `tdease.workflow.run` and does not carry the tdeasenexus-toolbox
 * chemistry usage or the analysis slug layout, so it reads only the universal
 * three. All map to the same external 'tool-policy' slot in prompt-pipeline's
 * SLOT_BY_KIND.
 */
const TOOL_POLICY_SEQUENCE: ReadonlyArray<{
  kind: Extract<PromptFragment['kind'], 'tool_policy' | 'wiki_policy' | 'native_toolchain' | 'scientific_honesty' | 'terminology' | 'analysis_layout' | 'evidence_presentation'>
  asset: PromptAssetPath
  mindsets?: readonly MindsetId[]
}> = Object.freeze([
  { kind: 'tool_policy', asset: PROMPT_ASSETS.toolPolicy },
  { kind: 'wiki_policy', asset: PROMPT_ASSETS.wikiPolicy },
  { kind: 'native_toolchain', asset: PROMPT_ASSETS.nativeToolchain, mindsets: ['explorer'] },
  { kind: 'scientific_honesty', asset: PROMPT_ASSETS.scientificHonesty },
  { kind: 'terminology', asset: PROMPT_ASSETS.terminology },
  { kind: 'analysis_layout', asset: PROMPT_ASSETS.analysisLayout, mindsets: ['explorer'] },
  { kind: 'evidence_presentation', asset: PROMPT_ASSETS.evidencePresentation, mindsets: ['explorer'] },
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

    const [baseRole, delegationPolicy, safetyPolicy] = ASSET_SEQUENCE
    fragments.push(await this.readFragment(baseRole.kind, baseRole.asset))

    // Tool-policy family: every session reads the universal fragments; the
    // explorer-only fragments are gated by mindset so executor does not carry
    // the tdeasenexus-toolbox chemistry usage or the analysis slug layout.
    for (const spec of TOOL_POLICY_SEQUENCE) {
      if (spec.mindsets && !spec.mindsets.includes(input.mindset)) continue
      fragments.push(await this.readFragment(spec.kind, spec.asset))
    }

    // Delegation guidance sits between the tool policy (which introduces the
    // tool families) and the mindset, so every session learns the subagent
    // interface before it picks a working loop.
    fragments.push(await this.readFragment(delegationPolicy.kind, delegationPolicy.asset))

    // Orchestration policy is opt-in: assembled only when the binding set
    // `orchestrateEnabled`. The orchestrate.* tool surface is gated by the same
    // flag (context.orchestrate is injected only then), so the agent never sees
    // the script capability — neither the tools nor the guidance — until the
    // session explicitly turns it on. Placed after delegation so the agent
    // already knows the subagent primitives the script builds on.
    if (input.orchestrateEnabled) {
      fragments.push(await this.readFragment('orchestrate_policy', PROMPT_ASSETS.orchestratePolicy))
    }
    // PTC policy is opt-in by its own `ptcEnabled` flag — a distinct capability
    // from orchestration (scripted tool calls that collapse round-trips, not
    // subagent organization). The tdease.ptc.exec surface is gated by the same
    // flag, so guidance and capability appear together.
    if (input.ptcEnabled) {
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

function freezeSnapshot(digest: Sha256, content: string): PromptSnapshot {
  return Object.freeze({ digest, content })
}
