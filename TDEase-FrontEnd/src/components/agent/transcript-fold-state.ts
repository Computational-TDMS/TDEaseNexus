import { inject, reactive, type InjectionKey, type Reactive } from 'vue'

type TranscriptFoldMap = Reactive<Map<string, boolean>>
export interface TranscriptFoldState {
  get(key: string, fallback: boolean): boolean
  /**
   * `undefined` when the key was never toggled — callers use it to
   * distinguish "the user chose" from "no preference yet", which is what lets
   * ThinkingBlock default folded (live or sealed) without fighting an
   * explicit open.
   */
  peek(key: string): boolean | undefined
  set(key: string, value: boolean): void
}

export const TRANSCRIPT_FOLD_KEY: InjectionKey<TranscriptFoldMap> = Symbol('transcript-fold-state')

export function useTranscriptFoldState(): TranscriptFoldState {
  const state = inject(TRANSCRIPT_FOLD_KEY, undefined) ?? reactive(new Map<string, boolean>())
  return {
    get: (key, fallback) => state.get(key) ?? fallback,
    peek: (key) => state.get(key),
    set: (key, value) => { state.set(key, value) },
  }
}
