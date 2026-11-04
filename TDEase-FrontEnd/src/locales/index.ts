/**
 * i18n barrel export.
 * en-US is the single source of truth AND the fallback locale, so it ships
 * statically in the entry chunk. Every other locale (~92KB raw for zh-CN)
 * rides a single lazy chunk via LOADER: it is loaded before mount when the
 * detected locale is not English, and on demand from the language switcher
 * otherwise. Every consumer goes through `ensureLocaleLoaded`/`setLocale`;
 * nobody touches `setLocaleMessage` directly.
 *
 * Adding a language = one `xx-XX/` directory of JSON + one `xx-XX.messages.ts`
 * assembly + one LOADER entry + one LOCALE_ITEMS row (native label).
 */
import { createI18n } from 'vue-i18n'

import enUSCommon from './en-US/common.json'
import enUSAgent from './en-US/agent.json'
import enUSVisualization from './en-US/visualization.json'
import enUSWorkflow from './en-US/workflow.json'
import enUSWorkbench from './en-US/workbench.json'

export type AppLocale = 'en-US' | 'zh-CN' | 'de-DE'

const enMessages = {
  common: enUSCommon,
  visualization: enUSVisualization,
  workflow: enUSWorkflow,
  workbench: enUSWorkbench,
  agent: enUSAgent,
}

export const LOCALE_STORAGE_KEY = 'locale'

/** Lazy assembly modules for every non-fallback locale, keyed by locale. */
const LOADER: Partial<Record<AppLocale, () => Promise<Record<string, unknown>>>> = {
  'zh-CN': () => import('./zh-CN.messages').then((m) => m.zhCNMessages),
  'de-DE': () => import('./de-DE.messages').then((m) => m.deDEMessages),
}

const SUPPORTED: readonly AppLocale[] = ['en-US', ...Object.keys(LOADER) as AppLocale[]]

/** Switcher menu rows — native names on purpose: a language names itself. */
export const LOCALE_ITEMS: ReadonlyArray<{ locale: AppLocale; label: string }> = [
  { locale: 'zh-CN', label: '中文' },
  { locale: 'en-US', label: 'English' },
  { locale: 'de-DE', label: 'Deutsch' },
]

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (SUPPORTED as readonly string[]).includes(value)
}

/** BCP-47 primary tag → app locale, for navigator.language detection. */
const NAV_PREFIX: Record<string, AppLocale> = {
  zh: 'zh-CN',
  de: 'de-DE',
}

function detectLocale(): AppLocale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (isAppLocale(stored)) return stored
    const nav = navigator.language?.slice(0, 2)
    if (nav && NAV_PREFIX[nav]) return NAV_PREFIX[nav]
  } catch { /* ignore */ }
  return 'en-US'
}

/**
 * Keep `<html lang>` in step with the active locale. index.html can only ship
 * a static guess (`en`), and screen-reader pronunciation, hyphenation and CJK
 * glyph selection all key off this attribute — leaving it stale ships an
 * English-tagged document full of Chinese text.
 */
function syncDocumentLang(locale: AppLocale) {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
}

const initialLocale = detectLocale()

// Record<string, …> on purpose: vue-i18n narrows its locale/keys type from the
// messages map it is given, and a single-locale map would type the lazy
// locales out of every assignment below even though setLocaleMessage
// registers them later.
const messages: Record<string, typeof enMessages> = {
  'en-US': enMessages,
}

export const i18n = createI18n({
  legacy: false,
  // Only en-US is statically present; prepareInitialLocale swaps in the
  // detected locale once its lazy messages have loaded.
  locale: 'en-US',
  fallbackLocale: 'en-US',
  globalInjection: true,
  messages,
})

// Chunk fetch + registration per locale; the promise is memoized so two rapid
// switches to the same locale share one fetch.
const loading = new Map<AppLocale, Promise<void>>()

function ensureLocaleLoaded(locale: AppLocale): Promise<void> {
  if (locale === 'en-US') return Promise.resolve()
  const inFlight = loading.get(locale)
  if (inFlight) return inFlight
  const loader = LOADER[locale]
  if (!loader) return Promise.resolve()
  const task = loader()
    .then((messages) => { i18n.global.setLocaleMessage(locale, messages) })
  loading.set(locale, task)
  task.catch(() => loading.delete(locale))
  return task
}

/**
 * Boot seam for `src/main.ts`: resolve the DETECTED locale's messages before
 * `app.mount()`. For an English/default boot this is a no-op synchronous
 * return (en-US ships statically); otherwise it awaits the locale's one lazy
 * chunk so the first painted frame — Welcome copy included — is already in
 * the right language instead of flashing the fallback.
 */
export async function prepareInitialLocale(): Promise<void> {
  if (initialLocale === 'en-US') return
  await ensureLocaleLoaded(initialLocale)
  i18n.global.locale.value = initialLocale
}

syncDocumentLang(initialLocale)

/**
 * The one way to change locale at runtime — loads the target locale's
 * messages if needed (its lazy chunk), switches vue-i18n, persists the
 * choice, and updates `<html lang>` together. Callers that only assign
 * `i18n.global.locale.value` leave the document tagged with the old language
 * and can render keys for a locale whose messages never loaded.
 */
export async function setLocale(locale: AppLocale) {
  await ensureLocaleLoaded(locale)
  i18n.global.locale.value = locale
  syncDocumentLang(locale)
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch { /* ignore */ }
}
