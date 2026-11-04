/**
 * documentRegistry — docs/STATUS.md.
 *
 * "One component per `DocumentKey` variant. There is no fallback branch; an
 * unmapped key is a startup assertion failure, exactly like an unregistered
 * command."
 *
 * This is the document-side twin of `studio/commands/registry.ts`: a
 * registration table validated once, at construction, rather than a `v-if`
 * chain that answers an unmapped key at render time. `DocumentHost.vue` holds
 * no dispatch knowledge -- it resolves a key here and mounts what comes back.
 *
 * Two mechanisms enforce totality, and the compiler one is the real gate:
 *
 * 1. `DocumentDefinitionTable` (`definitions.ts`) is a mapped type over the
 *    `DocumentKey` union, so omitting a variant, or naming one that does not
 *    exist, fails `vue-tsc` before any test runs.
 * 2. `DocumentRegistry`'s constructor re-checks the same invariants at
 *    runtime, because the table is not the only way to build a registry --
 *    a test, or a future dynamic registration, can hand it an array -- and
 *    because a compile-time-only guarantee erases at runtime, where a
 *    corrupted persisted tab list actually arrives.
 *
 * Lives under `components/` rather than `studio/` on purpose: it names Vue
 * components, and §10.3's dependency direction is `components/ -> studio/`,
 * never the reverse.
 */

import type { Component } from 'vue'
import type { DocumentKey } from '@/studio/domain/document'

export type DocumentKind = DocumentKey['kind']

/** The one place the `DocumentKey` variant list is enumerated as values. */
export const DOCUMENT_KINDS = [
  'run-index', 'run', 'result', 'file', 'runFile', 'wiki', 'wiki-index', 'analysis-review', 'settings',
] as const satisfies ReadonlyArray<DocumentKind>

/**
 * Proves `DOCUMENT_KINDS` still covers the union. Adding a variant to
 * `DocumentKey` without adding it here is a compile error, not a silent gap.
 */
type MissingKind = Exclude<DocumentKind, (typeof DOCUMENT_KINDS)[number]>
const _kindsAreTotal: MissingKind extends never ? true : never = true
void _kindsAreTotal

export type KeyOfKind<K extends DocumentKind> = Extract<DocumentKey, { kind: K }>

/** The document surface's DOM id for one editor group — the `role="tabpanel"`
 *  that the group's tab strip's `role="tab"` rows point at via `aria-controls`.
 *  Scoped per group: groups are arbitrary (VSCode model), so a static id
 *  cannot serve more than one of them. Doc ids contain `:` and `/` (e.g.
 *  `file:ws:path`) — legal in an HTML id; consumers must reference it via
 *  attribute/`getElementById`, never a bare `querySelector('#…')`. */
export function documentTabPanelId(groupId: string): string {
  return `document-panel-${groupId}`
}

/** DOM id of one tab-strip row, for `aria-labelledby` on the panel. The same
 *  document can be shown in several groups at once, so the row id is scoped
 *  by group to keep DOM ids unique. */
export function documentTabDomId(docId: string, groupId: string): string {
  return `document-tab-${groupId}-${docId}`
}

/** Copy for a variant the build does not ship yet. Both keys are i18n ids. */
export interface NotBuiltCopy {
  titleKey: string
  descriptionKey: string
}

export interface DocumentDefinition<K extends DocumentKind = DocumentKind> {
  kind: K
  /** The component `DocumentHost` mounts. Never a branch, never a fallback. */
  component: Component
  /** Props derived from the key. Absent means the component takes none. */
  props?: (key: KeyOfKind<K>) => Record<string, unknown>
  /**
   * Set when this variant has no real surface yet (§4.8's absent use cases).
   * The registration stays in the table -- totality is the whole point -- and
   * this field is the single machine-readable record of the gap, so "which
   * document kinds are owed" is a query rather than a grep for `v-else`.
   */
  notBuilt?: NotBuiltCopy
}

/** The union of every per-variant definition, for heterogeneous collections. */
export type AnyDocumentDefinition = { [K in DocumentKind]: DocumentDefinition<K> }[DocumentKind]

/**
 * The registration table. A mapped type over the union, so the compiler --
 * not a test, not a runtime throw -- is what rejects an omitted or invented
 * variant at the one authoring site that matters.
 */
