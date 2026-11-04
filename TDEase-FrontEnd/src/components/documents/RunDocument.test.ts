import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import RunDocument from './RunDocument.vue'
import { useRunsStore } from '@/stores/runs'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'
import { BackendFailure } from '@/studio/domain/backend-failure'
import { useConfirmDialogStore } from '@/stores/confirmDialog'

function mountDocument(runId: string) {
  return mount(RunDocument, {
    props: { runId },
    global: { stubs: { 'el-icon': true } },
  })
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('RunDocument', () => {
  beforeEach(async () => {
    // Without this, `request.mock.calls[0]` is whatever an earlier test in
    // this file recorded, and an assertion about "the first confirm" silently
    // reads someone else's.
    vi.clearAllMocks()
    setActivePinia(createPinia())
    const workspaceStore = useWorkspaceStore()
    await workspaceStore.setWorkspace('demo', { id: 'ws-1' })
    // `window.confirm` is gone: it is a native OS dialog that cannot be
    // themed, translated or told what it is about to destroy. Destructive
    // confirmation is the confirmDialog store (rendered by ConfirmDialogHost).
    // Default here is the DISMISSAL path — resolve(false) — so any test that
    // does not opt in proves the store was not called.
    vi.spyOn(useConfirmDialogStore(), 'request').mockResolvedValue(false)
    // The Files/Artifacts listing loads immediately on mount in every test
    // below; give it a resolved default so tests that don't care about it
    // aren't left with an unhandled loading state.
    vi.spyOn(useDocumentsStore(), 'listRunFiles').mockResolvedValue([])
    vi.spyOn(useDocumentsStore(), 'listRunRevisions').mockResolvedValue([])
  })

  it('offers Cancel for a running Run and calls the store method', async () => {
    const runsStore = useRunsStore()
    const cancelSpy = vi.spyOn(runsStore, 'cancel').mockResolvedValue(undefined)
    runsStore.active.set('run-1', {
      id: 'run-1', title: 'Run 1', workspaceId: 'ws-1', status: 'RUNNING',
      cores: 4, rerunMode: 'resume', labels: {},
      resultCount: 0, createdAt: new Date().toISOString(), lastEventSeq: 0,
    })

    const wrapper = mountDocument('run-1')
    const buttons = wrapper.findAll('button')
    const cancelButton = buttons.find((btn) => btn.text().includes('取消'))
    expect(cancelButton).toBeTruthy()

    await cancelButton!.trigger('click')
    expect(cancelSpy).toHaveBeenCalledWith('run-1')
  })

  // bans an ambiguous generic rerun: the user's
  // verbs are `Continue` and `Recompute all results`, never the engine's
  // `resume` / `overwrite`, which stay confined to the store's transport
  // argument. This asserts both halves — the label the user reads and the mode
  // the store receives — so a future rename cannot silently reintroduce
  // "Overwrite" as a user-facing word.
  it('offers Continue, Recompute all results and Move to trash for a terminal Run', async () => {
    const runsStore = useRunsStore()
    const rerunSpy = vi.spyOn(runsStore, 'rerun').mockResolvedValue(undefined)
    const trashSpy = vi.spyOn(runsStore, 'trash').mockResolvedValue(undefined)
    runsStore.history.push({
      id: 'run-2', title: 'Run 2', workspaceId: 'ws-1', status: 'FAILED',
      cores: 4, rerunMode: 'resume', labels: {},
      resultCount: 0, createdAt: new Date().toISOString(), lastEventSeq: 0,
    })

    const wrapper = mountDocument('run-2')
    const buttons = wrapper.findAll('button')

    // No button anywhere in this header may read as the banned generic rerun.
    expect(wrapper.text()).not.toContain('覆盖')

    await buttons.find((btn) => btn.text().includes('继续'))!.trigger('click')
    expect(rerunSpy).toHaveBeenCalledWith('run-2', 'resume')

    // Destructive, so it confirms — request() is stubbed to resolve(false) in
    // this suite's setup, which is the dismissal path; the store must NOT be
    // called.
    await buttons.find((btn) => btn.text().includes('重算全部结果'))!.trigger('click')
    await flush()
    expect(rerunSpy).not.toHaveBeenCalledWith('run-2', 'overwrite')

    // Trash is recoverable, so it must NOT confirm: one click, one call. The
    // store mock dismisses, so if Trash ever grows a confirmation this
    // assertion fails — which is the point.
    await buttons.find((btn) => btn.text().includes('回收站'))!.trigger('click')
    await flush()
    expect(trashSpy).toHaveBeenCalledWith('run-2')
  })

  it('recomputes only after the confirmation is accepted', async () => {
    const runsStore = useRunsStore()
    const rerunSpy = vi.spyOn(runsStore, 'rerun').mockResolvedValue(undefined)
    // `vi.spyOn` in beforeEach reuses the existing spy, so its call history
    // survives across tests; clear it before asserting on call arguments.
    const confirmSpy = vi.mocked(useConfirmDialogStore().request)
    confirmSpy.mockClear()
    confirmSpy.mockResolvedValue(true)
    runsStore.history.push({
      id: 'run-3', title: 'Run 3', workspaceId: 'ws-1', status: 'SUCCEEDED',
      cores: 4, rerunMode: 'resume', labels: {},
      resultCount: 0, createdAt: new Date().toISOString(), lastEventSeq: 0,
    })

    const wrapper = mountDocument('run-3')
    await wrapper.findAll('button').find((btn) => btn.text().includes('重算全部结果'))!.trigger('click')
    await flush()

    expect(rerunSpy).toHaveBeenCalledWith('run-3', 'overwrite')
    // The dialog must name the run, not ask "Are you sure?"
    expect(confirmSpy.mock.calls[0]?.[0]?.title).toContain('Run 3')
  })

  it('loads and lists the Run\'s files through the documents store', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'listRunFiles').mockResolvedValue([
      { path: 'results/sample/proteoforms.tsv', size: 2048, digest: 'a'.repeat(64) },
      { path: 'logs/run.log', size: 512, digest: 'b'.repeat(64) },
    ] as never)

    const wrapper = mountDocument('run-3')
    await flush()

    expect(documentsStore.listRunFiles).toHaveBeenCalledWith('run-3')
    const rows = wrapper.findAll('.run-document__file-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('results/sample/proteoforms.tsv')
  })

  it('opens a file document through the documents store when a file row is clicked', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'listRunFiles').mockResolvedValue([
      { path: 'results/sample/proteoforms.tsv', size: 2048, digest: 'a'.repeat(64) },
    ] as never)
    const openSpy = vi.spyOn(documentsStore, 'openRunFile').mockReturnValue('file:ws-1:run-files/run-3/results/sample/proteoforms.tsv')

    const wrapper = mountDocument('run-3')
    await flush()

    await wrapper.find('.run-document__file-row').trigger('click')
    expect(openSpy).toHaveBeenCalledWith('run-3', 'results/sample/proteoforms.tsv')
  })

  it('pulls an artifact into its owning Workspace Run without asking for a destination', async () => {
    const documentsStore = useDocumentsStore()
    useRunsStore().history.push({
      id: 'run-3', title: 'Run 3', workspaceId: 'ws-1', workspaceRunPath: 'runs/soybean-all',
      status: 'SUCCEEDED', cores: 4, rerunMode: 'resume', labels: {},
      resultCount: 1, createdAt: new Date().toISOString(), lastEventSeq: 0,
    })
    const writeBytesAtomic = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('tdeaseDesktop', { workspace: { writeBytesAtomic } })
    vi.spyOn(documentsStore, 'listRunFiles').mockResolvedValue([
      { path: 'results/sample/proteoforms.tsv', size: 2048, digest: 'a'.repeat(64) },
    ] as never)
    const fetchSpy = vi.spyOn(documentsStore, 'fetchRunFile').mockResolvedValue(new Blob(['result']))

    const wrapper = mountDocument('run-3')
    await flush()

    await wrapper.find('[aria-label="抓取到此 Run"]').trigger('click')
    await flush()

    expect(fetchSpy).toHaveBeenCalledWith('run-3', 'results/sample/proteoforms.tsv')
    expect(writeBytesAtomic).toHaveBeenCalledWith('demo', 'runs/soybean-all/results/sample/proteoforms.tsv', [114, 101, 115, 117, 108, 116])
    vi.unstubAllGlobals()
  })

  it('previews and explicitly restores workflow files from a retained revision', async () => {
    const documentsStore = useDocumentsStore()
    useRunsStore().history.push({
      id: 'run-revision', title: 'Revision Run', workspaceId: 'ws-1', workspaceRunPath: 'runs/soybean-all',
      currentRevision: 'rev-00000010', status: 'SUCCEEDED', cores: 4,
      rerunMode: 'resume', labels: {}, resultCount: 1,
      createdAt: new Date().toISOString(), lastEventSeq: 10,
    })
    vi.spyOn(documentsStore, 'listRunRevisions').mockResolvedValue([{
      revisionId: 'rev-00000010', createdAt: new Date().toISOString(), fileCount: 1, workflowFileCount: 1,
    }])
    vi.spyOn(documentsStore, 'listRunFiles').mockImplementation(async (_runId, _pattern, revision) => revision
      ? [{ path: 'Snakefile', size: 24, digest: 'a'.repeat(64), role: 'workflow' } as never]
      : [])
    const fetchSpy = vi.spyOn(documentsStore, 'fetchRunFile').mockResolvedValue(new Blob(['rule all:\n    input: []\n']))
    const writeBytesAtomic = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('tdeaseDesktop', { workspace: { writeBytesAtomic } })

    const wrapper = mountDocument('run-revision')
    await flush()
    await wrapper.findAll('button').find((button) => button.text().includes('预览工作流'))!.trigger('click')
    await flush()
    expect(wrapper.find('.run-document__workflow-preview').text()).toContain('rule all')
    expect(writeBytesAtomic).not.toHaveBeenCalled()

    vi.mocked(useConfirmDialogStore().request).mockResolvedValue(true)
    await wrapper.findAll('button').find((button) => button.text().includes('恢复为当前工作流'))!.trigger('click')
    await flush()
    expect(fetchSpy).toHaveBeenCalledWith('run-revision', 'Snakefile', 'rev-00000010')
    expect(writeBytesAtomic).toHaveBeenCalledWith('demo', 'runs/soybean-all/Snakefile', expect.any(Array))
    vi.unstubAllGlobals()
  })

  it('shows an honest empty state when a Run has no files yet', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'listRunFiles').mockResolvedValue([])

    const wrapper = mountDocument('run-4')
    await flush()

    expect(wrapper.findAll('.run-document__file-row')).toHaveLength(0)
    expect(wrapper.text()).toContain('暂无文件')
  })

  it('shows the error envelope when listing files fails, and Retry re-fetches', async () => {
    const documentsStore = useDocumentsStore()
    const listSpy = vi.spyOn(documentsStore, 'listRunFiles')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{ path: 'a.csv', size: 10, digest: 'c'.repeat(64) }] as never)

    const wrapper = mountDocument('run-5')
    await flush()

    expect(wrapper.find('[role="alert"], [role="status"]').exists()).toBe(true)

    const retryButton = wrapper.findAll('button').find((btn) => btn.text() === '重试')
    expect(retryButton).toBeTruthy()
    await retryButton!.trigger('click')
    await flush()

    expect(listSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.findAll('.run-document__file-row')).toHaveLength(1)
  })
  /**
   * The end of the chain the failure envelope exists for: the Backend states a
   * code and a remedy, and the user sees *those* rather than this component's
   * generic placeholder. Before `throwBackendFailure`, the envelope was
   * discarded at the fetch layer and this assertion was unachievable.
   */
  it('shows the Backend’s own code and remedy, not the placeholder', async () => {
    vi.spyOn(useDocumentsStore(), 'listRunFiles').mockRejectedValue(
      new BackendFailure(
        {
          code: 'RUN_NOT_FOUND',
          domain: 'run',
          message: 'That Run is not in this Workspace.',
          remedy: 'Pick a Run from the Run Index, or reopen the Workspace that owns it.',
          retryable: false,
        },
        true,
        404,
      ),
    )

    const wrapper = mountDocument('run-6')
    await flush()

    expect(wrapper.text()).toContain('RUN_NOT_FOUND')
    expect(wrapper.text()).toContain('Pick a Run from the Run Index')
    expect(wrapper.text()).not.toContain('RUN_FILES_LIST_FAILED')
  })

  it('falls back to its own message when the failure carries no envelope', async () => {
    vi.spyOn(useDocumentsStore(), 'listRunFiles').mockRejectedValue(new Error('socket hang up'))

    const wrapper = mountDocument('run-7')
    await flush()

    expect(wrapper.text()).toContain('RUN_FILES_LIST_FAILED')
  })

  // ── Explicit artifact transfer ───────────────────────────────────────────

  async function flushDeep() {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  function pushTerminalRun() {
    useRunsStore().history.push({
      id: 'run-auto', title: 'Auto Run', workspaceId: 'ws-1',
      workspaceRunPath: 'runs/soybean-all',
      status: 'SUCCEEDED', cores: 4, rerunMode: 'resume', labels: {},
      resultCount: 1, createdAt: new Date().toISOString(), lastEventSeq: 0,
    })
  }

  it('does not download result files merely by opening a terminal Run', async () => {
    const documentsStore = useDocumentsStore()
    pushTerminalRun()
    const writeBytesAtomic = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('tdeaseDesktop', {
      workspace: { exists: vi.fn().mockResolvedValue(false), writeBytesAtomic },
    })
    vi.spyOn(documentsStore, 'listRunFiles').mockResolvedValue([
      { path: 'results/sample/proteoforms.tsv', size: 2048, digest: 'a'.repeat(64) },
    ] as never)
    const fetchSpy = vi.spyOn(documentsStore, 'fetchRunFile').mockResolvedValue(new Blob(['result']))

    mountDocument('run-auto')
    await flushDeep()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(writeBytesAtomic).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('RunDocument jump tabs + inline log', () => {
  beforeEach(() => {
    // jsdom has no layout engine: stub the smooth scroll the jump tabs call.
    Element.prototype.scrollIntoView = vi.fn()
    vi.spyOn(useDocumentsStore(), 'getRunLog').mockResolvedValue({
      text: 'step ok\nError: boom\ntraceback (most recent call last)',
      lines: 400,
    })
  })

  async function mountTerminalRun() {
    const runsStore = useRunsStore()
    runsStore.history.push({
      id: 'run-tabs', title: 'Run tabs', workspaceId: 'ws-1', status: 'SUCCEEDED',
      cores: 4, rerunMode: 'resume', labels: {},
      resultCount: 0, createdAt: new Date().toISOString(), lastEventSeq: 0,
    })
    const wrapper = mountDocument('run-tabs')
    await flush()
    return wrapper
  }

  it('renders three jump tabs and marks the clicked one active', async () => {
    const wrapper = await mountTerminalRun()
    const tabs = wrapper.findAll('[data-testid="run-jump"]')
    expect(tabs).toHaveLength(3)
    expect(tabs.map((tab) => tab.text())).toEqual(['DAG', '文件与产物', '运行日志'])
    expect(tabs[0].attributes('aria-selected')).toBe('true')

    await tabs[2].trigger('click')
    expect(tabs[2].attributes('aria-selected')).toBe('true')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('keeps the log collapsed by default, below the files section', async () => {
    const wrapper = await mountTerminalRun()
    expect(wrapper.find('[data-testid="run-log"]').exists()).toBe(false)
    const logSection = wrapper.find('[data-section="log"]')
    const filesSection = wrapper.find('[data-section="files"]')
    // log section exists after files in document order
    expect(logSection.exists()).toBe(true)
    expect(filesSection.element.compareDocumentPosition(logSection.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('expands the log on demand, fetches it once and flags error lines', async () => {
    const store = useDocumentsStore()
    const wrapper = await mountTerminalRun()
    const toggle = () => wrapper.find('[data-testid="run-log-toggle"]')
    await toggle().trigger('click')
    await flush()
    const log = wrapper.find('[data-testid="run-log"]')
    expect(log.exists()).toBe(true)
    expect(store.getRunLog).toHaveBeenCalledWith('run-tabs', 400)
    const errorLines = log.findAll('.run-document__log-line--error')
    expect(errorLines).toHaveLength(2)
    expect(errorLines[0].text()).toContain('Error: boom')

    // collapse again: content disappears, the store is not re-called
    await toggle().trigger('click')
    expect(wrapper.find('[data-testid="run-log"]').exists()).toBe(false)
    expect(store.getRunLog).toHaveBeenCalledTimes(1)
  })

  it('surfaces a log load failure as an inline error card with retry', async () => {
    vi.spyOn(useDocumentsStore(), 'getRunLog').mockRejectedValue(new Error('down'))
    const wrapper = await mountTerminalRun()
    await wrapper.find('[data-testid="run-log-toggle"]').trigger('click')
    await flush()
    await flush()
    // ErrorCard renders the remedy line; the title lives in its header slot.
    expect(wrapper.text()).toContain('请检查后端连接后重试。')
  })
})
