<template>
  <aside class="session-list" :class="{ 'session-list--headerless': headerless }">
    <div v-if="!headerless" class="session-list-header">
      <span class="header-title">{{ t('agent.sessionBar.sessionsLabel') }}</span>
      <button class="new-session" @click="$emit('new')">{{ t('agent.sessionBar.new') }}</button>
    </div>
    <!-- The New button still has to be reachable in the headerless variant
         (it's the one action the SessionBar dropdown can't show via its title),
         so render a slim row of just that action when the full header is off. -->
    <div v-else class="session-list-header session-list-header--actions">
      <button class="new-session" @click="$emit('new')">{{ t('agent.sessionBar.new') }}</button>
    </div>
    <div v-auto-animate="autoAnimateOpts" class="session-items">
      <div v-if="list.length === 0" class="session-empty">{{ t('agent.sessionBar.empty') }}</div>
      <div
        v-for="s in list"
        :key="s.id"
        class="session-item"
        :class="{ active: s.id === agentStore.activeId }"
        role="button"
        tabindex="0"
        :aria-current="s.id === agentStore.activeId ? 'page' : undefined"
        @click="agentStore.selectSession(s.id)"
        @keydown.enter.prevent="agentStore.selectSession(s.id)"
        @keydown.space.prevent="agentStore.selectSession(s.id)"
      >
        <div class="session-main">
          <span class="session-title" :title="sessionDisplayTitle(s)">{{ sessionDisplayTitle(s) }}</span>
          <span class="session-time">
            <span v-if="sessionIsWorking(s)" class="runtime-dots" role="img" :aria-label="t('agent.sessionBar.runtimeStreaming')" />
            <i v-else :class="['runtime-indicator', statusClass(s)]" role="img" :aria-label="statusLabel(s)" />
            {{ formatTime(s.updatedAt) }}
          </span>
        </div>
        <div class="session-ops">
          <IconButton v-if="s.id === agentStore.activeId" size="xs" :aria-label="t('agent.sessionBar.fork')" :title="t('agent.sessionBar.fork')" @click.stop="$emit('fork', s.id)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="4" cy="3.5" r="1.7" /><circle cx="4" cy="12.5" r="1.7" /><circle cx="12" cy="6.5" r="1.7" /><path d="M4 5.2v5.6M4 6.5c0 2.2 2.4 2.6 6.3 1.2" />
            </svg>
          </IconButton>
          <IconButton size="xs" :aria-label="t('agent.sessionBar.archive')" :title="t('agent.sessionBar.archive')" @click.stop="agentStore.archiveSession(s.id)">
            <Close />
          </IconButton>
          <!-- Archive is the ONLY exit from the list. There is no delete: a
               conversation is work the user can never reproduce, and an
               unrecoverable loss is a worse trade than a longer archive list. -->
        </div>
      </div>

      <!-- Archived sessions: persisted but out of the way (ZCode's archived
           flat section). Collapsed by default; restore pulls a session back
           into the main list. Archive is terminal-safe: nothing here deletes. -->
      <div v-if="archivedList.length > 0" class="session-archived">
        <button
          type="button"
          class="archived-toggle"
          :aria-expanded="archivedOpen"
          @click="archivedOpen = !archivedOpen"
        >
          <span class="archived-arrow" :class="{ open: archivedOpen }" aria-hidden="true">›</span>
          {{ t('agent.sessionBar.archived') }} ({{ archivedList.length }})
        </button>
        <template v-if="archivedOpen">
          <div
            v-for="s in archivedList"
            :key="s.id"
            class="session-item session-item--archived"
            role="button"
            tabindex="0"
            @click="agentStore.selectSession(s.id)"
            @keydown.enter.prevent="agentStore.selectSession(s.id)"
          >
            <div class="session-main">
              <span class="session-title" :title="sessionDisplayTitle(s)">{{ sessionDisplayTitle(s) }}</span>
              <span class="session-time">{{ formatTime(s.updatedAt) }}</span>
            </div>
            <div class="session-ops">
              <IconButton size="xs" :aria-label="t('agent.sessionBar.unarchive')" :title="t('agent.sessionBar.unarchive')" @click.stop="agentStore.unarchiveSession(s.id)">
                <RefreshLeft />
              </IconButton>
            </div>
          </div>
        </template>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Close, RefreshLeft } from '@element-plus/icons-vue'
