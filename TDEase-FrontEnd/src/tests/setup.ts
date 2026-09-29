import { config } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { i18n } from '@/locales'
// zh-CN rides a lazy chunk in the app (en-US is the static fallback); tests
// assert rendered Chinese strings, so the test bundle registers the messages
// up front instead of each test awaiting the dynamic import.
import { zhCNMessages } from '@/locales/zh-CN.messages'

i18n.global.setLocaleMessage('zh-CN', zhCNMessages)
if (typeof i18n.global.locale === 'object' && 'value' in i18n.global.locale) {
  i18n.global.locale.value = 'zh-CN'
}

config.global.plugins = [
  ...(config.global.plugins || []),
  i18n,
  ElementPlus,
]

config.global.config = {
  ...(config.global.config || {}),
  warnHandler(message) {
    throw new Error(`Unexpected Vue warning: ${message}`)
  },
}

// jsdom deliberately omits a canvas implementation. Plotly and Mermaid probe
// the 2D context while modules are initialized, even in tests that never draw.
// Keep the test environment quiet without introducing a native canvas binary.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => {
  const context = new Proxy(
    {
      canvas: document.createElement('canvas'),
      measureText: (text: string) => ({ width: text.length * 8 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      createPattern: () => null,
    },
    {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target]
        return () => undefined
      },
    },
  )
  return () => context as unknown as CanvasRenderingContext2D
  })() as unknown as typeof HTMLCanvasElement.prototype.getContext
}

if (typeof window !== 'undefined' && typeof ResizeObserver === 'undefined') {
  class ResizeObserverStub implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub
}
