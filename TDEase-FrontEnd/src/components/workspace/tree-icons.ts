/**
 * Tree icon helpers — pure SVG string builders shared by TreeNode and
 * PendingCreateNode. Kept module-local to keep the rendering components thin.
 */

import { extensionOf } from '@/services/visualization/fileTypes'

const svg = (width: number, inner: string) =>
  `<svg width="${width}" height="${width}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`

export const ICONS = {
  chevronRight: `<polyline points="9 6 15 12 9 18"/>`,
  chevronDown:  `<polyline points="6 9 12 15 18 9"/>`,
  folder:
    '<path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen:
    '<path d="M3 16.9V7.5a2 2 0 0 1 2-2h4.2l2 2H18a2 2 0 0 1 2 2v1.3"/><path d="M3.2 18.35a1.6 1.6 0 0 0 1.48 1H18.1a2 2 0 0 0 1.9-1.37l1.35-4.05A1.6 1.6 0 0 0 19.83 11H6.95a2 2 0 0 0-1.85 1.25z"/>',
  doc:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  video:'<rect x="3" y="5" width="18" height="14" rx="2"/><polygon points="10 9 15 12 10 15 10 9"/>',
  audio:'<path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 5v14"/><path d="M16 8v8"/><path d="M20 11v2"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  pdf:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  csv:  '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>',
  zip:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><rect x="8" y="12" width="8" height="4" rx="1"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  markdown: '<path d="M4 5h16v14H4z"/><path d="M7 15V9l3 3 3-3v6"/><path d="M16 9v6"/><path d="M14.5 13.5 16 15l1.5-1.5"/>',
} as const

const EXT_KIND: Record<string, string> = {
  png:'image', jpg:'image', jpeg:'image', gif:'image', webp:'image', svg:'image',
  mp4:'video', webm:'video', mov:'video',
  mp3:'audio', wav:'audio', ogg:'audio', flac:'audio',
  pdf:'pdf', docx:'doc', xlsx:'doc',
  md:'markdown', markdown:'markdown',
  js:'code', ts:'code', jsx:'code', tsx:'code', py:'code', rs:'code', go:'code',
  css:'code', html:'code', sql:'code', sh:'code', bash:'code', txt:'code', json:'code', yaml:'code', yml:'code',
  csv:'code', tsv:'code',
  // TopFD outputs: feature tables read like a spreadsheet, msalign is a
  // peak/spectrum text file. Reuse the grid/code glyphs so no new SVG is owed.
  feature:'csv',
  msalign:'code',
  zip:'zip', gz:'zip', tar:'zip',
  smk:'code', snakefile:'code',
}

export function iconSvgFor(name: string, isDir: boolean, expanded: boolean): string {
  if (isDir) return svg(14, expanded ? ICONS.folderOpen : ICONS.folder)
  const ext = extensionOf(name)
  switch (EXT_KIND[ext]) {
    case 'image': return svg(14, ICONS.image)
    case 'video': return svg(14, ICONS.video)
    case 'audio': return svg(14, ICONS.audio)
    case 'pdf':   return svg(14, ICONS.pdf)
    case 'markdown': return svg(14, ICONS.markdown)
    case 'code':  return svg(14, ICONS.code)
    case 'doc':   return svg(14, ICONS.doc)
    case 'zip':   return svg(14, ICONS.zip)
    case 'csv':   return svg(14, ICONS.csv)
    default:      return svg(14, ICONS.file)
  }
}

export function disclosureSvgFor(isDir: boolean, expanded: boolean): string {
  if (!isDir) return ''
  return svg(12, expanded ? ICONS.chevronDown : ICONS.chevronRight)
}