import { useAgentStore, type AgentSession } from '@/stores/agent'
import { useSubagentsStore } from '@/stores/subagents'
import { useI18n } from 'vue-i18n'
import IconButton from '@/components/primitives/IconButton.vue'
import { vAutoAnimate } from '@formkit/auto-animate/vue'

const { t } = useI18n()

// auto-animate options — duration/easing from the project's design tokens so
// list enter/leave/reorder motion matches every other transition in the shell.
// Read from CSS vars at mount; static after that (the token values don't
// change at runtime).
const autoAnimateOpts = {
  duration: 220,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
}
withDefaults(defineProps<{
  /**
   * Suppress the "Sessions" header row. The SessionBar dropdown already labels
   * itself as a session switcher via its title button, so embedding a second
   * "Sessions + New" header inside the dropdown duplicated the left pane's.
   * The New action still renders (slim row) so it stays reachable here.
   */
  headerless?: boolean
}>(), {
  headerless: false,
})
defineEmits<{ new: []; fork: [id: string] }>()
const agentStore = useAgentStore()
const subagentsStore = useSubagentsStore()
const list = computed(() => agentStore.sessions)
const archivedList = computed(() => agentStore.archivedSessions)
const archivedOpen = ref(false)

/**
 * Until a session is named, its title is a localized placeholder — never a
 * persisted literal. `recovered` (reconstructed from disk) shows a distinct
 * label so the user knows where the session came from; both collapse to the
 * real title the moment the first user message names it.
 */
function sessionDisplayTitle(s: { untitled?: boolean; recovered?: boolean; title: string }): string {
  if (s.untitled) return s.recovered ? t('agent.sessionBar.recovered') : t('agent.sessionBar.untitled')
  return s.title
}

/**
 * A session is WORKING while its own turn is in flight OR any of its
 * subagents is still running. A fire-and-forget spawn settles the parent
 * turn before its children finish (§6 results inject on the NEXT turn), so
 * `turn.sending` alone reported "idle" while background children were still
 * working — the sidebar spinner stopped mid-work.
 */
function sessionIsWorking(s: AgentSession): boolean {
  if (s.turn?.sending) return true
  return (subagentsStore.snapshots[s.id] ?? []).some((r) => r.state === 'running')
}

/**
 * The per-session status indicator has four states, in priority order:
 *
 *   working    — a turn is in flight, or background subagents are still
 *                running (rotating arc spinner — motion IS the signal)
 *   unread     — a turn settled while the user was viewing another session;
 *                the result landed but has not been seen (solid dot)
 *   failed     — the last turn failed (solid error-coloured dot)
 *   idle       — at rest (faint dot)
 *
 * The shape and motion carry the meaning, not colour alone: the spin is what
 * distinguishes "working" from "has something new", so the two are never
 * confused at a glance.
 */
function statusClass(s: AgentSession): string {
  if (s.turn?.unreadSettlement) return s.turn.lastOutcome === 'failed' ? 'runtime-indicator--failed' : 'runtime-indicator--unread'
  if (s.runtimeStatus === 'failed') return 'runtime-indicator--failed'
  return 'runtime-indicator--idle'
}

function statusLabel(s: AgentSession): string {
  if (s.turn?.unreadSettlement) return t('agent.sessionBar.runtimeUnread')
  if (s.runtimeStatus === 'failed') return t('agent.sessionBar.runtimeFailed')
  return t('agent.sessionBar.runtimeIdle')
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? d.toTimeString().slice(0, 5) : `${d.getMonth() + 1}/${d.getDate()}`
}
</script>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary);
  border-right: var(--line-w) solid var(--line-seam);
  overflow: hidden;
  min-width: 220px;
}
.session-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-3) var(--space-2-5);
  border-bottom: var(--line-w) solid var(--line-seam);
  flex-shrink: 0;
}
.session-list-header--actions { padding: var(--space-2) var(--space-3); }
.header-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--color-text);
}
.new-session { border: 0; background: none; color: var(--color-primary); cursor: pointer; font: inherit; font-size: var(--text-sm); padding: var(--space-1-5) 0; }
.new-session:hover { color: var(--color-text); }
.session-items { flex: 1; overflow-y: auto; padding: var(--space-2); }
.session-empty { padding: var(--space-4) var(--space-3); font-size: var(--text-sm); color: var(--color-text-muted); text-align: center; }
.session-item {
  display: flex; align-items: center; gap: var(--space-1); padding: var(--space-2-5) var(--space-2);
  border-radius: var(--radius-sm); cursor: pointer; transition: background-color var(--dur-fast) var(--ease-out);
  border: 1px solid transparent;
}
.session-item:hover,
.session-item:focus-visible { background: var(--color-bg-hover); }
.session-item:focus-visible { outline: none; }
/* Active = the chrome selection voice (interact soft tint + blue text), the
   same pair NavigatorPanel tabs and DocumentTabs use — one "selected" language
   across every switcher. The old hover-fill + hairline border read active and
   hover identically and bolted a ghost outline onto the tint. */
