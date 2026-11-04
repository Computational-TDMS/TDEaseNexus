<template>
  <section
    class="error-card"
    :class="{ 'is-engine': isEngine }"
    :role="isEngine ? 'status' : 'alert'"
  >
    <header class="error-card__head">
      <span class="error-card__icon" aria-hidden="true">
        <el-icon :size="16">
          <component :is="headIcon" />
        </el-icon>
      </span>
      <h3 class="error-card__message">{{ error.message }}</h3>
      <span class="error-card__meta mono">{{ error.code }}</span>
    </header>

    <p class="error-card__remedy">{{ error.remedy }}</p>

    <Disclosure v-if="hasDetails" :summary="t('common.button.showDetails')" class="error-card__details">
      <dl class="error-card__details-list">
        <template v-for="(value, key) in error.details" :key="key">
          <dt>{{ key }}</dt>
          <dd>{{ formatDetail(value) }}</dd>
        </template>
      </dl>
    </Disclosure>

    <footer v-if="hasCause || showRetry" class="error-card__actions">
      <button
        v-if="hasCause"
        type="button"
        class="error-card__cause-link"
        @click="emit('navigate-to-cause', error.cause as NonNullable<StructuredError['cause']>)"
      >
        {{ t('common.error.goToCause') }}
      </button>
      <AppButton v-if="showRetry" variant="primary" size="sm" @click="emit('retry')">
        {{ t('common.button.retry') }}
      </AppButton>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { InfoFilled, WarningFilled } from '@element-plus/icons-vue'
import AppButton from './AppButton.vue'
import Disclosure from './Disclosure.vue'
import type { StructuredError } from '@/studio/domain/errors'

const { t } = useI18n()

// The one failure-envelope card (CORE-ARCHITECTURE.md §7.1), used identically
// in the Agent dock, documents and the Activity dock.
//
// `domain: 'engine'` is an observation of a failed Run, not a product error
// (CORE-ARCHITECTURE.md §7.2): neutral heading, neutral icon, no retry ever,
// regardless of `retryable`.
const props = defineProps<{ error: StructuredError }>()

const emit = defineEmits<{
  retry: []
  'navigate-to-cause': [cause: NonNullable<StructuredError['cause']>]
}>()

const isEngine = computed(() => props.error.domain === 'engine')
const headIcon = computed(() => (isEngine.value ? InfoFilled : WarningFilled))

const hasDetails = computed(() => {
  const details = props.error.details
  return !!details && Object.keys(details).length > 0
})

const hasCause = computed(() => {
  const cause = props.error.cause
  return !!cause && Object.keys(cause).length > 0
})

// Never true for engine, even when the caller marks retryable: an engine
// failure is diagnosed, not retried blindly.
const showRetry = computed(() => props.error.retryable && !isEngine.value)

function formatDetail(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
</script>

<style scoped>
.error-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
}

.error-card__head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.error-card__icon {
  display: inline-flex;
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--color-error-text);
}

.error-card.is-engine .error-card__icon {
  color: var(--icon-info);
}

.error-card__message {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--text-md);
  line-height: var(--text-md-lh);
  font-weight: 600;
  color: var(--color-text);
}

.error-card.is-engine .error-card__message {
  font-weight: 500;
}

.error-card__meta {
  flex-shrink: 0;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.error-card__remedy {
  margin: 0;
  max-width: 68ch;
  font-size: var(--text-base);
  line-height: var(--text-base-lh);
  color: var(--color-text-secondary);
}

.error-card__details-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-1) var(--space-3);
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
}

.error-card__details-list dt {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
}

.error-card__details-list dd {
  margin: 0;
  color: var(--color-text-secondary);
  word-break: break-word;
}

.error-card__actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-top: var(--space-1);
}

.error-card__cause-link {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-primary);
  font-size: var(--text-sm);
  text-decoration: underline;
  cursor: pointer;
}

.error-card__cause-link:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}
</style>
