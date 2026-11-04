import workbenchZh from '@/locales/zh-CN/workbench.json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import FileDocument from './FileDocument.vue'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'
import type { ViewerRenderInput } from '@/types/visualization'

const ViewerSurfaceStub = defineComponent({
  name: 'ViewerSurfaceStub',
  props: { input: Object },
  setup(props) {
    return () => h('div', { class: 'viewer-surface-stub' }, JSON.stringify(props.input))
  },
})

const MsAlignDocumentStub = defineComponent({
  name: 'MsAlignDocumentStub',
  props: { spectra: Array, fileName: String, peakLoader: Function },
  setup(props) {
    return () => h('div', { class: 'msalign-stub', 'data-peak-total': props.spectra?.reduce((n: number, s: { peaks: unknown[] }) => n + s.peaks.length, 0) ?? 0 })
  },
})

function mountDocument(path: string, runId?: string) {
  return mount(FileDocument, {
    props: runId ? { workspaceId: 'ws-1', path, runId } : { workspaceId: 'ws-1', path },
    global: {
      stubs: {
        'el-icon': true,
        ViewerSurface: ViewerSurfaceStub,
        MsAlignDocument: MsAlignDocumentStub,
      },
    },
  })
}

// `blob.text()` in jsdom does not settle on the same microtask tick as the
// mocked reader promise, so a plain `Promise.resolve()` chain is not enough --
// `flushPromises` plus a real timer tick covers both.
async function flush() {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await flushPromises()
}

