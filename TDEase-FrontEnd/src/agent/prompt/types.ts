/**
 * Ports and values for prompt assembly. They deliberately have no filesystem,
 * Electron, Vue, or Pi dependency so the same assembly runs headlessly.
 */

export type Sha256 = string

export interface Sha256Digest {
  sha256(content: string): Promise<Sha256>
}

/** System-root-relative paths. The adapter owns the actual System root. */
export const PROMPT_ASSETS = Object.freeze({
  baseRole: 'prompts/internal/base_role.md',
  toolPolicy: 'prompts/internal/tool_policy.md',
  wikiPolicy: 'prompts/internal/wiki_policy.md',
  nativeToolchain: 'prompts/internal/native_toolchain.md',
  scientificHonesty: 'prompts/internal/scientific_honesty.md',
  terminology: 'prompts/internal/terminology.md',
  analysisLayout: 'prompts/internal/analysis_layout.md',
  evidencePresentation: 'prompts/internal/evidence_presentation.md',
  delegationPolicy: 'prompts/internal/delegation_policy.md',
  orchestratePolicy: 'prompts/internal/orchestrate_policy.md',
  ptcPolicy: 'prompts/internal/ptc_policy.md',
  explorerMode: 'prompts/internal/mode_explorer.md',
  executorMode: 'prompts/internal/mode_executor.md',
  safetyPolicy: 'prompts/internal/safety_policy.md',
} as const)

export type PromptAssetPath = (typeof PROMPT_ASSETS)[keyof typeof PROMPT_ASSETS]

export interface PromptAssetReader {
  readText(path: PromptAssetPath): Promise<string>
}

export type MindsetId = 'explorer' | 'executor'

export type ModePromptMap = Readonly<Record<MindsetId, PromptAssetPath>>

export const DEFAULT_MODE_PROMPTS: ModePromptMap = Object.freeze({
  explorer: PROMPT_ASSETS.explorerMode,
  executor: PROMPT_ASSETS.executorMode,
})

/** The order is contractual and matches FILE-LAYOUT: System, then Workspace. */
export type PromptSkillScope = 'system' | 'workspace'

export interface PromptSkillText {
  readonly id: string
  readonly scope: PromptSkillScope
  readonly content: string
}

/**
 * One line of the compact skill index (progressive disclosure, layer 1): the
 * scoped name (`system:qc` / `workspace:qc`) plus an optional one-line
 * description. Never carries SKILL.md content — full text still loads only via
 * an explicit @skill reference or `skill.read`.
 */
export interface PromptSkillIndexEntry {
  readonly name: string
  readonly description?: string
}

export interface PromptSkillCollision {
  readonly name: string
  readonly sources: ReadonlyArray<PromptSkillScope>
}

export interface SystemPromptInput {
  mindset: MindsetId
  skills?: ReadonlyArray<PromptSkillText>
  /** Compact skill index rendered as a `## Available skills` section; omitted when empty. */
  skillIndex?: ReadonlyArray<PromptSkillIndexEntry>
  /** A pre-rendered, turn-start Workspace description. */
  workspaceContext?: string
  /** Optional subagent role briefing, assembled by the registry (base + role
   *  system_prompt). Rendered as a `subagent_role` fragment when present —
   *  this is how a child session gets its role's own system prompt. */
  subagentRole?: string
  /** When true, the orchestration policy fragment is assembled (teaching the
   *  agent the `orchestrate.run/wait` script interface). Off by default — the
   *  orchestrate.* tool surface and this fragment are gated by the same
   *  `orchestrateEnabled` binding flag, so the agent never sees the script
   *  capability until the session opts in. */
  orchestrateEnabled?: boolean
  /** When true, the PTC policy fragment is assembled (teaching the agent the
   *  `tdease.ptc.exec` script interface). Gated by the same `ptcEnabled`
   *  binding flag as the command surface — a distinct capability from
   *  orchestration. */
  ptcEnabled?: boolean
}

export type PromptFragmentKind =
  | 'base_role'
  | 'tool_policy'
  | 'wiki_policy'
  | 'native_toolchain'
  | 'scientific_honesty'
  | 'terminology'
  | 'analysis_layout'
  | 'evidence_presentation'
  | 'delegation_policy'
  | 'orchestrate_policy'
  | 'ptc_policy'
  | 'mode'
  | 'safety_policy'
  | 'subagent_role'
  | 'skill_index'
  | 'skill'
  | 'workspace_context'

export interface PromptFragment {
  readonly kind: PromptFragmentKind
  readonly content: string
  readonly asset?: PromptAssetPath
}

/** Content-addressed snapshot persisted under `snapshots/<digest>.md`. */
export interface PromptSnapshot {
  readonly digest: Sha256
  readonly content: string
}

export interface AssembledSystemPrompt extends PromptSnapshot {
  readonly fragments: ReadonlyArray<PromptFragment>
  readonly skills: ReadonlyArray<PromptSkillText>
}

/** The store owns durable placement; the assembler only knows content and digest. */
export interface PromptSnapshotStore {
  write(digest: Sha256, content: string): Promise<void>
  read(digest: Sha256): Promise<string | undefined>
}
