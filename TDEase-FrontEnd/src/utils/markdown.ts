/**
 * Markdown renderer — markdown-it + KaTeX + task-lists + mermaid +
 * Obsidian callouts/highlights/footnotes + heading anchors + table
 * scroll wrapper + image renderer.
 *
 * Configured with html:true (raw HTML renders, scrubbed by the allowlist
 * sanitizer at the single render exit), breaks:true, linkify:true,
 * typographer:true. renderMarkdown = render → sanitize → toolbar injection;
 * every surface that shows model output goes through it.
 *
 * Workspace file references are syntax-agnostic: `![[path]]`, `[[path]]`,
 * `![](path)`, `[](path)` and the agent attachment marker `[attached_image:
 * path]` all present the file by its TYPE — visual assets (images/SVG/html)
 * embed inline as the ONE unified viz frame (lazy blob hydration; full
 * width, auto-fitting height — html via sandboxed interactive iframe with
 * reported height, image/svg via natural-height img), data files and
 * unknown extensions as cards. The system prompt teaches none of the
 * syntax details; it only says "cite the file".
 */

import markdownit from 'markdown-it';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type Token from 'markdown-it/lib/token.mjs';
import taskLists from 'markdown-it-task-lists';
import { renderCodeBlockToolbarHtml } from './code-block-toolbar';
import { sanitizeMarkdownPreviewHtml } from './markdown-html-sanitizer';
import { parseWikiLinkInner } from '@/services/wiki/wikilinks';
import {
  extensionOf,
  HTML_EXTENSIONS,
  TABLE_EXTENSIONS,
  TEXT_EXTENSIONS,
} from '@/services/visualization/fileTypes';

type MarkdownItInstance = ReturnType<typeof markdownit>;
type MarkdownRenderEnv = {
  footnoteIdPrefix?: string;
  footnotes?: FootnoteState;
};

let _md: MarkdownItInstance | null = null;

// ── Constants ────────────────────────────────────────────────────────────────

const INLINE_MATH_OPEN = '\\(';
const INLINE_MATH_CLOSE = '\\)';
const BLOCK_MATH_OPEN = '\\[';
const BLOCK_MATH_CLOSE = '\\]';
const CALLOUT_MARKER_RE = /^\s*\[!([A-Za-z][A-Za-z0-9_-]*)\]([+-])?(?:[ \t]+(.+?))?\s*$/;
const IMAGE_SIZE_RE = /^([1-9]\d{0,4})(?:x([1-9]\d{0,4}))?$/i;
const FOOTNOTE_DEF_MARKER_RE = /^\[\^([^\]\n]+)]:[ \t]*/;
const AUTO_LINK_SUFFIX_BOUNDARY_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\ufeff',
  '。', '、', '，', '；', '：', '！', '？',
  '）', '】', '］', '｝', '》', '〉', '」', '』', '〕', '〗',
]);

const CALLOUT_ALIASES: Record<string, string> = {
  note: 'note', abstract: 'abstract', summary: 'abstract', tldr: 'abstract',
  info: 'info', todo: 'todo',
  tip: 'tip', hint: 'tip', important: 'tip',
  success: 'success', check: 'success', done: 'success',
  question: 'question', help: 'question', faq: 'question',
  warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'failure', fail: 'failure', missing: 'failure',
  danger: 'danger', error: 'danger',
  bug: 'bug', example: 'example',
  quote: 'quote', cite: 'quote',
};

// ── Heading slug ─────────────────────────────────────────────────────────────

function slugifyMarkdownHeading(text: string): string {
  const slug = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'section';
}

