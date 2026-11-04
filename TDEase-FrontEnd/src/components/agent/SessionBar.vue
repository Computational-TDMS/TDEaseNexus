<!--
  SessionBar — the conversation's title row.

  Slimmed from the original six-control bar: Authority and the context
  indicator live in the Composer toolbar (next to the action they control),
  and the two native `<select>`s for provider/model were always empty here
  because AgentPage never wired them. What remains is the session switcher, a
  model pill that opens the cascading ModelPickerMenu (current pair on top,
  configured providers with model flyouts, and footer entries to the runtime
  drawer and Settings → Providers), and — centered, at the TOP — the mindset
  switch (Execute ↔ Explore). The mindset is a product-level choice, not a
  per-control setting: it owns the bar's center the way ChatGPT's surface
  switcher does, and flipping it adjusts the page (the transcript's mode
  emblem backdrop crossfades).

  The pill reflects the active `provider/model` string and shows a pressed
  state while the picker is open, so the user can see at a glance whether
  the menu is up.
-->
<template>
  <div class="session-bar">
    <div ref="sessionMenuRef" class="session-bar__session">
      <button
        type="button"
        class="session-bar__title"
        :aria-expanded="sessionMenuOpen"
        :aria-haspopup="true"
        :aria-label="t('agent.sessionBar.sessionsLabel')"
        @click="toggleMenu"
        @keydown.escape.prevent="closeMenu"
      >
        <span class="session-bar__title-text">{{ sessionTitle }}</span>
        <el-icon :size="14" aria-hidden="true"><ArrowDown /></el-icon>
      </button>
      <div v-if="sessionMenuOpen" class="session-bar__menu" role="menu" :aria-label="t('agent.sessionBar.sessionsLabel')">
        <SessionList headerless @new="onNew" @fork="onFork" />
      </div>
    </div>

    <!-- The mindset switch, centered: the page's most consequential per-turn
         choice deserves the most prominent neutral spot in the bar. -->
    <div v-if="mindset" class="session-bar__mindset">
      <ModeSelector :model-value="mindset" @update:model-value="emit('update:mindset', $event)" />
    </div>

    <div ref="modelPickerRef" class="session-bar__model-wrap">
      <button
        v-if="modelName"
        type="button"
        class="session-bar__model"
        :class="{ 'session-bar__model--active': pickerOpen }"
        :aria-expanded="pickerOpen"
        :aria-haspopup="true"
        :title="t('agent.modelPicker.title')"
        @click="pickerOpen = !pickerOpen"
      >
        <span class="session-bar__model-text">{{ modelName }}</span>
        <el-icon :size="13" aria-hidden="true"><ArrowDown /></el-icon>
      </button>
      <ModelPickerMenu v-if="pickerOpen" @close="pickerOpen = false" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, computed } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { ArrowDown } from '@element-plus/icons-vue'
import { useAgentStore } from '@/stores/agent'
import SessionList from './SessionList.vue'
import ModelPickerMenu from './ModelPickerMenu.vue'
import ModeSelector from './ModeSelector.vue'
import type { MindsetId } from '@/agent/prompt'
import { useI18n } from 'vue-i18n'

defineProps<{
  /** Read-only `provider/model` label, e.g. "openai/gpt-4o". */
  modelName?: string
  /** The Agent's working approach for the next turn — the centered
   *  product-level switch. Absent while the runtime has not produced one. */
  mindset?: MindsetId
}>()

const emit = defineEmits<{
  new: []
  fork: [sessionId: string]
  'update:mindset': [value: MindsetId]
}>()

const { t } = useI18n()
const agentStore = useAgentStore()

const sessionTitle = computed(() => agentStore.active?.title || t('agent.sessionBar.sessionsLabel'))
const sessionMenuOpen = ref(false)
const sessionMenuRef = ref<HTMLElement | null>(null)
onClickOutside(sessionMenuRef, () => { sessionMenuOpen.value = false })

// The model pill opens the cascading ModelPickerMenu (configured providers
// only). The pressed state + rotated chevron signal "open", and clicking the
// pill again dismisses — the same popover affordance the session menu uses.
// The picker's flyout teleports to <body> (to escape the menu's clipping),
// so it must be ignored here: a click inside the flyout IS a picker click.
const pickerOpen = ref(false)
const modelPickerRef = ref<HTMLElement | null>(null)
onClickOutside(modelPickerRef, () => { pickerOpen.value = false }, { ignore: ['.model-picker__submenu'] })

function toggleMenu() {
  sessionMenuOpen.value = !sessionMenuOpen.value
  if (sessionMenuOpen.value) {
    // Move focus into the menu so keyboard users can navigate it immediately.
    void nextTick(() => {
      const first = sessionMenuRef.value?.querySelector<HTMLElement>('[tabindex="0"], button')
      first?.focus()
    })
  }
}

function closeMenu() {
  sessionMenuOpen.value = false
}

function onNew() {
  sessionMenuOpen.value = false
  emit('new')
}

function onFork(sessionId: string) {
  sessionMenuOpen.value = false
  emit('fork', sessionId)
}
</script>

<style scoped>
.session-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* Horizontal-only padding: vertical padding would push the effective
     height past the header height and misalign with the adjacent panel
     headers. */
  padding: 0 var(--space-3);
  /* Tonal layering pilot: no hairline under the bar. The bar blends into
     the shell tone (--ctp-mantle, via the transparent background over
     .agent-page) while the transcript below steps UP to --ctp-base — the
     luminance step, not a 1px line, is what separates title row from
     content. */
  min-height: var(--header-h);
}

.session-bar__session {
  position: relative;
  min-width: 0;
  flex-shrink: 1;
}

/* Centered switch: auto margins on both sides center the block between the
   title and the model pill. */
.session-bar__mindset {
  margin: 0 auto;
  flex-shrink: 0;
}

.session-bar__title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  border: none;
  background: none;
  color: var(--color-text, var(--color-text));
  font: inherit;
  font-weight: 600;
  font-size: var(--text-base);
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  padding: 2px var(--space-1);
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}
.session-bar__title:hover {
  background: var(--color-hover);
}

.session-bar__title-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-bar__menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: var(--z-dockbar);
  width: 260px;
  max-height: 360px;
  background: var(--elev-2-bg, var(--color-bg));
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
  box-shadow: var(--elev-2);
  overflow: hidden;
}

.session-bar__model-wrap {
  position: relative;
  margin-left: auto;
  flex-shrink: 0;
}

.session-bar__model {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 26px;
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-muted, var(--color-text-muted));
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1;
  white-space: nowrap;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.session-bar__model:hover {
  background: var(--color-hover);
  color: var(--color-text);
}
.session-bar__model:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}
.session-bar__model--active {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.session-bar__model--active .el-icon {
  transform: rotate(180deg);
}
.session-bar__model-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-bar__model .el-icon {
  transition: transform var(--dur-fast) var(--ease-out);
  flex-shrink: 0;
}

@media (prefers-reduced-motion: reduce) {
  .session-bar__title,
  .session-bar__model,
  .session-bar__model .el-icon { transition: none; }
}
</style>
