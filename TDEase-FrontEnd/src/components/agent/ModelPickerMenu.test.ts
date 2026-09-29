import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ModelPickerMenu from './ModelPickerMenu.vue'
import { useSettingsStore } from '@/stores/settings'
import { useAgentTabsStore } from '@/stores/agentTabs'
import { useDocumentsStore } from '@/stores/documents'

/**
 * The picker's whole point: its provider list is the store's configured rule
 * (oauth/no-auth pass, api-key needs the settings.json flag) — never the full
 * catalog. These tests seed a mix through the agentProviders IPC bridge (the
 * same seam settings.test.ts uses; the redacted summaries live in a private
 * store ref fed by that read) and assert the menu shows exactly the usable
 * ones, and that a flyout pick lands as the atomic provider+model pair.
 */
describe('ModelPickerMenu', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    delete (globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop
  })

  /** Install the agentProviders bridge double BEFORE store creation — the
   *  boot read runs at store setup and its result is the picker's list. */
  async function seedProviders() {
    ;(globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop = {
      agentProviders: {
        read: vi.fn().mockResolvedValue({
          providers: {
            deepseek: { configured: true },
            anthropic: { configured: false },
            'custom-endpoint': { configured: true, name: 'My Endpoint', models: ['my-model'] },
            'custom-broken': { configured: false, name: 'Broken Endpoint', models: ['ghost-model'] },
          },
        }),
      },
    }
    const store = useSettingsStore()
    await flushPromises()
    return store
  }

  /** The flyout teleports to <body>; the stub keeps it inside the wrapper
   *  tree so test queries (and jsdom events) see it as ordinary children. */
  function mountPicker() {
    return mount(ModelPickerMenu, { global: { stubs: { teleport: true } } })
  }

  it('lists only configured providers — no-key catalog and custom entries are hidden', async () => {
    const store = await seedProviders()
    const wrapper = mountPicker()

    const listed = wrapper.findAll('.model-picker__provider-name').map((n) => n.text())
    // deepseek: key configured · ollama: no-auth provider always usable ·
    // custom-endpoint: user-defined with a key. Anthropic (no key) and the
    // key-less custom endpoint must NOT offer models that cannot bind.
    expect(listed).toContain('DeepSeek')
    expect(listed).toContain('Ollama (Local)')
    expect(listed).toContain('My Endpoint')
    expect(listed).not.toContain('Anthropic')
    expect(listed).not.toContain('Broken Endpoint')
    expect(store.provider).toBe('deepseek')
  })

  it('picking a model from another provider writes the pair atomically and closes', async () => {
    await seedProviders()
    const wrapper = mountPicker()

    await wrapper.findAll('.model-picker__provider-row')
      .find((n) => n.text() === 'My Endpoint')!
      .trigger('mouseenter')
    await wrapper.findAll('.model-picker__model')
      .find((n) => n.text().includes('my-model'))!
      .trigger('click')

    const store = useSettingsStore()
    expect(store.provider).toBe('custom-endpoint')
    expect(store.model).toBe('my-model')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('footer entries keep the runtime drawer and provider settings reachable', async () => {
    await seedProviders()
    const documentsStore = useDocumentsStore()
    const openSettings = vi.spyOn(documentsStore, 'openSettings').mockReturnValue('settings')
    const wrapper = mountPicker()

    await wrapper.findAll('.model-picker__footer-row')
      .find((n) => n.text() === '运行设置')!
      .trigger('click')
    expect(useAgentTabsStore().tabs.some((tab) => tab.key.kind === 'agent-settings')).toBe(true)
    expect(wrapper.emitted('close')?.length).toBe(1)

    await mountPicker().findAll('.model-picker__footer-row')
      .find((n) => n.text() === '管理模型')!
      .trigger('click')
    expect(openSettings).toHaveBeenCalledWith(undefined, 'providers')
  })
})
