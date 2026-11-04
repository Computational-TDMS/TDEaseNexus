import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { CatppuccinTheme } from '@/config/theme'
import { defaultTheme, themeMetadata } from '@/config/theme'
import { createLogger } from '@/utils/logger'

const log = createLogger('theme-store')

const THEME_STORAGE_KEY = 'tdease-theme'

export const useThemeStore = defineStore('theme', () => {
  // State
  const currentTheme = ref<CatppuccinTheme>(defaultTheme)

  // Actions
  const setTheme = (theme: CatppuccinTheme) => {
    currentTheme.value = theme
    applyTheme(theme)
    saveTheme(theme)
  }

  const applyTheme = (theme: CatppuccinTheme) => {
    // Apply theme to document
    document.documentElement.setAttribute('data-theme', theme)

    // Update meta theme-color for mobile browsers
    const colors = getThemeColors(theme)
    const metaThemeColor = document.querySelector('meta[name="theme-color"]')
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', colors.base)
    } else {
      const meta = document.createElement('meta')
      meta.name = 'theme-color'
      meta.content = colors.base
      document.head.appendChild(meta)
    }
  }

  const saveTheme = (theme: CatppuccinTheme) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch (e) {
      log.warn('Failed to save theme preference:', e)
    }
  }

  const loadTheme = (): CatppuccinTheme => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY)
      if (saved && isValidTheme(saved)) {
        return saved as CatppuccinTheme
      }
    } catch (e) {
      log.warn('Failed to load theme preference:', e)
    }
    return defaultTheme
  }

  const isValidTheme = (value: string): value is CatppuccinTheme => {
    return ['celadon', 'latte', 'frappe', 'macchiato', 'mocha'].includes(value)
  }

  const getThemeColors = (_theme: CatppuccinTheme) => {
    // Get CSS variables for current theme
    const style = getComputedStyle(document.documentElement)
    const getColor = (name: string) => style.getPropertyValue(name).trim()

    return {
      rosewater: getColor('--ctp-rosewater'),
      flamingo: getColor('--ctp-flamingo'),
      pink: getColor('--ctp-pink'),
      mauve: getColor('--ctp-mauve'),
      red: getColor('--ctp-red'),
      maroon: getColor('--ctp-maroon'),
      peach: getColor('--ctp-peach'),
      yellow: getColor('--ctp-yellow'),
      green: getColor('--ctp-green'),
      teal: getColor('--ctp-teal'),
      sky: getColor('--ctp-sky'),
      sapphire: getColor('--ctp-sapphire'),
      blue: getColor('--ctp-blue'),
      lavender: getColor('--ctp-lavender'),
      text: getColor('--ctp-text'),
      subtext1: getColor('--ctp-subtext1'),
      subtext0: getColor('--ctp-subtext0'),
      overlay2: getColor('--ctp-overlay2'),
      overlay1: getColor('--ctp-overlay1'),
      overlay0: getColor('--ctp-overlay0'),
      surface2: getColor('--ctp-surface2'),
      surface1: getColor('--ctp-surface1'),
      surface0: getColor('--ctp-surface0'),
      base: getColor('--ctp-base'),
      mantle: getColor('--ctp-mantle'),
      crust: getColor('--ctp-crust'),
    }
  }

  const toggleTheme = () => {
    const themes = Object.entries(themeMetadata) as [CatppuccinTheme, typeof themeMetadata[CatppuccinTheme]][]
    const currentIndex = themes.findIndex(([t]) => t === currentTheme.value)
    const currentMode = currentIndex >= 0 ? themes[currentIndex][1].mode : 'dark'

    // Find the next theme (metadata order, wrapping) whose mode differs — a
    // genuine light/dark toggle, not a step to the adjacent sibling variant.
    for (let step = 1; step <= themes.length; step++) {
      const candidate = themes[(currentIndex + step) % themes.length]
      if (candidate[1].mode !== currentMode) {
        setTheme(candidate[0])
        return
      }
    }
  }

  // Initialize theme on store creation
  const initialize = () => {
    const savedTheme = loadTheme()
    currentTheme.value = savedTheme
    applyTheme(savedTheme)
  }

  // Watch for theme changes
  watch(currentTheme, (newTheme) => {
    applyTheme(newTheme)
  })

  return {
    currentTheme,
    setTheme,
    applyTheme,
    toggleTheme,
    initialize,
    getThemeColors,
  }
})