function uniqueMarkdownHeadingId(text: string, seen: Map<string, number>): string {
  const base = slugifyMarkdownHeading(text);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function hashStringBase36(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function footnoteIdPrefixForSource(src: string): string {
  return `hana-fn-${hashStringBase36(src)}`;
}

// ── Footnote state ───────────────────────────────────────────────────────────

interface FootnoteDefinition { label: string; content: string }
interface FootnoteReference {
  label: string;
  number: number;
  footnoteId: string;
  refIds: string[];
}
interface FootnoteState {
  prefix: string;
  definitions: Map<string, FootnoteDefinition>;
  references: FootnoteReference[];
  referenceByLabel: Map<string, FootnoteReference>;
  renderingDefinitions: boolean;
}

function normalizeFootnoteLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function ensureFootnoteState(env: MarkdownRenderEnv, src: string): FootnoteState {
  if (!env.footnotes) {
    env.footnotes = {
      prefix: env.footnoteIdPrefix || footnoteIdPrefixForSource(src),
      definitions: new Map(),
      references: [],
      referenceByLabel: new Map(),
      renderingDefinitions: false,
    };
  }
  return env.footnotes;
}

// ── Image label parsing ──────────────────────────────────────────────────────

export interface ImageDimensions { width?: string; height?: string }
export interface ImageLabel { alt: string; dimensions: ImageDimensions | null }

export function parseImageDimensions(raw: string): ImageDimensions | null {
  const match = IMAGE_SIZE_RE.exec(raw.trim());
  if (!match) return null;
  return { width: match[1], ...(match[2] ? { height: match[2] } : {}) };
}

function isEscaped(src: string, pos: number): boolean {
  let count = 0;
  for (let i = pos - 1; i >= 0 && src.charCodeAt(i) === 0x5C; i -= 1) count += 1;
  return count % 2 === 1;
}

function findUnescapedDelimiter(src: string, delimiter: string, from: number, to: number): number {
  let pos = src.indexOf(delimiter, from);
  while (pos >= 0 && pos < to) {
    if (!isEscaped(src, pos)) return pos;
    pos = src.indexOf(delimiter, pos + delimiter.length);
  }
  return -1;
}

function findLineEndingDelimiter(line: string, delimiter: string): number {
  let from = 0;
  while (from < line.length) {
    const pos = findUnescapedDelimiter(line, delimiter, from, line.length);
    if (pos < 0) return -1;
    if (line.slice(pos + delimiter.length).trim() === '') return pos;
    from = pos + delimiter.length;
  }
  return -1;
}

function splitUnescapedPipe(value: string): [string, string] | null {
  for (let i = value.length - 1; i >= 0; i -= 1) {
    if (value[i] === '|' && !isEscaped(value, i)) {
      return [value.slice(0, i), value.slice(i + 1)];
    }
  }
  return null;
}

export function parseImageLabel(raw: string): ImageLabel {
  const trimmed = raw.trim();
  const pureSize = parseImageDimensions(trimmed);
  if (pureSize) return { alt: '', dimensions: pureSize };
  const split = splitUnescapedPipe(raw);
  if (!split) return { alt: raw, dimensions: null };
  const [alt, maybeSize] = split;
  const dimensions = parseImageDimensions(maybeSize);
  if (!dimensions) return { alt: raw, dimensions: null };
  return { alt: alt.trim(), dimensions };
}

function basenamePortable(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

// ── Plugin: Obsidian media embeds `![[...]]` ─────────────────────────────────
//
// `![[target]]` embeds a Workspace file, presented by its type (see
// `presentInlineHtml`): images/SVG inline, html/data files as cards, anything
// else as a generic file card. There is deliberately no extension allowlist —
// every embed form resolves to *something* clickable, never literal text.

const IMAGE_EMBED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']

function splitObsidianEmbedTarget(raw: string): { target: string; label: string | null } {
  const split = splitUnescapedPipe(raw);
  if (!split) return { target: raw.trim(), label: null };
  return { target: split[0].trim(), label: split[1].trim() };
}

function stripObsidianFragment(raw: string): string {
  const hash = raw.indexOf('#');
  return (hash >= 0 ? raw.slice(0, hash) : raw).trim();
}

function parseObsidianEmbedTarget(rawInner: string): { src: string; alt: string } | null {
  const { target, label } = splitObsidianEmbedTarget(rawInner);
  const mediaTarget = stripObsidianFragment(target);
  if (!mediaTarget) return null;
  return { src: mediaTarget, alt: label || basenamePortable(mediaTarget) };
}

function obsidianImageEmbeds(md: MarkdownItInstance): void {
  md.inline.ruler.before('image', 'obsidian_image_embed', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + 3) !== '![[') return false;
    const close = findUnescapedDelimiter(state.src, ']]', start + 3, state.posMax);
    if (close < 0) return false;
    const parsed = parseObsidianEmbedTarget(state.src.slice(start + 3, close));
    if (!parsed) return false;
    if (!silent) {
      const token = state.push('workspace_embed', '', 0);
      token.attrs = [['src', parsed.src]];
      token.content = parsed.alt;
      token.markup = '![[]]';
    }
    state.pos = close + 2;
    return true;
  });
}

// ── Plugin: agent attachment markers `[attached_image: path]` ────────────────
//
// The recognition marker the Composer's attach flow composes into a sent
// message (image-attachment.ts resolves it to model-visible pixels) renders
// in the transcript as the same workspace embed the user-facing syntaxes get:
// the user sees the image they sent, not the wire format. A bare bracket that
// is not a valid link never reaches the link rule, so a plain
// before('image') registration is enough.

const ATTACHED_IMAGE_PREFIX = '[attached_image:';

function attachedImageMarkerEmbeds(md: MarkdownItInstance): void {
  md.inline.ruler.before('image', 'attached_image_embed', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + ATTACHED_IMAGE_PREFIX.length) !== ATTACHED_IMAGE_PREFIX) return false;
    const close = findUnescapedDelimiter(state.src, ']', start + ATTACHED_IMAGE_PREFIX.length, state.posMax);
    if (close < 0) return false;
    const target = state.src.slice(start + ATTACHED_IMAGE_PREFIX.length, close).trim();
    if (!target) return false;
    if (!silent) {
      const token = state.push('workspace_embed', '', 0);
      token.attrs = [['src', target]];
      token.content = basenamePortable(target);
      token.markup = '[attached_image:]';
    }
    state.pos = close + 1;
    return true;
  });
}

/**
 * The single presentation router for a Workspace file reference written as an
 * EMBED (`![](path)`, `![[path]]`, or `[[path]]` on a media/data file): the
 * file type decides the surface, not the syntax. Visual assets — images/SVG
 * and html — embed inline as the ONE unified viz frame (a chrome-carrying
 * fixed-height box MarkdownContent hydrates lazily: html → sandboxed
 * interactive iframe, image/svg → img with lightbox); data files
 * (table/json/text) and unknown extensions render as cards the user opens on
 * click.
 */
function presentInlineHtml(md: MarkdownItInstance, src: string, label: string): string {
  const ext = extensionOf(src)
  if (IMAGE_EMBED_EXTENSIONS.includes(ext)) {
    return mediaFrameHtml(md, src, label, ext === 'svg' ? 'svg' : 'image')
  }
  if (HTML_EXTENSIONS.has(ext)) {
    return mediaFrameHtml(md, src, label, 'html')
  }
  const dataKind = workspaceDataKindOf(src)
  if (dataKind) {
    return dataFileCardHtml(md, src, label, dataKind)
  }
  return dataFileCardHtml(md, src, label, 'file')
}

/** Renderer for the shared `workspace_embed` token. A Workspace-relative src
 * presents by file type; a browser-loadable absolute URL renders as a plain
 * image (known image extension) or a plain anchor — no iframes in the
 * sanitized pipeline. */
function markdownEmbedRenderer(md: MarkdownItInstance): void {
  md.renderer.rules.workspace_embed = (tokens, idx) => {
    const src = tokens[idx].attrGet('src') ?? '';
    const alt = tokens[idx].content;
    if (isWorkspaceRelativeSrc(src)) {
      return presentInlineHtml(md, src, alt)
    }
    const safeSrc = md.utils.escapeHtml(src)
    const safeAlt = md.utils.escapeHtml(alt || src)
    if (IMAGE_EMBED_EXTENSIONS.includes(extensionOf(src))) {
      return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async" />`
    }
    return `<a href="${safeSrc}">${safeAlt}</a>`
  };
}

