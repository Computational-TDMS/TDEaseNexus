<!--
  SubagentPanel — the floating subagents sidebar (NOT a session tab).

  Lives in the Agent page's right rail as a third state (alongside AgentTabHost
  and ActivityCapsule), toggled by Ctrl+Shift+D / the ActivityCapsule row. It is
  deliberately NOT an agentTabsStore entry: subagents are an ambient activity
  stream, not a document you pin. Four sections: parallel groups, the flat run
  list (reuses SubagentList), the selected run's result envelope, and a
  conversation peek (recent tools + last assistant snippet).

  Reads useSubagentsStore, which auto-follows the active session. Cancel forwards
  to the store; peek calls the bridge best-effort (degrades to nothing on hosts
  without the peek IPC). There is no second data model — the store mirrors the
  Node SubagentRegistry's SubagentStatus projection one-for-one.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Close, View, ChatDotRound } from '@element-plus/icons-vue'
import AppButton from '@/components/primitives/AppButton.vue'
import SubagentList from './SubagentList.vue'
import { useSubagentsStore } from '@/stores/subagents'
import { useAgentTabsStore } from '@/stores/agentTabs'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()
const store = useSubagentsStore()
const agentTabsStore = useAgentTabsStore()

const selectedId = ref<string | null>(null)

/** Flat records: those NOT in a parallel group. */
const flat = computed(() => store.active.filter((r) => !r.groupId))
const selected = computed(() => (selectedId.value ? store.byId(selectedId.value) : undefined))
const selectedPeek = computed(() => (selectedId.value ? store.peeks[selectedId.value] : undefined))

function close(): void { emit('update:open', false) }
function onCancel(id: string): void { void store.cancel(id) }

/** Open this child's full conversation as a tab — same route the capsule list
 *  uses. Keeps the two subagent surfaces (floating panel + capsule list)
 *  consistent: either one can reach a child's conversation. */
function openConversation(id: string, role: string): void {
  agentTabsStore.open({ kind: 'agent-subagent', subagentId: id, role }, { title: role })
}

/** Summary line for a parallel group: "2 returned, 1 running". */
function groupSummary(members: ReadonlyArray<{ state: string }>): string {
  const counts = new Map<string, number>()
  for (const m of members) counts.set(m.state, (counts.get(m.state) ?? 0) + 1)
  return [...counts.entries()].map(([state, n]) => `${n} ${state}`).join(', ')
}

/** Load a peek for the selected run (best-effort). */
function peekSelected(): void {
  if (selectedId.value) void store.peek(selectedId.value)
}

/** Findings are free-form (`unknown[]` per the report-back contract): render
 *  strings as-is, objects through their text-ish field, the rest as compact
 *  JSON — same quiet list voice as openQuestions/evidence above. */
function findingText(finding: unknown): string {
  if (typeof finding === 'string') return finding
  if (finding && typeof finding === 'object') {
    const rec = finding as Record<string, unknown>
    for (const key of ['text', 'summary', 'title', 'description']) {
      const value = rec[key]
      if (typeof value === 'string' && value.trim()) return value
    }
  }
  return JSON.stringify(finding)
}

// Auto-peek when a running run is selected, so the panel shows live progress.
watch(selectedId, (id) => { if (id) void store.peek(id) })
</script>

