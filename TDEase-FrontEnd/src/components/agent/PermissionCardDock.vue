<!--
  PermissionCardDock — the live approval surface, floating above the Composer.

  This replaces ApprovalModal (Phase D-17, palot chat-permission.tsx pattern).
  A pending approval used to grab the whole window as a modal overlay —
  blocking the transcript from view and adding a Teleport + focus-trap layer.
  A tool-permission decision is small and time-sensitive; it reads better as
  a card where the user is already looking (above the input), with the
  conversation still visible behind it. That is one less abstraction layer
  (AGENTS.md iron rule 3: look outward — is there an extra garbage architecture layer?).

  Overlay, not docked-in-flow (tonal-layering pilot): the card is absolutely
  positioned at `bottom: 100%` of the Composer's anchor wrapper, so an
  arriving approval never inserts a flex child into the conversation column
  — the transcript's geometry does not change and there is no layout jump.
  The pattern is Raycast's confirm bar: a transient, time-sensitive decision
  floats above the control it gates. Because it now floats, the card carries
  real overlay chrome: a full warning-tinted border (the one border that
  survives the no-hairline rule, because it carries semantics), rounded
  corners, and the panel shadow.

  Behavior carried over from the modal:
    - Reads the live `pendingApprovals` queue and renders ONLY the head.
      Approvals are serialized in the main-process coordinator, so a new one
      is not pushed until the current resolves; rendering only the head makes
      "one at a time" the visible contract.
    - Reuses `PermissionCard` for the presentation kernel (command title,
      tier, read-only args, the approval ladder) and its handlers.
    - Esc denies the head approval — but ONLY when the dock itself holds focus
      (see onKeyDown). A plain Esc elsewhere is left to dismiss whatever else
      is open (a completion popup, the session dropdown, the dock fan), so the
      two no longer fire on the same keypress. No focus trap: the dock does
      not steal the window, so Tab works normally.
    - Auto-focuses the first action when an approval lands, and returns focus
      to the Composer when the queue drains so a keyboard user is never left
      on `body` after deciding.

  Historical (replayed) approvals still render inline via ProcessFold as
  read-only resolved cards; only the LIVE decision floats here.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAgentStore } from '@/stores/agent'
import PermissionCard from './PermissionCard.vue'
import type { PermissionBlock } from '@/stores/chat-types'

const store = useAgentStore()
const dockRef = ref<HTMLElement | null>(null)

const current = computed(() => store.pendingApprovals[0] ?? null)

const syntheticBlock = computed<PermissionBlock | null>(() => {
  const req = current.value
  if (!req) return null
  return {
    type: 'permission',
    id: req.id,
    toolName: req.action,
    args: req.args,
    reason: req.reason,
    status: 'pending',
    actionable: true,
  }
})

const queueDepth = computed(() => store.pendingApprovals.length)

function onKeyDown(e: KeyboardEvent) {
  // Esc denies the head approval — but ONLY when the dock (or one of its
  // action buttons) holds focus. The previous "any Esc while an approval is
  // pending" rule collided with every other Esc in the app: closing a slash
  // completion popup, the session dropdown, or the dock fan would silently
  // deny the approval at the same time. Focus-scoping the key to the dock
  // keeps the keyboard shortcut for users who Tabbed into the decision, and
  // leaves a plain Esc elsewhere to dismiss whatever else is open.
  if (e.key !== 'Escape' || !current.value) return
  const dock = dockRef.value
  if (!dock) return
  if (dock.contains(document.activeElement)) {
    e.stopImmediatePropagation()
    store.resolveApproval(current.value.id, 'deny')
  }
}

// Auto-focus the first action when a new approval lands so a keyboard user
// can Allow/Deny without reaching for the mouse. Capture where focus WAS
// before we steal it, and restore it (to the Composer by default — the user is
// mid-conversation) when the queue drains, so the user is never stranded on
// `body` after deciding.
let preApprovalFocus: HTMLElement | null = null

