<!--
  AgentFileList — the inspector's Files tab content.

  A grid of thumbnail cards for every file the Agent produced/cited in the
  active session. Each card is a lazy-loaded thumbnail (for images/SVG) or an
  icon (for HTML) plus the basename and a kind badge. Clicking the thumbnail
  opens the file in THIS host as an `agent-file` tab (FileDocument →
  MediaViewer) — the same route a transcript file-card click takes — so the
  preview appears where the user already is (the Agent tab host), not on the
  Workbench document surface they may not be looking at. The list derives from
  the files store, which is a pure projection of the transcript, so there
  is no IPC of its own.

  Thumbnails load through the same `readWorkspaceBlob` bridge the old
  MarkdownContent hydration used, but lazily — only when the card is scrolled
  into view (IntersectionObserver) and only as a small preview, never the
  full-size inline image that blew up the transcript.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { Document as DocumentIcon } from '@element-plus/icons-vue'
import { useAgentFilesStore, type AgentFile } from '@/stores/agentFiles'
import { useAgentTabsStore } from '@/stores/agentTabs'
import { useWorkspaceStore } from '@/stores/workspace'
import { readWorkspaceBlob } from '@/services/workspace/desktopWorkspace'
import { asWorkspaceId, asRelativePath } from '@/studio/domain/identity'
import Empty from '@/components/primitives/Empty.vue'

const { t } = useI18n()
const files = useAgentFilesStore()
const agentTabsStore = useAgentTabsStore()
const workspaceStore = useWorkspaceStore()

const rootPath = computed(() => workspaceStore.workspacePath)

/**
 * objectUrl per file path. Built lazily by the IntersectionObserver
 * callback; revoked on unmount / when the file leaves the active set.
 * HTML files keep an icon (no thumbnail) — an iframe preview is heavier
 * and belongs in the document area.
 */
const thumbnails = ref<Record<string, string>>({})
const failed = ref<Set<string>>(new Set())
const observers = new Map<string, IntersectionObserver>()

/**
 * Thumbnail bounding box. The card renders at ~150–200px wide, so a 240px box
 * covers retina without keeping a multi-megabyte plot PNG alive in memory just
 * to be CSS-scaled down. The original bytes are never needed here — clicking
 * opens the full file in the document area.
 */
const THUMB_MAX = 240

function ensureObserver(file: AgentFile, el: HTMLElement | null) {
  if (!el) return
  if (observers.has(file.path)) return
  if (typeof IntersectionObserver === 'undefined') {
    void loadThumbnail(file)
    return
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        void loadThumbnail(file)
        observer.disconnect()
        observers.delete(file.path)
      }
    }
  }, { rootMargin: '64px' })
  observer.observe(el)
  observers.set(file.path, observer)
}

/**
 * Downscale an image blob to a small thumbnail object URL via an off-screen
 * canvas. Returns null if the browser cannot decode it (rare format, decode
 * error) — the caller then falls back to the full-size blob URL so the card
 * still shows something. The thumbnail is `image/png` regardless of source;
 * the card never persists it and the originals open by path, so re-encoding is
 * harmless.
 *
 * This used to keep the entire source blob alive (a rendered plot can be
 * several MB) just to be CSS-scaled to ~180px. Drawing it onto a 240px canvas
 * and revoking the original caps the per-file cost at a few KB.
 */
async function downscaleToThumbnail(blob: Blob): Promise<string | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return null
  try {
    // createImageBitmap is the cheap path (no DOM <img>); it handles PNG/JPEG/
    // GIF/WebP. SVG is handled below via an <img> + data URL fallback.
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, THUMB_MAX / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) { bitmap.close?.(); return null }
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    return await new Promise<string | null>((resolve) => {
      canvas.toBlob((out) => resolve(out ? URL.createObjectURL(out) : null), 'image/png')
    })
  } catch {
    return null
  }
}

async function loadThumbnail(file: AgentFile): Promise<void> {
  if (thumbnails.value[file.path] || failed.value.has(file.path)) return
  if (!rootPath.value) return
  // Only real images get a thumbnail — html keeps an icon, and data/file kinds
  // (table / json / text / unknown binary) keep the placeholder tile: their
  // bytes are not decodable and would render as a broken <img>.
  if (file.kind !== 'image' && file.kind !== 'svg') return
  try {
    const blob = await readWorkspaceBlob(rootPath.value, file.path)
    // Downscale first; only if that fails do we pay for the full-size blob URL.
    const thumbUrl = await downscaleToThumbnail(blob)
    const url = thumbUrl ?? URL.createObjectURL(blob)
    thumbnails.value = { ...thumbnails.value, [file.path]: url }
  } catch {
    failed.value = new Set(failed.value).add(file.path)
  }
}

function onThumbnailRef(file: AgentFile, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLElement) ensureObserver(file, el)
}

/**
 * Open the file as an `agent-file` tab in THIS host. The old route went
 * through `documentsStore.openWorkspaceFile` (the Workbench center), which is
 * invisible while the user is on the Agent page — clicking "Open" silently
 * opened a document on a different surface. Routing through the Agent's own
 * tab host matches the transcript file-card click (AgentPage.onOpenFile)
 * so the preview shows where the user already is. A path that cannot be made
 * relative (absolute / escaping) is not openable as a workspace file; swallow.
 */
