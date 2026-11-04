// Vite plugins shared by BOTH configs (vite.config.ts for the app build,
// vitest.config.ts for the dev test suite). A plugin that exists in only one
// of the two pipelines is a silent environment divergence — the exact bug
// class this file exists to prevent.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

const VIRTUAL_KATEX_CSS = 'virtual:katex-css-text'

/**
 * `virtual:katex-css-text` → the literal text of katex.min.css, as a string.
 *
 * The import must NOT go through Vite's CSS pipeline under any suffix: in the
 * app build `?raw` works, but Vitest's CSS handling stubs EVERY css-flavored
 * request to an empty string — `?raw`, `?inline`, all of them — and a virtual
 * id still containing `.css` gets transformed the same way. The id here is
 * extension-free, so both environments run the same one code path (this
 * loader), which is what the conversation export's inline stylesheet depends
 * on (export-katex.ts).
 */
export function katexCssText(): Plugin {
  return {
    name: 'tdease-katex-css-text',
    enforce: 'pre',
    resolveId(id) {
      if (id === VIRTUAL_KATEX_CSS) return `\0${VIRTUAL_KATEX_CSS}`
      return null
    },
    async load(id) {
      if (id !== `\0${VIRTUAL_KATEX_CSS}`) return null
      const file = fileURLToPath(new URL('./node_modules/katex/dist/katex.min.css', import.meta.url))
      return `export default ${JSON.stringify(await fs.promises.readFile(file, 'utf8'))}`
    },
  }
}
