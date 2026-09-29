<!--
  SubagentConversation — one subagent's full conversation, as an Agent tab.

  A subagent is a child session whose `sessionId` equals its `subagentId`, and
  whose events persist to `<workspace>/.tdease/sessions/<subagentId>/events
  .jsonl` by the same writer the parent session uses. So reading its
  conversation needs NO new IPC — this component reuses the exact path
  `useAgentTurn.loadHistory` uses: `createWorkspaceSessionLog(...).readWith
  Presence()` → `projectSessionEvents()` → `messages`, then renders them with
  the same `Transcript` the parent conversation uses. One viewer, not two.

  The header's state/elapsed reads the live record from the subagents store, so
  a still-running child's header keeps updating even though its transcript body
  is a disk snapshot (the events file is appended to as the child works; this
  view is read once on open and cached by the host's KeepAlive — close + reopen
  to see later turns).

  `open-file` (a media card the child produced) is handled here, not bubbled
  to AgentPage: it opens an `agent-file` tab in the same host, so a file the
  child cited is reachable without leaving the subagent's conversation.
-->
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Transcript from './Transcript.vue'
import Empty from '@/components/primitives/Empty.vue'
import Skeleton from '@/components/primitives/Skeleton.vue'
import StatusMark, { type RunStatus as MarkStatus } from '@/components/primitives/StatusMark.vue'
import { useLiveSessionProjection } from './useLiveSessionProjection'
import { useWorkspaceStore } from '@/stores/workspace'
import { useSubagentsStore } from '@/stores/subagents'
import { useAgentTabsStore } from '@/stores/agentTabs'
import { asWorkspaceId, asRelativePath } from '@/studio/domain/identity'

const props = defineProps<{ subagentId: string; role: string }>()

const { t } = useI18n()
const workspaceStore = useWorkspaceStore()
const subagents = useSubagentsStore()
const agentTabsStore = useAgentTabsStore()

// The live, streaming projection of this child's session — the same
// disk-history + live `event_committed` design the main turn uses. The header
// below reads the registry record for live state/elapsed; the body streams the
// child's conversation as it works (tool calls, thinking, results land in real
// time; the assistant text appears when its `message.completed` commits).
const { messages, settlements, status, loadError } = useLiveSessionProjection(() => props.subagentId)

/** Live record for the header (state/elapsed). Reactivity follows the store. */
const record = computed(() => subagents.byId(props.subagentId))
const stateLabel = computed(() => {
  switch (record.value?.state) {
    case 'running': return t('agent.subagent.state.running')
    case 'returned': return t('agent.subagent.state.returned')
    case 'blocked': return t('agent.subagent.state.blocked')
    case 'cancelled': return t('agent.subagent.state.cancelled')
    default: return ''
  }
})
function stateToMark(s: string | undefined): MarkStatus | null {
  if (s === 'running') return 'running'
  if (s === 'returned') return 'succeeded'
  if (s === 'blocked') return 'failed'
  if (s === 'cancelled') return 'cancelled'
  return null
}

function elapsedLabel(elapsedS: number | undefined): string {
  if (!elapsedS) return ''
  if (elapsedS < 60) return `${elapsedS}s`
  const m = Math.floor(elapsedS / 60)
  const s = elapsedS % 60
  return `${m}m ${s}s`
}

/** A media file the child produced was clicked in its transcript. Open it
 *  as an `agent-file` tab in this same host — the same route a parent-session
 *  file click takes. */
function onOpenFile(file: { path: string; kind: 'image' | 'svg' | 'html' | 'table' | 'json' | 'text' | 'file'; name: string }) {
  const wsId = workspaceStore.workspaceId
  if (!wsId) return
  try {
    agentTabsStore.open(
      { kind: 'agent-file', workspaceId: asWorkspaceId(wsId), path: asRelativePath(file.path) },
      { title: file.name },
    )
  } catch { /* asRelativePath rejects absolute/escaping paths */ }
}

// Best-effort peek so the panel/capsule has recent activity even before the
// user opens this tab; the streaming projection above is the live source.
onMounted(() => { void subagents.peek(props.subagentId) })
</script>

<template>
  <div class="subagent-conversation">
    <header class="subagent-conversation__header">
      <StatusMark v-if="stateToMark(record?.state)" :status="stateToMark(record?.state)!" size="sm" />
      <span class="subagent-conversation__role" :title="props.role">{{ props.role }}</span>
      <span v-if="stateLabel" class="subagent-conversation__state">{{ stateLabel }}</span>
      <span v-if="record?.elapsedS" class="subagent-conversation__elapsed">{{ elapsedLabel(record.elapsedS) }}</span>
    </header>

    <div class="subagent-conversation__body">
      <div v-if="status === 'loading'" class="subagent-conversation__loading">
        <Skeleton variant="block" :height="240" />
      </div>

      <Transcript
        v-else-if="status === 'ready'"
        class="subagent-conversation__transcript"
        :messages="messages"
        :settlements="settlements"
        @open-file="onOpenFile"
      />

      <!-- error: the log EXISTS but could not be read (corrupt/truncated).
           This must never wear the 'missing' copy — claiming the record is
           "not on disk" sends the user hunting for a file that is right
           there. The read failure is the diagnostic; show it. -->
      <Empty
        v-else-if="status === 'error'"
        :title="t('agent.subagent.conversationErrorTitle')"
        :description="t('agent.subagent.conversationErrorDescription', { message: loadError ?? '' })"
      />

      <!-- missing: the subagent's session log is not on disk. Most often the
           child is still running and has not flushed events yet, or the run
           pre-dates session persistence. Fall back to the peek snippet so the
           view is not empty. -->
      <Empty
        v-else
        :title="t('agent.subagent.conversationMissingTitle')"
        :description="t('agent.subagent.conversationMissingDescription')"
      />
    </div>
  </div>
</template>

<style scoped>
.subagent-conversation {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.subagent-conversation__header {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-height: var(--header-h);
  padding: 0 var(--space-3);
  border-bottom: var(--line-w) solid var(--line-hairline);
  background: var(--color-bg-secondary);
}

.subagent-conversation__role {
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-conversation__state {
  margin-left: auto;
  font-size: var(--text-label);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.subagent-conversation__elapsed {
  font-family: var(--font-mono);
  font-size: var(--text-mono);
  color: var(--color-text-muted);
}

.subagent-conversation__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}

.subagent-conversation__loading {
  padding: var(--space-3);
}

/* The transcript fills the body; its own scroll lives inside. */
.subagent-conversation__transcript {
  flex: 1 1 auto;
  min-height: 0;
}
</style>
