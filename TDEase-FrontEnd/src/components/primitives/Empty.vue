<template>
  <div class="empty">
    <div v-if="icon" class="empty__icon" aria-hidden="true">
      <el-icon :size="32">
        <component :is="icon" />
      </el-icon>
    </div>
    <h3 class="empty__title">{{ title }}</h3>
    <p v-if="description" class="empty__description">{{ description }}</p>
    <div v-if="$slots.default" class="empty__suggestions">
      <slot />
    </div>
    <AppButton v-if="actionLabel" variant="primary" class="empty__action" @click="emit('action')">
      {{ actionLabel }}
    </AppButton>
  </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
import AppButton from './AppButton.vue'

// VISUAL-SYSTEM.md §11: "icon + one sentence + one action; never a shrug."
// `title` always renders, so the icon is never left to stand alone, and
// exactly one primary action is possible -- there is no slot for a second one.
defineProps<{
  icon?: Component
  title: string
  description?: string
  actionLabel?: string
}>()

const emit = defineEmits<{ action: [] }>()
</script>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-6) var(--space-5);
  text-align: center;
}

.empty__icon {
  display: inline-flex;
  color: var(--icon-muted);
  margin-bottom: var(--space-1);
}

.empty__title {
  margin: 0;
  font-size: var(--text-xl);
  line-height: var(--text-xl-lh);
  font-weight: 600;
  color: var(--color-text);
}

.empty__description {
  margin: 0;
  max-width: 68ch;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-muted);
}

.empty__suggestions {
  width: 100%;
  max-width: 68ch;
  margin-top: var(--space-2);
}

.empty__action {
  margin-top: var(--space-2);
}
</style>
