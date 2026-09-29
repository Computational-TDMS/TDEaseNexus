/**
 * Mermaid diagram renderer — lazily loads mermaid, renders every
 * `.mermaid-diagram` shell produced by the markdown-it mermaidFences plugin,
 * and maintains a source-toggle toolbar so users can fall back to the raw
 * source if rendering fails or they want to inspect it.
 *
 * Ported from openhanako desktop/src/react/utils/mermaid-renderer.ts.
 */

import type { MermaidConfig } from 'mermaid';
import { i18n } from '@/locales';

/** Module-scope access to the global i18n instance — this renderer builds DOM
 *  nodes outside any Vue component, so it can't useI18n(). `global.t` is the
 *  reactive, locale-aware translation function vue-i18n exposes app-wide. */
const t = i18n.global.t.bind(i18n.global);

interface MermaidRenderResult {
  svg: string;
  bindFunctions?: (element: Element) => void;
}

interface MermaidApi {
  initialize(config: MermaidConfig): void;
  render(id: string, source: string): Promise<MermaidRenderResult>;
}

const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
};

/**
 * Mermaid defaults to a light-on-light 'default' theme regardless of the app
 * theme, which renders dark-on-dark under the dark Catppuccin flavours. The
 * renderer is re-initialized per render with the theme read off the live
 * `data-theme` attribute (set by stores/theme.ts on <html>). Latte keeps
 * 'default'; frappe/macchiato/mocha get 'dark'.
 *
 * Follow-up: a live theme switch does NOT re-render already-rendered
 * diagrams — that needs an invalidation pass over `.mermaid-diagram` shells,
 * which is deliberately out of scope here.
 */
function currentMermaidTheme(): 'default' | 'dark' {
  const theme = typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined;
  return theme === 'frappe' || theme === 'macchiato' || theme === 'mocha' ? 'dark' : 'default';
}

let mermaidPromise: Promise<MermaidApi> | null = null;
let idSeq = 0;
let renderSeq = 0;

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      const mod = await import('mermaid');
      const mermaid = mod.default;
      mermaid.initialize(MERMAID_CONFIG);
      return mermaid;
    })();
  }
  return mermaidPromise;
}

function nextMermaidId(): string {
  idSeq += 1;
  return `tdease-mermaid-${idSeq}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readSource(diagram: Element): string {
  return diagram.querySelector<HTMLElement>('.mermaid-source code')?.textContent || '';
}

function ensureSourceToolbar(diagram: HTMLElement, sourceBlock: HTMLElement, source: string): void {
  const existing = diagram.querySelector<HTMLElement>('.mermaid-source-toolbar');
  if (existing?.dataset.source === source) return;
  existing?.remove();
  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-source-toolbar';
  toolbar.dataset.source = source;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'mermaid-source-toggle';
  toggle.textContent = t('agent.mermaid.showSource');
  toggle.setAttribute('aria-expanded', sourceBlock.hasAttribute('hidden') ? 'false' : 'true');
  toggle.addEventListener('click', () => {
    const hidden = sourceBlock.hasAttribute('hidden');
    if (hidden) {
      sourceBlock.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.textContent = t('agent.mermaid.hideSource');
    } else {
      sourceBlock.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = t('agent.mermaid.showSource');
    }
  });

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'mermaid-source-copy';
  copy.textContent = t('agent.mermaid.copySource');
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText?.(source);
  });

  toolbar.append(toggle, copy);
  diagram.insertBefore(toolbar, sourceBlock);
}

function ensureRenderedElement(diagram: Element): HTMLElement {
  const existing = diagram.querySelector<HTMLElement>('.mermaid-rendered');
  if (existing) return existing;
  const rendered = document.createElement('div');
  rendered.className = 'mermaid-rendered';
  diagram.appendChild(rendered);
  return rendered;
}

function hasRenderedSvg(rendered: HTMLElement): boolean {
  return !!rendered.querySelector('svg');
}

async function renderMermaidDiagram(diagram: HTMLElement): Promise<void> {
  const source = readSource(diagram);
  const rendered = ensureRenderedElement(diagram);
  const sourceBlock = diagram.querySelector<HTMLElement>('.mermaid-source');
  const status = diagram.dataset.mermaidStatus;

  if (!source.trim()) return;
  if (status === 'loading' && diagram.dataset.mermaidSource === source) return;
  if (status === 'rendered' && diagram.dataset.mermaidSource === source && hasRenderedSvg(rendered)) {
    if (sourceBlock) ensureSourceToolbar(diagram, sourceBlock, source);
    return;
  }
  if (status === 'error' && diagram.dataset.mermaidSource === source && rendered.textContent) return;

  diagram.dataset.mermaidStatus = 'loading';
  diagram.dataset.mermaidSource = source;
  const currentRenderSeq = String(++renderSeq);
  diagram.dataset.mermaidRenderSeq = currentRenderSeq;
  diagram.classList.remove('is-rendered', 'is-error');
  rendered.textContent = '';

  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({ ...MERMAID_CONFIG, theme: currentMermaidTheme() });
    const { svg, bindFunctions } = await mermaid.render(nextMermaidId(), source);
    if (diagram.dataset.mermaidRenderSeq !== currentRenderSeq || readSource(diagram) !== source) return;
    rendered.innerHTML = svg;
    bindFunctions?.(rendered);
    sourceBlock?.setAttribute('hidden', '');
    if (sourceBlock) ensureSourceToolbar(diagram, sourceBlock, source);
    diagram.dataset.mermaidStatus = 'rendered';
    diagram.classList.add('is-rendered');
  } catch (err) {
    if (diagram.dataset.mermaidRenderSeq !== currentRenderSeq || readSource(diagram) !== source) return;
    sourceBlock?.removeAttribute('hidden');
    rendered.textContent = t('agent.mermaid.renderFailed', { error: errorMessage(err) });
    diagram.dataset.mermaidStatus = 'error';
    diagram.classList.add('is-error');
  }
}

export async function renderMermaidDiagrams(root: ParentNode | null): Promise<void> {
  if (!root) return;
  const diagrams = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-diagram'));
  await Promise.all(diagrams.map(renderMermaidDiagram));
}

/** Test hook: reset the mermaid loader cache and id sequence. */
export function __resetMermaidRendererForTests(): void {
  mermaidPromise = null;
  idSeq = 0;
  renderSeq = 0;
}