export type DocumentDefinitionTable = { readonly [K in DocumentKind]: DocumentDefinition<K> }

export interface ResolvedDocument {
  kind: DocumentKind
  component: Component
  props: Record<string, unknown>
  notBuilt?: NotBuiltCopy
}

export class DocumentRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentRegistrationError'
  }
}

export class DocumentResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DocumentResolutionError'
  }
}

export class DocumentRegistry {
  private readonly definitions = new Map<DocumentKind, AnyDocumentDefinition>()

  constructor(definitions: ReadonlyArray<AnyDocumentDefinition>) {
    for (const definition of definitions) {
      validateDefinition(definition, this.definitions)
      this.definitions.set(definition.kind, definition)
    }
    requireTotal(this.definitions)
  }

  list(): ReadonlyArray<AnyDocumentDefinition> {
    return [...this.definitions.values()]
  }

  /** The `DocumentKey` variants registered with a `notBuilt` placeholder. */
  notBuilt(): ReadonlyArray<DocumentKind> {
    return this.list().filter((definition) => definition.notBuilt).map((definition) => definition.kind)
  }

  /**
   * The only dispatch in the shell.
   *
   * The table is total by construction, so the throw below is unreachable
   * from any well-typed key. It exists for what the type system cannot see:
   * a `kind` string restored from a stale persisted tab list. §5.1 calls that
   * an assertion failure, and `AppErrorBoundary` is what turns it into a
   * loud, visible failure rather than a blank window.
   */
  resolve(key: DocumentKey): ResolvedDocument {
    const definition = this.definitions.get(key.kind)
    if (!definition) {
      throw new DocumentResolutionError(
        `Document registry: no dispatch for DocumentKey.kind = ${JSON.stringify((key as { kind?: unknown }).kind)}`,
      )
    }
    const props = definition.props
      ? (definition.props as (value: DocumentKey) => Record<string, unknown>)(key)
      : {}
    return { kind: definition.kind, component: definition.component, props, ...(definition.notBuilt ? { notBuilt: definition.notBuilt } : {}) }
  }
}

/** Builds a registry from the compile-time-total table. */
export function createDocumentRegistry(table: DocumentDefinitionTable): DocumentRegistry {
  return new DocumentRegistry(Object.values(table) as ReadonlyArray<AnyDocumentDefinition>)
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>(DOCUMENT_KINDS)

function validateDefinition(
  definition: AnyDocumentDefinition,
  registered: ReadonlyMap<DocumentKind, AnyDocumentDefinition>,
): void {
  if (!definition || !KNOWN_KINDS.has(definition.kind)) {
    throw new DocumentRegistrationError(
      `Unknown DocumentKey variant: ${JSON.stringify(definition?.kind ?? null)}`,
    )
  }
  if (registered.has(definition.kind)) {
    throw new DocumentRegistrationError(`Duplicate document registration: ${definition.kind}`)
  }
  if (!definition.component) {
    throw new DocumentRegistrationError(`Document registration requires a component: ${definition.kind}`)
  }
  const notBuilt = definition.notBuilt
  if (notBuilt && !(notBuilt.titleKey?.trim() && notBuilt.descriptionKey?.trim())) {
    throw new DocumentRegistrationError(
      `Not-built document requires both a title and a description key: ${definition.kind}`,
    )
  }
  // §5.1's honesty rule: an unbuilt kind explains which kind it is. Two kinds
  // sharing one message is the shared-generic-Empty defect this registry
  // replaces, so it is refused at construction rather than caught by a test.
  if (notBuilt) {
    for (const existing of registered.values()) {
      if (existing.notBuilt?.titleKey === notBuilt.titleKey) {
        throw new DocumentRegistrationError(
          `Not-built documents must not share a message: ${existing.kind} and ${definition.kind}`,
        )
      }
    }
  }
}

function requireTotal(registered: ReadonlyMap<DocumentKind, AnyDocumentDefinition>): void {
  const missing = DOCUMENT_KINDS.filter((kind) => !registered.has(kind))
  if (missing.length) {
    throw new DocumentRegistrationError(
      `Document registry is not total; unregistered DocumentKey variants: ${missing.join(', ')}`,
    )
  }
}
