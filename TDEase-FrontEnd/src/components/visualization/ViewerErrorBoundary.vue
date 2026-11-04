<template>
  <div class="viewer-error-boundary">
    <slot v-if="!renderError" />

    <div v-else class="viewer-error-fallback" data-testid="viewer-render-failed">
      <el-icon :size="24">
        <Warning />
      </el-icon>
      <span>{{ message }}</span>
      <AppButton variant="primary" size="sm" @click="resetBoundary">{{ $t('common.button.retry') }}</AppButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onErrorCaptured, ref } from 'vue'
import { Warning } from '@element-plus/icons-vue'
import AppButton from '@/components/primitives/AppButton.vue'
import { createLogger } from '@/utils/logger'

interface Props {
  fallbackMessage?: string
  context?: string
}

const props = withDefaults(defineProps<Props>(), {
  context: 'viewer',
})

const emit = defineEmits<{
  reset: []
}>()

const log = createLogger('viewer-error-boundary')
const renderError = ref<unknown | null>(null)

// Default to the i18n key so the message is localizable; explicit prop still wins.
const message = computed(() => props.fallbackMessage ?? '')

function resetBoundary() {
  renderError.value = null
  emit('reset')
}

onErrorCaptured((error, _instance, info) => {
  renderError.value = error
  log.error('Viewer render error captured', { context: props.context, info, error })
  // Prevent bubbling so a single viewer failure does not break the whole page.
  return false
})
</script>

<style scoped>
.viewer-error-boundary {
  /* Flex item inside its host surface: stretches without height:100%. */
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.viewer-error-boundary > * {
  flex: 1;
  min-height: 0;
}

.viewer-error-fallback {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  color: var(--color-error-text);
  text-align: center;
  padding: 16px;
}
</style>
