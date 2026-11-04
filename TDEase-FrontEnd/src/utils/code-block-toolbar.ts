/**
 * Code-block toolbar — injects a wrap/copy toolbar into every <pre> in
 * rendered markdown HTML, producing a stable DOM structure that survives
 * streaming innerHTML reconciliation.
 *
 * The toolbar is generated at render time (before v-html injection) so the
 * HTML string is stable; click handling is done via root event delegation
 * in MarkdownContent.vue (NOT per-button listeners), because per-button
 * listeners would be detached every time the streaming reconcile touches
 * the parent's innerHTML.
 *
 * Ported from openhanako desktop/src/react/utils/format.ts
 * (renderCodeBlockToolbarHtml + decorateCodeBlockElements).
 */

export interface CodeBlockToolbarLabels {
  wrap: string;
  unwrap: string;
  copy: string;
  copied: string;
}

const DEFAULT_LABELS: CodeBlockToolbarLabels = {
  wrap: 'Wrap',
  unwrap: 'Unwrap',
  copy: 'Copy',
  copied: 'Copied',
};

export function codeBlockToolbarLabels(
  partial: Partial<CodeBlockToolbarLabels> = {},
): CodeBlockToolbarLabels {
  return { ...DEFAULT_LABELS, ...partial };
}

function createToolbarButton(
  doc: Document,
  action: 'wrap' | 'copy',
  labels: CodeBlockToolbarLabels,
): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'code-block-action';
  btn.dataset.codeBlockAction = action;
  if (action === 'wrap') {
    btn.title = labels.wrap;
    btn.setAttribute('aria-label', labels.wrap);
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = labels.wrap;
  } else {
    btn.title = labels.copy;
    btn.setAttribute('aria-label', labels.copy);
    btn.dataset.copied = 'false';
    btn.textContent = labels.copy;
  }
  return btn;
}

/** The fence's language id from the code element's `language-x` class, for
 *  the head bar's label (VSCode / PI-Desktop convention: the language names
 *  the block; '' renders no label). */
function codeLanguageLabel(pre: HTMLPreElement): string {
  const code = pre.querySelector('code');
  const match = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(code?.className ?? '');
  return (match?.[1] ?? '').toLowerCase();
}

function createCodeBlockHead(doc: Document, labels: CodeBlockToolbarLabels, lang: string): HTMLDivElement {
  const head = doc.createElement('div');
  head.className = 'code-block-head';
  if (lang) {
    const langLabel = doc.createElement('span');
    langLabel.className = 'code-block-lang';
    langLabel.textContent = lang;
    head.appendChild(langLabel);
  }
  head.appendChild(createToolbarButton(doc, 'wrap', labels));
  head.appendChild(createToolbarButton(doc, 'copy', labels));
  return head;
}

function decorateCodeBlockElements(
  root: ParentNode,
  labels: CodeBlockToolbarLabels,
): void {
  const pres = root.querySelectorAll('pre');
  for (const pre of pres) {
    if (pre.classList.contains('mermaid-source')) continue;
    if (pre.parentElement?.classList.contains('code-block-wrap')) continue;
    if (!pre.parentNode) continue;

    const doc = pre.ownerDocument;
    const wrapper = doc.createElement('div');
    wrapper.className = 'code-block-wrap';
    wrapper.dataset.wrap = 'false';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(createCodeBlockHead(doc, labels, codeLanguageLabel(pre)));
    wrapper.appendChild(pre);
  }
}

/**
 * Wrap every <pre> in the rendered HTML with a .code-block-wrap div holding
 * a toolbar. Returns the (possibly unchanged) HTML string. No-op if there
 * are no <pre> elements or no DOM is available.
 */
export function renderCodeBlockToolbarHtml(
  html: string,
  labels: Partial<CodeBlockToolbarLabels> = {},
): string {
  if (!html.includes('<pre')) return html;
  const doc = globalThis.document;
  if (!doc?.createElement) return html;
  const template = doc.createElement('template');
  template.innerHTML = html;
  decorateCodeBlockElements(template.content, codeBlockToolbarLabels(labels));
  return template.innerHTML;
}