<template>
  <aside v-if="props.open" class="subagent-panel" role="complementary" :aria-label="t('agent.subagent.label', 'Subagents')">
    <header class="subagent-panel__head">
      <h2 class="subagent-panel__title">{{ t('agent.subagent.label', 'Subagents') }}</h2>
      <span v-if="store.runningCount" class="subagent-panel__running">{{ store.runningCount }} running</span>
      <AppButton variant="subtle" size="sm" class="subagent-panel__close" :aria-label="t('common.button.close')" @click="close">
        <el-icon :size="14"><Close /></el-icon>
      </AppButton>
    </header>

    <div class="subagent-panel__body">
      <!-- § Parallel groups / fleet -->
      <section v-if="store.groups.length" class="subagent-panel__section">
        <h3 class="subagent-panel__section-title">{{ t('agent.subagent.groups', 'Parallel groups') }}</h3>
        <ul class="subagent-panel__groups">
          <li v-for="group in store.groups" :key="group.groupId" class="subagent-group">
            <div class="subagent-group__head">
              <span class="subagent-group__id">{{ group.groupId.slice(0, 13) }}</span>
              <span class="subagent-group__summary">{{ groupSummary(group.members) }}</span>
            </div>
            <ul class="subagent-group__members">
              <li
                v-for="m in group.members" :key="m.subagentId"
                class="subagent-group__member" :class="`is-${m.state}`"
                @click="selectedId = m.subagentId"
              >
                <span class="subagent-group__member-role">{{ m.role }}</span>
                <span class="subagent-group__member-state">{{ m.state }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <!-- § Flat run list -->
      <section class="subagent-panel__section subagent-panel__section--list">
        <h3 v-if="store.groups.length" class="subagent-panel__section-title">{{ t('agent.subagent.individual', 'Individual subagents') }}</h3>
        <SubagentList :records="flat" :loading="store.loading" @cancel="onCancel" />
      </section>

      <!-- § Selected result envelope -->
      <section v-if="selected?.result" class="subagent-panel__section">
        <div class="subagent-panel__result-head">
          <h3 class="subagent-panel__section-title">{{ selected.role }} — {{ t('agent.subagent.result', 'result') }}</h3>
          <AppButton
            v-if="selectedId"
            variant="subtle"
            size="sm"
            :title="t('agent.subagent.openConversation', 'Open conversation')"
            @click="openConversation(selectedId, selected.role)"
          >
            <el-icon :size="14"><ChatDotRound /></el-icon>
          </AppButton>
        </div>
        <dl class="subagent-panel__envelope">
          <div v-if="selected.result.confidence" class="subagent-panel__envelope-row">
            <dt>{{ t('agent.subagent.confidence', 'confidence') }}</dt><dd>{{ selected.result.confidence }}</dd>
          </div>
          <div v-if="selected.result.findings.length" class="subagent-panel__envelope-row">
            <dt>{{ t('agent.subagent.findings', 'findings') }}</dt>
            <dd>
              <ul class="subagent-panel__questions">
                <li v-for="(finding, i) in selected.result.findings" :key="i">{{ findingText(finding) }}</li>
              </ul>
            </dd>
          </div>
          <div v-if="selected.result.evidenceLinks.length" class="subagent-panel__envelope-row">
            <dt>{{ t('agent.subagent.evidence', 'evidence') }}</dt>
            <dd>
              <span v-for="(link, i) in selected.result.evidenceLinks" :key="i" class="subagent-panel__link">
                {{ link.label }}
              </span>
            </dd>
          </div>
          <div v-if="selected.result.openQuestions.length" class="subagent-panel__envelope-row">
            <dt>{{ t('agent.subagent.openQuestions', 'open questions') }}</dt>
            <dd>
              <ul class="subagent-panel__questions">
                <li v-for="(q, i) in selected.result.openQuestions" :key="i">{{ q }}</li>
              </ul>
            </dd>
          </div>
        </dl>
      </section>

      <!-- § Conversation peek -->
      <section v-if="selected" class="subagent-panel__section">
        <div class="subagent-panel__peek-head">
          <h3 class="subagent-panel__section-title">{{ t('agent.subagent.peek', 'activity') }}</h3>
          <AppButton variant="subtle" size="sm" :title="t('agent.subagent.refreshPeek', 'refresh')" @click="peekSelected">
            <el-icon :size="14"><View /></el-icon>
          </AppButton>
        </div>
        <div v-if="selected.error" class="subagent-panel__error">{{ selected.error.message }}</div>
        <div v-else-if="selectedPeek" class="subagent-panel__peek">
          <div v-if="selectedPeek.recentTools?.length" class="subagent-panel__tools">
            <span v-for="tool in selectedPeek.recentTools" :key="tool" class="subagent-panel__tool-chip">{{ tool }}</span>
          </div>
          <pre v-if="selectedPeek.lastAssistantSnippet" class="subagent-panel__snippet">{{ selectedPeek.lastAssistantSnippet }}</pre>
          <p v-else-if="!selectedPeek.recentTools?.length" class="subagent-panel__muted">{{ t('agent.subagent.noActivity', 'No activity yet.') }}</p>
        </div>
        <p v-else class="subagent-panel__muted">{{ t('agent.subagent.peekHint', 'Press the eye icon to peek.') }}</p>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.subagent-panel {
  display: flex;
  flex-direction: column;
  flex: 0 0 38%;
  min-width: 300px;
  max-width: 540px;
  border-left: var(--line-w) solid var(--line-seam);
  background: var(--color-bg-primary);
  overflow: hidden;
}
.subagent-panel__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-seam);
  flex-shrink: 0;
}
.subagent-panel__title { margin: 0; font-size: var(--text-base); font-weight: 600; color: var(--color-text); }
.subagent-panel__running {
  font-size: var(--text-label); text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--status-running, var(--color-text-muted));
}
.subagent-panel__close { margin-left: auto; }
.subagent-panel__body {
  display: flex; flex-direction: column;
  min-height: 0; overflow-y: auto;
}
.subagent-panel__section {
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-seam);
}
.subagent-panel__section--list { padding: 0; }
.subagent-panel__section-title {
  margin: 0 0 var(--space-2) 0;
  font-size: var(--text-label); text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--color-text-muted);
}
.subagent-panel__groups { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.subagent-group {
  padding: var(--space-2);
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
}
.subagent-group__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-1); }
.subagent-group__id { font-family: var(--font-mono); font-size: var(--text-mono); color: var(--color-text-muted); }
.subagent-group__summary { font-size: var(--text-label); color: var(--color-text-secondary); }
.subagent-group__members { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.subagent-group__member {
  display: flex; justify-content: space-between; align-items: center;
  padding: 2px var(--space-1); border-radius: var(--radius-sm);
  cursor: pointer; font-size: var(--text-sm);
}
.subagent-group__member:hover { background: var(--color-bg-tertiary, var(--color-bg-secondary)); }
.subagent-group__member-role { color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subagent-group__member-state { font-size: var(--text-label); color: var(--color-text-muted); text-transform: uppercase; }

.subagent-panel__envelope { margin: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.subagent-panel__envelope-row { display: flex; flex-direction: column; gap: 2px; }
.subagent-panel__envelope-row dt { font-size: var(--text-label); text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-muted); }
.subagent-panel__envelope-row dd { margin: 0; }
.subagent-panel__link {
  display: inline-block; margin: 0 var(--space-1) var(--space-1) 0;
  padding: 1px var(--space-1); border-radius: var(--radius-sm);
  background: var(--color-bg-secondary); font-size: var(--text-sm);
}
.subagent-panel__questions { margin: 0; padding-left: var(--space-3); font-size: var(--text-sm); color: var(--color-text-secondary); }

.subagent-panel__peek-head { display: flex; align-items: center; justify-content: space-between; }
.subagent-panel__result-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-2); }
.subagent-panel__tools { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-bottom: var(--space-1); }
.subagent-panel__tool-chip {
  padding: 1px var(--space-1); border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary, var(--color-bg-secondary));
  font-family: var(--font-mono); font-size: var(--text-mono); color: var(--color-text-secondary);
}
.subagent-panel__snippet {
  margin: 0; padding: var(--space-2); max-height: 200px; overflow: auto;
  background: var(--color-bg-secondary); border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: var(--text-mono); white-space: pre-wrap; word-break: break-word;
}
.subagent-panel__error { font-size: var(--text-sm); color: var(--color-warning-text); }
.subagent-panel__muted { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }
</style>
