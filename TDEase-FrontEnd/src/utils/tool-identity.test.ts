/**
 * Tests for the tool-identity single source: bare names, THE failure
 * predicate, categories, and action-phrase keys.
 */
import { describe, expect, it } from 'vitest'
import { bareToolName, isToolFailure, toolActionKey, toolIconName, toolSubject } from './tool-identity'

describe('bareToolName', () => {
  it('strips the tdease. registry prefix and leaves builtins alone', () => {
    expect(bareToolName('tdease.runs.status')).toBe('runs.status')
    expect(bareToolName('tdease.subagent.spawn')).toBe('subagent.spawn')
    expect(bareToolName('bash')).toBe('bash')
    expect(bareToolName('read')).toBe('read')
  })
})

describe('isToolFailure — the ONE predicate every surface shares', () => {
  const base = { done: true, success: true }
  it('failed is a failure', () => {
    expect(isToolFailure({ status: 'failed', done: true, success: false })).toBe(true)
  })
  it('succeeded and running are not', () => {
    expect(isToolFailure({ status: 'succeeded', ...base })).toBe(false)
    expect(isToolFailure({ status: 'running', done: false, success: false })).toBe(false)
  })
  it('cancelled is never a failure — even when it carries an error text', () => {
    // The regression the unification fixed: ProcessFold's old inline
    // predicate (status==='failed' || !!error) counted a cancelled call that
    // carried an error message as a failure, while ToolGroupBlock's did not.
    expect(isToolFailure({ status: 'cancelled', done: true, success: false })).toBe(false)
  })
  it('a done call that did not succeed and is not running/cancelled is a failure', () => {
    expect(isToolFailure({ status: 'unknown', done: true, success: false })).toBe(true)
  })
})

describe('toolIconName', () => {
  it('maps the process-UI glyphs', () => {
    expect(toolIconName('bash')).toBe('terminal')
    expect(toolIconName('tdease.write')).toBe('pencil')
    expect(toolIconName('read')).toBe('file')
    expect(toolIconName('grep')).toBe('search')
    expect(toolIconName('tdease.todo_write')).toBe('list')
    expect(toolIconName('tdease.subagent.spawn')).toBe('spark')
  })

  it('splits the run lifecycle into distinct gestures (workflow graph / resume / watch / log / fetch)', () => {
    // The audit-follow-up mapping: run lifecycle tools are NOT one terminal
    // blob — orchestration reads as a graph, resuming as a start action,
    // watching as status work, log/file access as their own reading gestures.
    expect(toolIconName('tdease.workflow.run')).toBe('workflow')
    expect(toolIconName('tdease.orchestrate.run')).toBe('workflow')
    expect(toolIconName('tdease.runs.resume')).toBe('run')
    expect(toolIconName('tdease.runs.overwrite')).toBe('run')
    expect(toolIconName('tdease.runs.status')).toBe('monitor')
    expect(toolIconName('tdease.runs.wait')).toBe('monitor')
    expect(toolIconName('tdease.job.status')).toBe('monitor')
    expect(toolIconName('tdease.runs.tailLog')).toBe('log')
    expect(toolIconName('tdease.runs.fetchFile')).toBe('fileDown')
    expect(toolIconName('tdease.runs.pullFile')).toBe('fileDown')
    expect(toolIconName('tdease.runs.listFiles')).toBe('folder')
    // Raw shell stays the terminal glyph.
    expect(toolIconName('bash')).toBe('terminal')
  })
})

describe('toolActionKey', () => {
  it('maps builtins and listed registry commands to action phrases', () => {
    expect(toolActionKey('bash')).toBe('agent.toolAction.bash')
    expect(toolActionKey('tdease.bash')).toBe('agent.toolAction.bash')
    expect(toolActionKey('tdease.read')).toBe('agent.toolAction.read')
    expect(toolActionKey('tdease.runs.status')).toBe('agent.toolAction.runWatch')
    expect(toolActionKey('tdease.subagent.spawn')).toBe('agent.toolAction.spawn')
  })
  it('todo-family tools share the plan phrase', () => {
    expect(toolActionKey('tdease.todo_write')).toBe('agent.toolAction.plan')
  })
  it('returns undefined for unlisted tools — bare name, not an invented phrase', () => {
    expect(toolActionKey('tdease.uniprot.blast')).toBeUndefined()
    expect(toolActionKey('tdease.session.reportBlocked')).toBeUndefined()
  })
  it('phantom tool names get no phrase — nothing may dress up a tool the runtime never registers', () => {
    // The phantom-tool defect class: hand-maintained UI tables once carried
    // arms for names nothing produces (web_search, runs.submit,
    // workflow.execute, edit-diff, glob, exec_command, canvas.write). The
    // cleanup removed them; these guards keep them out.
    expect(toolActionKey('tdease.web_search')).toBeUndefined()
    expect(toolActionKey('tdease.runs.submit')).toBeUndefined()
    expect(toolActionKey('tdease.workflow.execute')).toBeUndefined()
    expect(toolActionKey('tdease.edit-diff')).toBeUndefined()
  })
})

describe('toolSubject — the intent line object, distilled from the args', () => {
  it('shows the bash command: first line, one line, cut honestly', () => {
    expect(toolSubject('bash', { command: 'npm run build' })).toBe('npm run build')
    expect(toolSubject('bash', { command: 'npm test\nnpm run lint' })).toBe('npm test')
    expect(toolSubject('bash', { command: 'echo    spaced\tout' })).toBe('echo spaced out')
    const long = `echo ${'x'.repeat(80)}`
    const subject = toolSubject('bash', { command: long })
    expect(subject).toBe(`${long.slice(0, 48)}…`)
  })
  it('shows the file leaf for path-like calls — HUD-grade granularity', () => {
    expect(toolSubject('read', { path: 'C:\\ws\\src\\agent\\turn-phase.ts' })).toBe('turn-phase.ts')
    expect(toolSubject('read', { path: '/ws/src/agent/turn-phase.ts' })).toBe('turn-phase.ts')
    expect(toolSubject('tdease.write', { filePath: '/ws/docs/plan.md' })).toBe('plan.md')
  })
  it('prefers the pattern/query/role field in try order', () => {
    expect(toolSubject('grep', { pattern: 'toolSubject', path: '/ws/src' })).toBe('toolSubject')
    expect(toolSubject('tdease.subagent.spawn', { role: 'scout', prompt: 'look around' })).toBe('scout')
  })
  it('names the plan task in progress via its own activeForm', () => {
    expect(toolSubject('tdease.todo_write', { todos: [
      { content: 'a', activeForm: 'done deal', status: 'completed' },
      { content: 'b', activeForm: 'rewiring the HUD', status: 'in_progress' },
    ] })).toBe('rewiring the HUD')
  })
  it('returns undefined over unknown shapes — never an invented subject', () => {
    expect(toolSubject('bash', undefined)).toBeUndefined()
    expect(toolSubject('read', {})).toBeUndefined()
    expect(toolSubject('tdease.uniprot.blast', { sequence: 'MKTAYIAK' })).toBeUndefined()
  })
})
