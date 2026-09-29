<!--
  NotBuiltDocument — docs/STATUS.md.

  The registered component for a `DocumentKey` variant whose surface does not
  exist yet (`analysis-review` — its plan-review use case is absent per §4.8).

  It is a real registration, not a fallback: the registry stays total, and the
  gap lives in one table row per variant instead of a `v-else` branch that a
  typo could also reach. The copy is passed in as i18n keys so each variant
  says which kind it is and which slice ships it -- never a shared generic
  message (`DocumentRegistry` refuses two variants that share one).
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Empty from '@/components/primitives/Empty.vue'

const props = defineProps<{ titleKey: string; descriptionKey: string }>()

const { t } = useI18n()
</script>

<template>
  <Empty :title="t(props.titleKey)" :description="t(props.descriptionKey)" />
</template>