function openInDocument(file: AgentFile) {
  const wsId = workspaceStore.workspaceId
  if (!wsId) return
  try {
    agentTabsStore.open(
      { kind: 'agent-file', workspaceId: asWorkspaceId(wsId), path: asRelativePath(file.path) },
      { title: file.name },
    )
  } catch { /* asRelativePath rejects absolute/escaping paths — not openable */ }
}

// Revoke thumbnails when the active file set changes or the component unmounts.
const activePaths = computed(() => new Set(files.active.map((a) => a.path)))
watch(activePaths, (next, prev) => {
  if (!prev) return
  for (const path of prev) {
    if (!next.has(path)) {
      const url = thumbnails.value[path]
      if (url) URL.revokeObjectURL(url)
      observers.get(path)?.disconnect()
      observers.delete(path)
      const thumbs = { ...thumbnails.value }
      delete thumbs[path]
      thumbnails.value = thumbs
    }
  }
})

onBeforeUnmount(() => {
  for (const url of Object.values(thumbnails.value)) URL.revokeObjectURL(url)
  for (const observer of observers.values()) observer.disconnect()
  observers.clear()
})

/** Group header label — the producing exchange, not a raw id. */
function groupTitle(group: { kind: 'turn' | 'subagent'; turn?: number; role?: string }): string {
  return group.kind === 'turn'
    ? t('agent.files.turnGroup', { n: group.turn ?? 0 })
    : t('agent.files.subagentGroup', { role: group.role ?? '' })
}
</script>

<template>
  <div class="file-list">
    <Empty v-if="!files.hasFiles" :icon="DocumentIcon" :title="t('agent.inspector.empty.files')" />

    <template v-else>
      <section
        v-for="group in files.grouped"
        :key="group.key"
        class="file-list__group"
      >
        <header class="file-list__group-head">
          <span class="file-list__group-title">{{ groupTitle(group) }}</span>
          <span v-if="group.snippet" class="file-list__group-snippet" :title="group.snippet">{{ group.snippet }}</span>
        </header>
        <ul class="file-list__grid">
          <li
            v-for="file in group.files"
            :key="file.path"
            class="file-tile"
            :class="`file-tile--${file.kind}`"
            :title="file.path"
          >
            <button type="button" class="file-tile__thumb" :aria-label="file.name" :title="file.name" @click="openInDocument(file)">
              <img
                v-if="thumbnails[file.path]"
                :src="thumbnails[file.path]"
                :alt="file.name"
                class="file-tile__img"
                loading="lazy"
              />
              <span v-else-if="file.kind === 'html'" class="file-tile__icon" aria-hidden="true">
                <el-icon :size="28"><DocumentIcon /></el-icon>
              </span>
              <span
                v-else
                :ref="(el) => onThumbnailRef(file, el as Element | ComponentPublicInstance | null)"
                class="file-tile__placeholder"
                aria-hidden="true"
              />
              <span class="file-tile__kind">{{ file.kind }}</span>
            </button>
            <div class="file-tile__meta">
              <span class="file-tile__name">{{ file.name }}</span>
              <button type="button" class="file-tile__open" :title="t('agent.files.openInDocument')" @click="openInDocument(file)">
                {{ t('agent.files.openInDocument') }}
              </button>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.file-list {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  padding: var(--space-2);
}

.file-list__grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: var(--space-2);
}

.file-list__group + .file-list__group {
  margin-top: var(--space-3);
}

.file-list__group-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  margin-bottom: var(--space-1-5);
}

.file-list__group-title {
  flex: none;
  font-size: var(--text-label);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
}

.file-list__group-snippet {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

.file-tile {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.file-tile__thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 4 / 3;
  padding: 0;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.file-tile__thumb:hover { border-color: var(--color-border-control-hover); background: var(--color-hover); }
/* File-kind hue as a soft background tint, not a side-stripe border. The kind
   badge inside the thumb already carries the label; the tint reinforces it
   without the banned border-left accent (VISUAL-SYSTEM.md absolute bans). */
.file-tile--image .file-tile__thumb { background: color-mix(in srgb, var(--domain-file) 7%, var(--color-bg-secondary)); }
.file-tile--svg .file-tile__thumb { background: color-mix(in srgb, var(--domain-ptm) 7%, var(--color-bg-secondary)); }
.file-tile--html .file-tile__thumb { background: color-mix(in srgb, var(--domain-protein) 7%, var(--color-bg-secondary)); }

.file-tile__img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.file-tile__icon {
  color: var(--color-text-muted);
}

.file-tile__placeholder {
  width: 100%;
  height: 100%;
  background:
    linear-gradient(135deg, transparent 48%, var(--color-border-panel) 48%, var(--color-border-panel) 52%, transparent 52%),
    var(--color-bg);
  opacity: 0.5;
}

.file-tile__kind {
  position: absolute;
  bottom: var(--space-1);
  right: var(--space-1);
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-bg-tertiary) 80%, transparent);
  color: var(--color-text-muted);
  font-size: var(--text-label);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  pointer-events: none;
}

.file-tile__meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.file-tile__name {
  font-family: var(--font-mono);
  font-size: var(--text-mono);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tile__open {
  align-self: flex-start;
  border: none;
  background: none;
  padding: 0;
  color: var(--color-primary);
  font: inherit;
  font-size: var(--text-label);
  cursor: pointer;
}
.file-tile__open:hover { text-decoration: underline; }
</style>
