import { describe, expect, it } from 'vitest'

import { createSessionProjector, projectSessionEvents } from './project'
import { createSessionEvent, type EventInput } from './vocabulary'

function events(...inputs: EventInput[]) {
  return inputs.map((input, index) => createSessionEvent(input, index + 1))
}

describe('projectSessionEvents', () => {
  it('projects a completed tool as a tool group with no separate media blocks', () => {
    // Figures now travel as markdown links inside the tool result text, rendered
    // by MarkdownContent's hydration — there is no `media` block extraction.
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'Run the analysis.',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'bash', name: 'bash', args: { command: 'make fig' } },
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'bash', ok: true, result: 'wrote results/figure.svg\n\n![](results/figure.svg)' },
      { type: 'turn.completed', turn_id: 'turn_1', outcome: 'resolved', usage: { input_tokens: 1, output_tokens: 1, tool_calls: 1, wall_clock_ms: 1 } },
    ))

    const blocks = projection.messages[1].blocks!
    expect(blocks.some((block) => block.type === 'media')).toBe(false)
    expect(blocks.some((block) => block.type === 'tool_group')).toBe(true)
  })

  it('carries a bounded result preview on a settled successful tool call', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'Run the analysis.',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'bash', name: 'bash', args: {} },
      // Structured results compress to compact JSON; strings stay verbatim.
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'bash', ok: true, result: { status: 'ok', points: [1, 2] } },
    ))
    const group = projection.messages[1].blocks!.find((b) => b.type === 'tool_group')!
    const tool = group.type === 'tool_group' ? group.tools[0] : undefined
    expect(tool?.resultPreview).toEqual({ text: '{"status":"ok","points":[1,2]}', truncated: false, totalChars: 30 })
  })

  it('cuts oversized results at the preview budget and carries the verbatim total', () => {
    const long = 'x'.repeat(1000)
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'go',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'c1', name: 'bash', args: {} },
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'c1', ok: true, result: long },
    ))
    const group = projection.messages[1].blocks!.find((b) => b.type === 'tool_group')!
    const tool = group.type === 'tool_group' ? group.tools[0] : undefined
    expect(tool?.resultPreview?.truncated).toBe(true)
    expect(tool?.resultPreview?.totalChars).toBe(1000)
    expect(tool?.resultPreview?.text.length).toBe(800)
  })

  it('an explicitly empty result is a preview with empty text, not a missing preview', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'go',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'c1', name: 'read', args: {} },
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'c1', ok: true, result: '' },
    ))
    const group = projection.messages[1].blocks!.find((b) => b.type === 'tool_group')!
    const tool = group.type === 'tool_group' ? group.tools[0] : undefined
    expect(tool?.resultPreview).toEqual({ text: '', truncated: false, totalChars: 0 })
  })

  it('marks a tool interrupted by its turn\'s end as cancelled — never eternally running', () => {
    // The turn ended (cancelled) without call c2 completing. Its lifecycle is
    // over: replaying the session must show it as cancelled, not as running
    // dots that tick forever.
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'go',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'c1', name: 'bash', args: {} },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'c2', name: 'read', args: {} },
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'c1', ok: true, result: 'done' },
      { type: 'turn.cancelled', turn_id: 'turn_1' },
    ))
    const group = projection.messages[1].blocks!.find((b) => b.type === 'tool_group')!
    const tools = group.type === 'tool_group' ? group.tools : []
    expect(tools[0]?.status).toBe('succeeded')
    expect(tools[1]?.status).toBe('cancelled')
    expect(tools[1]?.done).toBe(true)
  })

  it('folds a resolved approval into its tool call, not a separate permission block', () => {
    // A tool gated on consent used to project as TWO blocks: a `permission`
    // card AND a `tool_group` row, both carrying the same name + args — the
    // replay rendered the same call twice (a bulky card plus a tool row). The
    // approval now folds into the ToolCall itself (`tool.approval`), so a
    // replayed approved tool shows once: name + args + the decision on one row.
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started',
        turn_id: 'turn_1',
        user_message: 'Submit the workflow.',
        prompt_snapshot_digest: 'a'.repeat(64),
        model: 'fixture/model',
        mindset: 'auto',
        authority: 'ask',
      },
      { type: 'approval.requested', turn_id: 'turn_1', call_id: 'call_1', action: 'workflow.submit', basis: 'Submitting a Run.' },
      { type: 'approval.resolved', turn_id: 'turn_1', call_id: 'call_1', decision: 'approved', by: 'user' },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'call_1', name: 'tdease.workflow.submit', args: { planRef: 'plan_1' } },
      { type: 'thinking.recorded', turn_id: 'turn_1', content: 'The plan is valid.' },
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'call_1', ok: true, result: { run_id: 'run_1' } },
      { type: 'message.completed', turn_id: 'turn_1', role: 'assistant', content: 'Submitted run_1.' },
      {
        type: 'turn.completed',
        turn_id: 'turn_1',
        outcome: 'resolved',
        usage: { input_tokens: 12, output_tokens: 5, tool_calls: 1, wall_clock_ms: 43 },
      },
    ))

    const act = projection.messages[1]
    // No `permission` block at all — the only rich/tool block is the tool_group.
    expect(act.blocks?.map((b) => b.type)).not.toContain('permission')
    const group = act.blocks!.find((b) => b.type === 'tool_group')!
    expect(group.tools).toHaveLength(1)
    expect(group.tools[0]).toMatchObject({
      name: 'tdease.workflow.submit',
      args: { planRef: 'plan_1' },
      status: 'succeeded',
      approval: { decision: 'approved', reason: 'Submitting a Run.' },
    })
  })

  it('records a declined approval on its tool call as well', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started',
        turn_id: 'turn_1',
        user_message: 'Run it.',
        prompt_snapshot_digest: 'a'.repeat(64),
        model: 'fixture/model',
        mindset: 'auto',
        authority: 'ask',
      },
      { type: 'approval.requested', turn_id: 'turn_1', call_id: 'call_1', action: 'shell.exec', basis: 'bash requested shell.exec' },
      { type: 'approval.resolved', turn_id: 'turn_1', call_id: 'call_1', decision: 'declined', by: 'user' },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'call_1', name: 'tdease.bash', args: { command: 'rm -rf /' } },
      {
        type: 'turn.completed',
        turn_id: 'turn_1',
        outcome: 'resolved',
        usage: { input_tokens: 1, output_tokens: 1, tool_calls: 1, wall_clock_ms: 1 },
      },
    ))

    const group = projection.messages[1].blocks!.find((b) => b.type === 'tool_group')!
    expect(group.tools[0].approval).toEqual({ decision: 'declined', reason: 'bash requested shell.exec' })
  })

  it('interleaves tool groups at their call positions instead of folding the turn into one group', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started',
        turn_id: 'turn_1',
        user_message: 'Inspect and submit.',
        prompt_snapshot_digest: 'a'.repeat(64),
        model: 'fixture/model',
        mindset: 'auto',
        authority: 'auto',
      },
      { type: 'message.completed', turn_id: 'turn_1', role: 'assistant', content: 'Let me look.' },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'call_1', name: 'read', args: { path: 'config.yaml' } },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'call_2', name: 'ls', args: {} },
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'call_1', ok: true, result: {} },
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'call_2', ok: true, result: {} },
      { type: 'message.completed', turn_id: 'turn_1', role: 'assistant', content: 'Now I submit.' },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'call_3', name: 'tdease.workflow.run', args: { runPath: 'runs/a' } },
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'call_3', ok: true, result: { run_id: 'run_1' } },
      { type: 'message.completed', turn_id: 'turn_1', role: 'assistant', content: 'Done.' },
      {
        type: 'turn.completed',
        turn_id: 'turn_1',
        outcome: 'resolved',
        usage: { input_tokens: 1, output_tokens: 1, tool_calls: 3, wall_clock_ms: 1 },
      },
    ))

    const act = projection.messages[1]
    expect(act.blocks?.map((block) => block.type)).toEqual([
      'text', 'tool_group', 'text', 'tool_group', 'text',
    ])
    const groups = act.blocks!.filter((block) => block.type === 'tool_group')
    // Consecutive calls (call_1 + call_2) share one fold; the later call after
    // intervening text gets its own group at its own position.
    expect(groups[0]).toMatchObject({ id: 'event:3', tools: [{ id: 'event:3' }, { id: 'event:4' }] })
    expect(groups[1]).toMatchObject({ id: 'event:8', tools: [{ id: 'event:8' }] })
  })

  it('rejects a non-monotonic prefix instead of inventing a projection order', () => {
    const [first, second] = events(
      {
        type: 'turn.started',
        turn_id: 'turn_1',
        user_message: 'Hello.',
        prompt_snapshot_digest: 'a'.repeat(64),
        model: 'fixture/model',
        mindset: 'auto',
        authority: 'ask',
      },
      { type: 'turn.cancelled', turn_id: 'turn_1' },
    )

    expect(() => projectSessionEvents([second, first])).toThrow('contiguous sequence numbers')
  })
})