watch(current, async (head, prev) => {
  // A new approval arrived: remember the current focus, then move it into the
  // decision so a keyboard user can act immediately.
  if (head && !prev) {
    preApprovalFocus = document.activeElement as HTMLElement | null
    await nextTick()
    // Focus the PRIMARY action (Allow once) rather than the first button
    // (Deny), so Enter = approve and Esc = deny form a symmetric pair. The
    // user can still Tab to Deny; this just makes the confirm key confirm.
    const primary = dockRef.value?.querySelector<HTMLElement>('.perm-approve')
    const first = primary ?? dockRef.value?.querySelector<HTMLElement>(
      'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
    )
    first?.focus()
    return
  }
  // The queue just drained: put focus back where the user was, preferring the
  // Composer's textarea so they can keep typing. Scoped to the dock's own
  // agent page: with the Workbench sidebar's composer in the document, a
  // document-wide first-match could land on the other host's textarea.
  // The preApprovalFocus may be a stale node (e.g. a button removed mid-turn),
  // so guard with isConnected.
  if (!head && prev) {
    const host = dockRef.value?.closest('.agent-page')
    const composer = host?.querySelector<HTMLTextAreaElement>('.composer__textarea-row textarea')
    const target = (preApprovalFocus && preApprovalFocus.isConnected) ? preApprovalFocus : composer
    preApprovalFocus = null
    target?.focus()
  }
})

onMounted(() => { document.addEventListener('keydown', onKeyDown) })
onBeforeUnmount(() => { document.removeEventListener('keydown', onKeyDown) })
</script>

<template>
  <Transition name="permission-dock">
    <div
      v-if="syntheticBlock"
      ref="dockRef"
      class="permission-dock"
      role="region"
      :aria-label="$t('agent.approval.modalTitle')"
    >
      <div v-if="queueDepth > 1" class="permission-dock__queue">
        {{ $t('agent.approval.queueRemaining', { n: queueDepth - 1 }) }}
      </div>
      <PermissionCard
        class="permission-dock__card"
        message-id="__live__"
        :block="syntheticBlock"
      />
    </div>
  </Transition>
</template>

<style scoped>
.permission-dock {
  /* Overlay, not a flex child: pinned to the top edge of the Composer anchor
     (bottom: 100%), inset by the Composer's own horizontal padding so the
     card lands exactly over the input card. An arriving approval therefore
     never changes the transcript's geometry — no layout jump. z-index 15
     sits above the transcript's floating pills (10) and below the popover
     family (the session menu and completion popups live at 20+). */
  position: absolute;
  /* The dock floats inside the Composer anchor, a `pointer-events: none`
     scrim so the transcript stays scrollable around the floating card. The
     dock re-enables hit-testing ITSELF rather than relying on the host page
     to list its class name: that list once said `.permission-card-dock`
     while this root said `permission-dock`, the selector matched nothing,
     and every approval card shipped unclickable — clicks fell through to
     the transcript underneath. */
  pointer-events: auto;
  bottom: 100%;
  left: var(--space-3);
  right: var(--space-3);
  margin-bottom: var(--space-2);
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1-5) var(--space-3) var(--space-2);
  /* Floating chrome: the warning frame now runs all the way around (it is
     the one border that survives the tonal-layering pilot, because it
     carries the "this needs a decision" semantics), over the warning-tinted
     surface, with the panel shadow doing the lifting. */
  border: var(--line-w) solid color-mix(in srgb, var(--color-warning) 45%, var(--line-seam));
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-warning) 7%, var(--color-bg-secondary));
  box-shadow: var(--shadow-panel);
}

.permission-dock__queue {
  align-self: flex-end;
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

/* The card carries its own surface/border; inside the dock it reads as the
   decision body, so flatten its outer chrome to avoid a double box. */
.permission-dock__card.permission-card {
  margin: 0;
  border: 0;
  background: transparent;
}

/* Enter/exit: slide up from the Composer edge. */
.permission-dock-enter-active,
.permission-dock-leave-active {
  transition: transform var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
}
.permission-dock-enter-from,
.permission-dock-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (prefers-reduced-motion: reduce) {
  .permission-dock-enter-active,
  .permission-dock-leave-active { transition: none; }
}
</style>
