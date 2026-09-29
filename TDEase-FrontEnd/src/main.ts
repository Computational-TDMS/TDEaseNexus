import { createApp } from 'vue'
import { createPinia } from 'pinia'
import {
  ElButton,
  ElButtonGroup,
  ElCheckbox,
  ElCheckboxButton,
  ElCheckboxGroup,
  ElCol,
  ElCollapseTransition,
  ElConfigProvider,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElOption,
  ElRow,
  ElSelect,
  ElSlider,
  ElSwitch,
  ElTag,
} from 'element-plus'
import App from './App.vue'
import router from './router'
import { useThemeStore } from './stores/theme'
import { useSettingsStore } from './stores/settings'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentsStore } from '@/stores/documents'
import { useUiLayoutStore } from '@/stores/uiLayout'
import { createLogger } from '@/utils/logger'
import '@/styles/fonts.css'
import '@/styles/layout-system.css'
import '@/styles/unified-design-tokens.css'
import '@/styles/catppuccin-element-plus.css'
import '@/styles/global.css'
import { viewerRegistry } from '@/services/visualization/ViewerRegistry'
import { i18n, prepareInitialLocale } from '@/locales'

// Fail fast on duplicate or invalid static viewer definitions.
viewerRegistry.list()
// AG Grid modules are registered lazily by their consumers (RunIndexDocument,
// AgGridTable) via ensureAgGridModulesRegistered() on first render. Do NOT
// register them here: doing so pulls the ~1MB ag-grid-community into the entry
// chunk even when no table is ever opened.

const app = createApp(App)
const log = createLogger('app')

// Global error handler
app.config.errorHandler = (err, _instance, info) => {
  log.error('Vue error', { err, info })
}

// Element Plus registers component-by-component (was: `app.use(ElementPlus)`
// plus the full `element-plus/dist/index.css`). unplugin-element-plus injects
// each named import's styles, so the bundle carries only the components
// templates actually render. Imperative confirm/prompt/notice no longer goes
// through element-plus at all: it lives in the confirmDialog store, rendered
// by the self-drawn ConfirmDialogHost.
const elementPlusComponents = [
  ElButton,
  ElButtonGroup,
  ElCheckbox,
  ElCheckboxButton,
  ElCheckboxGroup,
  ElCol,
  ElCollapseTransition,
  ElConfigProvider,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElOption,
  ElRow,
  ElSelect,
  ElSlider,
  ElSwitch,
  ElTag,
]

const pinia = createPinia()
app.use(pinia)
app.use(router)
elementPlusComponents.forEach((component) => app.use(component))
app.use(i18n)

// Initialize theme
const themeStore = useThemeStore()
themeStore.initialize()

/** The Welcome guide is the Workbench's no-tab surface (DocumentGroup renders
 *  it whenever no document resolves), so there is no first-run flag and no
 *  welcome tab to manage: an empty workbench shows the guide by construction.
 *  Landing itself is not decided here: the Agent page is the front door on
 *  EVERY boot (uiLayout DEFAULTS, and the page is deliberately not
 *  persisted) — the Agent empty state is the first-run surface, and the
 *  Welcome guide serves the Workbench the user flips to. */

// The pre-mount boot sequence, in one async IIFE (top-level await would drop
// the build target below the chrome87 baseline the entry is compiled for).
void (async () => {
  // Resolve the detected locale's messages before any pre-mount decision
  // renders text: en-US ships statically (no-op), a Chinese boot awaits the
  // one lazy zh-CN chunk so the Welcome copy paints in the right language.
  await prepareInitialLocale()

  // Restore every synchronous piece of shell state BEFORE mount: layout sizes
  // (uiLayout.hydrate), open documents (documents' immediate workspace watcher
  // runs on this first store construction), and the no-tabs landing page. All
  // of it reads localStorage, so it is synchronous — and doing it pre-mount is
  // the difference between "the first frame is the real layout" and "the first
  // frame is DEFAULTS, then the whole shell reflows" (the latter was the
  // largest measured CLS event, reproducible on every warm start, 2026-09-04
  // perf audit).
  const workspaceStore = useWorkspaceStore()
  const uiLayout = useUiLayoutStore()
  if (workspaceStore.workspaceId) uiLayout.hydrate(workspaceStore.workspaceId)
  // Constructing the documents store pre-mount runs its immediate workspace
  // watcher (open-document restore). The old "no open document → land on the
  // Workbench" override is gone: the Agent page owns the landing.
  useDocumentsStore()

  // Resolve the real Backend base URL (the supervised local Backend owns an
  // OS-assigned port, e.g. 51016) BEFORE any component mounts. Pinia stores
  // set up `immediate` watchers that read the shared TDEase client on setup
  // (`stores/selection.ts`'s `refreshRunFileStatuses` is the one that
  // surfaced this); if they run against the pre-swap default
  // `http://127.0.0.1:8000` client, every Run surface (graph, files, fetch)
  // silently fails with ERR_CONNECTION_REFUSED. `connectBackend()` does the
  // IPC → setTDEaseBaseUrl → supervisor.connect chain; awaiting it means
  // mount observers a real client. What mount must NOT wait for is the first
  // probe's ANSWER: base-URL resolution is one IPC roundtrip, while the probe
  // adds two HTTP roundtrips (and up to 2×2.5s of timeouts against a hanging
  // remote backend) to the first-paint critical path. The supervisor's phase
  // is exactly what the shell renders as its connecting/degraded state, so
  // `awaitFirstProbe: false` keeps the client-swap invariant while taking
  // probes off that path. Connection failure does NOT block the UI: the
  // supervisor transitions to `offline` and the shell renders its degraded
  // state, exactly as before.
  // `persist: false` — boot honors the persisted connection block; only an
  // explicit Connect click may rewrite it (a preconfigured remote deployment
  // must survive a renderer whose localStorage says otherwise).
  void useSettingsStore().connectBackend({ awaitFirstProbe: false, persist: false }).finally(() => {
    app.mount('#app')
    // First frame painted: the main window's splash closes on this signal
    // (electron/main.ts ready-to-show handler). Without it the splash would
    // switch to a blank window — mount waits on the backend:connection
    // handshake, which on a cold first run can take minutes of uv sync.
    window.tdeaseDesktop?.rendererReady?.()
  })
})()
