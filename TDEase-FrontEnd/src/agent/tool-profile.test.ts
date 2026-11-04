import { describe, expect, it } from 'vitest'
import { createAgentToolProfile } from './tool-profile'
import { studioCommandDefinitions } from '@/studio/commands/definitions'
import {
  DEFAULT_AGENT_TOOL_SETTINGS,
  normalizeAgentToolSettings,
} from '@/contracts/agent-runtime'

describe('Agent tool profile', () => {
  it('shares the read/compute surface across mindsets; only Run execution is workflow-exclusive', () => {
    const analysis = createAgentToolProfile('analysis', DEFAULT_AGENT_TOOL_SETTINGS)
    const workflow = createAgentToolProfile('workflow', DEFAULT_AGENT_TOOL_SETTINGS)

    // Both mindsets observe Runs, delegate and run long scientific commands —
    // none of that composes or mutates a Run.
    for (const id of [
      'runs.list', 'runs.status', 'runs.wait', 'runs.listFiles', 'runs.pullFile',
      'job.start', 'uniprot.get', 'subagent.spawn', 'skill.read',
    ]) {
      expect(analysis.allowsStudioCommand(id)).toBe(true)
      expect(workflow.allowsStudioCommand(id)).toBe(true)
    }

    // Catalog discovery composes Runs: Workflow-only.
    for (const id of ['nodes.list', 'nodes.get', 'templates.list', 'templates.get']) {
      expect(workflow.allowsStudioCommand(id)).toBe(true)
      expect(analysis.allowsStudioCommand(id)).toBe(false)
    }

    // Scripted tool calls are an Analysis affordance.
    expect(analysis.allowsStudioCommand('ptc.exec')).toBe(true)
    expect(workflow.allowsStudioCommand('ptc.exec')).toBe(false)
    // fetchFile exited the agent surface: it could only return Blob metadata —
    // materialization is pullFile's job (data-closure design §3).
    expect(analysis.allowsStudioCommand('runs.fetchFile')).toBe(false)

    // The workflow-only set is exactly Run composition and control.
    for (const id of [
      'workflow.inspect', 'workflow.validate', 'workflow.run', 'nodes.install',
      'runs.resume', 'runs.overwrite', 'runs.cancel', 'runs.trash', 'runs.restore',
    ]) {
      expect(workflow.allowsStudioCommand(id)).toBe(true)
      expect(analysis.allowsStudioCommand(id)).toBe(false)
    }

    // Both are general agents: the same file/shell builtins and plan tool.
    // write/edit follow workspaceWrite (on by default), so analysis artifacts
    // get first-class file tools instead of rerouting writes through bash.
    expect(analysis.runtime.builtins).toEqual(['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'])
    expect(workflow.runtime.builtins).toEqual(analysis.runtime.builtins)
    expect(analysis.includeTodo).toBe(true)
    expect(workflow.includeTodo).toBe(true)
  })

  it('lets Settings narrow optional groups; write tools follow workspaceWrite for both mindsets', () => {
    const settings = normalizeAgentToolSettings({
      ...DEFAULT_AGENT_TOOL_SETTINGS,
      runObservation: false,
      workspaceWrite: true,
      shell: true,
      mcp: true,
    })
    const analysis = createAgentToolProfile('analysis', settings)
    const workflow = createAgentToolProfile('workflow', settings)
    const noWrite = normalizeAgentToolSettings({ ...DEFAULT_AGENT_TOOL_SETTINGS, workspaceWrite: false })

    expect(analysis.allowsStudioCommand('runs.status')).toBe(false)
    expect(analysis.runtime.builtins).toEqual(['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'])
    expect(workflow.runtime).toEqual({
      builtins: ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'],
      mcp: true,
    })
    expect(createAgentToolProfile('analysis', noWrite).runtime.builtins)
      .toEqual(['read', 'grep', 'find', 'ls', 'bash'])
    expect(createAgentToolProfile('workflow', noWrite).runtime.builtins)
      .toEqual(['read', 'grep', 'find', 'ls', 'bash'])
    expect(workflow.allowsStudioCommand('workflow.run')).toBe(true)
    expect(workflow.includeTodo).toBe(true)
    expect(analysis.includeTodo).toBe(true)
  })

  it('exposes Run-control commands to Workflow by default (runControl defaults on)', () => {
    // Regression: runControl defaulted to false, so runs.resume / runs.overwrite
    // were invisible to Workflow even though the workflow prompt and workflow
    // skill name them — the phantom-tool defect.
    const workflow = createAgentToolProfile('workflow', DEFAULT_AGENT_TOOL_SETTINGS)
    expect(workflow.allowsStudioCommand('runs.resume')).toBe(true)
    expect(workflow.allowsStudioCommand('runs.overwrite')).toBe(true)
    expect(workflow.allowsStudioCommand('runs.cancel')).toBe(true)
    // Analysis never gets Run-control, regardless of the default.
    const analysis = createAgentToolProfile('analysis', DEFAULT_AGENT_TOOL_SETTINGS)
    expect(analysis.allowsStudioCommand('runs.resume')).toBe(false)
  })

  it('hides Run-control commands when the user disables runControl', () => {
    const settings = normalizeAgentToolSettings({ ...DEFAULT_AGENT_TOOL_SETTINGS, runControl: false })
    const workflow = createAgentToolProfile('workflow', settings)
    expect(workflow.allowsStudioCommand('runs.resume')).toBe(false)
    expect(workflow.allowsStudioCommand('runs.overwrite')).toBe(false)
  })

  it('keeps view.* out of every default profile; the viewer-pointer beta is opt-in', () => {
    // Experimental beta: advertised tools spend schema tokens in every
    // session, and the Workbench renders natively without the pointer — so
    // viewTools defaults OFF. Safe from the phantom-tool defect: no prompt or
    // skill names view.* (grep agent/prompt to keep that true).
    const analysis = createAgentToolProfile('analysis', DEFAULT_AGENT_TOOL_SETTINGS)
    const workflow = createAgentToolProfile('workflow', DEFAULT_AGENT_TOOL_SETTINGS)
    expect(analysis.allowsStudioCommand('view.open')).toBe(false)
    expect(workflow.allowsStudioCommand('view.open')).toBe(false)
    expect(workflow.allowsStudioCommand('view.focus')).toBe(false)
    expect(workflow.allowsStudioCommand('view.select')).toBe(false)

    // The viewer pointer is Analysis-only; Workflow never carries it.
    const optedIn = normalizeAgentToolSettings({ ...DEFAULT_AGENT_TOOL_SETTINGS, viewTools: true })
    const analysisIn = createAgentToolProfile('analysis', optedIn)
    expect(analysisIn.allowsStudioCommand('view.open')).toBe(true)
    expect(analysisIn.allowsStudioCommand('view.focus')).toBe(true)
    expect(analysisIn.allowsStudioCommand('view.select')).toBe(true)
    expect(createAgentToolProfile('workflow', optedIn).allowsStudioCommand('view.open')).toBe(false)
  })

  it('registers no wiki commands at all (the wiki is plain files; the agent reads and writes it through the file tools)', () => {
    // The former wiki.* command family (and its opt-in setting) is gone: wiki
    // pages are markdown files the agent reaches with read/grep/write, like
    // any other file. Nothing named wiki.* may re-enter the tool surface.
    expect(studioCommandDefinitions().some((definition) => definition.id.startsWith('wiki.'))).toBe(false)
    expect('wiki' in DEFAULT_AGENT_TOOL_SETTINGS).toBe(false)
  })
})