describe('FileDocument', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    const workspaceStore = useWorkspaceStore()
    await workspaceStore.setWorkspace('demo', { id: 'ws-1' })
  })

  afterEach(() => {
    delete (globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop
  })

  // ── Workspace origin (the surface must not care where
  // the bytes came from) ─────────────────────────────────────────────────────

  it('renders a Workspace text file through readWorkspaceFile, not through the Run gateway', async () => {
    const documentsStore = useDocumentsStore()
    const readSpy = vi.spyOn(documentsStore, 'readWorkspaceFile')
      .mockResolvedValue(new Blob(['import numpy as np\n']))
    const fetchSpy = vi.spyOn(documentsStore, 'fetchRunFile')

    const wrapper = mountDocument('analysis.py')
    await flush()

    expect(readSpy).toHaveBeenCalledWith('analysis.py')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(wrapper.find('.file-document__text').text()).toContain('import numpy as np')
    expect(wrapper.find('[data-state="type-card"]').exists()).toBe(false)
  })

  it('routes a Workspace CSV to the same table viewer a Run CSV reaches', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'readWorkspaceFile')
      .mockResolvedValue(new Blob(['a,b\n1,2\n3,4\n'], { type: 'text/csv' }))

    const wrapper = mountDocument('data/summary.csv')
    await flush()

    const surface = wrapper.findComponent(ViewerSurfaceStub)
    expect(surface.exists()).toBe(true)
    const input = surface.props('input') as ViewerRenderInput
    expect(input.viewer).toBe('table')
    expect((input.inputs.rows as { rows: unknown[] }).rows).toHaveLength(2)
  })


  it('shows the type card for a binary Workspace file and never asks the reader for its bytes', async () => {
    const documentsStore = useDocumentsStore()
    const readSpy = vi.spyOn(documentsStore, 'readWorkspaceFile')

    const wrapper = mountDocument('raw/sample.raw')
    await flush()

    expect(readSpy).not.toHaveBeenCalled()
    const card = wrapper.find('[data-state="type-card"]')
    expect(card.exists()).toBe(true)
    // It states what the file is: type and path, not a shrug.
    expect(card.text()).toContain('RAW')
    expect(card.text()).toContain('raw/sample.raw')
    expect(wrapper.findComponent(ViewerSurfaceStub).exists()).toBe(false)
    expect(wrapper.find('.file-document__text').exists()).toBe(false)
  })

  it('streams a .mzML into the spectrum-list viewer instead of the binary card', async () => {
    const documentsStore = useDocumentsStore()
    const mzmlText = `<?xml version="1.0"?><mzML><run><spectrumList count="1">
<spectrum index="0" id="controllerType=0 controllerNumber=1 scan=7" defaultArrayLength="2">
<cvParam accession="MS:1000511" name="ms level" value="2"/>
<binaryDataArrayList count="1"><binaryDataArray>
<cvParam accession="MS:1000523" name="64-bit float"/><cvParam accession="MS:1000514" name="m/z array"/>
<binary>AAAAAA</binary></binaryDataArray></binaryDataArrayList></spectrum>
</spectrumList></run></mzML>`
    const readSpy = vi.spyOn(documentsStore, 'readWorkspaceFile')
      .mockResolvedValue(new Blob([mzmlText]))

    const wrapper = mountDocument('raw/sample.mzML')
    await flush()

    expect(readSpy).toHaveBeenCalledWith('raw/sample.mzML')
    expect(wrapper.find('[data-state="type-card"]').exists()).toBe(false)
    const viewer = wrapper.findComponent(MsAlignDocumentStub)
    expect(viewer.exists()).toBe(true)
    const spectra = viewer.props('spectra') as { scan?: number; metadata: Record<string, string> }[]
    expect(spectra).toHaveLength(1)
    expect(spectra[0].scan).toBe(7)
    expect(spectra[0].metadata.LEVEL).toBe('2')
    expect(typeof viewer.props('peakLoader')).toBe('function')
  })

  it('renders a Workspace image through the same Blob media path as a Run image', async () => {
    const documentsStore = useDocumentsStore()
    const readSpy = vi.spyOn(documentsStore, 'readWorkspaceFile')
      .mockResolvedValue(new Blob(['fake-png'], { type: 'image/png' }))
    const createObjectURL = vi.fn().mockReturnValue('blob:workspace-plot')
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })

    const wrapper = mountDocument('figures/qc.png')
    await flush()

    expect(readSpy).toHaveBeenCalledWith('figures/qc.png')
    const surface = wrapper.findComponent(ViewerSurfaceStub)
    expect(surface.exists()).toBe(true)
    const input = surface.props('input') as ViewerRenderInput
    expect((input.inputs.media as { rows: unknown[] }).rows).toEqual([
      { url: 'blob:workspace-plot', type: 'image/png', label: 'qc.png' },
    ])
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  it('offers real desktop actions on the type card when the desktop bridge is there', async () => {
    const openExternal = vi.fn().mockResolvedValue('ok')
    const showInFolder = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop = { workspace: { openExternal, showInFolder } }

    const wrapper = mountDocument('raw/sample.raw')
    await flush()

    const buttons = wrapper.findAll('[data-state="type-card"] button')
    expect(buttons).toHaveLength(2)

    await buttons[0]!.trigger('click')
    await buttons[1]!.trigger('click')
    await flush()

    // `setWorkspace('demo', { id: 'ws-1' })` makes `demo` the workspace root.
    expect(openExternal).toHaveBeenCalledWith('demo/raw/sample.raw')
    expect(showInFolder).toHaveBeenCalledWith('demo/raw/sample.raw')
  })

  it('does not offer a desktop action it cannot perform, and says what to do instead', async () => {
    const wrapper = mountDocument('raw/sample.raw')
    await flush()

    expect(wrapper.findAll('[data-state="type-card"] button')).toHaveLength(0)
    expect(wrapper.find('.file-document__card-hint').exists()).toBe(true)
  })

  it('surfaces a failed Workspace read as a retryable envelope through the same reader', async () => {
    const documentsStore = useDocumentsStore()
    const readSpy = vi.spyOn(documentsStore, 'readWorkspaceFile')
      .mockRejectedValueOnce(new Error('ENOENT'))
    readSpy.mockResolvedValueOnce(new Blob(['recovered']))

    const wrapper = mountDocument('notes.md')
    await flush()

    expect(wrapper.find('[role="alert"], [role="status"]').exists()).toBe(true)

    const retryButton = wrapper.find('.error-card button')
    expect(retryButton).toBeTruthy()
    await retryButton!.trigger('click')
    await flush()

    expect(readSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.file-document__text').text()).toContain('recovered')
  })

  // ── Run origin: bytes via fetchRunFile, bound by the key's runId ──────────

  it('fetches a CSV Run file through the documents store and routes it to the table viewer', async () => {
    const documentsStore = useDocumentsStore()
    const fetchSpy = vi.spyOn(documentsStore, 'fetchRunFile')
      .mockResolvedValue(new Blob(['a,b\n1,2\n3,4\n'], { type: 'text/csv' }))
    const readSpy = vi.spyOn(documentsStore, 'readWorkspaceFile')

    const wrapper = mountDocument('results/sample/table.csv', 'run-1')
    await flush()

    expect(fetchSpy).toHaveBeenCalledWith('run-1', 'results/sample/table.csv')
    expect(readSpy).not.toHaveBeenCalled()
    const surface = wrapper.findComponent(ViewerSurfaceStub)
    expect(surface.exists()).toBe(true)
    const input = surface.props('input') as ViewerRenderInput
    expect(input.viewer).toBe('table')
    expect((input.inputs.rows as { rows: unknown[] }).rows).toHaveLength(2)
  })

  it('fetches a PNG Run file and routes it to the media viewer as an object URL', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'fetchRunFile').mockResolvedValue(new Blob(['fake-png'], { type: 'image/png' }))
    const createObjectURL = vi.fn().mockReturnValue('blob:mock-url')
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })

    const wrapper = mountDocument('results/qc/plot.png', 'run-1')
    await flush()

    const surface = wrapper.findComponent(ViewerSurfaceStub)
    expect(surface.exists()).toBe(true)
    const input = surface.props('input') as ViewerRenderInput
    expect((input.inputs.media as { rows: Array<{ url: string; type: string }> }).rows[0]).toMatchObject({
      url: 'blob:mock-url',
      type: 'image/png',
    })

    vi.unstubAllGlobals()
  })

  it('opens an arbitrarily placed .smk file on its DAG target and keeps source in the same document', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'fetchRunFile').mockResolvedValue(new Blob(['rule all:\n    input: "x"\n']))

    const wrapper = mountDocument('misc/pipeline.smk', 'run-1')
    await flush()

    expect(wrapper.find('[data-render-target="workflow-dag"]').exists()).toBe(true)
    const sourceTab = wrapper.findAll('[role="tab"]')[1]
    expect(sourceTab).toBeTruthy()
    await sourceTab!.trigger('click')
    expect(wrapper.find('.file-document__text').text()).toContain('rule all')
    expect(wrapper.findComponent(ViewerSurfaceStub).exists()).toBe(false)
  })

  it('dispatches .smk by format without requiring a conventional directory or valid content', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'readWorkspaceFile')
      .mockResolvedValue(new Blob(['This is a lab note, not a workflow.\n']))

    const wrapper = mountDocument('notes/misleading.smk')
    await flush()

    expect(wrapper.find('[data-render-target="workflow-dag"]').exists()).toBe(true)
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(2)
  })

  it('renders an arbitrarily placed FASTA file as formatted records with a Source target', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'readWorkspaceFile').mockResolvedValue(new Blob([
      '>sp|P62805|H4_HUMAN Histone H4\nMSGRGKGGKGLGKGGAKRHRK\n',
    ]))

    const wrapper = mountDocument('runs/chlamy-h4/reinhardtii_histones.fasta')
    await flush()

    expect(wrapper.find('[data-render-target="fasta-formatted"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('sp|P62805|H4_HUMAN')
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(2)

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    expect(wrapper.find('.file-document__text').text()).toContain('>sp|P62805|H4_HUMAN')
  })

  it('shows an honest unsupported card for a binary Run file without fetching it', async () => {
    const documentsStore = useDocumentsStore()
    const fetchSpy = vi.spyOn(documentsStore, 'fetchRunFile')

    const wrapper = mountDocument('spectra/scan.raw', 'run-1')
    await flush()

    expect(fetchSpy).not.toHaveBeenCalled()
    // Read from the locale, not hard-coded, so a copy rewrite does not break this.
    expect(wrapper.text()).toContain(workbenchZh.fileDocument.unsupportedTitle)
    // A Run's bytes are on the Backend: none of the Workspace card's desktop
    // actions could reach them, so the card must not appear here.
    expect(wrapper.find('[data-state="type-card"]').exists()).toBe(false)
    expect(wrapper.findComponent(ViewerSurfaceStub).exists()).toBe(false)
  })

  it('shows the error envelope on a failed fetch and retries through the same store method', async () => {
    const documentsStore = useDocumentsStore()
    const fetchSpy = vi.spyOn(documentsStore, 'fetchRunFile').mockRejectedValueOnce(new Error('boom'))
    fetchSpy.mockResolvedValueOnce(new Blob(['ok']))

    const wrapper = mountDocument('logs/run.log', 'run-1')
    await flush()

    expect(wrapper.find('[role="alert"], [role="status"]').exists()).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const retryButton = wrapper.find('.error-card button')
    expect(retryButton).toBeTruthy()
    await retryButton!.trigger('click')
    await flush()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.file-document__text').text()).toContain('ok')
  })

  // ── TopFD `.feature` / `.msalign` recognition (the new file kinds) ────────

  it('renders a TopFD .feature file as an ag-grid table and offers a Feature Map target', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'readWorkspaceFile')
      .mockResolvedValue(new Blob(['Feature_ID\tMass\tIntensity\n0\t1292.87\t100\n1\t1400.5\t200\n']))

    const wrapper = mountDocument('runs/run-1/sample_ms1.feature')
    await flush()

    // The table target is the default and reaches the same AgGrid path as CSV.
    const surface = wrapper.findComponent(ViewerSurfaceStub)
    expect(surface.exists()).toBe(true)
    const input = surface.props('input') as ViewerRenderInput
    expect(input.viewer).toBe('table')
    expect((input.inputs.rows as { rows: unknown[] }).rows).toHaveLength(2)

    // A Feature Map target is offered alongside Table and Source.
    const tabs = wrapper.findAll('[role="tab"]').map((btn) => btn.text())
    expect(tabs).toContain(workbenchZh.fileDocument.target.table)
    expect(tabs).toContain(workbenchZh.fileDocument.target.featuremap)
    // A feature file offers three peer targets (Table, Feature Map, Source).
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(3)
  })

  it('switches a .feature file to its Feature Map target', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'readWorkspaceFile')
      .mockResolvedValue(new Blob(['Feature_ID\tMass\tMin_time\tApex_time\tIntensity\n0\t1292.87\t175.0\t180.0\t100\n']))

    const wrapper = mountDocument('runs/run-1/sample_ms1.feature')
    await flush()

    const featuremapTab = wrapper.findAll('[role="tab"]').find((btn) => btn.text() === workbenchZh.fileDocument.target.featuremap)
    expect(featuremapTab).toBeTruthy()
    await featuremapTab!.trigger('click')

    const surface = wrapper.findComponent(ViewerSurfaceStub)
    expect(surface.exists()).toBe(true)
    expect((surface.props('input') as ViewerRenderInput).viewer).toBe('featuremap')
  })

  it('routes a TopFD .msalign file to the spectrum-list viewer, never the binary card', async () => {
    const documentsStore = useDocumentsStore()
    const msalignText = [
      'BEGIN IONS\nSPECTRUM_ID=1\nSCANS=100\nLEVEL=2\nACTIVATION=HCD\n100.1 10.0 2\n200.2 20.0 2\nEND IONS',
      'BEGIN IONS\nSPECTRUM_ID=2\nSCANS=200\nLEVEL=2\nACTIVATION=HCD\n300.3 30.0 2\nEND IONS',
    ].join('\n')
    vi.spyOn(documentsStore, 'readWorkspaceFile').mockResolvedValue(new Blob([msalignText]))

    const wrapper = mountDocument('runs/run-1/sample_ms2.msalign')
    await flush()

    // msalign is a recognized kind: no unsupported/binary card.
    expect(wrapper.text()).not.toContain(workbenchZh.fileDocument.unsupportedTitle)
    // The spectrum-list viewer receives the parsed spectra.
    const msalign = wrapper.findComponent(MsAlignDocumentStub)
    expect(msalign.exists()).toBe(true)
    expect(msalign.props('spectra')).toHaveLength(2)
    expect(msalign.attributes('data-peak-total')).toBe('3')

    // Source is the only peer target (msalign has no table form).
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs).toHaveLength(2)
  })

  it('falls back to the raw text Source view for a .msalign file', async () => {
    const documentsStore = useDocumentsStore()
    const msalignText = 'BEGIN IONS\nSPECTRUM_ID=1\nSCANS=100\n100.1 10.0\nEND IONS'
    const readSpy = vi.spyOn(documentsStore, 'readWorkspaceFile').mockResolvedValue(new Blob([msalignText]))

    const wrapper = mountDocument('runs/run-1/sample_ms2.msalign')
    await flush()

    const sourceTab = wrapper.findAll('[role="tab"]').find((btn) => btn.text() === workbenchZh.fileDocument.target.source)
    expect(sourceTab).toBeTruthy()
    await sourceTab!.trigger('click')
    // The raw text was dropped after parsing; Source re-reads it lazily.
    await flush()

    expect(wrapper.find('.file-document__text').text()).toContain('BEGIN IONS')
    // …and the re-read went through the same store reader as the load itself.
    expect(readSpy).toHaveBeenCalledTimes(2)
  })

  // ── TopPIC prsm/proteoform TSVs: the Variants target ──────────────────────

  const TOPPIC_TSV = [
    'Protein accession\tProtein description\tFirst residue\tLast residue\tProteoform mass\tDatabase protein sequence\tE-value\tFeature intensity',
    'sp|P1|H2B_VAR\tH2B variant one\t1\t5\t1000.5\tMKTVL\t1e-5\t100',
    'sp|P2|H2B_VAR2\tH2B variant two\t1\t5\t1100.1\tMKTAL\t1e-6\t200',
  ].join('\n')

  const SIBLING_FASTA = '>sp|P1|H2B_VAR H2B variant one\nMKTVL\n>sp|P2|H2B_VAR2 H2B variant two\nMKTAL\n'

  it('offers table, variants and source targets for a TopPIC proteoform TSV', async () => {
    const documentsStore = useDocumentsStore()
    vi.spyOn(documentsStore, 'readWorkspaceFile')
      .mockResolvedValue(new Blob([TOPPIC_TSV]))

    const wrapper = mountDocument('runs/run-1/sample_ms2_toppic_proteoform.tsv')
    await flush()

    const tabs = wrapper.findAll('[role="tab"]').map((btn) => btn.text())
    expect(tabs).toEqual([
      workbenchZh.fileDocument.target.table,
      workbenchZh.fileDocument.target.variants,
      workbenchZh.fileDocument.target.source,
    ])
    // the table target stays the default — existing behavior unchanged
    expect(wrapper.findComponent(ViewerSurfaceStub).exists()).toBe(true)
    expect(wrapper.find('[data-render-target="toppic-variants"]').exists()).toBe(false)
  })

  it('renders the Variants alignment from the sibling FASTA on first entry', async () => {
    const documentsStore = useDocumentsStore()
    const workspaceStore = useWorkspaceStore()
    vi.spyOn(documentsStore, 'readWorkspaceFile').mockImplementation(async (path: string) => {
      if (path.endsWith('.tsv')) return new Blob([TOPPIC_TSV])
      if (path === 'runs/run-1/histone48.fasta') return new Blob([SIBLING_FASTA])
      throw new Error(`unexpected read: ${path}`)
    })
    vi.spyOn(workspaceStore, 'loadDirLazy').mockResolvedValue([
      { name: 'histone48.fasta', path: 'runs/run-1/histone48.fasta', type: 'file', size: 100 },
      { name: 'sample_ms2_toppic_proteoform.tsv', path: 'runs/run-1/sample_ms2_toppic_proteoform.tsv', type: 'file', size: 300 },
    ])

    const wrapper = mountDocument('runs/run-1/sample_ms2_toppic_proteoform.tsv')
    await flush()

    const variantsTab = wrapper.findAll('[role="tab"]').find((btn) => btn.text() === workbenchZh.fileDocument.target.variants)
    expect(variantsTab).toBeTruthy()
    await variantsTab!.trigger('click')
    await flush()

    expect(wrapper.find('[data-render-target="toppic-variants"]').exists()).toBe(true)
    expect(wrapper.find('[data-render-target="toppic-variants"]').text()).toContain('histone48.fasta')
    expect(wrapper.find('[data-render-target="toppic-variants"]').text()).toContain('sp|P1|H2B_VAR')
    // both rows come from identifications, so both are tinted
    expect(wrapper.findAll('.variant-alignment__row.is-identified')).toHaveLength(2)
    // the two sequences differ at one residue — a mismatch run exists
    expect(wrapper.find('[data-render-target="toppic-variants"]').find('.mismatch').exists()).toBe(true)
  })

  it('picks the preamble-named FASTA when several candidates share the folder', async () => {
    const documentsStore = useDocumentsStore()
    const workspaceStore = useWorkspaceStore()
    const preambleTsv = [
      '********************** Parameters **********************',
      'Protein database file:                       \thistone48.fasta',
      'Spectrum file:                               \tsample_ms2.msalign',
      '',
      TOPPIC_TSV,
    ].join('\n')
    vi.spyOn(documentsStore, 'readWorkspaceFile').mockImplementation(async (path: string) => {
      if (path.endsWith('.tsv')) return new Blob([preambleTsv])
      if (path === 'runs/run-1/histone48.fasta') return new Blob([SIBLING_FASTA])
      if (path === 'runs/run-1/database.fasta') return new Blob(['>wrong|DECoy decoy\nMMMMM\n'])
      throw new Error(`unexpected read: ${path}`)
    })
    vi.spyOn(workspaceStore, 'loadDirLazy').mockResolvedValue([
      { name: 'histone48.fasta', path: 'runs/run-1/histone48.fasta', type: 'file', size: 100 },
      { name: 'database.fasta', path: 'runs/run-1/database.fasta', type: 'file', size: 50 },
    ])

    const wrapper = mountDocument('runs/run-1/sample_ms2_toppic_proteoform.tsv')
    await flush()

    const variantsTab = wrapper.findAll('[role="tab"]').find((btn) => btn.text() === workbenchZh.fileDocument.target.variants)
    await variantsTab!.trigger('click')
    await flush()

    const viewer = wrapper.find('[data-render-target="toppic-variants"]')
    expect(viewer.exists()).toBe(true)
    expect(viewer.text()).toContain('histone48.fasta')
    expect(viewer.text()).not.toContain('wrong|DECoy')
  })

  it('surfaces an actionable error when no sibling FASTA can be resolved', async () => {
    const documentsStore = useDocumentsStore()
    const workspaceStore = useWorkspaceStore()
    vi.spyOn(documentsStore, 'readWorkspaceFile').mockResolvedValue(new Blob([TOPPIC_TSV]))
    vi.spyOn(workspaceStore, 'loadDirLazy').mockResolvedValue([])

    const wrapper = mountDocument('runs/run-1/sample_ms2_toppic_proteoform.tsv')
    await flush()

    const variantsTab = wrapper.findAll('[role="tab"]').find((btn) => btn.text() === workbenchZh.fileDocument.target.variants)
    await variantsTab!.trigger('click')
    await flush()

    expect(wrapper.find('[data-render-target="toppic-variants"]').exists()).toBe(true)
    expect(wrapper.find('[role="alert"], [role="status"]').exists()).toBe(true)
    expect(wrapper.text()).toContain(workbenchZh.fileDocument.variants.fastaMissingMessage)
  })
})
