<!--
  BlockedCard — "A blocked turn is a question, not a
  paragraph." Renders the `tdease.session.reportBlocked` reason and what is
  needed as a question card, not prose in the outcome chip. When the model
  offered `options` (a choice among alternatives), they render as one-tap
  reply buttons — clicking one sends that answer as the next turn, so a
  choice never forces the user to retype it.
-->
<template>
  <section class="blocked-card" role="note">
    <header class="blocked-card__head">
      <span class="blocked-card__icon" aria-hidden="true">?</span>
      <span class="blocked-card__title">{{ t('agent.transcript.blocked.title') }}</span>
    </header>
    <p class="blocked-card__reason">{{ reason }}</p>
    <p class="blocked-card__needed">
      <span class="blocked-card__needed-label">{{ t('agent.transcript.blocked.neededLabel') }}</span>
      {{ needed }}
    </p>
    <div v-if="options?.length" class="blocked-card__options" role="group" :aria-label="t('agent.transcript.blocked.optionsLabel')">
      <button
        v-for="option in options"
        :key="option"
        type="button"
        class="blocked-card__option"
        @click="emit('answer', option)"
      >
        {{ option }}
      </button>
    </div>
    <!-- Manual answer row: a choice is not always one of the offered
         options, so the card carries its own input — answering never
         requires leaving the card for the composer. -->
    <div class="blocked-card__custom">
      <input
        v-model="customAnswer"
        type="text"
        class="blocked-card__custom-input"
        :placeholder="t('agent.transcript.blocked.customAnswer')"
        :aria-label="t('agent.transcript.blocked.customAnswer')"
        @keydown.enter.prevent="submitCustom"
      >
      <button
        type="button"
        class="blocked-card__custom-send"
        :title="t('agent.transcript.blocked.sendAnswer')"
        :aria-label="t('agent.transcript.blocked.sendAnswer')"
        @click="submitCustom"
      >
        <el-icon :size="12" aria-hidden="true"><ArrowUp /></el-icon>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ArrowUp } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'

defineProps<{
  reason: string
  needed: string
  options?: ReadonlyArray<string>
}>()

const emit = defineEmits<{ answer: [option: string] }>()

const { t } = useI18n()

const customAnswer = ref('')

function submitCustom() {
  const text = customAnswer.value.trim()
  if (!text) return
  emit('answer', text)
  customAnswer.value = ''
}
</script>

<style scoped>
.blocked-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: var(--space-2) 0;
  padding: var(--space-3);
  /*
    A blocked turn is a question, not a decoration. The
    3px accent stripe this replaces carried no meaning the full border and the
    heading do not already carry, and it is the most recognizable tell of a
    generated interface. Weight comes from the border and a tinted surface.
  */
  border: var(--line-w) solid color-mix(in srgb, var(--color-primary) 45%, var(--line-hairline));
  border-radius: var(--radius-md, 6px);
  background: color-mix(in srgb, var(--color-primary) 5%, var(--color-bg));
}

.blocked-card__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.blocked-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--color-primary);
  color: var(--color-on-primary);
  font-size: var(--text-sm);
  font-weight: 700;
}

.blocked-card__title {
  font-weight: 600;
  color: var(--color-text);
  font-size: var(--text-base, 13px);
}

.blocked-card__reason {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-base, 13px);
  line-height: 1.5;
}

.blocked-card__needed {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--text-base, 13px);
  line-height: 1.5;
}

.blocked-card__needed-label {
  font-weight: 600;
  color: var(--color-text);
}

.blocked-card__options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.blocked-card__option {
  padding: var(--space-1) var(--space-2);
  border: var(--line-w) solid color-mix(in srgb, var(--color-primary) 40%, var(--line-hairline));
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--text-label);
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}

.blocked-card__option:hover {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--color-bg));
}

.blocked-card__custom {
  display: flex;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.blocked-card__custom-input {
  flex: 1;
  min-width: 0;
  padding: var(--space-1) var(--space-2);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--text-label);
  line-height: 1.4;
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out);
}

.blocked-card__custom-input:focus {
  border-color: var(--color-ring);
}

.blocked-card__custom-input::placeholder {
  color: var(--color-text-muted);
}

.blocked-card__custom-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border: var(--line-w) solid color-mix(in srgb, var(--color-primary) 40%, var(--line-hairline));
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-primary);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}

.blocked-card__custom-send:hover {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--color-bg));
}
</style>
