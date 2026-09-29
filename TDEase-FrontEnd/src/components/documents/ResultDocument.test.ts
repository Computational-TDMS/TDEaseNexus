/**
 * ResultDocument — the four availability states must stay four things.
 *
 * The defect this whole effort removes is a surface that looks functional and
 * is not, so these tests assert on the *distinguishing* output of each state
 * (a distinct `StructuredError.code`, a viewer host, an honest empty state),
 * never on "something rendered". Copy is asserted through i18n keys rather
 * than locale strings: the keys are merged into `src/locales/**` by a separate
 * pass, and `vue-i18n` echoes a missing key back, so key-level assertions are
 * both stable and immune to a rewrite of the wording.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import ResultDocument from './ResultDocument.vue'
import { useConfirmDialogStore } from '@/stores/confirmDialog'
import { useDocumentsStore, type ResultOverview } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'
import { asRelativePath, asResultId, asRunId, asSha256, asWorkspaceId } from '@/studio/domain/identity'
import type { PublishedResult, ResultRef } from '@/studio/domain/result'

const ViewerSurfaceStub = defineComponent({
  name: 'ViewerSurfaceStub',
  props: { input: Object },
  setup: () => () => h('div', { class: 'viz-host-stub' }),
})

const PINNED_DIGEST = 'a'.repeat(64)
const CURRENT_DIGEST = 'b'.repeat(64)

const ref: ResultRef = {
  workspaceId: asWorkspaceId('ws-1'),
  runId: asRunId('run_abc'),
  resultId: asResultId('feature-table:sample-a'),
  digest: asSha256(PINNED_DIGEST),
}

function publishedResult(overrides: Partial<PublishedResult> = {}): PublishedResult {
  return {
    ref,
    title: 'Features — sample-a',
    kind: 'feature_table',
    size: 128,
    technicalPath: asRelativePath('results/sample-a/features.csv'),
    metadata: { sample: 'sample-a' },
    ...overrides,
  }
}

function overview(overrides: Partial<ResultOverview> = {}): ResultOverview {
  return {
    ref,
    availability: 'cached',
    published: publishedResult(),
    supersededBy: null,
    cacheUnavailable: false,
    ...overrides,
  }
}

function mountDocument() {
  return mount(ResultDocument, {
    props: { resultRef: ref },
    global: {
      stubs: {
        'el-icon': true,
        'el-select': true,
        'el-option': true,
        'el-tooltip': true,
        ViewerSurface: ViewerSurfaceStub,
      },
    },
  })
}

async function flush() {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await flushPromises()
}

describe('ResultDocument', () => {
  let store: ReturnType<typeof useDocumentsStore>

  beforeEach(async () => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    await useWorkspaceStore().setWorkspace('demo', { id: 'ws-1' })
    store = useDocumentsStore()
  })

  it('opens a cached Result through ResultCache.open and mounts a resolved viewer', async () => {
    const describe_ = vi.spyOn(store, 'describeResult').mockResolvedValue(overview())
    const open = vi.spyOn(store, 'openResultContent')
      .mockResolvedValue({ ref, blob: new Blob(['mass,intensity\n1,2\n3,4\n']), mediaType: 'text/csv' })

    const wrapper = mountDocument()
    await flush()

    // The frame is asked first and the bytes second — the whole point of
    // `describeResult` is that the four states are decided before a fetch.
    expect(describe_).toHaveBeenCalledWith(ref)
    expect(open).toHaveBeenCalledWith(ref)

    const surface = wrapper.findComponent(ViewerSurfaceStub)
    expect(surface.exists()).toBe(true)
    const input = surface.props('input') as { inputs: { rows: { rows: unknown[] } } }
    expect(input.inputs.rows.rows).toHaveLength(2)

    // Frame ownership (§5.5): the title, the dimension chip and the
    // availability chip belong to the document, not to the viewer.
    expect(wrapper.text()).toContain('Features — sample-a')
    expect(wrapper.text()).toContain('sample: sample-a')
    expect(wrapper.text()).toContain("已缓存")
  })

  it('distinguishes remote from cached rather than collapsing both into a spinner', async () => {
    vi.spyOn(store, 'describeResult').mockResolvedValue(overview({ availability: 'remote' }))
    vi.spyOn(store, 'openResultContent')
      .mockResolvedValue({ ref, blob: new Blob(['a,b\n1,2\n']), mediaType: 'text/csv' })

    const wrapper = mountDocument()
    await flush()

    expect(wrapper.text()).toContain("未缓存")
    expect(wrapper.text()).not.toContain("已缓存")
    expect(wrapper.findComponent(ViewerSurfaceStub).exists()).toBe(true)
  })

  it('says so when this build has no local Result cache at all', async () => {
    vi.spyOn(store, 'describeResult')
      .mockResolvedValue(overview({ availability: 'remote', cacheUnavailable: true }))
    vi.spyOn(store, 'openResultContent')
      .mockResolvedValue({ ref, blob: new Blob(['a,b\n1,2\n']) })

    const wrapper = mountDocument()
    await flush()

    expect(wrapper.text()).toContain("当前构建没有本地结果缓存，因此每次打开都会重新从后端获取数据。本页其余功能不受影响。")
  })

  it('reports a pinned digest the Run no longer publishes as superseded, never as an empty view', async () => {
    vi.spyOn(store, 'describeResult').mockResolvedValue(overview({
      availability: 'unavailable',
      published: null,
      supersededBy: CURRENT_DIGEST,
    }))
    const open = vi.spyOn(store, 'openResultContent')

    const wrapper = mountDocument()
    await flush()

    // CORE-ARCHITECTURE.md §3.4: not papered over, and not fetched either.
    expect(open).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('RESULT_SUPERSEDED')
    expect(wrapper.text()).toContain("重算已将其替换为下方所示的新摘要。若要查看当前版本，请从该运行重新打开结果；此引用保持锁定，以便基于它做出的结论仍指向原始数据。")
    expect(wrapper.text()).toContain(CURRENT_DIGEST)
    expect(wrapper.findComponent(ViewerSurfaceStub).exists()).toBe(false)
  })

  it('reports a never-published Result as a different failure from a superseded one', async () => {
    vi.spyOn(store, 'describeResult')
      .mockResolvedValue(overview({ availability: 'unavailable', published: null, supersededBy: null }))

    const wrapper = mountDocument()
    await flush()

    expect(wrapper.text()).toContain('RESULT_NOT_PUBLISHED')
    expect(wrapper.text()).not.toContain('RESULT_SUPERSEDED')
  })

  it('offers eviction as the remedy for a cache conflict, and refetches after it', async () => {
    const describe_ = vi.spyOn(store, 'describeResult').mockResolvedValue(overview({ availability: 'conflict' }))
    const evict = vi.spyOn(store, 'evictResult').mockResolvedValue()

    const wrapper = mountDocument()
    await flush()
    expect(wrapper.text()).toContain('RESULT_CACHE_CONFLICT')

    // The conflict envelope is retryable, so ErrorCard shows Retry; retrying
    // drops the cached copy first (§3.3 — eviction can only make it slower).
    describe_.mockResolvedValue(overview({ availability: 'remote' }))
    vi.spyOn(store, 'openResultContent').mockResolvedValue({ ref, blob: new Blob(['a,b\n1,2\n']) })
    await wrapper.findComponent({ name: 'ErrorCard' }).vm.$emit('retry')
    await flush()

    expect(evict).toHaveBeenCalledWith(ref)
    expect(describe_).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('RESULT_CACHE_CONFLICT')
  })

  it('surfaces the Backend envelope when the bytes cannot be read', async () => {
    vi.spyOn(store, 'describeResult').mockResolvedValue(overview())
    vi.spyOn(store, 'openResultContent').mockRejectedValue(new Error('socket closed'))

    const wrapper = mountDocument()
    await flush()

    expect(wrapper.text()).toContain('RESULT_OPEN_FAILED')
    expect(wrapper.text()).toContain("请确认后端可访问、且该运行的文件仍在磁盘上，然后重试。")
  })

  it('keeps a binary Result saveable instead of calling it unsupported and stopping', async () => {
    vi.spyOn(store, 'describeResult').mockResolvedValue(overview({
      published: publishedResult({ technicalPath: asRelativePath('results/sample-a/features.raw') }),
    }))
    const open = vi.spyOn(store, 'openResultContent')

    const wrapper = mountDocument()
    await flush()

    expect(open).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain("数据本身是可用的。可将其保存到工作区，再用能读取该格式的工具打开。")
    // The empty state's one action is the same act as the frame button.
    expect(wrapper.text()).toContain("保存到工作区…")
  })

  it('materializes only on the explicit act, and only to the destination the user named', async () => {
    vi.spyOn(store, 'describeResult').mockResolvedValue(overview())
    vi.spyOn(store, 'openResultContent').mockResolvedValue({ ref, blob: new Blob(['a,b\n1,2\n']) })
    const materialize = vi.spyOn(store, 'materializeResult').mockResolvedValue()
    vi.spyOn(useConfirmDialogStore(), 'requestText').mockResolvedValue('analysis/features.csv')

    const wrapper = mountDocument()
    await flush()

    // Opening created nothing (§5.5): materialize is untouched until clicked.
    expect(materialize).not.toHaveBeenCalled()

    await wrapper.find('.result-document__actions button').trigger('click')
    await flush()

    expect(materialize).toHaveBeenCalledWith(ref, 'analysis/features.csv')
  })

  it('writes nothing when the destination prompt is dismissed', async () => {
    vi.spyOn(store, 'describeResult').mockResolvedValue(overview())
    vi.spyOn(store, 'openResultContent').mockResolvedValue({ ref, blob: new Blob(['a,b\n1,2\n']) })
    const materialize = vi.spyOn(store, 'materializeResult').mockResolvedValue()
    vi.spyOn(useConfirmDialogStore(), 'requestText').mockResolvedValue(null)

    const wrapper = mountDocument()
    await flush()
    await wrapper.find('.result-document__actions button').trigger('click')
    await flush()

    expect(materialize).not.toHaveBeenCalled()
  })

  it('states a refused overwrite as a failure with a remedy, not as a silent no-op', async () => {
    vi.spyOn(store, 'describeResult').mockResolvedValue(overview())
    vi.spyOn(store, 'openResultContent').mockResolvedValue({ ref, blob: new Blob(['a,b\n1,2\n']) })
    vi.spyOn(store, 'materializeResult')
      .mockRejectedValue(new Error('Workspace materialization conflict: analysis/features.csv'))
    vi.spyOn(useConfirmDialogStore(), 'requestText').mockResolvedValue('analysis/features.csv')

    const wrapper = mountDocument()
    await flush()
    await wrapper.find('.result-document__actions button').trigger('click')
    await flush()

    expect(wrapper.text()).toContain('RESULT_MATERIALIZE_FAILED')
    expect(wrapper.text()).toContain("该路径下已有内容不同的文件，因此未做改动。请换一个路径保存，或先删除已有文件。")
    // The Result itself is still readable — the failure is about the copy.
    expect(wrapper.findComponent(ViewerSurfaceStub).exists()).toBe(true)
  })
})