// ── Plugin: wiki double links `[[...]]` ──────────────────────────────────────
//
// `[[target]]`, `[[target|label]]`, `[[target#heading]]` — the Obsidian link
// syntax. A page target renders as an inert anchor carrying the raw target in
// `data-wikilink-target`; a media/data/html file target embeds inline, the way
// Obsidian displays `[[figure.png]]` (grammar rules live in
// services/wiki/wikilinks.ts; resolution of page links is the wiki document's
// job on click — the renderer stays scope-blind).

/** Whether a wikilink target names a file that embeds by type (anything but a
 *  wiki page): every known media/html/data extension embeds; bare page names
 *  and .md/.txt stay links. */
function wikiTargetEmbeds(target: string): boolean {
  if (!isWorkspaceRelativeSrc(target)) return false
  const ext = extensionOf(target)
  if (ext === 'md' || ext === 'txt' || ext === target) return false
  if (IMAGE_EMBED_EXTENSIONS.includes(ext) || HTML_EXTENSIONS.has(ext)) return true
  return workspaceDataKindOf(target) !== null
}

function wikiLinks(md: MarkdownItInstance): void {
  md.inline.ruler.before('link', 'wiki_link', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + 2) !== '[[') return false;
    const close = findUnescapedDelimiter(state.src, ']]', start + 2, state.posMax);
    if (close < 0) return false;
    const inner = state.src.slice(start + 2, close);
    if (inner.includes('\n')) return false;
    const parts = parseWikiLinkInner(inner);
    if (!parts) return false;
    if (!silent) {
      const embedSrc = stripObsidianFragment(parts.target);
      if (wikiTargetEmbeds(embedSrc)) {
        const token = state.push('workspace_embed', '', 0);
        token.attrs = [['src', embedSrc]];
        token.content = parts.label === parts.target ? basenamePortable(embedSrc) : parts.label;
        token.markup = '[[]]';
      } else {
        const token = state.push('wikilink', '', 0);
        token.content = parts.label;
        token.attrs = [['target', parts.target]];
        if (parts.heading) token.attrSet('heading', parts.heading);
        token.markup = '[[]]';
      }
    }
    state.pos = close + 2;
    return true;
  });
  md.renderer.rules.wikilink = (tokens, idx) => {
    const token = tokens[idx];
    const target = token.attrGet('target') ?? '';
    const heading = token.attrGet('heading') ?? '';
    const label = token.content || target;
    return `<a class="wikilink" href="#" data-wikilink-target="${md.utils.escapeHtml(target)}"` +
      `${heading ? ` data-wikilink-heading="${md.utils.escapeHtml(heading)}"` : ''}>${md.utils.escapeHtml(label)}</a>`;
  };
}

// ── Plugin: Obsidian callouts ────────────────────────────────────────────────

function normalizeCalloutType(type: string): string {
  return CALLOUT_ALIASES[type.toLowerCase()] || 'note';
}

