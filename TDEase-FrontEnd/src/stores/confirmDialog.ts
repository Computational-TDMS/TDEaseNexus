import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

/**
 * confirmDialog — imperative confirm / text-prompt / notice as a store, not a
 * chrome import.
 *
 * ZCode's confirmDialogStore shape: callers `await confirmDialog.request(...)`
 * and get a Promise; one host component (ConfirmDialogHost, mounted once in
 * AppShell) renders whatever is pending. Call sites therefore never import UI
 * chrome — stores and documents can ask for consent while staying pure
 * truth-holders (architecture.test's rule; `setRunSurfacePrompt` already
 * followed it by having AppShell inject an ElMessageBox callback — that
 * injection now wires this store instead, and component call sites migrated
 * off ElMessageBox entirely).
 *
 * Requests queue FIFO: a second ask while one is open resolves strictly after
 * the first settles, so no promise is ever orphaned (ElMessageBox instead
 * replaced the visible box and left the earlier promise pending).
 */

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive action: danger-styled confirm button, keyboard focus lands on Cancel. */
  danger?: boolean
}

export interface TextPromptOptions extends ConfirmOptions {
  initialValue?: string
  placeholder?: string
  /** Return an error message to block submit; null (or undefined) accepts. */
  validate?: (value: string) => string | null
}

export interface NoticeOptions {
  title?: string
  message: string
  okLabel?: string
}

type Pending =
  | { id: number; kind: 'confirm'; options: ConfirmOptions; settle: (ok: boolean) => void }
  | { id: number; kind: 'text'; options: TextPromptOptions; settle: (value: string | null) => void }
  | { id: number; kind: 'notice'; options: NoticeOptions; settle: () => void }

export const useConfirmDialogStore = defineStore('confirmDialog', () => {
  // The head is what the host renders; `waiting` is plain FIFO bookkeeping —
  // only the head needs to be reactive. `id` keys the host's dialog so each
  // request remounts it (autofocus and a clean draft per question).
  const pending = shallowRef<Pending | null>(null)
  const waiting: Pending[] = []
  let seq = 0

  function enqueue(next: Omit<Pending, 'id'>): void {
    waiting.push({ ...next, id: ++seq } as Pending)
    if (pending.value === null) pending.value = waiting.shift() ?? null
  }

  function request(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => enqueue({ kind: 'confirm', options, settle: resolve }))
  }

  function requestText(options: TextPromptOptions): Promise<string | null> {
    return new Promise((resolve) => enqueue({ kind: 'text', options, settle: resolve }))
  }

  function notice(options: NoticeOptions): Promise<void> {
    return new Promise((resolve) => enqueue({ kind: 'notice', options, settle: resolve }))
  }

  function showNext(): void {
    pending.value = waiting.shift() ?? null
  }

  /** Confirm button on a confirm, submit on a text prompt, OK on a notice. */
  function accept(): void {
    const head = pending.value
    if (!head) return
    if (head.kind === 'confirm') head.settle(true)
    else if (head.kind === 'notice') head.settle()
    // A text prompt never accepts through accept(): the host validates the
    // draft first and calls acceptText(value). Enter on a prompt routes there.
    else return
    showNext()
  }

  function acceptText(value: string): void {
    const head = pending.value
    if (!head || head.kind !== 'text') return
    head.settle(value)
    showNext()
  }

  /** Esc, backdrop click, or the cancel button. */
  function cancel(): void {
    const head = pending.value
    if (!head) return
    if (head.kind === 'text') head.settle(null)
    else if (head.kind === 'confirm') head.settle(false)
    else head.settle()
    showNext()
  }

  return { pending, request, requestText, notice, accept, acceptText, cancel }
})
