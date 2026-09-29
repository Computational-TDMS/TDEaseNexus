<!--
  LangSwitcher — the title bar's locale picker.

  Trigger sizing mirrors ThemeSwitcher: an AppButton (`subtle`/`sm`) so all
  three title bar controls are one primitive at one density-aware height.
  Menu rows come from LOCALE_ITEMS (src/locales/index.ts), so a newly added
  language appears here without touching this component.
-->
<template>
  <el-dropdown
    trigger="click"
    placement="bottom-end"
    :popper-options="POPPER_OPTIONS"
    @command="handleSwitch"
  >
    <AppButton
      variant="subtle"
      size="sm"
      class="lang-switcher"
      :title="t('workbench.titleBar.languageSwitch')"
      :aria-label="t('workbench.titleBar.languageSwitch')"
      aria-haspopup="menu"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    </AppButton>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="item in LOCALE_ITEMS"
          :key="item.locale"
          :command="item.locale"
          :disabled="currentLocale === item.locale"
        >{{ item.label }}</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { isAppLocale, LOCALE_ITEMS, setLocale } from '@/locales'
import AppButton from '@/components/primitives/AppButton.vue'

// See ThemeSwitcher: the trigger is flush against the window's right edge, so
// Popper needs an explicit gutter or the menu welds itself to the frame.
const POPPER_OPTIONS = {
  modifiers: [{ name: 'preventOverflow', options: { padding: 8 } }],
}

const { t, locale } = useI18n()

const currentLocale = computed(() => locale.value)

function handleSwitch(code: string) {
  if (!isAppLocale(code)) return
  // setLocale also syncs <html lang> and persistence — see src/locales/index.ts.
  // Fire-and-forget: a lazy locale may first await its message chunk; the UI
  // switches when it lands (en-US resolves immediately).
  void setLocale(code)
}
</script>

<style scoped>
/*
  Sizing comes from AppButton (`--row-h-sm`); nothing to override here. The
  class stays as the component's stable test/query handle.
*/
.lang-switcher {
  flex: none;
}
</style>
