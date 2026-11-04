<template>
  <section class="section">
    <div class="section-header">
      <h2 class="section-title">{{ t('workbench.settings.general.update.title') }}</h2>
    </div>
    <div class="surface-card">
      <div class="row row-inline">
        <div class="row-text">
          <div class="row-label" data-update-status>{{ statusText }}</div>
          <!-- Only where the user asked (this settings row) does a failure
               surface; ambient check failures stay in the logs. -->
          <div v-if="state.phase === 'error' && state.message" class="row-hint">{{ state.message }}</div>
        </div>
        <div class="row-control">
          <AppButton
            v-if="state.phase === 'downloaded'"
            variant="primary"
            size="sm"
            data-update-restart
            @click="restart"
          >
            {{ t('workbench.settings.general.update.restart') }}
          </AppButton>
          <AppButton
            v-else
            variant="subtle"
            size="sm"
            :disabled="state.phase === 'checking' || state.phase === 'downloading'"
            @click="check"
          >
            {{ t('workbench.settings.general.update.check') }}
          </AppButton>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@/components/primitives/AppButton.vue'
import { desktopUpdateBridge, type UpdateBridgeState } from '@/services/desktop/desktopBridge'

/** The app-update row of General settings: quiet state line + the one action.
 *  The download runs in the background (main process); the restart is the
 *  only transition the user is asked to make, and only ever explicit. */
const { t } = useI18n()

// Outside Electron (browser dev) there is no bridge and no updater: the row
// reads "up to date" and the buttons do nothing — never an error surface.
const state = ref<UpdateBridgeState>({ phase: 'unavailable', version: null, progress: null, message: null })

let unsubscribe: (() => void) | undefined

onMounted(async () => {
  const bridge = desktopUpdateBridge()
  if (!bridge) return
  state.value = await bridge.currentState()
  unsubscribe = bridge.subscribe((next) => { state.value = next })
})

onUnmounted(() => { unsubscribe?.() })

const statusText = computed(() => {
  switch (state.value.phase) {
    case 'checking': return t('workbench.settings.general.update.checking')
    case 'available': return t('workbench.settings.general.update.available', { version: state.value.version ?? '' })
    case 'downloading': return t('workbench.settings.general.update.downloading', {
      version: state.value.version ?? '',
      progress: state.value.progress == null ? '' : Math.round(state.value.progress),
    })
    case 'downloaded': return t('workbench.settings.general.update.downloaded', { version: state.value.version ?? '' })
    case 'error': return t('workbench.settings.general.update.error')
    default: return t('workbench.settings.general.update.upToDate')
  }
})

function check() { desktopUpdateBridge()?.check().then((next) => { state.value = next }) }
function restart() { desktopUpdateBridge()?.restart() }
</script>
