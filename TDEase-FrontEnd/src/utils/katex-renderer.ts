/**
 * KaTeX renderer — the lazy counterpart to the math shells emitted by
 * utils/markdown.ts. KaTeX (~280KB JS + ~300KB CSS) is loaded only when a
 * rendered message actually contains math, mirroring the mermaid shell→hydrate
 * split in utils/mermaid-renderer.ts.
 *
 * Each `<span class="katex-shell" data-formula=... data-display=...>` left by
 * the markdown-it math rules is replaced in place with the KaTeX-rendered HTML.
 * The shell's own text content is the escaped formula, so before hydration the
 * math is still legible — it just isn't typeset.
 */

type KatexRenderInput = string;
interface KatexRenderOptions {
  displayMode?: boolean;
  throwOnError?: boolean;
  strict?: boolean | 'ignore';
}
interface KatexApi {
  renderToString(tex: KatexRenderInput, options?: KatexRenderOptions): string;
}

let katexPromise: Promise<KatexApi> | null = null;
let cssLoaded = false;

async function loadKatex(): Promise<KatexApi> {
  if (!katexPromise) {
    katexPromise = (async () => {
      // CSS loads once, in parallel with the JS; it's idempotent across calls.
      if (!cssLoaded) {
        cssLoaded = true;
        void import('katex/dist/katex.min.css').catch(() => {
          // CSS failure is non-fatal: math still renders structurally.
          cssLoaded = false;
        });
      }
      const mod = await import('katex');
      // katex ships both a default and named export depending on bundler path;
      // accept whichever resolves to the renderToString-bearing object.
      return (mod.default ?? mod) as KatexApi;
    })();
  }
  return katexPromise;
}

async function renderShell(shell: HTMLElement): Promise<void> {
  const formula = shell.dataset.formula;
  if (formula === undefined) return;
  if (shell.dataset.katexStatus === 'rendered') return;

  try {
    const katex = await loadKatex();
    const display = shell.dataset.display === 'true';
    const html = katex.renderToString(formula, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
    });
    shell.innerHTML = html;
    shell.dataset.katexStatus = 'rendered';
  } catch (err) {
    // Leave the legible fallback text in place; mark so we don't retry in a loop.
    shell.dataset.katexStatus = 'error';
    if (import.meta.env?.DEV) console.warn('[katex] render failed:', err);
  }
}

/** Render every `.katex-shell` under `root`. No-op when there is no math. */
export async function renderKatex(root: ParentNode | null): Promise<void> {
  if (!root) return;
  const shells = Array.from(root.querySelectorAll<HTMLElement>('.katex-shell'));
  if (shells.length === 0) return;
  await Promise.all(shells.map(renderShell));
}