function titleCaseCalloutType(type: string): string {
  return type.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function findMatchingBlockquoteClose(tokens: Token[], openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i += 1) {
    if (tokens[i].type === 'blockquote_open') depth += 1;
    if (tokens[i].type === 'blockquote_close') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findFirstDirectParagraph(tokens: Token[], openIndex: number, closeIndex: number): number {
  const parentLevel = tokens[openIndex].level;
  for (let i = openIndex + 1; i < closeIndex; i += 1) {
    const token = tokens[i];
    if (token.level !== parentLevel + 1) continue;
    if (token.type === 'paragraph_open') return i;
    if (!token.hidden) return -1;
  }
  return -1;
}

function makeCalloutTitleTokens(state: StateCore, title: string, foldable: boolean, level: number): Token[] {
  const open = new state.Token(
    foldable ? 'callout_summary_open' : 'callout_title_open',
    foldable ? 'summary' : 'div',
    1,
  );
  open.attrSet('class', 'markdown-callout-title');
  open.level = level;
  const inline = new state.Token('inline', '', 0);
  inline.content = title;
  inline.children = [];
  inline.level = level + 1;
  const close = new state.Token(
    foldable ? 'callout_summary_close' : 'callout_title_close',
    foldable ? 'summary' : 'div',
    -1,
  );
  close.level = level;
  return [open, inline, close];
}

function obsidianCallouts(md: MarkdownItInstance): void {
  md.core.ruler.after('block', 'obsidian_callouts', (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      const open = tokens[i];
      if (open.type !== 'blockquote_open') continue;
      const closeIndex = findMatchingBlockquoteClose(tokens, i);
      if (closeIndex < 0) continue;
      const paragraphIndex = findFirstDirectParagraph(tokens, i, closeIndex);
      const inlineIndex = paragraphIndex + 1;
      if (
        paragraphIndex < 0
        || tokens[paragraphIndex]?.type !== 'paragraph_open'
        || tokens[inlineIndex]?.type !== 'inline'
        || tokens[paragraphIndex + 2]?.type !== 'paragraph_close'
      ) {
        continue;
      }
      const inline = tokens[inlineIndex];
      const lineEnd = inline.content.indexOf('\n');
      const firstLine = lineEnd >= 0 ? inline.content.slice(0, lineEnd) : inline.content;
      const match = CALLOUT_MARKER_RE.exec(firstLine);
      if (!match) continue;
      const sourceType = match[1];
      const canonicalType = normalizeCalloutType(sourceType);
      const foldMarker = match[2] || '';
      const foldable = foldMarker === '+' || foldMarker === '-';
      const title = (match[3]?.trim() || titleCaseCalloutType(sourceType));
      open.tag = foldable ? 'details' : 'div';
      open.attrSet('class', `markdown-callout markdown-callout-${canonicalType}`);
      if (foldable && foldMarker === '+') open.attrSet('open', 'open');
      const close = tokens[closeIndex];
      close.tag = foldable ? 'details' : 'div';
      tokens.splice(i + 1, 0, ...makeCalloutTitleTokens(state, title, foldable, open.level + 1));
      if (lineEnd >= 0) {
        inline.content = inline.content.slice(lineEnd + 1);
      } else {
        tokens.splice(paragraphIndex + 3, 3);
      }
    }
  });
}

// ── Plugin: autolink suffix trimming + local-file autolink unwrap ────────────

function splitAutoLinkSuffix(text: string): { linkText: string; suffix: string } | null {
  for (let index = 0; index < text.length; index += 1) {
    if (!AUTO_LINK_SUFFIX_BOUNDARY_CHARS.has(text[index])) continue;
    return { linkText: text.slice(0, index), suffix: text.slice(index) };
  }
  return null;
}

function stripHrefSuffix(href: string, suffix: string): string {
  for (const candidate of [encodeURI(suffix), encodeURIComponent(suffix), suffix]) {
    if (!candidate) continue;
    if (href.toLowerCase().endsWith(candidate.toLowerCase())) {
      return href.slice(0, href.length - candidate.length);
    }
  }
  return href;
}

function isAutoLinkifyToken(token: Token | undefined, type: 'link_open' | 'link_close'): boolean {
  return token?.type === type && token.markup === 'linkify' && token.info === 'auto';
}

function trimAutoLinkifiedSuffixes(md: MarkdownItInstance): void {
  md.core.ruler.after('linkify', 'trim_auto_linkified_suffixes', (state: StateCore) => {
    for (const blockToken of state.tokens) {
      const children = blockToken.children;
      if (!children?.length) continue;
      for (let index = 0; index < children.length - 2; index += 1) {
        const open = children[index];
        const text = children[index + 1];
        const close = children[index + 2];
        if (!isAutoLinkifyToken(open, 'link_open') || text?.type !== 'text' || !isAutoLinkifyToken(close, 'link_close')) continue;
        const split = splitAutoLinkSuffix(text.content);
        if (!split || !split.linkText) continue;
        text.content = split.linkText;
        const href = open.attrGet('href');
        if (href) open.attrSet('href', stripHrefSuffix(href, split.suffix));
        const next = children[index + 3];
        if (next?.type === 'text') {
          next.content = `${split.suffix}${next.content}`;
        } else {
          const suffixToken = new state.Token('text', '', 0);
          suffixToken.content = split.suffix;
          children.splice(index + 3, 0, suffixToken);
        }
        index += 2;
      }
    }
  });
}

// ── Plugin: Obsidian highlights `==...==` ────────────────────────────────────

function tokenizeInner(state: StateInline, from: number, to: number): void {
  const oldPos = state.pos;
  const oldMax = state.posMax;
  state.pos = from;
  state.posMax = to;
  state.md.inline.tokenize(state);
  state.pos = oldPos;
  state.posMax = oldMax;
}

function obsidianHighlights(md: MarkdownItInstance): void {
  md.inline.ruler.before('emphasis', 'obsidian_mark', (state, silent) => {
    const start = state.pos;
    if (state.src.slice(start, start + 2) !== '==') return false;
    const end = state.src.indexOf('==', start + 2);
    if (end < 0 || end === start + 2) return false;
    if (!silent) {
      state.push('mark_open', 'mark', 1);
      tokenizeInner(state, start + 2, end);
      state.push('mark_close', 'mark', -1);
    }
    state.pos = end + 2;
    return true;
  });
}

// ── Plugin: TeX bracket math `\(\)` / `\[\]` ─────────────────────────────────

function texBracketMath(md: MarkdownItInstance): void {
  md.inline.ruler.before('escape', 'tex_parenthesis_math', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + INLINE_MATH_OPEN.length) !== INLINE_MATH_OPEN) return false;
    const contentStart = start + INLINE_MATH_OPEN.length;
    const close = findUnescapedDelimiter(state.src, INLINE_MATH_CLOSE, contentStart, state.posMax);
    if (close < 0 || close === contentStart) return false;
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.markup = INLINE_MATH_OPEN;
      token.content = state.src.slice(contentStart, close);
    }
    state.pos = close + INLINE_MATH_CLOSE.length;
    return true;
  });

  md.block.ruler.before('paragraph', 'tex_bracket_math_block', (
    state: StateBlock,
    startLine: number,
    endLine: number,
    silent: boolean,
  ) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (start + BLOCK_MATH_OPEN.length > max) return false;
    if (state.src.slice(start, start + BLOCK_MATH_OPEN.length) !== BLOCK_MATH_OPEN) return false;

    let nextLine = startLine;
    const firstLine = state.src.slice(start + BLOCK_MATH_OPEN.length, max);
    const firstLineClose = findLineEndingDelimiter(firstLine, BLOCK_MATH_CLOSE);
    let content: string;

    if (firstLineClose >= 0) {
      content = firstLine.slice(0, firstLineClose);
    } else {
      let found = false;
      let lastLine = '';
      for (nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const lineMax = state.eMarks[nextLine];
        if (lineStart < lineMax && state.tShift[nextLine] < state.blkIndent) break;
        const line = state.src.slice(lineStart, lineMax);
        const close = findLineEndingDelimiter(line, BLOCK_MATH_CLOSE);
        if (close >= 0) {
          lastLine = line.slice(0, close);
          found = true;
          break;
        }
      }
      if (!found) return false;
      content = (firstLine.trim() ? `${firstLine}\n` : '')
        + state.getLines(startLine + 1, nextLine, state.tShift[startLine], true)
        + (lastLine.trim() ? lastLine : '');
    }

    if (!content.trim()) return false;
    if (silent) return true;
    state.line = nextLine + 1;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = content;
    token.map = [startLine, state.line];
    token.markup = `${BLOCK_MATH_OPEN}${BLOCK_MATH_CLOSE}`;
    return true;
  });
}

// ── Plugin: Math shells (lazy KaTeX) ─────────────────────────────────────────
//
// Detects `$...$` (inline) and `$$...$$` (block) delimiters and pushes the same
// `math_inline` / `math_block` tokens texBracketMath uses for `\(...\)` / `\[...\]`.
// The render rules below turn either token into an inert placeholder that
// katex-renderer.ts hydrates on first paint — so KaTeX (~280KB JS + ~300KB CSS)
// never enters the entry chunk and only loads when a message actually contains math.

