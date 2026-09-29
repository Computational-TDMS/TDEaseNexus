<template>
  <div class="config-panel">
    <div class="panel-header">
      <span class="panel-title">{{ t('visualization.ms2.configuration') }}</span>
      <AppButton variant="subtle" size="sm" @click="emit('reset')">{{ t('common.button.reset') }}</AppButton>
    </div>

    <div class="config-section">
      <div class="section-title">{{ t('visualization.ms2.ionTypes') }}</div>
      <el-checkbox-group v-model="localConfig.ionTypes" size="small">
        <el-checkbox-button label="a">a</el-checkbox-button>
        <el-checkbox-button label="b">b</el-checkbox-button>
        <el-checkbox-button label="c">c</el-checkbox-button>
        <el-checkbox-button label="x">x</el-checkbox-button>
        <el-checkbox-button label="y">y</el-checkbox-button>
        <el-checkbox-button label="z">z</el-checkbox-button>
      </el-checkbox-group>
    </div>

    <div class="config-section">
      <div class="section-title">{{ t('visualization.ms2.maxChargeTitle') }}</div>
      <el-slider v-model="localConfig.maxFragmentCharge" :min="1" :max="5" show-stops />
    </div>

    <div class="config-section">
      <div class="section-title">{{ t('visualization.ms2.toleranceTitle') }}</div>
      <el-slider v-model="localConfig.tolerancePpm" :min="1" :max="100" :step="1" />
      <div class="slider-value">{{ localConfig.tolerancePpm }} ppm</div>
    </div>

    <div class="config-section">
      <div class="section-title">{{ t('visualization.ms2.displayOptions') }}</div>
      <el-checkbox v-model="localConfig.showMatchedPeaks" size="small">
        {{ t('visualization.ms2.showMatchedPeaks') }}
      </el-checkbox>
      <el-checkbox v-model="localConfig.showUnmatchedPeaks" size="small">
        {{ t('visualization.ms2.showUnmatchedPeaks') }}
      </el-checkbox>
      <el-checkbox v-model="localConfig.showNeutralLosses" size="small">
        {{ t('visualization.ms2.showNeutralLosses') }}
      </el-checkbox>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@/components/primitives/AppButton.vue'
import type { ViewerConfig } from '@/composables/ms2-sequence'

const { t } = useI18n()

interface Props {
  config: ViewerConfig
}

const props = defineProps<Props>()

const emit = defineEmits<{
  change: [config: ViewerConfig]
  reset: []
}>()

const localConfig = reactive<ViewerConfig>({ ...props.config })

watch(
  () => props.config,
  (newConfig) => {
    Object.assign(localConfig, newConfig)
  },
  { deep: true }
)

watch(
  localConfig,
  () => {
    emit('change', { ...localConfig })
  },
  { deep: true }
)
</script>

<style scoped>
.config-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--color-text);
}

.config-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.section-title {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  font-weight: 500;
}

.slider-value {
  font-size: var(--text-label);
  color: var(--color-text-disabled);
  text-align: right;
}
</style>
