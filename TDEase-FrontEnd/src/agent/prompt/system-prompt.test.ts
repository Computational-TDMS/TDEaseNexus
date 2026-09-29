import { describe, expect, it, vi } from 'vitest'
import {
  PROMPT_ASSETS,
  PromptSnapshotIntegrityError,
  SystemPromptAssembler,
  type PromptAssetPath,
  type PromptAssetReader,
  type PromptSnapshotStore,
  type Sha256,
  type Sha256Digest,
} from './index'

const assetTexts: Record<PromptAssetPath, string> = {
  [PROMPT_ASSETS.baseRole]: 'BASE ROLE',
  [PROMPT_ASSETS.toolPolicy]: 'TOOL POLICY',
  [PROMPT_ASSETS.wikiPolicy]: 'WIKI POLICY',
  [PROMPT_ASSETS.nativeToolchain]: 'NATIVE TOOLCHAIN',
  [PROMPT_ASSETS.scientificHonesty]: 'SCIENTIFIC HONESTY',
  [PROMPT_ASSETS.terminology]: 'TERMINOLOGY',
  [PROMPT_ASSETS.analysisLayout]: 'ANALYSIS LAYOUT',
  [PROMPT_ASSETS.evidencePresentation]: 'EVIDENCE PRESENTATION',
  [PROMPT_ASSETS.delegationPolicy]: 'DELEGATION POLICY',
  [PROMPT_ASSETS.explorerMode]: 'EXPLORER MODE',
  [PROMPT_ASSETS.executorMode]: 'EXECUTOR MODE',
  [PROMPT_ASSETS.safetyPolicy]: 'SAFETY POLICY',
}

function digestForTests(): Sha256Digest {
  return {
    async sha256(content: string): Promise<Sha256> {
      let value = 5381
      for (const character of content) value = ((value * 33) ^ character.charCodeAt(0)) >>> 0
      return value.toString(16).padStart(64, '0')
    },
  }
}

function readerFor(values: Record<PromptAssetPath, string>): PromptAssetReader & { readText: ReturnType<typeof vi.fn> } {
  return {
    readText: vi.fn(async (path: PromptAssetPath) => values[path]),
  }
}