describe('projectSessionEvents settlements', () => {
  it('collects a resolved settlement for one turn', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'go',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'tool.requested', turn_id: 'turn_1', call_id: 'c1', name: 'tdease.nodes.list', args: {} },
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'c1', ok: true, result: [] },
      { type: 'message.completed', turn_id: 'turn_1', role: 'assistant', content: 'done' },
      { type: 'turn.completed', turn_id: 'turn_1', outcome: 'resolved', usage: { input_tokens: 10, output_tokens: 20, tool_calls: 1, wall_clock_ms: 500 } },
    ))

    expect(projection.settlements.get('turn_1')).toEqual({
      kind: 'completed',
      outcome: 'resolved',
      usage: { input_tokens: 10, output_tokens: 20, tool_calls: 1, wall_clock_ms: 500 },
      blocked: undefined,
    })
  })

  it('attaches the reportBlocked args to a blocked settlement', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'go',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      {
        type: 'tool.requested', turn_id: 'turn_1', call_id: 'c1', name: 'tdease.session.reportBlocked',
        args: { reason: 'no fasta reference found', needed: 'a fasta file in the Workspace' },
      },
      { type: 'tool.completed', turn_id: 'turn_1', call_id: 'c1', ok: true, result: { reported: true } },
      { type: 'turn.completed', turn_id: 'turn_1', outcome: 'blocked', usage: { input_tokens: 1, output_tokens: 1, tool_calls: 1, wall_clock_ms: 1 } },
    ))

    expect(projection.settlements.get('turn_1')).toMatchObject({
      kind: 'completed',
      outcome: 'blocked',
      blocked: { reason: 'no fasta reference found', needed: 'a fasta file in the Workspace' },
    })
  })

  it('records a failed settlement', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'go',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'turn.failed', turn_id: 'turn_1', error: { code: 'PROVIDER_ERROR', message: 'timed out' } },
    ))
    expect(projection.settlements.get('turn_1')).toEqual({ kind: 'failed', error: { code: 'PROVIDER_ERROR', message: 'timed out' } })
  })

  it('records a cancelled settlement', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'go',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'turn.cancelled', turn_id: 'turn_1' },
    ))
    expect(projection.settlements.get('turn_1')).toEqual({ kind: 'cancelled' })
  })

  it('keeps separate turns independent', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'a',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'turn.completed', turn_id: 'turn_1', outcome: 'resolved', usage: { input_tokens: 0, output_tokens: 0, tool_calls: 0, wall_clock_ms: 0 } },
      {
        type: 'turn.started', turn_id: 'turn_2', user_message: 'b',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'turn.cancelled', turn_id: 'turn_2' },
    ))
    expect(projection.settlements.get('turn_1')).toMatchObject({ kind: 'completed', outcome: 'resolved' })
    expect(projection.settlements.get('turn_2')).toEqual({ kind: 'cancelled' })
  })

  it('projects a compaction as a standalone marker message at its log position', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'Long task.',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      { type: 'turn.completed', turn_id: 'turn_1', outcome: 'resolved', usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0, wall_clock_ms: 1 } },
      // Session-scoped: no turn_id — the compaction speaks for the session.
      { type: 'context.compacted', reason: 'manual', tokens_before: 152000, tokens_after: 18000 },
    ))

    const marker = projection.messages[1]
    expect(marker.id).toBe('event:3')
    expect(marker.blocks).toEqual([
      { type: 'compaction', id: 'event:3', reason: 'manual', tokensBefore: 152000, tokensAfter: 18000 },
    ])
  })

  it('rejects a compaction event with a bogus reason or a foreign turn_id', () => {
    expect(() => createSessionEvent({ type: 'context.compacted', reason: 'bogus' } as never, 1)).toThrow()
    expect(() => createSessionEvent({ type: 'context.compacted', reason: 'manual', turn_id: 'turn_1' } as never, 1)).toThrow()
  })

  it('carries reportBlocked options onto the blocked settlement for one-tap answers', () => {
    const projection = projectSessionEvents(events(
      {
        type: 'turn.started', turn_id: 'turn_1', user_message: 'Which localization?',
        prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
      },
      {
        type: 'tool.requested', turn_id: 'turn_1', call_id: 'rb', name: 'tdease.session.reportBlocked',
        args: {
          reason: 'Two readings of the question.',
          needed: 'Confirm which one.',
          options: ['(a) K20 dimethyl', '(b) +121.9 explanation', '   ', 42],
        },
      },
      { type: 'turn.completed', turn_id: 'turn_1', outcome: 'blocked', usage: { input_tokens: 1, output_tokens: 1, tool_calls: 1, wall_clock_ms: 1 } },
    ))

    const settlement = projection.settlements.get('turn_1')
    expect(settlement).toMatchObject({
      kind: 'completed',
      outcome: 'blocked',
      blocked: {
        reason: 'Two readings of the question.',
        needed: 'Confirm which one.',
        options: ['(a) K20 dimethyl', '(b) +121.9 explanation'],
      },
    })
  })
})