.session-item.active { background: var(--color-interact-soft); }
.session-item.active .session-title { color: var(--color-interact-text); }
.session-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1-5); }
.session-title { font-size: var(--text-base); color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-time { font-size: var(--text-label); color: var(--color-text-muted); display: flex; align-items: center; gap: var(--space-1); }
/* The indicator is a fixed 10×10 box so switching between states never shifts
   the time text. Each state draws its glyph via ::before, centred in the box. */
.runtime-indicator { width: 10px; height: 10px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; }
/* idle: faint, small — the session is at rest, the indicator barely asserts. */
.runtime-indicator--idle::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--color-text-muted); opacity: 0.35; }
/* unread: solid primary dot — new results waiting to be viewed. */
.runtime-indicator--unread::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--color-primary); }
/* failed: solid error dot — same weight as unread, in the danger tone. */
.runtime-indicator--failed::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--color-error); }
/* Working: the app's dots shimmer — `...` revealed one dot at a time by a
   stepped width animation, the same idiom ThinkingBlock/ToolGroupBlock use
   for "work in progress", so one language everywhere. No JS timer, no
   re-render; the span is the animation. */
.runtime-dots {
  display: inline-block;
  flex: 0 0 auto;
  min-width: 14px;
  font-size: var(--text-label);
  font-weight: 700;
  letter-spacing: 0.1em;
  line-height: 1;
  color: var(--status-running, var(--color-primary));
}
.runtime-dots::after {
  content: '...';
  display: inline-block;
  width: 0;
  overflow: hidden;
  animation: runtime-dots-reveal 1.4s steps(4, end) infinite;
}
@keyframes runtime-dots-reveal {
  0%   { width: 0; }
  100% { width: 1.4em; }
}
/* Reduced motion: a static ellipsis still reads as "in progress" (it is the
   conventional glyph), so unlike a spinner there is nothing essential to
   preserve — freeze it, matching .tool-dots / .thinking-dots. */
@media (prefers-reduced-motion: reduce) {
  .runtime-dots::after { animation: none; width: 1.4em; }
}
.session-ops { display: flex; gap: var(--space-1-5); opacity: 0; transition: opacity var(--dur-fast) var(--ease-out); }
/* Keyboard parity (WCAG 2.4.7): hover reveals the ops, and so does focus
   landing anywhere inside the row — so a keyboard user can reach and trigger
   fork/archive without first having to hover with a pointer. */
.session-item:hover .session-ops,
.session-item:focus-within .session-ops { opacity: 1; }
/* IconButton already owns the shape + states; scope its footprint down here so
   it fits the row's height without dominating it. */
.session-ops :deep(.icon-button) { width: 20px; height: 20px; }
.session-ops :deep(.icon-button .el-icon) { font-size: 11px; }

/* ── Archived section ─────────────────────────────────────────────────────── */
.session-archived {
  margin-top: var(--space-2);
  padding-top: var(--space-1);
  border-top: var(--line-w) solid var(--line-seam);
}
.archived-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  border: 0;
  background: none;
  cursor: pointer;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  padding: var(--space-1-5) var(--space-2);
  text-align: left;
}
.archived-toggle:hover { color: var(--color-text); }
.archived-arrow {
  display: inline-block;
  width: 0.8em;
  transition: transform var(--dur-fast) var(--ease-out);
}
.archived-arrow.open { transform: rotate(90deg); }
.session-item--archived .session-title { color: var(--color-text-muted); }
</style>
