import { describe, expect, it } from 'vitest'
import { createAgentToolProfile } from './tool-profile'
import { studioCommandDefinitions } from '@/studio/commands/definitions'
import {
  DEFAULT_AGENT_TOOL_SETTINGS,
  normalizeAgentToolSettings,
} from '@/contracts/agent-runtime'

describe('Agent tool profile', () => {
  it('gives Explorer write-only Evidence without workflow tools', () => {
    const profile = createAgentToolProfile('explorer', DEFAULT_AGENT_TOOL_SETTINGS)

    expect(profile.allowsStudioCommand('evidence.list')).toBe(false)
    expect(profile.allowsStudioCommand('evidence.read')).toBe(false)
    expect(profile.allowsStudioCommand('evidence.graph')).toBe(false)
    expect(profile.allowsStudioCommand('evidence.verify')).toBe(false)
    expect(profile.allowsStudioCommand('evidence.write')).toBe(true)
    expect(profile.allowsStudioCommand('runs.fetchFile')).toBe(true)
    // Long scientific commands run through the job port, not a 300s bash
    // timeout: the prompt names job.start, so Explorer must see job.* tools.
    expect(profile.allowsStudioCommand('job.start')).toBe(true)
    expect(profile.allowsStudioCommand('job.status')).toBe(true)
    expect(profile.allowsStudioCommand('job.peek')).toBe(true)
    expect(profile.allowsStudioCommand('job.cancel')).toBe(true)
    expect(profile.allowsStudioCommand('job.list')).toBe(true)
    // Discovery docs are read-only: Explorer reads node/template capability
    // sheets to understand what a skill can produce, without running anything.
    expect(profile.allowsStudioCommand('nodes.list')).toBe(true)
    expect(profile.allowsStudioCommand('nodes.get')).toBe(true)
    expect(profile.allowsStudioCommand('templates.get')).toBe(true)
    // Workflow stays gated to Executor; scientific scripts use controlled bash.
    expect(profile.allowsStudioCommand('workflow.submit')).toBe(false)
    expect(profile.allowsStudioCommand('workflow.run')).toBe(false)
    expect(profile.allowsStudioCommand('runs.overwrite')).toBe(false)
    expect(profile.runtime.builtins).toEqual(['read', 'grep', 'find', 'ls', 'bash'])
  })

  it('lets Settings narrow optional groups and only Executor receive write tools', () => {
    const settings = normalizeAgentToolSettings({
      ...DEFAULT_AGENT_TOOL_SETTINGS,
      runObservation: false,
      workspaceWrite: true,
      shell: true,
      mcp: true,
    })
    const explorer = createAgentToolProfile('explorer', settings)
    const executor = createAgentToolProfile('executor', settings)

    expect(explorer.allowsStudioCommand('runs.status')).toBe(false)
    expect(explorer.runtime.builtins).toEqual(['read', 'grep', 'find', 'ls', 'bash'])
    expect(executor.runtime).toEqual({
      builtins: ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'],
      mcp: true,
    })
    expect(executor.allowsStudioCommand('workflow.run')).toBe(true)
    expect(executor.includeTodo).toBe(true)
  })

  it('exposes Run-control commands to Executor by default (runControl defaults on)', () => {
    // Regression: runControl defaulted to false, so runs.resume / runs.overwrite
    // were invisible to Executor even though the executor prompt and workflow
    // skill name them — the phantom-tool defect.
    const executor = createAgentToolProfile('executor', DEFAULT_AGENT_TOOL_SETTINGS)
    expect(executor.allowsStudioCommand('runs.resume')).toBe(true)
    expect(executor.allowsStudioCommand('runs.overwrite')).toBe(true)
    expect(executor.allowsStudioCommand('runs.cancel')).toBe(true)
    // Explorer never gets Run-control, regardless of the default.
    const explorer = createAgentToolProfile('explorer', DEFAULT_AGENT_TOOL_SETTINGS)
    expect(explorer.allowsStudioCommand('runs.resume')).toBe(false)
  })

  it('hides Run-control commands when the user disables runControl', () => {
    const settings = normalizeAgentToolSettings({ ...DEFAULT_AGENT_TOOL_SETTINGS, runControl: false })
    const executor = createAgentToolProfile('executor', settings)
    expect(executor.allowsStudioCommand('runs.resume')).toBe(false)
    expect(executor.allowsStudioCommand('runs.overwrite')).toBe(false)
  })

  it('keeps view.* out of every default profile; the viewer-pointer beta is opt-in', () => {
    // Experimental beta: advertised tools spend schema tokens in every
    // session, and the Workbench renders natively without the pointer — so
    // viewTools defaults OFF. Safe from the phantom-tool defect: no prompt or
    // skill names view.* (grep agent/prompt to keep that true).
    const explorer = createAgentToolProfile('explorer', DEFAULT_AGENT_TOOL_SETTINGS)
    const executor = createAgentToolProfile('executor', DEFAULT_AGENT_TOOL_SETTINGS)
    expect(explorer.allowsStudioCommand('view.open')).toBe(false)
    expect(executor.allowsStudioCommand('view.open')).toBe(false)
    expect(executor.allowsStudioCommand('view.focus')).toBe(false)
    expect(executor.allowsStudioCommand('view.select')).toBe(false)

    const optedIn = normalizeAgentToolSettings({ ...DEFAULT_AGENT_TOOL_SETTINGS, viewTools: true })
    expect(createAgentToolProfile('executor', optedIn).allowsStudioCommand('view.open')).toBe(true)
    expect(createAgentToolProfile('explorer', optedIn).allowsStudioCommand('view.select')).toBe(true)
  })

  it('registers no wiki commands at all (the wiki is plain files; the agent reads and writes it through the file tools)', () => {
    // The former wiki.* command family (and its opt-in setting) is gone: wiki
    // pages are markdown files the agent reaches with read/grep/write, like
    // any other file. Nothing named wiki.* may re-enter the tool surface.
    expect(studioCommandDefinitions().some((definition) => definition.id.startsWith('wiki.'))).toBe(false)
    expect('wiki' in DEFAULT_AGENT_TOOL_SETTINGS).toBe(false)
  })
})
