/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "plotly.js-dist-min" {
  const Plotly: {
    react: (
      el: HTMLElement,
      data: unknown[],
      layout?: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<unknown>;
    purge: (el: HTMLElement) => void;
    Plots: {
      resize: (el: HTMLElement) => void;
    };
  };
  export default Plotly;
}

// Literal katex.min.css text via the katexCssText() plugin (vite-plugins.ts),
// wired into BOTH vite.config.ts and vitest.config.ts.
declare module 'virtual:katex-css-text' {
  const css: string;
  export default css;
}
