/**
 * Image attachments for multimodal models — prompt markers → bytes →
 * `ImageContent[]` pipeline.
 *
 * Rendering and recognition are strictly separated:
 *   - `![[...]]` is the RENDER path (MarkdownContent.vue inlines the file for
 *     the user). This module never touches it and never reads image bytes for
 *     rendering.
 *   - Recognition is the model reading the image pixels. Two producer forms
 *     land in the prompt text, resolved identically here, only when the model
 *     declares image input:
 *       `[attached_image: path]` — written by the Composer's 📎 attach flow
 *         (or the agent itself);
 *       `@file: <path>` mentions of image files — the same token the mention
 *         system uses for text files; prompt-pipeline refuses to inline image
 *         bytes as text, so the pixels travel through this module instead.
 *
 * A text-only model never pays a read: `supportsImages=false` short-circuits
 * to `undefined` without calling `readBytes` once, and the markers stay inert
 * text the model sees as lines.
 */

import type { ImageContent } from '@earendil-works/pi-ai'

/** The marker the prompt text carries. Only this — never `![[`. */
export const ATTACHED_IMAGE_MARKER = /\[attached_image:\s*([^\]]+)\]/g

/** An `@file:` mention token (mention grammar: no spaces, forward slashes)
 * whose path looks like an image. Same tokens the text-file resolver sees —
 * `imageMimeType` decides which of these are recognition candidates. */
const MENTION_IMAGE_TOKEN = /@file:([A-Za-z0-9_./-]+)/g

/** Hard cap on a single attached image (bytes). Oversized images are skipped. */
export const MAX_ATTACHED_IMAGE_BYTES = 10 * 1024 * 1024

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

export interface AttachedImageMarker {
  path: string
  start: number
  end: number
}

/** Extract every image recognition candidate: `[attached_image: path]`
 * markers plus `@file:` mentions of image files. Pure, no I/O. A token is a
 * candidate only if it sits on a token boundary — `user@file:x.png` (an email
 * fragment) is not a mention. */
export function parseImageMarkers(message: string): AttachedImageMarker[] {
  const out: AttachedImageMarker[] = []
  ATTACHED_IMAGE_MARKER.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTACHED_IMAGE_MARKER.exec(message)) !== null) {
    out.push({
      path: match[1].trim(),
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  MENTION_IMAGE_TOKEN.lastIndex = 0
  while ((match = MENTION_IMAGE_TOKEN.exec(message)) !== null) {
    const before = match.index === 0 ? ' ' : message[match.index - 1]
    if (!/\s/.test(before)) continue
    out.push({
      path: match[1],
      start: match.index,
      end: match.index + match[0].length,
    })
  }
  return out
}

/** A Workspace-relative path the model may read: no leading `/`, no scheme,
 * no `..` segment, no drive letter, non-empty. */
export function isWorkspaceRelativePath(path: string): boolean {
  if (!path || path.trim() !== path) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false
  const segments = path.split(/[\\/]/)
  if (segments.some((seg) => seg === '..' || seg === '')) return false
  return true
}

/** Map a workspace-relative image path to its MIME type, or null for a
 * non-image/unknown file (the marker is skipped, staying inert text). */
export function imageMimeType(relPath: string): string | null {
  const name = relPath.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return IMAGE_MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null
}

export interface ResolvePromptImagesInput {
  message: string
  /** The model declares image input (`input: ['text','image']`). */
  supportsImages: boolean
  /** Read a workspace-relative file as raw bytes. Must be containment-checked
   * by the caller's bridge. Absent when the host has no workspace bridge. */
  readBytes?: (relative: string) => Promise<Uint8Array>
  /** Stat a workspace-relative file (bytes), null when unavailable. When
   * present, an oversized file is skipped BEFORE readBytes runs — a marker
   * can point at a multi-GB file, and reading it whole just to discard it at
   * the cap is exactly the unbounded read the cap exists to prevent. */
  sizeOf?: (relative: string) => Promise<number | null>
  capBytes?: number
}

/**
 * Resolve image recognition candidates (`[attached_image: ...]` markers and
 * image `@file:` mentions) in a prompt to `ImageContent[]` for a multimodal
 * model. Returns `undefined` when nothing should be injected:
 *   - text-only model (`supportsImages=false`) — no read, ever;
 *   - no markers;
 *   - every marker failed validation / read / cap (skipped, not thrown).
 * Throws only when the model supports images, markers exist, and no `readBytes`
 * was provided — a wiring error, fail loud.
 */
export async function resolvePromptImages(
  input: ResolvePromptImagesInput,
): Promise<ImageContent[] | undefined> {
  if (!input.supportsImages) return undefined

  const markers = parseImageMarkers(input.message)
  if (markers.length === 0) return undefined

  if (!input.readBytes) {
    throw new Error('image-attachment: model supports images but no readBytes was provided')
  }

  const cap = input.capBytes ?? MAX_ATTACHED_IMAGE_BYTES
  const seen = new Set<string>()
  const images: ImageContent[] = []

  for (const marker of markers) {
    if (!isWorkspaceRelativePath(marker.path)) continue
    const mimeType = imageMimeType(marker.path)
    if (!mimeType) continue
    if (seen.has(marker.path)) continue
    seen.add(marker.path)
    try {
      // Size pre-check (fstat) first: the cap must gate the READ, not just
      // the injection — otherwise an oversized file is fully loaded into
      // memory before being discarded.
      if (input.sizeOf) {
        const size = await input.sizeOf(marker.path)
        if (size !== null && size > cap) continue
      }
      const bytes = await input.readBytes(marker.path)
      if (bytes.byteLength > cap) continue
      images.push({
        type: 'image',
        data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
        mimeType,
      })
    } catch {
      // Missing / unreadable / out-of-containment image: skip it, keep the
      // marker as inert text so the model still sees the reference.
      continue
    }
  }

  return images.length > 0 ? images : undefined
}
