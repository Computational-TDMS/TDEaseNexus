import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { nextTick } from 'vue'
import AppShell from './AppShell.vue'
import { useUiLayoutStore } from '@/stores/uiLayout'
import router from '@/router'

// jsdom has no ResizeObserver; `useElementSize` (ResizableSplit + the page's
// own nested-split math) needs one to exist, even if it never fires.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function mountAppShell(pinia: ReturnType<typeof createPinia>) {
  return mount(AppShell, {
    attachTo: document.body,
    global: { plugins: [pinia, router], stubs: { 'el-icon': true } },
  })
}

describe('AppShell', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
    delete document.documentElement.dataset.density
    vi.unstubAllGlobals()
  })

  it('renders the Workbench regions with their documented role and aria-label', async () => {
    const pinia = createPinia()
    const wrapper = mountAppShell(pinia)
    await nextTick()

    const cases: Array<{ selector: string; role: string }> = [
      { selector: '.side-bar', role: 'navigation' },
      { selector: '.navigator-panel', role: 'navigation' },
      { selector: '.document-host', role: 'main' },
      // The panel starts collapsed, so it is not rendered until the
      // StatusBar's Runs/Logs toggles open it.
      { selector: '.status-bar', role: 'contentinfo' },
    ]

    for (const { selector, role } of cases) {
      const el = wrapper.find(selector)
      expect(el.exists(), `${selector} should render`).toBe(true)
      expect(el.attributes('role')).toBe(role)
      expect(el.attributes('aria-label')).toBeTruthy()
    }

    wrapper.unmount()
  })

  it('keeps exactly one Agent mounted across page switches', async () => {
    const pinia = createPinia()
    const wrapper = mountAppShell(pinia)
    await nextTick()

    // The Workbench dock is gone: the single AgentPage always teleports into
    // the Agent page host (hidden by v-show while Workbench is front), so a
    // live turn can never acquire a second runtime during navigation.
    expect(wrapper.findAll('.agent-page')).toHaveLength(1)
    expect(wrapper.find('#agent-page-host .agent-page').exists()).toBe(true)

    useUiLayoutStore(pinia).setActivePage('agent')
    await nextTick()
    expect(wrapper.findAll('.agent-page')).toHaveLength(1)
    expect(wrapper.find('#agent-page-host .agent-page').exists()).toBe(true)

    wrapper.unmount()
  })

  it('switches between the Workbench and full Agent pages', async () => {
    vi.useFakeTimers()
    try {
      const pinia = createPinia()
      const wrapper = mountAppShell(pinia)
      await nextTick()

      // Boot lands on the Agent page; walk to the Workbench and let the slide
      // settle so the test starts from the Workbench-front state. nextTick
      // first: the settle fallback timer is scheduled by the async watch.
      useUiLayoutStore(pinia).setActivePage('workbench')
      await nextTick()
      vi.advanceTimersByTime(500)
      await nextTick()

      const pages = wrapper.findAll('.app-shell__page-slot')
      expect(pages).toHaveLength(2)
      expect(pages[0].isVisible()).toBe(true)
      expect(pages[1].isVisible()).toBe(false)

      useUiLayoutStore(pinia).setActivePage('agent')
      await nextTick()
      // Mid-slide both pages paint: the track carries the Workbench out while
      // the Agent page slides in, so a pulled-away page never blanks.
      expect(pages[0].isVisible()).toBe(true)
      expect(pages[1].isVisible()).toBe(true)

      // Settled (transitionend in the app; the fallback timer here): the page
      // being left drops out of paint again.
      vi.advanceTimersByTime(500)
      await nextTick()
      expect(pages[0].isVisible()).toBe(false)
      expect(pages[1].isVisible()).toBe(true)

      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the door handle follows the Agent window: right edge on Workbench, left edge on Agent', async () => {
    const pinia = createPinia()
    const wrapper = mountAppShell(pinia)
    await nextTick()

    // Boot lands on the Agent page; the Workbench-front assertions below pin
    // the page explicitly rather than leaning on the mount default.
    useUiLayoutStore(pinia).setActivePage('workbench')
    await nextTick()

    const handle = wrapper.find('.page-handle')
    expect(handle.exists()).toBe(true)
    // Workbench front: the Agent is the right-docked sidebar, so the pull
    // hangs on the right edge.
    expect(handle.classes()).toContain('page-handle--right')

    useUiLayoutStore(pinia).setActivePage('agent')
    await nextTick()
    // Full Agent page: the pull moves to the left edge to bring the
    // Workbench back.
    expect(handle.classes()).toContain('page-handle--left')

    wrapper.unmount()
  })

  it('the rail page switcher reaches the Agent page from anywhere', async () => {
    const pinia = createPinia()
    const wrapper = mountAppShell(pinia)
    await nextTick()

    const switcher = wrapper.find('.side-bar__top').findAll('.side-bar__btn')
    expect(switcher).toHaveLength(2)
    // Boot lands on the Agent page, so the Agent button carries the chip.
    expect(switcher[0].classes()).not.toContain('is-active')
    expect(switcher[1].classes()).toContain('is-active')

    // Off to the Workbench…
    await switcher[0].trigger('click')
    expect(useUiLayoutStore(pinia).activePage).toBe('workbench')
    expect(switcher[0].classes()).toContain('is-active')

    // …and the guaranteed way home, one click from anywhere.
    await switcher[1].trigger('click')
    expect(useUiLayoutStore(pinia).activePage).toBe('agent')

    wrapper.unmount()
  })

  it("setDensity('compact') sets document.documentElement.dataset.density", async () => {
    const pinia = createPinia()
    const wrapper = mountAppShell(pinia)
    await nextTick()

    useUiLayoutStore(pinia).setDensity('compact')
    expect(document.documentElement.dataset.density).toBe('compact')

    wrapper.unmount()
  })

  it('does not persist layout under a synthetic default Workspace', async () => {
    const pinia = createPinia()
    const wrapper = mountAppShell(pinia)
    await nextTick()

    useUiLayoutStore(pinia).togglePanelVisible()
    await nextTick()

    expect(Object.keys(window.localStorage).some((key) => key.startsWith('tdease.ui.default.'))).toBe(false)
    wrapper.unmount()
  })
})

describe('router', () => {
  it('exposes exactly one named route', () => {
    const named = router.getRoutes().filter((r) => r.name != null)
    expect(named).toHaveLength(1)
    expect(named[0].name).toBe('Workbench')
    expect(named[0].path).toBe('/')
  })

  it('/agent, /explore and /studio resolve to the catch-all redirect', () => {
    // The Agent is shell state, not a route. A stale bookmark still lands on
    // the Workbench rather than 404-ing.
    for (const path of ['/agent', '/explore', '/studio']) {
      const resolved = router.resolve(path)
      expect(resolved.name).toBeUndefined()
      expect(resolved.matched.some((m) => m.redirect === '/')).toBe(true)
    }
  })
})
