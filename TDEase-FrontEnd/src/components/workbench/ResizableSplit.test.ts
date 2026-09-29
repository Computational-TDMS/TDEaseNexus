import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ResizableSplit from './ResizableSplit.vue'

describe('ResizableSplit', () => {
  function mountWithSync(props: Record<string, unknown> = {}) {
    const wrapper = mount(ResizableSplit, {
      props: {
        direction: 'horizontal',
        size: 320,
        min: 240,
        max: 420,
        ...props,
        'onUpdate:size': (value: number) => {
          wrapper.setProps({ size: value })
        },
      },
      slots: {
        first: '<div>first</div>',
        second: '<div>second</div>',
      },
    })
    return wrapper
  }

  it('renders separator aria attributes and tracks aria-valuenow', async () => {
    const wrapper = mountWithSync({ size: 320, min: 240, max: 420, ariaLabel: 'Navigator width' })
    const handle = wrapper.get('[role="separator"]')

    expect(handle.attributes('aria-orientation')).toBe('horizontal')
    expect(handle.attributes('aria-valuemin')).toBe('240')
    expect(handle.attributes('aria-valuemax')).toBe('420')
    expect(handle.attributes('aria-valuenow')).toBe('320')
    expect(handle.attributes('aria-label')).toBe('Navigator width')
    expect(handle.attributes('tabindex')).toBe('0')

    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(handle.attributes('aria-valuenow')).toBe('336')
  })

  it('arrow keys resize by exactly 16px, Shift+Arrow by 64px', async () => {
    const wrapper = mountWithSync({ size: 320 })
    const handle = wrapper.get('[role="separator"]')

    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.props('size')).toBe(336)

    await handle.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.props('size')).toBe(320)

    await handle.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
    expect(wrapper.props('size')).toBe(384)
  })

  it('Home/End snap to min/max and never leave [min, max]', async () => {
    const wrapper = mountWithSync({ size: 320, min: 240, max: 420 })
    const handle = wrapper.get('[role="separator"]')

    await handle.trigger('keydown', { key: 'End' })
    expect(wrapper.props('size')).toBe(420)

    await handle.trigger('keydown', { key: 'Home' })
    expect(wrapper.props('size')).toBe(240)

    // Repeated decreases must clamp at min, never dip below it.
    for (let i = 0; i < 10; i++) {
       
      await handle.trigger('keydown', { key: 'ArrowLeft', shiftKey: true })
    }
    expect(wrapper.props('size')).toBe(240)

    // Repeated increases must clamp at max, never exceed it.
    for (let i = 0; i < 20; i++) {
       
      await handle.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
    }
    expect(wrapper.props('size')).toBe(420)
  })

  it('vertical direction uses ArrowUp/ArrowDown and row-resize orientation', async () => {
    const wrapper = mountWithSync({ direction: 'vertical', size: 200, min: 100, max: 300 })
    const handle = wrapper.get('[role="separator"]')

    expect(handle.attributes('aria-orientation')).toBe('vertical')

    await handle.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.props('size')).toBe(216)

    await handle.trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.props('size')).toBe(200)
  })

  it('Enter toggles collapse when collapsible, restoring the prior size', async () => {
    const wrapper = mountWithSync({ size: 320, min: 240, max: 420, collapsible: true, collapsedSize: 0 })
    // useEventListener binds to the template ref through a post-flush watcher,
    // so the pointer listeners exist only after the first flush.
    await wrapper.vm.$nextTick()
    const handle = wrapper.get('[role="separator"]')

    await handle.trigger('keydown', { key: 'Enter' })
    expect(wrapper.props('size')).toBe(0)

    await handle.trigger('keydown', { key: 'Enter' })
    expect(wrapper.props('size')).toBe(320)
  })

  it('does not collapse on Enter when not collapsible', async () => {
    const wrapper = mountWithSync({ size: 320, collapsible: false })
    const handle = wrapper.get('[role="separator"]')

    await handle.trigger('keydown', { key: 'Enter' })
    expect(wrapper.props('size')).toBe(320)
  })

  it('double-click resets to the initial size', async () => {
    const wrapper = mountWithSync({ size: 320, min: 240, max: 420 })
    const handle = wrapper.get('[role="separator"]')

    await handle.trigger('keydown', { key: 'End' })
    expect(wrapper.props('size')).toBe(420)

    await handle.trigger('dblclick')
    expect(wrapper.props('size')).toBe(320)
  })

  it('reports the SashState: at a bound, and disabled for degenerate bounds', async () => {
    const wrapper = mountWithSync({ size: 240, min: 240, max: 420 })
    expect(wrapper.get('[role="separator"]').attributes('data-sash-state')).toBe('min')

    await wrapper.setProps({ size: 420 })
    expect(wrapper.get('[role="separator"]').attributes('data-sash-state')).toBe('max')

    await wrapper.setProps({ size: 320 })
    expect(wrapper.get('[role="separator"]').attributes('data-sash-state')).toBeUndefined()

    const degenerate = mountWithSync({ size: 300, min: 300, max: 300 })
    expect(degenerate.get('[role="separator"]').attributes('data-sash-state')).toBe('disabled')
  })

  // jsdom's event objects expose clientX as a getter-only property, so the
  // drags fire real MouseEvents through dispatchEvent (the handlers only read
  // clientX/altKey off the event).
  function firePointer(el: Element, type: string, x: number, alt = false): void {
    el.dispatchEvent(new MouseEvent(type, { clientX: x, altKey: alt, bubbles: true }))
  }

  it('snaps a collapsible drag past min − min/2 to the collapsed size', async () => {
    const wrapper = mountWithSync({ size: 320, min: 240, max: 420, collapsible: true, collapsedSize: 0 })
    // useEventListener binds to the template ref through a post-flush watcher,
    // so the pointer listeners exist only after the first flush.
    await wrapper.vm.$nextTick()
    const handle = wrapper.get('[role="separator"]')

    firePointer(handle.element, 'pointerdown', 400)
    // 320 + delta < 240 − 120 → delta < −200.
    firePointer(handle.element, 'pointermove', 190)
    await wrapper.vm.$nextTick()

    const sizes = wrapper.emitted('update:size')
    expect(sizes?.at(-1)).toEqual([0])
    expect(wrapper.emitted('update:collapsed')?.at(-1)).toEqual([true])

    firePointer(handle.element, 'pointerup', 190)
  })

  it('re-expands a collapsed split dragged past min/2, emitting collapsed=false', async () => {
    // A parent-collapsed dock: the last expanded size is unknown, so the snap
    // target is the clamped min (240) — never 0.
    const wrapper = mountWithSync({
      size: 0, min: 0, max: 0, collapsedSize: 0, collapsible: true, collapsed: true,
    })
    await wrapper.setProps({ min: 240, max: 420 })
    const handle = wrapper.get('[role="separator"]')

    firePointer(handle.element, 'pointerdown', 100)
    // From the collapsed edge: 0 + delta > 120.
    firePointer(handle.element, 'pointermove', 280)
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('update:collapsed')?.at(-1)).toEqual([false])
    const sizes = wrapper.emitted('update:size')
    expect(sizes?.at(-1)?.[0]).toBeGreaterThanOrEqual(240)

    firePointer(handle.element, 'pointerup', 280)
  })

  it('does NOT snap a non-collapsible drag below min — it clamps and commits on release', async () => {
    const wrapper = mountWithSync({ size: 320, min: 240, max: 420 })
    await wrapper.vm.$nextTick()
    const handle = wrapper.get('[role="separator"]')
    const root = wrapper.element as HTMLElement

    firePointer(handle.element, 'pointerdown', 400)
    firePointer(handle.element, 'pointermove', 190)

    // Mid-drag nothing is emitted and no store write happens; the pane
    // tracks the pointer through the live CSS variable alone.
    expect(wrapper.emitted('update:size')).toBeUndefined()
    expect(root.style.getPropertyValue('--resizable-split-live-size')).toBe('240px')

    firePointer(handle.element, 'pointerup', 190)
    await wrapper.vm.$nextTick()

    const sizes = wrapper.emitted('update:size')
    expect(sizes).toHaveLength(1)
    expect(sizes?.at(-1)).toEqual([240])
    expect(wrapper.emitted('update:collapsed')).toBeUndefined()
    expect(root.style.getPropertyValue('--resizable-split-live-size')).toBe('')
  })

  it('commits a release that lands in the same frame as the last move (no dropped tail)', async () => {
    const wrapper = mountWithSync({ size: 320, min: 240, max: 420 })
    await wrapper.vm.$nextTick()
    const handle = wrapper.get('[role="separator"]')

    firePointer(handle.element, 'pointerdown', 400)
    firePointer(handle.element, 'pointermove', 436)
    // No rAF wait: the pointerup lands before any frame boundary.
    firePointer(handle.element, 'pointerup', 436)

    expect(wrapper.emitted('update:size')?.at(-1)).toEqual([356])
  })

  it('Alt drags at half rate, applied live and committed on release', async () => {
    const wrapper = mountWithSync({ size: 320, min: 240, max: 420 })
    await wrapper.vm.$nextTick()
    const handle = wrapper.get('[role="separator"]')
    const root = wrapper.element as HTMLElement

    firePointer(handle.element, 'pointerdown', 0)
    firePointer(handle.element, 'pointermove', 32, true)

    expect(wrapper.emitted('update:size')).toBeUndefined()
    expect(root.style.getPropertyValue('--resizable-split-live-size')).toBe('336px')

    firePointer(handle.element, 'pointerup', 32)
    await wrapper.vm.$nextTick()
    expect(wrapper.props('size')).toBe(336)
  })

  it('clears the live variable when a drag snaps to the collapsed state', async () => {
    const wrapper = mountWithSync({ size: 320, min: 240, max: 420, collapsible: true, collapsedSize: 0 })
    await wrapper.vm.$nextTick()
    const handle = wrapper.get('[role="separator"]')
    const root = wrapper.element as HTMLElement

    firePointer(handle.element, 'pointerdown', 400)
    firePointer(handle.element, 'pointermove', 300)
    expect(root.style.getPropertyValue('--resizable-split-live-size')).not.toBe('')

    firePointer(handle.element, 'pointermove', 190)
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('update:size')?.at(-1)).toEqual([0])
    expect(root.style.getPropertyValue('--resizable-split-live-size')).toBe('')

    firePointer(handle.element, 'pointerup', 190)
  })
})
