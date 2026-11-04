<!--
  SideChatTab — the panel side of the selection flow (ZCode's
  SelectionSideChatPane): a compact transcript + composer for a CHILD session
  spawned from a selection in the parent conversation.

  The child is an ordinary session at the runtime layer (own id, own event
  log, own binding — see `createSideSession`); only its UI home is special.
  Sends route by explicit sessionId (`turn.send(text, wsId, sessionId)`), so
  the main conversation stays active and untouched while the user works here.
  Approval requests land in the global queue rendered by the main page's
  PermissionCardDock — deliberately NOT inside this panel, so a consent ask
  raised by a side chat can never hide behind it.

  Closing the tab archives the child (still on disk, listed under Archived —
  restore/delete live there); deleting the parent cascades to it.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '@/stores/agent'
import { useWorkspaceStore } from '@/stores/workspace'
import { useAgentConversation } from '../agentConversation'
import { takeSideChatDraft } from '../side-chat-drafts'
import Transcript from '../Transcript.vue'
import IconButton from '@/components/primitives/IconButton.vue'

const props = defineProps<{
  /** The child session this panel drives. */
  sessionId: string
  /** The parent conversation the selection came from (provenance only). */
  parentSessionId: string
}>()

const { t } = useI18n()
const agentStore = useAgentStore()
const workspaceStore = useWorkspaceStore()
const { turn } = useAgentConversation()

const session = computed(() => agentStore.allSessions.find((s) => s.id === props.sessionId) ?? null)

// The seeded quote (from the selection pill) lands here exactly once; after
// that the draft is this panel's local state.
const draft = ref(takeSideChatDraft(props.sessionId) ?? '')

onMounted(() => {
  // A side chat restored across a reload hydrates from metadata only — read
  // its log before first render, same contract the main transcript follows.
  if (session.value && !session.value.historyHydrated) void turn.loadHistory(props.sessionId)
})

onBeforeUnmount(() => {
  // Retire the side chat when its panel goes away (tab close, session
  // switch): archived, never deleted — the disk log persists and the Archived
  // section of the session list keeps it reachable. A running turn is left
  // alone; archiving mid-flight would fight the turn's own settle path.
  const side = agentStore.allSessions.find((s) => s.id === props.sessionId)
  if (side && !side.turn.sending) agentStore.archiveSession(props.sessionId)
})

const streamingMessageId = computed(() => {
  const side = session.value
  if (!side || !side.turn.streaming) return null
  return side.messages.findLast?.((m) => m.role === 'assistant')?.id ?? null
})

const busy = computed(() => session.value?.turn.sending ?? false)

async function send() {
  const text = draft.value.trim()
  if (!text) return
  draft.value = ''
  await turn.send(text, workspaceStore.workspaceId, props.sessionId)
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void send()
  }
}
</script>

<template>
  <div v-if="session" class="side-chat">
    <p class="side-chat__provenance">
      {{ t('agent.sideChat.fromParent', { title: agentStore.allSessions.find((s) => s.id === parentSessionId)?.title || t('agent.sessionBar.untitled') }) }}
    </p>
    <Transcript
      class="side-chat__transcript"
      :messages="session.messages"
      :settlements="session.settlements"
      :session-id="session.id"
      :streaming-message-id="streamingMessageId"
      :pending="busy && !streamingMessageId"
      :loading="!session.historyHydrated"
    >
      <template #empty>
        <p class="side-chat__empty">{{ t('agent.sideChat.emptyHint') }}</p>
      </template>
    </Transcript>
    <div class="side-chat__composer">
      <textarea
        v-model="draft"
        class="side-chat__input"
        rows="2"
        :placeholder="t('agent.sideChat.inputPlaceholder')"
        @keydown="onComposerKeydown"
      />
      <IconButton
        size="sm"
        :aria-label="t('agent.sideChat.send')"
        :title="t('agent.sideChat.send')"
        :disabled="!draft.trim()"
        @click="send"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2.5 8h10M8.5 3.5 13 8l-4.5 4.5" />
        </svg>
      </IconButton>
    </div>
  </div>
  <p v-else class="side-chat__gone">{{ t('agent.sideChat.gone') }}</p>
</template>

<style scoped>
.side-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.side-chat__provenance {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-label);
  color: var(--color-text-muted);
  border-bottom: var(--line-w) solid var(--line-seam);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-chat__transcript {
  flex: 1;
  min-height: 0;
}

.side-chat__empty,
.side-chat__gone {
  margin: 0;
  padding: var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  text-align: center;
}

.side-chat__composer {
  display: flex;
  align-items: flex-end;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: var(--line-w) solid var(--line-seam);
}

.side-chat__input {
  flex: 1;
  resize: none;
  padding: var(--space-2) var(--space-2-5);
  font: inherit;
  font-size: var(--text-base);
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.side-chat__input:focus {
  outline: none;
  border-color: var(--color-ring);
}
</style>
