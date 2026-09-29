<!--
  ThemeSwitcher — the title bar's theme picker.

  The trigger is an AppButton (`subtle`/`sm`), not a bespoke box: it lives in
  the title bar next to the density toggle, and `--row-h-sm` tracks the density
  token the bar's own height comes from. A hardcoded pixel size here is what
  made the control overflow a 32px (comfortable) / 26px (compact) bar and clip
  against the window edge.
-->
<template>
  <el-dropdown
    trigger="click"
    placement="bottom-end"
    :popper-options="POPPER_OPTIONS"
    @command="handleThemeChange"
  >
    <AppButton
      variant="subtle"
      size="sm"
      class="theme-switcher"
      :title="t('common.theme.switch')"
      :aria-label="t('common.theme.switch')"
      aria-haspopup="menu"
    >
      <!-- currentColor, not the icon default, so the glyph follows AppButton's
           subtle hover/active states the way LangSwitcher's inline svg does.
           Element Plus' bundled glyphs, not an Iconify API fetch: this picker
           is the one icon surface that used to go blank offline (desktop). -->
      <el-icon :size="16">
        <Sunny v-if="isLightTheme" />
        <Moon v-else />
      </el-icon>
    </AppButton>
    <template #dropdown>
      <el-dropdown-menu>
        <div class="theme-menu-header" role="presentation">{{ t('common.theme.menuHeader') }}</div>
        <el-dropdown-item
          v-for="(meta, theme) in themeMetadata"
          :key="theme"
          :command="theme"
          :class="{ 'is-active': currentTheme === theme }"
        >
          <div class="theme-option">
            <span class="theme-name">{{ meta.name }}</span>
            <span class="theme-mode">{{ t(`common.theme.mode.${meta.mode}`) }}</span>
            <el-icon v-if="currentTheme === theme" class="check-icon"><Check /></el-icon>
          </div>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Moon, Sunny } from '@element-plus/icons-vue'
import { useThemeStore } from '@/stores/theme'
import { themeMetadata, type CatppuccinTheme } from '@/config/theme'
import AppButton from '@/components/primitives/AppButton.vue'

// The trigger sits flush against the window's right edge, where Popper's
// default overflow handling parks the menu hard against the viewport with no
// margin at all. Keep a gutter so it reads as a floating menu, not a panel
// welded to the frame.
const POPPER_OPTIONS = {
  modifiers: [{ name: 'preventOverflow', options: { padding: 8 } }],
}

const { t } = useI18n()
const themeStore = useThemeStore()

const currentTheme = computed(() => themeStore.currentTheme)

const isLightTheme = computed(() => themeMetadata[currentTheme.value].mode === 'light')

const handleThemeChange = (theme: CatppuccinTheme) => {
  themeStore.setTheme(theme)
}
</script>

<style scoped>
.theme-menu-header {
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.theme-option {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 150px;
}

.theme-name {
  font-size: var(--text-md);
  font-weight: 500;
  color: var(--color-text);
  flex: 1;
}

.theme-mode {
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

.check-icon {
  color: var(--color-primary, var(--color-primary));
  font-size: var(--text-lg);
}

.el-dropdown-menu__item.is-active {
  background-color: var(--color-primary-soft);
}

.el-dropdown-menu__item:hover {
  background-color: var(--color-hover);
}

.el-dropdown-menu__item.is-active:hover {
  background-color: color-mix(in srgb, var(--color-primary-soft) 82%, var(--color-bg-hover));
}
</style>