const DOLLAR_INLINE_OPEN = '$';
const DOLLAR_INLINE_CLOSE = '$';
const DOLLAR_BLOCK_DELIM = '$$';

function latexShellMath(md: MarkdownItInstance): void {
  md.inline.ruler.before('escape', 'latex_dollar_inline', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x24 /* $ */) return false;
    const contentStart = start + DOLLAR_INLINE_OPEN.length;
    const close = findUnescapedDelimiter(state.src, DOLLAR_INLINE_CLOSE, contentStart, state.posMax);
    if (close < 0 || close === contentStart) return false;
    // Reject `$$` here — the block rule below (and adjacent-$$) owns display math.
    if (state.src.charCodeAt(close + 1) === 0x24 /* $ */) return false;
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.markup = DOLLAR_INLINE_OPEN;
      token.content = state.src.slice(contentStart, close);
    }
    state.pos = close + DOLLAR_INLINE_CLOSE.length;
    return true;
  });

  md.block.ruler.before('paragraph', 'latex_dollar_block', (
    state: StateBlock,
    startLine: number,
    endLine: number,
    silent: boolean,
  ) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (start + DOLLAR_BLOCK_DELIM.length > max) return false;
    if (state.src.slice(start, start + DOLLAR_BLOCK_DELIM.length) !== DOLLAR_BLOCK_DELIM) return false;

    const contentStart = start + DOLLAR_BLOCK_DELIM.length;
    const firstLine = state.src.slice(contentStart, max);
    const firstLineClose = findLineEndingDelimiter(firstLine, DOLLAR_BLOCK_DELIM);
    let content: string;
    let nextLine = startLine;

    if (firstLineClose >= 0) {
      content = firstLine.slice(0, firstLineClose);
    } else {
      let found = false;
      let lastLine = '';
      for (nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const lineMax = state.eMarks[nextLine];
        if (lineStart < lineMax && state.tShift[nextLine] < state.blkIndent) break;
        const line = state.src.slice(lineStart, lineMax);
        const close = findLineEndingDelimiter(line, DOLLAR_BLOCK_DELIM);
        if (close >= 0) {
          lastLine = line.slice(0, close);
          found = true;
          break;
        }
      }
      if (!found) return false;
      content = (firstLine.trim() ? `${firstLine}\n` : '')
        + state.getLines(startLine + 1, nextLine, state.tShift[startLine], true)
        + (lastLine.trim() ? lastLine : '');
    }

    if (!content.trim()) return false;
    if (silent) return true;
    state.line = nextLine + 1;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = content;
    token.map = [startLine, state.line];
    token.markup = DOLLAR_BLOCK_DELIM;
    return true;
  });

  // Render rules: emit a placeholder shell for BOTH inline and block math,
  // whether the token came from the $ / $$ rules above or texBracketMath.
  md.renderer.rules.math_inline = (tokens, idx) => mathShellHtml(tokens[idx].content, false);
  md.renderer.rules.math_block = (tokens, idx) => `${mathShellHtml(tokens[idx].content, true)}\n`;
}

function mathShellHtml(formula: string, display: boolean): string {
  const escaped = mdEscapeHtml(formula);
  const mode = display ? 'block' : 'inline';
  return `<span class="katex-shell katex-shell--${mode}" data-formula="${escaped}" data-display="${display}">${escaped}</span>`;
}

// Minimal HTML escaper scoped to formula text placed in an attribute. The full
// markdown-it escape map is overkill here; we cover the five characters that
// can break out of the attribute value or the visible fallback text.
function mdEscapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Plugin: Footnotes ────────────────────────────────────────────────────────

function firstNonSpaceLineContent(state: StateBlock, line: number): string {
  const start = state.bMarks[line] + state.tShift[line];
  const max = state.eMarks[line];
  return state.src.slice(start, max);
}

function isFootnoteContinuationLine(state: StateBlock, line: number): boolean {
  return state.sCount[line] - state.blkIndent >= 4;
}

function collectFootnoteDefinitionContent(
  state: StateBlock,
  startLine: number,
  firstLineContent: string,
): { content: string; nextLine: number } {
  const lines = [firstLineContent];
  let nextLine = startLine + 1;
  while (nextLine < state.lineMax) {
    if (state.isEmpty(nextLine)) {
      const followingLine = state.skipEmptyLines(nextLine);
      if (followingLine < state.lineMax && isFootnoteContinuationLine(state, followingLine)) {
        lines.push('');
        nextLine += 1;
        continue;
      }
      break;
    }
    if (!isFootnoteContinuationLine(state, nextLine)) break;
    lines.push(state.getLines(nextLine, nextLine + 1, state.blkIndent + 4, false).replace(/\n$/, ''));
    nextLine += 1;
  }
  return { content: lines.join('\n').trimEnd(), nextLine };
}

function footnoteDefinitions(md: MarkdownItInstance): void {
  md.block.ruler.before('reference', 'hana_footnote_definitions', (
    state: StateBlock,
    startLine: number,
    _endLine: number,
    silent: boolean,
  ) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const line = firstNonSpaceLineContent(state, startLine);
    const match = FOOTNOTE_DEF_MARKER_RE.exec(line);
    if (!match) return false;
    const label = normalizeFootnoteLabel(match[1]);
    if (!label) return false;
    if (silent) return true;
    const markdownEnv = state.env as MarkdownRenderEnv;
    const footnotes = ensureFootnoteState(markdownEnv, state.src);
    const { content, nextLine } = collectFootnoteDefinitionContent(state, startLine, line.slice(match[0].length));
    if (!footnotes.definitions.has(label)) {
      footnotes.definitions.set(label, { label, content });
    }
    state.line = nextLine;
    return true;
  }, { alt: ['paragraph', 'reference'] });
}

function recordFootnoteReference(footnotes: FootnoteState, label: string): {
  number: number; footnoteId: string; refId: string;
} {
  let reference = footnotes.referenceByLabel.get(label);
  if (!reference) {
    const number = footnotes.references.length + 1;
    reference = { label, number, footnoteId: `fn-${footnotes.prefix}-${number}`, refIds: [] };
    footnotes.referenceByLabel.set(label, reference);
    footnotes.references.push(reference);
  }
  const refNumber = reference.refIds.length + 1;
  const refId = refNumber === 1
    ? `fnref-${footnotes.prefix}-${reference.number}`
    : `fnref-${footnotes.prefix}-${reference.number}-${refNumber}`;
  reference.refIds.push(refId);
  return { number: reference.number, footnoteId: reference.footnoteId, refId };
}

