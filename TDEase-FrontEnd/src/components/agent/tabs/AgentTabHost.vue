<!--
  AgentTabHost — the Agent page's right-sidebar tab surface.

  The Agent-side twin of `DocumentHost`: a tab strip above a body that mounts
  the active tab's component. The body resolves through `resolveAgentTab`
  (the Agent tab registry), so this host holds no dispatch knowledge — adding
  a new AgentTabKind means registering it in the registry, not editing here.

  Reuses the Workbench's real viewers (`FileDocument` for `agent-file`) and
  the existing Agent view components, so there is one viewer per concern, not
  two. KeepAlive caches the last few tabs so switching back doesn't refetch.

  Empty state: when no tab is open the body shows a one-line hint. This is the
  resting state until the user clicks an asset/link in the transcript.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Aim } from '@element-plus/icons-vue'
import Empty from '@/components/primitives/Empty.vue'
import { useAgentTabsStore } from '@/stores/agentTabs'
import { resolveAgentTab } from './agentTabRegistry'
import AgentTabStrip from './AgentTabStrip.vue'

// Re-emit the tab strip's subagent-indicator click so AgentPage (which owns the
// floating SubagentPanel toggle) can open it. The host holds no panel state.
defineEmits<{ 'open-subagents': [] }>()

const { t } = useI18n()
const tabsStore = useAgentTabsStore()

const resolved = computed(() => (tabsStore.activeKey ? resolveAgentTab(tabsStore.activeKey) : null))
</script>

<template>
  <aside
    class="agent-tab-host"
    role="complementary"
    :aria-label="t('agent.tab.label')"
  >
    <AgentTabStrip @open-subagents="$emit('open-subagents')" />

    <div class="agent-tab-host__body">
      <KeepAlive :max="6">
        <component
          :is="resolved.component"
          v-if="resolved && tabsStore.active"
          :key="tabsStore.active.id"
          v-bind="resolved.props"
        />
      </KeepAlive>
      <Empty
        v-if="!tabsStore.active"
        :icon="Aim"
        :title="t('agent.tab.emptyTitle')"
        :description="t('agent.tab.emptyDescription')"
      />
    </div>
  </aside>
</template>

<style scoped>
.agent-tab-host {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg-secondary);
}

.agent-tab-host__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
</style>
