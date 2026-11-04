import type { DocumentKey } from '../domain/document'

export type DocumentSubview = 'index' | 'overview' | 'viewer' | 'editor' | 'review' | 'settings'

export function defaultDocumentSubview(key: DocumentKey): DocumentSubview {
  switch (key.kind) {
    case 'run-index': return 'index'
    case 'run': return 'overview'
    case 'result': return 'viewer'
    case 'file': return 'editor'
    // A Run's file opens on its rendered/source targets, same as a Workspace file.
    case 'runFile': return 'editor'
    // A wiki page opens reading (edit is an explicit toggle inside the doc);
    // the index is a listing.
    case 'wiki': return 'viewer'
    case 'wiki-index': return 'index'
    case 'analysis-review': return 'review'
    // §5.7's "last section" is remembered inside the Settings document, which
    // is where the section list lives; the store's single override slot is
    // for document subviews, not for a nested nav.
    case 'settings': return 'settings'
  }
}
