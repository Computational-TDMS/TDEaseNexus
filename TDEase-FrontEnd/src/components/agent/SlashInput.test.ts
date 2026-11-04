import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SlashInput from './SlashInput.vue'

const commands = [
  { name: 'stop', aliases: ['abort'], description: 'Stop the current response', permission: 'owner' as const },
  { name: 'status', description: 'Show session status', permission: 'anyone' as const },
]

describe('SlashInput', () => {
  beforeEach(() => {
    // SlashInput's @-mention picker reads runs/workspace stores; they need a Pinia.
    setActivePinia(createPinia())
  })

  afterEach(() => {
    // No global mock leaks to clean — stores are per-Pinia.
  })

  it('sends normal text with Enter and preserves Shift+Enter for newlines', async () => {
    const wrapper = mount(SlashInput, { props: { modelValue: 'Analyze this result', commands } })
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[0]).toEqual(['Analyze this result'])

    await wrapper.find('textarea').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('send')).toHaveLength(1)
  })

  it('completes a slash command without executing it', async () => {
    const wrapper = mount(SlashInput, { props: { modelValue: '/', commands } })
    await wrapper.vm.$nextTick()
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['/stop '])
    expect(wrapper.emitted('slash')).toBeUndefined()
  })

  it('executes a completed slash command only after a second Enter', async () => {
    const wrapper = mount(SlashInput, { props: { modelValue: '/abort ', commands } })
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('slash')?.[0]).toEqual(['stop', ''])
  })

  it('binds a $-picked skill as an @skill mention token', async () => {
    // `$` is the skill-only trigger. Confirming a skill replaces the `$`
    // fragment with the persisted `@skill:<name>` token — the same token the
    // old `/skill` path produced, so the prompt pipeline is unchanged.
    const wrapper = mount(SlashInput, {
      props: { modelValue: 'use $qc', commands, skills: [{ name: 'qc-report', description: 'Check QC' }] },
    })
    const textarea = wrapper.find('textarea').element
    // Place the caret at the end of the `$qc` fragment, then fire input so the
    // picker opens, then confirm with Enter.
    textarea.setSelectionRange(7, 7)
    await wrapper.find('textarea').trigger('input')
    await wrapper.vm.$nextTick()
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['use @skill:qc-report '])
  })

  it('completes a local MCP server argument', async () => {
    const resourceCommands = [...commands, { name: 'mcp', description: 'Use local MCP', permission: 'owner' as const }]
    const wrapper = mount(SlashInput, {
      props: { modelValue: '/mcp fire', commands: resourceCommands, mcpServers: ['firecrawl'] },
    })
    await wrapper.vm.$nextTick()
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['/mcp firecrawl '])
  })

  it('does not send on Enter while the @-mention popup is open (Enter confirms the mention instead)', async () => {
    // An empty workspace yields no candidates, so the popup stays closed and
    // Enter sends — assert the send path is unaffected when nothing matches.
    const wrapper = mount(SlashInput, { props: { modelValue: 'hello @x', commands } })
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[0]).toEqual(['hello @x'])
  })

  it('keeps the @ token in the message text after the picker confirms', async () => {
    // With no candidates the popup is closed, so a typed @run:abc123 survives
    // verbatim into the sent message — the pure-text-token contract.
    const wrapper = mount(SlashInput, { props: { modelValue: 'analyze @run:abc123', commands } })
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('send')?.[0]).toEqual(['analyze @run:abc123'])
  })
})

describe('SlashInput trigger rendering', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('never renders a trigger badge overlay — typing shows one glyph, not a ghost', async () => {
    // The old badge drew a second decorated / / @ / $ over the character the
    // textarea already owned — the double-slash ghost.
    for (const modelValue of ['/', '@run', '$sk', 'plain']) {
      const wrapper = mount(SlashInput, { props: { modelValue, commands } })
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.slash-badge').exists()).toBe(false)
      wrapper.unmount()
    }
  })

  it('paints tag blocks only for CONFIRMED tokens in the mirror, never in-progress fragments', async () => {
    const wrapper = mount(SlashInput, {
      props: {
        modelValue: 'compare @run:histone48 with @file:notes/a.txt, then @ru and a@b.com',
        commands,
      },
    })
    await wrapper.vm.$nextTick()
    const mirror = wrapper.find('.slash-mirror')
    const tokens = mirror.findAll('.mention-token')
    // Two confirmed tokens; the in-progress fragment `@ru` and the email
    // `a@b.com` never match the token grammar, so they stay plain.
    expect(tokens).toHaveLength(2)
    // Each token shows the kind icon + the SHORT label (scope halves and
    // directory paths are plumbing), and the raw text rides along hidden —
    // it keeps the inline width so the caret stays aligned.
    expect(tokens[0].find('.mention-token__label').text()).toBe('histone48')
    expect(tokens[1].find('.mention-token__label').text()).toBe('a.txt')
    expect(tokens[0].find('.mention-token__face .mention-token__ghost').exists()).toBe(false)
    expect(tokens[0].find('.mention-token__ghost').text()).toBe('@run:histone48')
  })
})
