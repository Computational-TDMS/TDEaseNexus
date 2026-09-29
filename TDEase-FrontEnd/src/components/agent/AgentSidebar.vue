<!--
  AgentSidebar — the Workbench's right-docked Agent view.

  The same conversation as the full Agent page — literally the same singleton
  (`agentConversation.ts`): one turn runtime, one draft, one slash registry,
  two views. The composer is live; typing here writes the shared draft and
  sending routes through the shared turn. What deliberately stays on the full
  page: the approval dock (ONE permission surface, so its global keydown and
  focus handling can never be fought over by two hosts) — when an approval is
  pending this sidebar shows a strip that pulls the door to the full page.

  Tonal layering (§1.1): the column sits on the content surface with no
  hairlines; separation from the document surface is the ResizableSplit seam.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Transcript from './Transcript.vue'
import Composer from './Composer.vue'
import { useAgentStore } from '@/stores/agent'
import { useUiLayoutStore } from '@/stores/uiLayout'
import { useAgentConversation } from './agentConversation'
import type { TurnSettlement } from '@/agent/events'

const { t } = useI18n()
const agentStore = useAgentStore()
const uiLayout = useUiLayoutStore()

const {
  turn, composerInput, localMcpServers, slashRegistry,
  dispatchSlash, sendFromComposer, stopTurn, dequeuePrompt,
} = useAgentConversation()

/** Stable empty fallback so a sessionless render passes one shared map, not a fresh allocation. */
const EMPTY_SETTLEMENTS: ReadonlyMap<string, TurnSettlement> = new Map()

// The in-flight assistant message, exactly as the full page derives it.
const streamingMessageId = computed(() =>
  turn.streaming.value
    ? (agentStore.active?.messages.findLast?.((m) => m.role === 'assistant')?.id ?? null)
    : null)
const pending = computed(() =>
  turn.sending.value && !agentStore.active?.turn.compacting && turn.hud.phase === 'waiting')
const historyLoading = computed(() => {
  const active = agentStore.active
  return !active || !active.historyHydrated
})
const approvalCount = computed(() => agentStore.pendingApprovals.length)
const isLive = computed(() => turn.sending.value || turn.streaming.value)

/** Pull the door: the full Agent page (where the approval dock lives). */
function pullDoor(): void {
  uiLayout.setActivePage('agent')
}
</script>

<template>
  <aside class="agent-sidebar" :aria-label="t('workbench.agentSidebar.label')">
    <header class="agent-sidebar__head">
      <span
        class="agent-sidebar__status"
        :class="{ 'is-live': isLive }"
        :title="isLive ? t('workbench.agentSidebar.live') : undefined"
        aria-hidden="true"
      />
      <span class="agent-sidebar__title">{{ t('workbench.agentSidebar.title') }}</span>
      <!-- One quiet action: start a fresh session. The full page keeps the
           whole session bar; the dock only ever needs "new". -->
      <button
        type="button"
        class="agent-sidebar__new"
        :title="t('workbench.agentSidebar.newSession')"
        :aria-label="t('workbench.agentSidebar.newSession')"
        @click="agentStore.createSession()"
      >
        {{ t('workbench.agentSidebar.newSession') }}
      </button>
    </header>

    <!-- `--composer-clear: 0`: the full page's floating composer reserves
         transcript clearance by height; here the composer is in flow below,
         so nothing floats over the tail. -->
    <Transcript
      class="agent-sidebar__transcript"
      :messages="agentStore.active?.messages ?? []"
      :settlements="agentStore.active?.settlements ?? EMPTY_SETTLEMENTS"
      :session-id="agentStore.active?.id ?? null"
      :streaming-message-id="streamingMessageId"
      :pending="pending"
      :compacting="agentStore.active?.turn.compacting ?? false"
      :loading="historyLoading"
      :style="{ '--composer-clear': '0px' }"
      @continue-turn="pullDoor"
      @answer-turn="(answer: string) => sendFromComposer(answer)"
      @open-file="pullDoor"
    >
      <template #empty>
        <p class="agent-sidebar__empty">{{ t('workbench.agentSidebar.empty') }}</p>
      </template>
    </Transcript>

    <!-- ONE permission surface lives on the full page; here an approval is a
         strip that expands to it, not a second dock. -->
    <button
      v-if="approvalCount > 0"
      type="button"
      class="agent-sidebar__approvals"
      :aria-label="t('workbench.agentSidebar.goHandle')"
      @click="pullDoor"
    >
      {{ t('workbench.agentSidebar.pendingCount', { count: approvalCount }) }}
      <span class="agent-sidebar__approvals-action">{{ t('workbench.agentSidebar.goHandle') }}</span>
    </button>

    <div class="agent-sidebar__composer">
      <Composer
        v-model="composerInput"
        :attachments="false"
        :commands="slashRegistry"
        :skills="turn.skills.value"
        :mcp-servers="localMcpServers"
        :busy="turn.sending.value"
        :queued="agentStore.active?.queuedPrompts ?? []"
        :mindset="turn.mindset.value"
        :authority="turn.permissionMode.value"
        :thinking-level="turn.thinkingLevel.value"
        @update:mindset="turn.mindset.value = $event"
        @update:authority="turn.permissionMode.value = $event"
        @update:thinking-level="turn.thinkingLevel.value = $event"
        @send="sendFromComposer"
        @stop="stopTurn"
        @dequeue="dequeuePrompt"
        @slash="dispatchSlash"
      />
    </div>
  </aside>
</template>

<style scoped>
.agent-sidebar {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--color-bg-secondary, var(--color-bg));
  overflow: hidden;
}

.agent-sidebar__head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}

.agent-sidebar__status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-border);
  flex: 0 0 auto;
}

/* Alive = the living channel (§1.2): a static glow dot, no animation. */
.agent-sidebar__status.is-live {
  background: var(--color-live);
  box-shadow: 0 0 6px var(--color-live-glow);
}

.agent-sidebar__title {
  font-size: var(--text-sm);
  color: var(--color-text);
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-sidebar__new {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  cursor: pointer;
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  transition: color var(--dur-instant) var(--ease-out);
}

.agent-sidebar__new:hover {
  color: var(--color-primary);
}

.agent-sidebar__new:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.agent-sidebar__transcript {
  flex: 1 1 auto;
  min-height: 0;
}

.agent-sidebar__empty {
  margin: 0;
  padding: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

/* An approval is time-sensitive, so it floats ABOVE the composer (the
   z-index ladder's overlay rung) — same register as the full page's dock. */
.agent-sidebar__approvals {
  position: absolute;
  bottom: 100%;
  left: var(--space-3);
  right: var(--space-3);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: 0 0 var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: var(--line-w) solid var(--elev-2-border, var(--line-seam));
  border-radius: var(--radius-sm);
  background: var(--elev-2-bg);
  box-shadow: var(--elev-2);
  color: var(--color-text);
  font-size: var(--text-sm);
  cursor: pointer;
  z-index: var(--z-overlay);
}

.agent-sidebar__approvals:hover {
  border-color: var(--color-primary);
}

.agent-sidebar__approvals-action {
  color: var(--color-primary);
  white-space: nowrap;
}

.agent-sidebar__composer {
  flex: 0 0 auto;
  position: relative; /* the approvals strip anchors to this block's top edge */
  padding: 0 var(--space-3) var(--space-3);
  min-width: 0;
}
</style>
