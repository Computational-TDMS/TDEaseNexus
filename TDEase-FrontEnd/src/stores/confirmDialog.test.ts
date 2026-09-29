import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConfirmDialogStore } from './confirmDialog'

describe('confirmDialog store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('resolves true on accept and false on cancel', async () => {
    const store = useConfirmDialogStore()

    const first = store.request({ title: 'T1' })
    store.accept()
    await expect(first).resolves.toBe(true)

    const second = store.request({ title: 'T2', danger: true })
    store.cancel()
    await expect(second).resolves.toBe(false)
  })

  it('resolves the text prompt with the draft, and null when dismissed', async () => {
    const store = useConfirmDialogStore()

    const answered = store.requestText({ title: 'Save as', initialValue: 'results/a.csv' })
    // accept() is deliberately a no-op on a text prompt: the host must hand
    // over the validated draft through acceptText.
    store.accept()
    store.acceptText('results/b.csv')
    await expect(answered).resolves.toBe('results/b.csv')

    const dismissed = store.requestText({ title: 'Save as' })
    store.cancel()
    await expect(dismissed).resolves.toBeNull()
  })

  it('queues FIFO: the next question only surfaces after the head settles', async () => {
    const store = useConfirmDialogStore()

    const first = store.request({ title: 'First' })
    const second = store.request({ title: 'Second' })

    expect(store.pending?.options.title).toBe('First')
    store.accept()
    await expect(first).resolves.toBe(true)
    expect(store.pending?.options.title).toBe('Second')

    store.cancel()
    await expect(second).resolves.toBe(false)
    expect(store.pending).toBeNull()
  })

  it('notice resolves on accept and on cancel, with no value', async () => {
    const store = useConfirmDialogStore()

    const told = store.notice({ message: 'rename failed' })
    store.accept()
    await expect(told).resolves.toBeUndefined()

    const dismissed = store.notice({ message: 'move failed' })
    store.cancel()
    await expect(dismissed).resolves.toBeUndefined()
  })

  it('accept and cancel are safe no-ops with nothing pending', () => {
    const store = useConfirmDialogStore()
    expect(() => {
      store.accept()
      store.acceptText('x')
      store.cancel()
    }).not.toThrow()
    expect(store.pending).toBeNull()
  })
})
