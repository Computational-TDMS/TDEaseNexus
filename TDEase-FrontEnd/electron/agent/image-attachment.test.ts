import { describe, expect, it, vi } from 'vitest'
import {
  imageMimeType,
  isWorkspaceRelativePath,
  parseImageMarkers,
  resolvePromptImages,
} from './image-attachment'

describe('parseImageMarkers', () => {
  it('extracts a single marker and its span', () => {
    const markers = parseImageMarkers('see [attached_image: docs/figure.png] now')
    expect(markers[0].path).toBe('docs/figure.png')
    expect(markers[0].start).toBe(4)
    expect(markers[0].end).toBe(4 + '[attached_image: docs/figure.png]'.length)
  })

  it('extracts multiple markers', () => {
    const markers = parseImageMarkers('[attached_image: a.png] and [attached_image: b/c.png]')
    expect(markers.map((m) => m.path)).toEqual(['a.png', 'b/c.png'])
  })

  it('handles paths with spaces and no space after colon', () => {
    expect(parseImageMarkers('[attached_image:my file.png]')[0].path).toBe('my file.png')
    expect(parseImageMarkers('[attached_image: x.png]')[0].path).toBe('x.png')
  })

  it('returns [] for no markers', () => {
    expect(parseImageMarkers('plain text')).toEqual([])
  })

  it('never matches an Obsidian render embed ![[...]]', () => {
    expect(parseImageMarkers('![[runs/r1/analysis/census.svg]]')).toEqual([])
  })

  it('does not match a similar-but-different marker name', () => {
    expect(parseImageMarkers('[attached_image2: x.png]')).toEqual([])
    expect(parseImageMarkers('[not_attached_image: x.png]')).toEqual([])
  })

  it('extracts an @file mention of an image as a candidate', () => {
    const markers = parseImageMarkers('see @file:docs/figure.png now')
    expect(markers[0].path).toBe('docs/figure.png')
    expect(markers[0].start).toBe(4)
    expect(markers[0].end).toBe(4 + '@file:docs/figure.png'.length)
  })

  it('extracts an @file mention at the start of the message', () => {
    expect(parseImageMarkers('@file:a.png look')[0].path).toBe('a.png')
  })

  it('does not treat an email-like fragment as an @file mention', () => {
    expect(parseImageMarkers('contact user@file:x.png today')).toEqual([])
  })

  it('collects both forms for the same file', () => {
    const markers = parseImageMarkers('[attached_image: a.png] and @file:a.png')
    expect(markers.map((m) => m.path)).toEqual(['a.png', 'a.png'])
  })

  it('ignores non-file mention tokens', () => {
    expect(parseImageMarkers('@run:r1 and @canvas:origin:c1')).toEqual([])
  })
})

describe('isWorkspaceRelativePath', () => {
  it('accepts workspace-relative paths', () => {
    for (const p of ['a.png', 'docs/a.png', '.tdease/attachments/a.png', 'a b.png', 'a/b/c.png']) {
      expect(isWorkspaceRelativePath(p), p).toBe(true)
    }
  })

  it('rejects absolute, traversal, drive, scheme, empty', () => {
    for (const p of ['', '/abs/a.png', '\\abs\\a.png', '../a.png', 'a/../../b.png', 'C:\\a.png', 'c:/a.png', 'http://x/a.png', ' ', 'a/']) {
      expect(isWorkspaceRelativePath(p), p).toBe(false)
    }
  })
})

describe('imageMimeType', () => {
  it('maps known image extensions', () => {
    expect(imageMimeType('a.png')).toBe('image/png')
    expect(imageMimeType('a.jpg')).toBe('image/jpeg')
    expect(imageMimeType('a.jpeg')).toBe('image/jpeg')
    expect(imageMimeType('a.gif')).toBe('image/gif')
    expect(imageMimeType('a.webp')).toBe('image/webp')
    expect(imageMimeType('a.bmp')).toBe('image/bmp')
  })

  it('returns null for non-images', () => {
    for (const p of ['a.txt', 'a.md', 'a.zip', 'noext', 'a.svg', 'a.html']) {
      expect(imageMimeType(p), p).toBeNull()
    }
  })
})