describe('SystemPromptAssembler', () => {
  it('assembles System assets, mode, frozen skills, and workspace context in contract order', async () => {
    const assets = readerFor(assetTexts)
    const assembler = new SystemPromptAssembler({ assets, digest: digestForTests() })
    const skills = [
      { id: 'workspace-skill', scope: 'workspace' as const, content: 'WORKSPACE SKILL' },
      { id: 'system-first', scope: 'system' as const, content: 'SYSTEM FIRST' },
      { id: 'system-second', scope: 'system' as const, content: 'SYSTEM SECOND' },
    ]

    const snapshot = await assembler.assemble({
      mindset: 'executor',
      skills,
      workspaceContext: 'WORKSPACE CONTEXT',
    })

    expect(assets.readText).toHaveBeenNthCalledWith(1, PROMPT_ASSETS.baseRole)
    expect(assets.readText).toHaveBeenNthCalledWith(2, PROMPT_ASSETS.toolPolicy)
    expect(assets.readText).toHaveBeenNthCalledWith(3, PROMPT_ASSETS.scientificHonesty)
    expect(assets.readText).toHaveBeenNthCalledWith(4, PROMPT_ASSETS.terminology)
    expect(assets.readText).toHaveBeenNthCalledWith(5, PROMPT_ASSETS.delegationPolicy)
    expect(assets.readText).toHaveBeenNthCalledWith(6, PROMPT_ASSETS.executorMode)
    expect(assets.readText).toHaveBeenNthCalledWith(7, PROMPT_ASSETS.safetyPolicy)
    // executor mindset skips the explorer-only fragments (wiki_policy, native_toolchain, analysis_layout, evidence_presentation)
    expect(assets.readText).not.toHaveBeenCalledWith(PROMPT_ASSETS.wikiPolicy)
    expect(assets.readText).not.toHaveBeenCalledWith(PROMPT_ASSETS.nativeToolchain)
    expect(assets.readText).not.toHaveBeenCalledWith(PROMPT_ASSETS.analysisLayout)
    expect(assets.readText).not.toHaveBeenCalledWith(PROMPT_ASSETS.evidencePresentation)
    expect(snapshot.content).toBe([
      'BASE ROLE',
      'TOOL POLICY',
      'SCIENTIFIC HONESTY',
      'TERMINOLOGY',
      'DELEGATION POLICY',
      'EXECUTOR MODE',
      'SAFETY POLICY',
      '## Skill: system-first\n\nSYSTEM FIRST',
      '## Skill: system-second\n\nSYSTEM SECOND',
      '## Skill: workspace-skill\n\nWORKSPACE SKILL',
      '## Workspace Context\n\nWORKSPACE CONTEXT',
    ].join('\n\n---\n\n'))
    expect(snapshot.fragments.map(({ kind }) => kind)).toEqual([
      'base_role', 'tool_policy', 'scientific_honesty', 'terminology', 'delegation_policy', 'mode', 'safety_policy',
      'skill', 'skill', 'skill', 'workspace_context',
    ])
    expect(snapshot.skills.map(({ id }) => id)).toEqual([
      'system-first', 'system-second', 'workspace-skill',
    ])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.fragments)).toBe(true)
    expect(Object.isFrozen(snapshot.fragments[0])).toBe(true)
    expect(Object.isFrozen(snapshot.skills)).toBe(true)
    expect(Object.isFrozen(snapshot.skills[0])).toBe(true)

    skills[0].content = 'MUTATED AFTER TURN START'
    expect(snapshot.content).not.toContain('MUTATED AFTER TURN START')
    expect(snapshot.skills.at(-1)?.content).toBe('WORKSPACE SKILL')
  })

  it('renders the skill index section and truncates it', async () => {
    const assembler = new SystemPromptAssembler({ assets: readerFor(assetTexts), digest: digestForTests() })
    const long = 'x'.repeat(200)
    const skillIndex = [
      { name: 'system:qc', description: `Quality\ncontrol ${long}` },
      { name: 'workspace:notes' },
      ...Array.from({ length: 60 }, (_, i) => ({ name: `workspace:s${i}` })),
    ]

    const snapshot = await assembler.assemble({ mindset: 'explorer', skillIndex })

    const section = snapshot.fragments.find((fragment) => fragment.kind === 'skill_index')
    expect(section?.content.startsWith('## Available skills\n\nUse the exact scoped id with `skill.read` when you need a skill\'s instructions.\n\n- system:qc — Quality control ')).toBe(true)
    expect(section?.content).toContain('\n- workspace:notes\n')
    expect(section?.content).not.toContain(long)
    expect(section?.content.match(/^- /gm)).toHaveLength(50)
    expect(section?.content).toContain('… and 12 more')
    expect(snapshot.content).not.toContain('Quality\ncontrol')
    // The index sits after safety and before any full skill fragments.
    expect(snapshot.fragments.map(({ kind }) => kind)).toEqual([
      'base_role', 'tool_policy', 'wiki_policy', 'native_toolchain', 'scientific_honesty', 'terminology', 'analysis_layout', 'evidence_presentation', 'delegation_policy', 'mode', 'safety_policy', 'skill_index',
    ])
  })

  it('renders a subagent role briefing as a fragment after safety when supplied', async () => {
    const assembler = new SystemPromptAssembler({ assets: readerFor(assetTexts), digest: digestForTests() })

    const without = await assembler.assemble({ mindset: 'explorer' })
    expect(without.fragments.some((fragment) => fragment.kind === 'subagent_role')).toBe(false)

    const withRole = await assembler.assemble({
      mindset: 'explorer',
      subagentRole: '# Base contract\n\nYou are the evidence specialist.',
    })
    expect(withRole.fragments.map(({ kind }) => kind)).toEqual([
      'base_role', 'tool_policy', 'wiki_policy', 'native_toolchain', 'scientific_honesty', 'terminology', 'analysis_layout', 'evidence_presentation', 'delegation_policy', 'mode', 'safety_policy', 'subagent_role',
    ])
    expect(withRole.fragments.find((fragment) => fragment.kind === 'subagent_role')?.content)
      .toBe('# Base contract\n\nYou are the evidence specialist.')
    // The role briefing changes the digest — a child's prompt is not a parent's.
    expect(withRole.digest).not.toBe(without.digest)
  })

  it('omits the skill index section when no skills are available', async () => {
    const assembler = new SystemPromptAssembler({ assets: readerFor(assetTexts), digest: digestForTests() })

    const without = await assembler.assemble({ mindset: 'explorer' })
    const empty = await assembler.assemble({ mindset: 'explorer', skillIndex: [] })

    expect(without.content).not.toContain('## Available skills')
    expect(empty.content).toBe(without.content)
  })

  it('uses an injected active-mode mapping', async () => {
    const assembler = new SystemPromptAssembler({
      assets: readerFor(assetTexts),
      digest: digestForTests(),
      modePrompts: { explorer: PROMPT_ASSETS.executorMode },
    })

    const snapshot = await assembler.assemble({ mindset: 'explorer' })

    expect(snapshot.fragments.find((f) => f.kind === 'mode')).toMatchObject({ asset: PROMPT_ASSETS.executorMode, content: 'EXECUTOR MODE' })
  })

  it('persists content-addressed snapshots and rejects changed stored content', async () => {
    const entries = new Map<Sha256, string>()
    const store: PromptSnapshotStore = {
      write: vi.fn(async (digest: Sha256, content: string) => { entries.set(digest, content) }),
      read: vi.fn(async (digest: Sha256) => entries.get(digest)),
    }
    const assembler = new SystemPromptAssembler({ assets: readerFor(assetTexts), digest: digestForTests() })

    const snapshot = await assembler.assembleAndPersist({ mindset: 'explorer' }, store)
    expect(store.write).toHaveBeenCalledWith(snapshot.digest, snapshot.content)

    const restored = await assembler.resolve(snapshot.digest, store)
    expect(restored).toEqual({ digest: snapshot.digest, content: snapshot.content })
    expect(Object.isFrozen(restored)).toBe(true)

    entries.set(snapshot.digest, 'tampered prompt content')
    await expect(assembler.resolve(snapshot.digest, store)).rejects.toBeInstanceOf(PromptSnapshotIntegrityError)
    expect(await assembler.resolve('f'.repeat(64), store)).toBeUndefined()
  })
})