function footnoteReferences(md: MarkdownItInstance): void {
  md.inline.ruler.before('link', 'hana_footnote_refs', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    if (state.src.slice(start, start + 2) !== '[^') return false;
    const close = findUnescapedDelimiter(state.src, ']', start + 2, state.posMax);
    if (close < 0) return false;
    const label = normalizeFootnoteLabel(state.src.slice(start + 2, close));
    if (!label) return false;
    const markdownEnv = state.env as MarkdownRenderEnv;
    const footnotes = ensureFootnoteState(markdownEnv, state.src);
    if (footnotes.renderingDefinitions || !footnotes.definitions.has(label)) return false;
    if (silent) return true;
    const ref = recordFootnoteReference(footnotes, label);
    const token = state.push('footnote_ref', '', 0);
    token.meta = ref;
    state.pos = close + 1;
    return true;
  });
}

function textToken(state: StateCore, content: string): Token {
  const token = new state.Token('text', '', 0);
  token.content = content;
  return token;
}

function backrefToken(state: StateCore, refId: string, index: number): Token {
  const token = new state.Token('footnote_backref', '', 0);
  token.meta = { refId, index };
  return token;
}

function appendFootnoteBackrefs(state: StateCore, inlineToken: Token, refIds: string[]): void {
  if (!inlineToken.children) inlineToken.children = [];
  if (inlineToken.children.length > 0) {
    inlineToken.children.push(textToken(state, ' '));
  }
  refIds.forEach((refId, index) => {
    if (index > 0) inlineToken.children?.push(textToken(state, ' '));
    inlineToken.children?.push(backrefToken(state, refId, index + 1));
  });
}

function appendFootnoteList(md: MarkdownItInstance): void {
  md.core.ruler.after('inline', 'hana_footnote_tail', (state: StateCore) => {
    const markdownEnv = state.env as MarkdownRenderEnv;
    const footnotes = markdownEnv.footnotes;
    if (!footnotes || footnotes.references.length === 0) return;
    const makeToken = (type: string, tag: string, nesting: -1 | 0 | 1, level: number): Token => {
      const token = new state.Token(type, tag, nesting);
      token.block = true;
      token.level = level;
      return token;
    };
    const sectionOpen = makeToken('footnote_block_open', 'section', 1, 0);
    sectionOpen.attrSet('class', 'footnotes');
    sectionOpen.attrSet('role', 'doc-endnotes');
    state.tokens.push(sectionOpen);
    state.tokens.push(makeToken('hr', 'hr', 0, 1));
    state.tokens.push(makeToken('ordered_list_open', 'ol', 1, 1));
    for (const reference of footnotes.references.slice()) {
      const definition = footnotes.definitions.get(reference.label);
      if (!definition) continue;
      const itemOpen = makeToken('list_item_open', 'li', 1, 2);
      itemOpen.attrSet('id', reference.footnoteId);
      state.tokens.push(itemOpen);
      const inline = makeToken('inline', '', 0, 3);
      inline.content = definition.content;
      inline.children = [];
      footnotes.renderingDefinitions = true;
      try {
        state.md.inline.parse(inline.content, state.md, state.env, inline.children);
      } finally {
        footnotes.renderingDefinitions = false;
      }
      appendFootnoteBackrefs(state, inline, reference.refIds);
      state.tokens.push(inline);
      state.tokens.push(makeToken('list_item_close', 'li', -1, 2));
    }
    state.tokens.push(makeToken('ordered_list_close', 'ol', -1, 1));
    state.tokens.push(makeToken('footnote_block_close', 'section', -1, 0));
  });
}

function footnoteRenderers(md: MarkdownItInstance): void {
  md.renderer.rules.footnote_ref = (tokens, idx) => {
    const meta = tokens[idx].meta as { number: number; footnoteId: string; refId: string };
    return `<sup class="footnote-ref"><a href="#${md.utils.escapeHtml(meta.footnoteId)}" id="${md.utils.escapeHtml(meta.refId)}" role="doc-noteref">${meta.number}</a></sup>`;
  };
  md.renderer.rules.footnote_backref = (tokens, idx) => {
    const meta = tokens[idx].meta as { refId: string; index: number };
    const refId = md.utils.escapeHtml(meta.refId);
    const label = meta.index > 1 ? `&#8617;${meta.index}` : '&#8617;';
    return `<a href="#${refId}" class="footnote-backref" role="doc-backlink" title="Jump back to reference">${label}</a>`;
  };
}

function footnotes(md: MarkdownItInstance): void {
  footnoteDefinitions(md);
  footnoteReferences(md);
  appendFootnoteList(md);
  footnoteRenderers(md);
}

// ── Plugin: heading anchors ──────────────────────────────────────────────────

function markdownHeadingAnchors(md: MarkdownItInstance): void {
  md.core.ruler.push('hana_heading_anchors', (state: StateCore) => {
    const seen = new Map<string, number>();
    for (let i = 0; i < state.tokens.length; i += 1) {
      const token = state.tokens[i];
      if (token.type !== 'heading_open') continue;
      const inline = state.tokens[i + 1];
      if (!inline || inline.type !== 'inline') continue;
      const text = inline.content.trim();
      if (!text) continue;
      token.attrSet('id', uniqueMarkdownHeadingId(text, seen));
    }
  });
}

// ── Plugin: mermaid fences ───────────────────────────────────────────────────

function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() || '';
}

function mermaidFences(md: MarkdownItInstance): void {
  const defaultFence = md.renderer.rules.fence
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (fenceLanguage(token.info) !== 'mermaid') {
      return defaultFence(tokens, idx, options, env, self);
    }
    const source = md.utils.escapeHtml(token.content);
    return [
      '<div class="mermaid-diagram">',
      `<pre class="mermaid-source"><code>${source}</code></pre>`,
      '<div class="mermaid-rendered"></div>',
      '</div>\n',
    ].join('');
  };
}

