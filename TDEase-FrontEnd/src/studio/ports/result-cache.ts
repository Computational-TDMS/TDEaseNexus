import type { RelativePath } from '../domain/identity'
import type { ResultRef } from '../domain/result'

export type ResultAvailability = 'remote' | 'cached' | 'conflict'

export interface ResultResource {
  ref: ResultRef
  blob: Blob
  mediaType?: string
}

export interface ResultCache {
  availability(ref: ResultRef): Promise<ResultAvailability>
  open(ref: ResultRef): Promise<ResultResource>
  materialize(ref: ResultRef, destination: RelativePath): Promise<void>
  evict(ref: ResultRef): Promise<void>
}
