import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import MarkdownContent from './MarkdownContent.vue'

/**
 * Block mode (`blockHtmls`) is the append-only streaming path: on a flush
 * only the block whose source HTML CHANGED may re-parse; every prefix block
 * keeps its DOM node identity (the selection-preservation contract the
 * legacy reconcile already gave, now without the whole-message template
 * parse). These mounts lock node identity across an append-style update.
 */

async function settle(steps = 3): Promise<void> {
  for (let i = 0; i < steps; i += 1) await nextTick()
}

function mountBlockMode(html: string, blockHtmls: string[]) {
  return mount(MarkdownContent, { props: { html, blockHtmls } })
}

describe('MarkdownContent block-mode reconcile', () => {
  it('keeps DOM node identity of prefix blocks when only the tail block changes', async () => {
    const wrapper = mountBlockMode('<p>one</p><p>two</p>', ['<p>one</p>', '<p>two</p>'])
    await settle()
    const root = wrapper.get('.md-content').element
    const firstBefore = root.children[0]!
    expect(firstBefore.outerHTML).toBe('<p>one</p>')

    // Streaming append: block 1's source is untouched, block 2 grew.
    await wrapper.setProps({
      html: '<p>one</p><p>two more</p>',
      blockHtmls: ['<p>one</p>', '<p>two more</p>'],
    })
    await settle()

    expect(root.children[0]!).toBe(firstBefore) // same node, not re-parsed
    expect(root.children.length).toBe(2)
    expect(root.children[1]!.outerHTML).toBe('<p>two more</p>')
    expect(root.innerHTML).toBe('<p>one</p><p>two more</p>')
  })

  it('appends new blocks without touching existing nodes', async () => {
    const wrapper = mountBlockMode('<p>one</p>', ['<p>one</p>'])
    await settle()
    const root = wrapper.get('.md-content').element
    const firstBefore = root.children[0]!

    await wrapper.setProps({
      html: '<p>one</p><p>two</p>',
      blockHtmls: ['<p>one</p>', '<p>two</p>'],
    })
    await settle()

    expect(root.children[0]!).toBe(firstBefore)
    // The appended block plays the one-shot entrance (.md-enter, dropped on
    // animationend — jsdom never fires it); assert content, not exact markup.
    expect(root.children[1]!.textContent).toBe('two')
  })

  it('replaces only the changed middle block when its source differs', async () => {
    const wrapper = mountBlockMode(
      '<p>one</p><p>two</p><p>three</p>',
      ['<p>one</p>', '<p>two</p>', '<p>three</p>'],
    )
    await settle()
    const root = wrapper.get('.md-content').element
    const [a, b, c] = Array.from(root.children)

    await wrapper.setProps({
      html: '<p>one</p><p>TWO</p><p>three</p>',
      blockHtmls: ['<p>one</p>', '<p>TWO</p>', '<p>three</p>'],
    })
    await settle()

    expect(root.children[0]!).toBe(a)
    expect(root.children[1]!).not.toBe(b)
    expect(root.children[1]!.outerHTML).toBe('<p>TWO</p>')
    expect(root.children[2]!).toBe(c)
  })
})