describe('resolvePromptImages', () => {
  it('text-only model: undefined and never reads bytes', async () => {
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const result = await resolvePromptImages({
      message: '[attached_image: a.png]',
      supportsImages: false,
      readBytes,
    })
    expect(result).toBeUndefined()
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('supports images but no markers: undefined', async () => {
    const readBytes = vi.fn(async () => new Uint8Array([1]))
    const result = await resolvePromptImages({
      message: 'no images here',
      supportsImages: true,
      readBytes,
    })
    expect(result).toBeUndefined()
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('resolves a marker to ImageContent with base64 + mime', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const result = await resolvePromptImages({
      message: '[attached_image: docs/fig.png]',
      supportsImages: true,
      readBytes: async () => bytes,
    })
    expect(result).toEqual([
      { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' },
    ])
  })

  it('deduplicates the same path', async () => {
    const readBytes = vi.fn(async () => new Uint8Array([1]))
    const result = await resolvePromptImages({
      message: '[attached_image: a.png] and [attached_image: a.png]',
      supportsImages: true,
      readBytes,
    })
    expect(result?.length).toBe(1)
    expect(readBytes).toHaveBeenCalledTimes(1)
  })

  it('skips invalid paths and non-image extensions, keeps valid ones', async () => {
    const readBytes = vi.fn(async () => new Uint8Array([1]))
    const result = await resolvePromptImages({
      message: '[attached_image: ../a.png] [attached_image: b.txt] [attached_image: c.png]',
      supportsImages: true,
      readBytes,
    })
    expect(result?.map((i) => i.mimeType)).toEqual(['image/png'])
    expect(readBytes).toHaveBeenCalledWith('c.png')
  })

  it('skips oversized images', async () => {
    const big = new Uint8Array(11 * 1024 * 1024)
    const result = await resolvePromptImages({
      message: '[attached_image: big.png]',
      supportsImages: true,
      readBytes: async () => big,
      capBytes: 10 * 1024 * 1024,
    })
    expect(result).toBeUndefined()
  })

  it('skips a read error but keeps the marker as inert text', async () => {
    const readBytes = vi.fn(async () => { throw new Error('ENOENT') })
    const result = await resolvePromptImages({
      message: '[attached_image: missing.png]',
      supportsImages: true,
      readBytes,
    })
    expect(result).toBeUndefined()
  })

  it('throws when supports images, has markers, but no readBytes', async () => {
    await expect(resolvePromptImages({
      message: '[attached_image: a.png]',
      supportsImages: true,
    })).rejects.toThrow(/readBytes/)
  })

  it('resolves an @file image mention for a vision model', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const result = await resolvePromptImages({
      message: 'please analyze @file:plots/census.png',
      supportsImages: true,
      readBytes: async () => bytes,
    })
    expect(result).toEqual([
      { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' },
    ])
  })

  it('text-only model: an @file mention never reads bytes', async () => {
    const readBytes = vi.fn(async () => new Uint8Array([1]))
    const result = await resolvePromptImages({
      message: 'please analyze @file:plots/census.png',
      supportsImages: false,
      readBytes,
    })
    expect(result).toBeUndefined()
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('an @file mention of a non-image stays inert', async () => {
    const readBytes = vi.fn(async () => new Uint8Array([1]))
    const result = await resolvePromptImages({
      message: 'see @file:notes.txt',
      supportsImages: true,
      readBytes,
    })
    expect(result).toBeUndefined()
    expect(readBytes).not.toHaveBeenCalled()
  })

  it('deduplicates across marker and mention forms', async () => {
    const readBytes = vi.fn(async () => new Uint8Array([1]))
    const result = await resolvePromptImages({
      message: '[attached_image: a.png] plus @file:a.png',
      supportsImages: true,
      readBytes,
    })
    expect(result?.length).toBe(1)
    expect(readBytes).toHaveBeenCalledTimes(1)
  })
})
