<!--
  App.vue — thin root shell.

  Everything structural now lives in `AppShell.vue`, mounted by the single
  `/` route. This component's only remaining job is the Element Plus locale
  bridge: it keeps `elementLocale` in sync with `vue-i18n`'s active locale so
  Element Plus's own strings (date pickers, confirm dialogs, …) follow the
  app language. No global CSS lives here — the reset, scrollbars,
  `::selection` and `:focus-visible` rules moved to `src/styles/global.css`.
-->
<template>
  <el-config-provider :locale="elementLocale">
    <router-view />
  </el-config-provider>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import type { Language } from 'element-plus/es/locale'

const { locale } = useI18n()

const elementLocale = ref<Language>(zhCn)

// zh-CN ships statically (default boot value); every other non-English locale
// resolves its Element Plus pack lazily, mirroring the app message chunks.
// vue-i18n types `locale` as string, so anything unknown falls to English —
// the same fallback the messages themselves use.
function resolveElementLocale(appLocale: string): Promise<Language> {
  if (appLocale === 'zh-CN') return Promise.resolve(zhCn)
  if (appLocale === 'de-DE') {
    return import('element-plus/es/locale/lang/de').then((de) => de.default ?? de)
  }
  return import('element-plus/es/locale/lang/en').then((en) => en.default ?? en)
}

watch(locale, (newLocale) => {
  void resolveElementLocale(newLocale).then((resolved) => { elementLocale.value = resolved })
}, { immediate: true })
</script>
