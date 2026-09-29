<template>
  <div class="media-viewer">
    <img
      v-if="isImage"
      class="media-image"
      :src="sourceUrl"
      :alt="label"
      :title="t('visualization.viewer.openFullscreen')"
      @click="lightboxOpen = true"
    />
    <button
      v-if="isImage"
      type="button"
      class="media-viewer__fullscreen"
      :title="t('visualization.viewer.openFullscreen')"
      :aria-label="t('visualization.viewer.openFullscreen')"
      @click="lightboxOpen = true"
    >
      <el-icon :size="14"><FullScreen /></el-icon>
    </button>
    <!-- No allow-same-origin: blob URLs inherit the app origin, so a framed
         artifact could escape into the parent document (see MarkdownContent). -->
    <iframe
      v-else-if="isHtml"
      class="media-frame"
      :src="sourceUrl"
      sandbox="allow-scripts"
      :title="label"
    />
    <a v-else-if="sourceUrl" class="media-link" :href="sourceUrl" target="_blank" rel="noreferrer">
      {{ label || sourceUrl }}
    </a>
    <div v-else class="media-empty">{{ t('visualization.viewer.noMediaSource') }}</div>

    <!-- Fullscreen lightbox: wheel-zoom + drag-pan over the same src. Teleported
         to <body> by the component itself, so the host pane's overflow cannot
         clip it. -->
    <MediaLightbox
      v-if="lightboxOpen && sourceUrl"
      :src="sourceUrl"
      :alt="label"
      @close="lightboxOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FullScreen } from '@element-plus/icons-vue'
import MediaLightbox from './MediaLightbox.vue'
import type { Dataset, SelectionState } from '@/types/visualization'

interface Props {
  datasets?: Dataset[]
  viewSpec?: Record<string, unknown>
  data?: unknown
  config?: Record<string, unknown>
  selection?: SelectionState | null
}

const props = defineProps<Props>()
const { t } = useI18n()

const lightboxOpen = ref(false)

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const media = computed(() => {
  const specMedia = asRecord(props.viewSpec?.media)
  if (Object.keys(specMedia).length > 0) return specMedia
  if (Object.keys(props.viewSpec ?? {}).length > 0) return asRecord(props.viewSpec)
  return props.datasets?.find(dataset => dataset.kind === 'media')?.rows[0] ?? {}
})

const sourceUrl = computed(() => String(media.value.url || media.value.path || ''))
const mediaKind = computed(() => String(media.value.type || media.value.mediaType || '').toLowerCase())
const label = computed(() => String(media.value.label || media.value.alt || t('visualization.viewer.mediaLabel')))

const isImage = computed(() => (
  mediaKind.value.includes('image')
  || ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(mediaKind.value)
  || /\.(png|jpe?g|svg|gif|webp)(\?.*)?$/i.test(sourceUrl.value)
))
const isHtml = computed(() => (
  mediaKind.value.includes('html')
  || /\.html?(\?.*)?$/i.test(sourceUrl.value)
))
</script>

<style scoped>
.media-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-secondary);
  overflow: hidden;
}

.media-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  cursor: zoom-in;
}

/* Fullscreen affordance — appears on hover over the image, top-right of the
   viewer pane. A button rather than relying on image-click alone so the afford
   is discoverable and reachable by keyboard. */
.media-viewer__fullscreen {
  position: absolute;
  top: var(--space-1-5, 6px);
  right: var(--space-1-5, 6px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-bg) 70%, transparent);
  color: var(--color-text-secondary);
  opacity: 0;
  cursor: pointer;
  transition: opacity var(--dur-fast, 120ms) var(--ease-out), background-color var(--dur-fast, 120ms) var(--ease-out);
}
.media-viewer:hover .media-viewer__fullscreen { opacity: 1; }
.media-viewer__fullscreen:hover { background: var(--color-hover); color: var(--color-text); }
.media-viewer__fullscreen:focus-visible { opacity: 1; outline: 2px solid var(--color-ring); outline-offset: 1px; }

.media-frame {
  width: 100%;
  height: 100%;
  min-height: 360px;
  border: 0;
  /* Embedded HTML docs may have a transparent background; give them a neutral
     panel surface per theme instead of a hard white. */
  background: var(--color-bg-secondary);
}

.media-link,
.media-empty {
  color: var(--color-text-secondary);
  font-size: var(--text-base);
}
</style>
