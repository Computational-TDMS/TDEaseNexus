<template>
  <div v-if="hasError" class="app-error-boundary">
    <div class="app-error-boundary__content">
      <h1 class="app-error-boundary__title">{{ t('common.error.title') }}</h1>
      <p class="app-error-boundary__message">
        {{ t('common.error.message') }}
      </p>
      <p v-if="isDev" class="app-error-boundary__detail">
        {{ errorMessage }}
      </p>
      <AppButton variant="primary" @click="reload">
        {{ t('common.error.reload') }}
      </AppButton>
    </div>
  </div>
  <slot v-else />
</template>

<script setup lang="ts">
import { ref, onErrorCaptured, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@/components/primitives/AppButton.vue'

const { t } = useI18n()
const hasError = ref(false)
const errorMessage = ref('')

const isDev = computed(() => import.meta.env.DEV)

onErrorCaptured((err: unknown) => {
  hasError.value = true
  errorMessage.value = err instanceof Error ? err.message : String(err)
  console.error('[AppErrorBoundary] Caught error:', err)
  return false // prevent propagation
})

function reload() {
  window.location.reload()
}
</script>

<style scoped>
.app-error-boundary {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  padding: var(--space-6);
}

.app-error-boundary__content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 480px;
}

.app-error-boundary__title {
  font-size: var(--text-xl);
  font-weight: 600;
  margin-bottom: var(--space-3);
  color: var(--color-error-text);
}

.app-error-boundary__message {
  color: var(--color-text-muted);
  margin-bottom: var(--space-2);
}

.app-error-boundary__detail {
  font-size: var(--text-label);
  color: var(--color-text-disabled);
  margin-bottom: var(--space-4);
  word-break: break-word;
  font-family: var(--font-mono);
}
</style>