// ── Plugin: image renderer (lazy + dimensions) ───────────────────────────────

/**
 * Whether an image `src` is a Workspace-relative path that the browser cannot
 * load directly (it would resolve against the page URL and 404). Absolute and
 * protocol URLs (`http(s):`, `data:`, `blob:`, `file:`) are left to the browser.
 * A leading `/` is treated as absolute-filesystem, not Workspace-relative.
 */
function isWorkspaceRelativeSrc(src: string): boolean {
  if (!src) return false
  if (src.startsWith('/') || src.startsWith('//')) return false
  // scheme:// or scheme: (data:, blob:, mailto:, …) → browser-loadable
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false
  return true
}

/**
 * The ONE inline visual placeholder — the unified viz frame. An embed-cited
 * visual asset (image / SVG / html, any path) emits the same bare
 * `<span class="md-media-frame">`; MarkdownContent hydrates it lazily (bytes
 * on intersect) into a slim bar (file name → sidebar viewer, button → OS
 * default app) over a body that always auto-fits at full width: image/svg
 * render as an `<img>` (click → lightbox) at natural height with the
 * intrinsic aspect ratio cached per path; html renders as a sandboxed
 * interactive iframe whose settled height is reported from inside and
 * cached the same way — remounts are born the right height (the flicker
 * fix; see markdown-hydration).
 */
function mediaFrameHtml(md: MarkdownItInstance, src: string, label: string, kind: 'image' | 'svg' | 'html'): string {
  const safeSrc = md.utils.escapeHtml(src)
  const safeAlt = md.utils.escapeHtml(label || basenamePortable(src))
  const name = md.utils.escapeHtml(basenamePortable(src))
  return `<span class="md-media-frame" data-workspace-src="${safeSrc}" ` +
    `data-file-kind="${kind}" data-file-name="${name}" aria-label="${safeAlt}"></span>`
}

/**
 * The data-file card kind for a Workspace path, or null when it is not a
 * cardable data file. Reuses the app's single extension vocabulary
 * (`fileTypes`): tables are CSV/TSV/TopFD `.feature`, JSON is its own kind
 * (pretty-printed on hydration), everything else in the text set is plain
 * text. Images and HTML are handled separately by the image/html paths.
 */
type WorkspaceDataKind = 'table' | 'json' | 'text'

function workspaceDataKindOf(path: string): WorkspaceDataKind | null {
  const ext = extensionOf(path)
  if (TABLE_EXTENSIONS.has(ext)) return 'table'
  if (ext === 'json') return 'json'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return null
}

/**
 * The card vocabulary for a Workspace path cited as a plain `[](path)` link.
 * Every file extension cards — the file type decides the surface, the same
 * router the embed forms use. There is deliberately no "plain anchor" outcome
 * for a file link: the sanitizer strips a workspace-relative href (no explicit
 * protocol), so an anchor rendered as dead text or a live link depending on
 * whether the rest of the message happened to contain raw HTML. A card is the
 * one surface that is honest under both paths — clickable, labelled, and the
 * same object the Files tab collects. Only an extensionless target (a wiki
 * page name) is not a file: it renders as the wikilink anchor.
 */
type LinkCardKind = WorkspaceDataKind | 'html' | 'image' | 'svg' | 'file'

function linkCardKindOf(path: string): LinkCardKind | null {
  const dataKind = workspaceDataKindOf(path)
  if (dataKind) return dataKind
  const ext = extensionOf(path)
  if (ext === 'svg') return 'svg'
  if (IMAGE_EMBED_EXTENSIONS.includes(ext)) return 'image'
  if (HTML_EXTENSIONS.has(ext)) return 'html'
  if (basenamePortable(path).includes('.')) return 'file'
  return null
}

/**
 * The compact "workspace file card" emitted for data-file refs — `![](path)` on
 * a table/JSON/text path, or `[](path)` as a link to any file (see
 * `LinkCardKind`). Shares the `.file-card` markup so clicks route through
 * the existing open-file handler; MarkdownContent hydrates the body lazily
 * by `data-file-kind` where a body exists (real table, pretty JSON, capped
 * code), never a JSON-dump stub — image/svg/file kinds keep the icon card.
 */
function dataFileCardHtml(md: MarkdownItInstance, src: string, label: string, kind: LinkCardKind): string {
  const name = md.utils.escapeHtml(basenamePortable(src))
  const safeSrc = md.utils.escapeHtml(src)
  const safeLabel = md.utils.escapeHtml(label || name)
  return `<span class="file-card" role="button" tabindex="0" ` +
    `data-workspace-src="${safeSrc}" data-file-kind="${kind}" data-file-name="${name}" ` +
    `aria-label="${safeLabel}" title="${safeSrc}">` +
    `<span class="file-card__icon" aria-hidden="true"></span>` +
    `<span class="file-card__name">${name}</span>` +
    `<span class="file-card__kind">${kind}</span>` +
    `</span>`
}

/**
 * Workspace file cards for plain `[](path)` links.
 *
 * The Obsidian plugin handles `![[...]]`; this handles the standard markdown
 * workspace link. A Workspace-relative
 * link whose target is a file (any extension — see `linkCardKindOf`) becomes
 * the same compact card as the embed forms; an extensionless target is a wiki
 * page name and becomes the same inert wikilink anchor `[[page]]` produces.
 * No `[](target)` form stays a bare anchor: the sanitizer strips a
 * workspace-relative href (no explicit protocol), so an anchor would render
 * as dead text or a live link depending on whether the rest of the answer
 * happened to contain raw HTML — a card or a wikilink is stable under both.
 */
