<!--
  Chip — filter / dimension / binding / neutral (VISUAL-SYSTEM.md
  §11; `binding` matches §9.2's slot-bar chips).

  This is the successor to `src/components/ui/LabChip.vue`, which is left
  untouched and coexists until later slices migrate its callers over.

  Icons come from `@element-plus/icons-vue`, never an inline SVG.
-->
<template>
  <span
    class="chip"
    :class="[`chip--${variant}`, { 'chip--pinned': pinned }]"
  >
    <span class="chip__label"><slot /></span>

    <button
      v-if="pinnable"
      type="button"
      class="chip__action chip__action--pin"
      :aria-pressed="pinned"
      :aria-label="pinned ? t('common.chip.unpin') : t('common.chip.pin')"
      @click="pinned = !pinned"
    >
      <el-icon :size="11">
        <LocationFilled v-if="pinned" />
        <Location v-else />
      </el-icon>
    </button>

    <button
      v-if="removable"
      type="button"
      class="chip__action chip__action--remove"
      :aria-label="t('common.chip.remove')"
      @click="$emit('remove')"
    >
      <el-icon :size="10"><Close /></el-icon>
    </button>
  </span>
</template>

<script setup lang="ts">
import { Close, Location, LocationFilled } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

withDefaults(defineProps<{
  variant?: 'filter' | 'dimension' | 'binding' | 'neutral'
  removable?: boolean
  pinnable?: boolean
}>(), {
  variant: 'neutral',
  removable: false,
  pinnable: false,
})

defineEmits<{
  remove: []
}>()

const pinned = defineModel<boolean>('pinned', { default: false })
</script>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--row-h-sm);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  white-space: nowrap;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-border);
}

.chip__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ----- Variants: the same neutral shape, hue is the only thing that shifts ----- */
.chip--filter {
  background: var(--color-primary-soft);
  border-color: color-mix(in srgb, var(--color-primary) 40%, transparent);
  color: var(--color-text);
}

.chip--dimension {
  background: transparent;
  border-color: var(--color-border-panel);
  color: var(--color-text-muted);
}

.chip--binding {
  background: var(--color-primary-soft);
  border-color: var(--color-border-control-hover);
}

.chip--neutral {
  background: var(--color-bg);
  border-color: var(--color-border);
}

.chip--pinned {
  border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
}

/* ----- Actions ----- */
.chip__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: var(--radius-xs);
  transition: color var(--dur-instant) var(--ease-out), background-color var(--dur-instant) var(--ease-out);
}

.chip__action:hover {
  color: var(--color-text);
  background: var(--color-hover);
}

.chip__action:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}

.chip__action--pin[aria-pressed="true"] {
  color: var(--color-interact-text);
}
</style>
