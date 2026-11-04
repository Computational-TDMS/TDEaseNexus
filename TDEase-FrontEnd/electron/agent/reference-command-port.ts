/**
 * Node implementation of the ReferenceCommandPort: a UniProt local-first
 * read-through store (`reference/uniprot-store.ts`) — a miss fetches the
 * official record once, saves an immutable snapshot, and projects the entry
 * for offline reuse. UniMod queries and ProFormA chemistry are not ported
 * here; the agent reaches the `tdeasenexus-toolbox` CLI directly in bash, so this
 * adapter holds no subprocess channel at all.
 *
 * `fetch` and `baseUrl` are injected so tests never touch the network
 * (mirrors how the spectra port injects its worker).
 */
import type {
  ReferenceCommandPort,
  ReferenceResult,
  UniProtGetInput,
  UniProtMapInput,
  UniProtQueryInput,
} from '../../src/studio/ports/reference-command-port'
import { createUniprotReadThrough } from './reference/uniprot-read-through'

export interface NodeReferenceCommandPortOptions {
  /** Writable per-user root (`<systemRoot>/reference`) for the UniProt store. */
  writableReferenceRoot: string
  /** Content-addressed large-result store root. */
  resultStoreRoot: string
  /** Official UniProt REST base. */
  uniprotBaseUrl: string
  /** EBI Job Dispatcher base hosting ncbiblast (UniProt BLAST). */
  blastBaseUrl?: string
  /** Contact email the Job Dispatcher requires on each BLAST submission. */
  blastContactEmail?: string
  /** Injectable fetch; defaults to the global. */
  fetch?: typeof globalThis.fetch
}

export function createNodeReferenceCommandPort(
  options: NodeReferenceCommandPortOptions,
): ReferenceCommandPort {
  const uniprot = createUniprotReadThrough({
    writableReferenceRoot: options.writableReferenceRoot,
    resultStoreRoot: options.resultStoreRoot,
    baseUrl: options.uniprotBaseUrl,
    blastBaseUrl: options.blastBaseUrl,
    blastContactEmail: options.blastContactEmail,
    fetch: options.fetch ?? globalThis.fetch,
  })

  return {
    uniprotGet(input: UniProtGetInput, signal?: AbortSignal): Promise<ReferenceResult> {
      return uniprot.get(input, signal)
    },
    uniprotQuery(input: UniProtQueryInput, signal?: AbortSignal): Promise<ReferenceResult> {
      return uniprot.query(input, signal)
    },
    uniprotMap(input: UniProtMapInput, signal?: AbortSignal): Promise<ReferenceResult> {
      return uniprot.map(input, signal)
    },
    uniprotBlast(input, signal) {
      return uniprot.blast(input, signal)
    },
    note(input) {
      return Promise.resolve(uniprot.note(input))
    },
    revise(input) {
      return Promise.resolve(uniprot.revise(input))
    },
    // Lifecycle: close the one remaining SQLite handle so WAL/SHM sidecars
    // release on Windows (the port otherwise keeps them locked and temp-dir
    // cleanup fails with EBUSY). Not part of the data-access interface;
    // callers that care about teardown (tests) use this.
    dispose() {
      uniprot.close()
    },
  } as ReferenceCommandPort & { dispose(): void }
}