function workspaceDataFileCards(md: MarkdownItInstance): void {
  md.core.ruler.after('inline', 'workspace_data_file_cards', (state: StateCore) => {
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue
      const children = block.children
      let i = 0
      while (i < children.length) {
        const open = children[i]
        if (open.type !== 'link_open') { i += 1; continue }
        const href = open.attrGet('href') ?? ''
        let close = -1
        for (let j = i + 1; j < children.length; j += 1) {
          if (children[j].type === 'link_close' && children[j].level === open.level) { close = j; break }
        }
        if (close < 0) { i += 1; continue }
        const label = inlineTextOf(children, i + 1, close)
        const kind = isWorkspaceRelativeSrc(href) ? linkCardKindOf(href) : null
        if (!kind) {
          // Extensionless Workspace target = a wiki page name, not a file:
          // the same inert wikilink anchor `[[page]]` renders. In-page `#`
          // fragment and absolute/protocol targets stay the plain anchor
          // markdown-it built.
          if (isWorkspaceRelativeSrc(href) && !href.startsWith('#')) {
            const wiki = new state.Token('wikilink', '', 0)
            wiki.attrs = [['target', href]]
            wiki.content = label
            wiki.level = open.level
            children.splice(i, close - i + 1, wiki)
          }
          i += 1
          continue
        }
        const name = basenamePortable(href)
        const card = new state.Token('workspace_file_card', 'span', 0)
        card.attrs = [
          ['src', href],
          ['kind', kind],
          ['name', name],
          ['label', label || name],
        ]
        card.level = open.level
        children.splice(i, close - i + 1, card)
        i += 1
      }
    }
  })

  md.renderer.rules.workspace_file_card = (tokens, idx) => {
    const token = tokens[idx]
    return dataFileCardHtml(
      md,
      token.attrGet('src') ?? '',
      token.attrGet('label') ?? '',
      (token.attrGet('kind') ?? 'text') as LinkCardKind,
    )
  }
}

function inlineTextOf(children: Token[], from: number, to: number): string {
  let out = ''
  for (let i = from; i < to; i += 1) {
    const token = children[i]
    if (token.type === 'text' || token.type === 'code_inline') out += token.content
  }
  return out.trim()
}

function markdownImageRenderer(md: MarkdownItInstance): void {
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const rawAlt = token.children
      ? self.renderInlineAsText(token.children, options, env)
      : token.content;
    const parsedLabel = parseImageLabel(rawAlt);
    token.attrSet('alt', parsedLabel.alt);
    const src = token.attrGet('src') ?? '';
    // Workspace-relative refs present by file type (same router as `![[...]]`
    // and `[[...]]` on a media file): inline image, or the matching card.
    if (isWorkspaceRelativeSrc(src)) {
      return presentInlineHtml(md, src, parsedLabel.alt)
    }
    // Browser-loadable src (http/data/blob/…) still renders as a normal img.
    if (parsedLabel.dimensions?.width && !token.attrGet('width')) {
      token.attrSet('width', parsedLabel.dimensions.width);
    }
    if (parsedLabel.dimensions?.height && !token.attrGet('height')) {
      token.attrSet('height', parsedLabel.dimensions.height);
    }
    token.attrSet('loading', 'lazy');
    token.attrSet('decoding', 'async');
    return self.renderToken(tokens, idx, options);
  };
}

// ── Plugin: table scroll wrapper ─────────────────────────────────────────────

function markdownTableScrollWrapper(md: MarkdownItInstance): void {
  const defaultTableOpen = md.renderer.rules.table_open
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  const defaultTableClose = md.renderer.rules.table_close
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.table_open = (tokens, idx, options, env, self) => (
    `<div class="markdown-table-scroll">\n${defaultTableOpen(tokens, idx, options, env, self)}`
  );
  md.renderer.rules.table_close = (tokens, idx, options, env, self) => (
    `${defaultTableClose(tokens, idx, options, env, self)}</div>\n`
  );
}

// ── Plugin wiring ────────────────────────────────────────────────────────────

function applyMarkdownPlugins(md: MarkdownItInstance): void {
  // Math is emitted as an inert `<span class="katex-shell" data-formula=...>`
  // placeholder here; the actual KaTeX render + CSS load lazily on first use
  // (see utils/katex-renderer.ts), so neither ships in the entry chunk. This
  // mirrors the mermaid shell→hydrate split.
  md.use(latexShellMath);
  md.use(texBracketMath);
  md.use(taskLists, { enabled: false, label: true });
  md.use(obsidianImageEmbeds);
  md.use(attachedImageMarkerEmbeds);
  md.use(markdownEmbedRenderer);
  md.use(obsidianHighlights);
  md.use(wikiLinks);
  md.use(obsidianCallouts);
  md.use(footnotes);
  md.use(markdownHeadingAnchors);
  md.use(trimAutoLinkifiedSuffixes);
  md.use(mermaidFences);
  md.use(markdownImageRenderer);
  md.use(workspaceDataFileCards);
  md.use(markdownTableScrollWrapper);
}

function buildMarkdownEnv(src: string): MarkdownRenderEnv {
  return { footnoteIdPrefix: footnoteIdPrefixForSource(src) };
}

/** Get the chat markdown instance (html:true; output is sanitized at the render exit). */
export function getMd(): MarkdownItInstance {
  if (_md) return _md;
  _md = markdownit({ html: true, breaks: true, linkify: true, typographer: true });
  applyMarkdownPlugins(_md);
  return _md;
}

/**
 * The single render exit for model output: markdown → allowlist sanitizer →
 * code-block toolbar. The sanitizer scrubs raw HTML (html:true) down to the
 * allowlist; the toolbar is injected AFTER it so our own trusted buttons are
 * never scrubbed. Skips the sanitizer walk entirely when the source carries no
 * markup-looking `<` (the common plain-prose/codeless message), and falls back
 * to the unsanitized HTML if the DOM is unavailable (non-browser callers).
 */
export function renderMarkdown(src: string): string {
  const raw = getMd().render(src, buildMarkdownEnv(src));
  let clean = raw;
  if (/<[a-zA-Z!/]/.test(src)) {
    try {
      clean = sanitizeMarkdownPreviewHtml(raw);
    } catch (err) {
      if (import.meta.env?.DEV) console.warn('[markdown] sanitizer failed:', err);
    }
  }
  return renderCodeBlockToolbarHtml(clean);
}
