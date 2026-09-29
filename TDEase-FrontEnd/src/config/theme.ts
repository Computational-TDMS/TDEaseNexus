/**
 * Theme Configuration
 *
 * Five themes: celadon (TDEase's own light theme · default) / latte (standard Catppuccin) / frappe / macchiato / mocha
 * celadon and latte are both light themes — celadon has warm rice-paper surfaces, latte the cool CTP surfaces.
 */

export type CatppuccinTheme = 'celadon' | 'latte' | 'frappe' | 'macchiato' | 'mocha'

export const themeMetadata: Record<CatppuccinTheme, { name: string; mode: 'light' | 'dark' }> = {
  celadon: { name: 'Celadon', mode: 'light' },
  latte: { name: 'Latte', mode: 'light' },
  frappe: { name: 'Frappé', mode: 'dark' },
  macchiato: { name: 'Macchiato', mode: 'dark' },
  mocha: { name: 'Mocha', mode: 'dark' },
}

export const defaultTheme: CatppuccinTheme = 'celadon'