describe('createSessionProjector (incremental fold)', () => {
  // A rich two-turn scenario: tools, approvals, thinking, a compaction
  // divider — everything the fold carries state for across events.
  const ALL = events(
    {
      type: 'turn.started', turn_id: 'turn_1', user_message: 'Run the analysis.',
      prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
    },
    { type: 'approval.requested', turn_id: 'turn_1', call_id: 'call_1', action: 'workflow.submit', basis: 'Submitting a Run.' },
    { type: 'approval.resolved', turn_id: 'turn_1', call_id: 'call_1', decision: 'approved', by: 'user' },
    { type: 'tool.requested', turn_id: 'turn_1', call_id: 'call_1', name: 'tdease.workflow.submit', args: { planRef: 'plan_1' } },
    { type: 'tool.completed', turn_id: 'turn_1', call_id: 'call_1', ok: true, result: { run_id: 'run_1' } },
    { type: 'thinking.recorded', turn_id: 'turn_1', content: 'The run is valid.' },
    { type: 'message.completed', turn_id: 'turn_1', role: 'assistant', content: 'Submitted run_1.' },
    { type: 'turn.completed', turn_id: 'turn_1', outcome: 'resolved', usage: { input_tokens: 1, output_tokens: 1, tool_calls: 1, wall_clock_ms: 1 } },
    { type: 'context.compacted', reason: 'manual', tokens_before: 152000, tokens_after: 18000 },
    {
      type: 'turn.started', turn_id: 'turn_2', user_message: 'Now compare.',
      prompt_snapshot_digest: 'b'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
    },
    { type: 'tool.requested', turn_id: 'turn_2', call_id: 'call_2', name: 'bash', args: { command: 'make compare' } },
    { type: 'tool.completed', turn_id: 'turn_2', call_id: 'call_2', ok: true, result: 'identical' },
    { type: 'turn.completed', turn_id: 'turn_2', outcome: 'resolved', usage: { input_tokens: 2, output_tokens: 2, tool_calls: 1, wall_clock_ms: 2 } },
  )

  it('a suffix-folded projection equals the batch projection of the whole log', () => {
    // The settle path's core property: folding turn 2 as a suffix into a
    // projector that already folded turn 1 must produce exactly what a full
    // reprojection of both turns produces.
    const projector = createSessionProjector()
    for (const event of ALL.slice(0, 8)) projector.fold(event)
    for (const event of ALL.slice(8)) projector.fold(event)
    expect(projector.snapshot()).toEqual(projectSessionEvents(ALL))
  })

  it('a snapshot stays stable against later folds', () => {
    const projector = createSessionProjector()
    for (const event of ALL.slice(0, 8)) projector.fold(event)
    const early = projector.snapshot()
    for (const event of ALL.slice(8)) projector.fold(event)

    expect(projector.snapshot()).toEqual(projectSessionEvents(ALL))
    // The earlier snapshot is a copy: later suffix folds must not reach into it.
    expect(early).toEqual(projectSessionEvents(ALL.slice(0, 8)))
  })

  it('refuses a fold that breaks sequence contiguity', () => {
    const projector = createSessionProjector()
    projector.fold(ALL[0]!)
    expect(() => projector.fold(ALL[2]!)).toThrow(/contiguous/)
  })
})
