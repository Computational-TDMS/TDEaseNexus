import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  ATTACHMENTS_DIR,
  attachedImageMarker,
  useComposerAttachments,
  type ComposerAttachmentsDeps,
} from './useComposerAttachments'

/**
 * The attach flow's contract: the textarea stays clean (no marker text is
 * inserted anywhere), chips carry object-URL previews, and composeMarkers()
 * produces the exact wire format the Node side (image-attachment.ts) parses.
 * These tests pin the marker shape, the `.tdease/attachments/` copies, and
 * the reject accounting — not the chips UI.
 */

let issuedUrls: number

function imageFile(name = 'a.png'): File {
  return new File([new Uint8Array([1])], name, { type: 'image/png' })
}

function textFile(name = 'notes.txt'): File {
  return new File(['hello'], name, { type: 'text/plain' })
}

function setup(overrides: Partial<ComposerAttachmentsDeps> = {}) {
  const revoked: string[] = []
  const api = useComposerAttachments({
    workspaceRoot: () => 'C:/ws',
    createPreviewUrl: () => `blob:preview-${++issuedUrls}`,
    revokePreviewUrl: (url) => revoked.push(url),
    ...overrides,
  })
  return { api, revoked }
}

beforeEach(() => {
  issuedUrls = 0
  setActivePinia(createPinia())
})

describe('useComposerAttachments', () => {
  it('an in-workspace image references its existing relative path', async () => {
    const { api } = setup({ getPathForFile: () => 'C:/ws/plots/census.png' })
    await api.acceptFiles([imageFile()])
    expect(api.attachments.value.map((a) => a.relPath)).toEqual(['plots/census.png'])
    expect(api.attachments.value[0].previewUrl).toBe('blob:preview-1')
    expect(api.rejectedCount.value).toBe(0)
  })

  it('an out-of-workspace image is copied into .tdease/attachments first', async () => {
    const copyInto = vi.fn(async () => undefined)
    const { api } = setup({
      getPathForFile: () => 'C:/Users/ray/Desktop/desktop-shot.png',
      copyInto,
    })
    await api.acceptFiles([imageFile('desktop-shot.png')])
    expect(copyInto).toHaveBeenCalledWith(['C:/Users/ray/Desktop/desktop-shot.png'], `C:/ws/${ATTACHMENTS_DIR}`)
    expect(api.attachments.value.map((a) => a.relPath)).toEqual([`${ATTACHMENTS_DIR}/desktop-shot.png`])
  })

  it('non-images are rejected and become no chip', async () => {
    const { api } = setup({ getPathForFile: () => 'C:/ws/notes.txt' })
    await api.acceptFiles([textFile(), imageFile()])
    expect(api.rejectedCount.value).toBe(1)
    expect(api.attachments.value).toHaveLength(1)
  })

  it('svg is not an attachable image (the Node MIME map has no svg)', async () => {
    const { api } = setup({ getPathForFile: () => 'C:/ws/a.svg' })
    await api.acceptFiles([new File([new Uint8Array([1])], 'a.svg', { type: 'image/svg+xml' })])
    expect(api.attachments.value).toHaveLength(0)
    expect(api.rejectedCount.value).toBe(1)
  })

  it('the same file twice yields one chip', async () => {
    const { api } = setup({ getPathForFile: () => 'C:/ws/a.png' })
    await api.acceptFiles([imageFile(), imageFile()])
    expect(api.attachments.value).toHaveLength(1)
  })

  it('composeMarkers emits one newline-separated marker per chip', async () => {
    const { api } = setup({
      getPathForFile: (f) => f.name === 'a.png' ? 'C:/ws/a.png' : 'C:/Users/ray/Desktop/b.png',
      copyInto: async () => undefined,
    })
    expect(api.composeMarkers()).toBe('')
    await api.acceptFiles([imageFile(), imageFile('b.png')])
    expect(api.composeMarkers()).toBe(
      `${attachedImageMarker('a.png')}\n${attachedImageMarker(`${ATTACHMENTS_DIR}/b.png`)}`,
    )
  })

  it('remove drops the chip and revokes its preview URL', async () => {
    const { api, revoked } = setup({ getPathForFile: () => 'C:/ws/a.png' })
    await api.acceptFiles([imageFile()])
    api.remove(api.attachments.value[0])
    expect(api.attachments.value).toHaveLength(0)
    expect(revoked).toEqual(['blob:preview-1'])
  })

  it('a copy failure counts as rejected and leaves no chip', async () => {
    const { api } = setup({
      getPathForFile: () => 'C:/Users/ray/Desktop/x.png',
      copyInto: async () => { throw new Error('disk full') },
    })
    await api.acceptFiles([imageFile()])
    expect(api.attachments.value).toHaveLength(0)
    expect(api.rejectedCount.value).toBe(1)
  })

  it('no workspace root: out-of-workspace images cannot attach', async () => {
    const { api } = setup({
      workspaceRoot: () => null,
      getPathForFile: () => 'C:/Users/ray/Desktop/x.png',
    })
    await api.acceptFiles([imageFile()])
    expect(api.attachments.value).toHaveLength(0)
    expect(api.rejectedCount.value).toBe(1)
  })

  it('no native path (browser dev): the file cannot resolve later, treated as rejected', async () => {
    const { api } = setup({ getPathForFile: () => null })
    await api.acceptFiles([imageFile()])
    expect(api.attachments.value).toHaveLength(0)
    expect(api.rejectedCount.value).toBe(1)
  })

  it('clear resets chips and hints and revokes every preview URL', async () => {
    const { api, revoked } = setup({
      getPathForFile: (f) => f.name === 'a.png' ? 'C:/ws/a.png' : 'C:/Users/ray/Desktop/b.png',
      copyInto: async () => undefined,
    })
    await api.acceptFiles([imageFile(), imageFile('b.png'), textFile()])
    api.clear()
    expect(api.attachments.value).toHaveLength(0)
    expect(api.rejectedCount.value).toBe(0)
    expect(api.dragging.value).toBe(false)
    expect(revoked).toEqual(['blob:preview-1', 'blob:preview-2'])
  })
})
