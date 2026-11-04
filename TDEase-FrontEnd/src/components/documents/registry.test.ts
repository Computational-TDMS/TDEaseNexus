import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import type { DocumentKey } from '@/studio/domain/document'
import { asResultId, asRunId, asSha256, asWorkspaceId } from '@/studio/domain/identity'
import { documentDefinitions, documentRegistry } from './definitions'
import {
  DOCUMENT_KINDS,
  DocumentRegistrationError,
  DocumentRegistry,
  DocumentResolutionError,
  type AnyDocumentDefinition,
  type DocumentKind,
} from './registry'

const Stub = defineComponent({ name: 'Stub', setup: () => () => h('div') })

function definition(overrides: Partial<AnyDocumentDefinition> = {}): AnyDocumentDefinition {
  return { kind: 'run-index', component: Stub, ...overrides } as AnyDocumentDefinition
}

/** Every variant registered against the same stub — a valid, total table. */
function total(overrides: ReadonlyArray<AnyDocumentDefinition> = []): AnyDocumentDefinition[] {
  const overridden = new Set(overrides.map((entry) => entry?.kind))
  return [
    ...DOCUMENT_KINDS.filter((kind) => !overridden.has(kind)).map((kind) => definition({ kind })),
    ...overrides,
  ]
}

describe('DocumentRegistry', () => {
  it('rejects invalid registrations at construction time', () => {
    // Duplicate variant.
    expect(() => new DocumentRegistry(total([definition({ kind: 'run' }), definition({ kind: 'run' })])))
      .toThrow(DocumentRegistrationError)
    expect(() => new DocumentRegistry(total([definition({ kind: 'run' }), definition({ kind: 'run' })])))
      .toThrow('Duplicate document registration: run')

    // Omitted variant — the table must be total, with no fallback branch.
    expect(() => new DocumentRegistry(total().filter((entry) => entry.kind !== 'result')))
      .toThrow('not total; unregistered DocumentKey variants: result')
    expect(() => new DocumentRegistry([])).toThrow(DocumentRegistrationError)

    // Unknown variant.
    expect(() => new DocumentRegistry(total([definition({ kind: 'nope' as DocumentKind })])))
      .toThrow('Unknown DocumentKey variant: "nope"')

    // A registration with no component.
    expect(() => new DocumentRegistry(total([definition({ kind: 'run', component: undefined as never })])))
      .toThrow('requires a component: run')

    // A not-built placeholder with half its copy.
    expect(() => new DocumentRegistry(total([definition({
      kind: 'result', notBuilt: { titleKey: 'a.title', descriptionKey: ' ' },
    })]))).toThrow('requires both a title and a description key: result')

    // Two unbuilt variants sharing one message — the generic-Empty defect
    // this registry replaces, refused at construction rather than by a test.
    expect(() => new DocumentRegistry(total([
      definition({ kind: 'result', notBuilt: { titleKey: 'same.title', descriptionKey: 'a.body' } }),
      definition({ kind: 'file', notBuilt: { titleKey: 'same.title', descriptionKey: 'b.body' } }),
    ]))).toThrow('must not share a message')
  })

  it('resolves each key to its component and the props derived from that key', () => {
    const runId = 'run-1'
    const runResolution = documentRegistry.resolve({ kind: 'run', runId } as DocumentKey)
    expect(runResolution.props).toEqual({ runId })

    const fileResolution = documentRegistry.resolve(
      { kind: 'file', workspaceId: 'ws-1', path: 'runs/run-1/a.csv' } as DocumentKey,
    )
    expect(fileResolution.props).toEqual({ workspaceId: 'ws-1', path: 'runs/run-1/a.csv' })

    expect(documentRegistry.resolve({ kind: 'settings' }).props).toEqual({})
  })

  it('fails loudly for a kind the union no longer knows about', () => {
    expect(() => documentRegistry.resolve({ kind: 'bogus-kind' } as unknown as DocumentKey))
      .toThrow(DocumentResolutionError)
    expect(() => documentRegistry.resolve({ kind: 'bogus-kind' } as unknown as DocumentKey))
      .toThrow(/no dispatch for DocumentKey\.kind = "bogus-kind"/)
  })
})

describe('the shipped document table', () => {
  it('registers every DocumentKey variant, keyed by its own kind', () => {
    expect(documentRegistry.list().map((entry) => entry.kind).sort())
      .toEqual([...DOCUMENT_KINDS].sort())
    for (const [key, entry] of Object.entries(documentDefinitions)) {
      expect(entry.kind).toBe(key)
    }
  })

  // `result` left this list on 2026-07-26 — it was not unbuilt:
  // `resultCacheStorage` + `result-availability` were complete and had zero
  // production importers *because* the row said `NotBuiltDocument`
  // (docs/STATUS.md). `canvas` was removed with the Canvas feature
  // entirely on 2026-09-17.
  // Only `analysis-review` still owes a use case (§4.8).
  it('names exactly the one variant §4.8 has no use case for as not built', () => {
    expect(documentRegistry.notBuilt().slice().sort())
      .toEqual(['analysis-review'])
  })

  // The whole `ResultRef` must reach the component: `resultId` alone is not an
  // identity (CORE-ARCHITECTURE.md §3.2 — the digest decides whether the
  // reference reads as "exactly this value" or has been superseded), and
  // `ResultCache` keys on all four fields.
  it('mounts the real Result renderer and hands it the whole ResultRef', () => {
    const result = documentRegistry.list().find((entry) => entry.kind === 'result')
    expect(result?.notBuilt).toBeUndefined()
    expect(result?.component).toBeTruthy()

    const ref = {
      workspaceId: asWorkspaceId('ws-1'),
      runId: asRunId('run_abc'),
      resultId: asResultId('feature-table:sample-a'),
      digest: asSha256('a'.repeat(64)),
    }
    expect(documentRegistry.resolve({ kind: 'result', ref }).props).toEqual({ resultRef: ref })
  })

  it('hands the wiki scope and page through to the component', () => {
    const bound = documentRegistry.resolve({ kind: 'wiki', scope: 'workspace', page: 'method/TopFD.md' })
    expect(bound.props).toEqual({ scope: 'workspace', page: 'method/TopFD.md' })
  })

  it('keeps the pre-registry i18n keys for the not-built copy', () => {
    const copyOf = (kind: DocumentKind) =>
      documentRegistry.list().find((entry) => entry.kind === kind)?.notBuilt
    expect(copyOf('analysis-review')).toEqual({
      titleKey: 'workbench.documentHost.analysisReviewNotBuiltTitle',
      descriptionKey: 'workbench.documentHost.analysisReviewNotBuiltDescription',
    })
  })
})
