/**
 * Shared Plotly theme derived from the design-token CSS variables, so charts
 * follow the active Catppuccin flavor (light/dark) instead of a hardcoded
 * light palette. Call these INSIDE computed()/functions that re-run — the
 * values are read from getComputedStyle at call time.
 */

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  // Guard against unresolved color-mix()/var() strings Plotly can't parse.
  if (!value || value.includes('color-mix') || value.includes('var(')) return fallback
  return value
}

/** Read any design token for use in JS chart config (Plotly can't parse var()). */
export function plotlyTokenColor(name: string, fallback: string): string {
  return cssVar(name, fallback)
}

/** #rrggbb (or #rgb) → rgba() string with the given alpha. */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const int = parseInt(h, 16)
  if (Number.isNaN(int) || h.length !== 6) return hex
  const r = (int >> 16) & 0xff
  const g = (int >> 8) & 0xff
  const b = int & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function plotlyBaseLayout(): Record<string, unknown> {
  const bg = cssVar('--ctp-base', '#ffffff')
  const crust = cssVar('--ctp-crust', '#1e1e2e')
  return {
    paper_bgcolor: bg,
    plot_bgcolor: bg,
    font: { family: 'Inter, Arial, sans-serif', size: 11, color: cssVar('--ctp-text', '#1f2937') },
    margin: { l: 56, r: 24, t: 36, b: 44 },
    hoverlabel: {
      bgcolor: hexToRgba(crust, 0.92),
      bordercolor: hexToRgba(crust, 0.92),
      font: { color: cssVar('--ctp-text', '#ffffff'), size: 12 },
    },
  }
}

export function plotlyAxisStyle(): Record<string, unknown> {
  const surface0 = cssVar('--ctp-surface0', '#d1d5db')
  return {
    linecolor: surface0,
    gridcolor: hexToRgba(surface0, 0.55),
    zerolinecolor: cssVar('--ctp-surface1', '#c7ccd4'),
    tickfont: { color: cssVar('--ctp-subtext0', '#4b5563'), size: 11 },
    title: { font: { color: cssVar('--ctp-subtext1', '#374151'), size: 12 } },
  }
}

const SERIES_FALLBACKS = ['#1e66f5', '#8839ef', '#ea76cb', '#40a02b', '#fe640b', '#04a5e5']

/** Tick/label color used on axes and colorbars. */
export function plotlyTickColor(): string {
  return cssVar('--ctp-subtext0', '#4b5563')
}

const VIZ_ROLE_FALLBACKS = {
  up: '#e74c3c',
  down: '#3498db',
  neutral: '#95a5a6',
  highlight: '#fe640b',
} as const

/** Domain data-viz semantic colors (--domain-viz-up/down/neutral/highlight). */
export function plotlyVizColor(role: keyof typeof VIZ_ROLE_FALLBACKS): string {
  return cssVar(`--domain-viz-${role}`, VIZ_ROLE_FALLBACKS[role])
}

/** Chart series color by index — tracks --chart-series-N tokens. */
export function plotlySeriesColor(index: number): string {
  const slot = (index % SERIES_FALLBACKS.length) + 1
  return cssVar(`--chart-series-${slot}`, SERIES_FALLBACKS[slot - 1])
}

/** Accent for annotation lines/labels (vlines, markers). */
export function plotlyAccentColor(): string {
  return cssVar('--ctp-red', '#f56c6c')
}

/** Translucent fill for annotated regions, derived from the primary color. */
export function plotlyPrimaryFill(alpha = 0.15): string {
  return hexToRgba(cssVar('--color-primary', '#2A7483'), alpha)
}
