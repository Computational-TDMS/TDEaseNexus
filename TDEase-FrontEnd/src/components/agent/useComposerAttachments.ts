/**
 * useComposerAttachments — the Composer's image attach flow (📎 / drag-drop).
 *
 * The textarea stays clean: attachments live as chips (with an object-URL
 * thumbnail) and the `[attached_image: <workspace-relative path>]` markers —
 * the recognition form electron/agent/image-attachment.ts resolves to base64
 * image content for vision models — are composed into the message at send
 * time (composeMarkers). Files from outside the workspace are copied into
 * `.tdease/attachments/` (excluded from file listings and mention candidates)
 * so the marker stays a portable workspace-relative path the Node side can
 * contain and read.
 *
 * This module is text-only itself: it never decodes image bytes.
 */
import { ref } from 'vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { getViewsFS } from '@/services/workspace/views-fs'
import { getDesktopFileOps, isDesktopFileOpsAvailable } from '@/services/workspace/desktopWorkspace'

/** Where out-of-workspace images land. Must stay a top-level dot-dir: the
 * mention picker and file listings exclude those, so copies never surface as
 * workspace files in their own right. */
export const ATTACHMENTS_DIR = '.tdease/attachments'

/** Wire format shared with electron/agent/image-attachment.ts
 * (ATTACHED_IMAGE_MARKER). Pinned from both sides by tests. */
export function attachedImageMarker(relPath: string): string {
  return `[attached_image: ${relPath}]`
}

/** Recognition accepts png/jpg/gif/webp/bmp — not svg (the Node MIME map has
 * no image/svg+xml, so an svg chip would silently attach nothing). */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i

function isAttachableImage(file: File): boolean {
  return (file.type.startsWith('image/') && !/svg/i.test(file.type))
    || (!file.type && IMAGE_EXT.test(file.name))
}

export interface ComposerAttachment {
  /** Workspace-relative path the marker references. */
  relPath: string
  /** File name shown on the chip. */
  name: string
  /** Object-URL thumbnail for the chip; revoked on remove/clear. */
  previewUrl: string
}

export interface ComposerAttachmentsDeps {
  /** Workspace root (absolute), or null when unbound. Defaults to the store. */
  workspaceRoot?: () => string | null
  /** Native absolute path of a dropped/picked File. Defaults to the
   * desktop bridge; null in browser dev mode (no real file to copy). */
  getPathForFile?: (file: File) => string | null
  /** Copy absolute source paths into an absolute destination directory. */
  copyInto?: (absSrcPaths: string[], destDirAbs: string) => Promise<void>
  /** Object-URL factory (tests stub it; jsdom has no URL.createObjectURL). */
  createPreviewUrl?: (file: File) => string
  /** Object-URL revoker (tests stub it alongside createPreviewUrl). */
  revokePreviewUrl?: (url: string) => void
}

export function useComposerAttachments(deps: ComposerAttachmentsDeps = {}) {
  const store = useWorkspaceStore()

  const attachments = ref<ComposerAttachment[]>([])
  /** Non-image (or unresolvable) files ignored by the last accept, for the
   * visible hint. Reset on the next accept. */
  const rejectedCount = ref(0)
  /** True while files are dragged over the composer card. */
  const dragging = ref(false)

  const workspaceRoot = deps.workspaceRoot ?? (() => store.workspacePath || null)
  const getPathForFile = deps.getPathForFile
    ?? ((file: File) => isDesktopFileOpsAvailable() ? getDesktopFileOps().getPathForFile(file) : null)
  const copyInto = deps.copyInto ?? ((absSrcPaths, destDirAbs) => getViewsFS().copyInto(absSrcPaths, destDirAbs))
  const createPreviewUrl = deps.createPreviewUrl ?? ((file: File) => URL.createObjectURL(file))
  const revokePreviewUrl = deps.revokePreviewUrl ?? ((url: string) => URL.revokeObjectURL(url))

  function normalize(path: string): string {
    return path.replace(/\\/g, '/')
  }

  /** Windows drive paths are case-insensitive; compare normalized prefixes
   * case-insensitively so a dropped workspace file relativizes reliably. */
  function isInsideWorkspace(abs: string, root: string): boolean {
    const rootNorm = normalize(root).replace(/\/?$/, '/').toLowerCase()
    return normalize(abs).toLowerCase().startsWith(rootNorm)
  }

  function relFromAbs(abs: string, root: string): string {
    const rootNorm = normalize(root).replace(/\/?$/, '/')
    return normalize(abs).slice(rootNorm.length).replace(/^\//, '')
  }

  function joinRoot(root: string, rel: string): string {
    return `${normalize(root).replace(/\/?$/, '/')}${rel}`
  }

  function insert(file: File, relPath: string) {
    if (attachments.value.some((a) => a.relPath === relPath)) return
    attachments.value.push({ relPath, name: file.name, previewUrl: createPreviewUrl(file) })
  }

  /**
   * Accept dropped or picked files. Only attachable images become chips;
   * everything else counts into `rejectedCount`. Images inside the workspace
   * reference their existing relative path; images from outside are copied
   * into `.tdease/attachments/` first (so the marker resolves later, from
   * disk, at prompt time).
   */
  async function acceptFiles(files: File[]): Promise<void> {
    rejectedCount.value = 0
    const images = files.filter(isAttachableImage)
    rejectedCount.value += files.length - images.length
    if (images.length === 0) return

    const root = workspaceRoot()
    const outside: Array<{ file: File; abs: string }> = []
    for (const file of images) {
      const abs = getPathForFile(file)
      if (!abs) {
        // No native path (browser dev): no workspace-relative path can be
        // produced, so the marker would never resolve — treat as rejected.
        rejectedCount.value++
        continue
      }
      if (root && isInsideWorkspace(abs, root)) {
        insert(file, relFromAbs(abs, root))
      } else {
        outside.push({ file, abs })
      }
    }
    if (outside.length === 0) return
    if (!root) {
      rejectedCount.value += outside.length
      return
    }
    try {
      await copyInto(outside.map((o) => o.abs), joinRoot(root, ATTACHMENTS_DIR))
    } catch (err) {
      console.error('[useComposerAttachments] copyInto failed', err)
      rejectedCount.value += outside.length
      return
    }
    for (const { file } of outside) {
      insert(file, `${ATTACHMENTS_DIR}/${file.name}`)
    }
  }

  /** Chip ×: drop the chip (its marker never entered the text). */
  function remove(att: ComposerAttachment): void {
    attachments.value = attachments.value.filter((a) => a.relPath !== att.relPath)
    revokePreviewUrl(att.previewUrl)
  }

  /**
   * The send-time wire format: one marker per attachment, newline-separated,
   * appended to the user's text by the Composer. Empty string when nothing is
   * attached — the message goes out byte-identical to a plain one.
   */
  function composeMarkers(): string {
    return attachments.value.map((a) => attachedImageMarker(a.relPath)).join('\n')
  }

  /** Chips are per-turn: once the message (with its markers) is sent, the
   * composer starts clean. */
  function clear(): void {
    for (const att of attachments.value) revokePreviewUrl(att.previewUrl)
    attachments.value = []
    rejectedCount.value = 0
    dragging.value = false
  }

  return { attachments, rejectedCount, dragging, acceptFiles, remove, composeMarkers, clear }
}
