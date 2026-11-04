<script setup lang="ts">
/**
 * PermissionCard — inline approve/deny card for a tool awaiting consent.
 *
 * Rule 1: "It renders args, not intent." The card shows the command title
 * and the exact arguments through the shared `SchemaForm` primitive in
 * read-only mode, always visible — never behind a click, so an action
 * cannot be approved without its arguments having been seen. There is no
 * model-authored sentence describing what the call is about to do; `reason`
 * (the permission `basis`) is shown only as secondary text.
 *
 * Rule 2 is the approval ladder. The tier comes from the command registry
 * (`stakesOf`), never from a judgement made here — see `registry.ts`'s
 * `CommandStakes`. At `document` the card marks itself as a review that
 * belongs on its own surface. The Analysis Review document does not exist yet
 * (docs/STATUS.md), so this card still resolves the approval rather
 * than blocking every submission — but it stops presenting the decision as a
 * small one.
 *
 * `store.resolveApproval(block.id, ...)` and the live `pendingApprovals`
 * queue share one id: `useAgentTurn.ts` mirrors each new pending approval
 * into the streaming message with `id` equal to the `ApprovalRequest.id`,
 * so this same component resolves the live approval and (after the turn
 * settles) renders identically from the replayed log.
 */
import { computed } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useI18n } from 'vue-i18n'
import { inferArgsSchema } from './infer-args-schema'
import SchemaForm from '@/components/primitives/SchemaForm.vue'
import AppButton from '@/components/primitives/AppButton.vue'
import { studioCommandDefinitions } from '@/studio/commands/definitions'
import { allowsSessionGrant, stakesOf, type CommandStakes } from '@/studio/commands/registry'
import { bareToolName } from '@/utils/tool-identity'
import { deriveWhitelistForTool } from '@/services/agent/permissionWhitelist'
import type { PermissionBlock } from '@/stores/chat-types'

const props = defineProps<{
  messageId: string
  block: PermissionBlock
}>()

const store = useAgentStore()
const { t } = useI18n()

const isPending = computed(() => props.block.status === 'pending')
const isActionable = computed(() => isPending.value && props.block.actionable !== false)
const resolvedLabel = computed(() => {
  switch (props.block.status) {
    case 'confirmed': return props.block.decision === 'allow_always'
      ? t('agent.approval.approvedWhitelisted')
      : t('agent.approval.approved')
    case 'rejected': return t('agent.approval.declined')
    case 'timeout': return t('agent.approval.timeout')
    case 'aborted': return t('agent.approval.aborted')
    default: return ''
  }
})

const hasArgs = computed(() => !!props.block.args && Object.keys(props.block.args).length > 0)
const argsSchema = computed(() => inferArgsSchema(props.block.args))

/**
 * The tier is a property of the command, read from the one registry. An
 * unregistered tool name is treated as `inline` rather than as harmless: the
 * safe default for something we cannot classify is "ask every time", not
 * "grant it forever".
 */
const commandId = computed(() => bareToolName(props.block.toolName))
const stakes = computed<CommandStakes>(() => {
  const definition = studioCommandDefinitions().find((entry) => entry.id === commandId.value)
  return definition ? stakesOf(definition) : 'inline'
})
const needsReviewSurface = computed(() => stakes.value === 'document')
/**
 * The "Allow for this session" button shows only when the command's stakes
 * permit a standing grant (`allowsSessionGrant`). At `document` the whole
 * point of the tier is that each instance is read — a grant that survives the
 * instance means the next one is never read — so the button is suppressed
 * there. See registry.ts `allowsSessionGrant`.
 */
const canGrantForSession = computed(() => allowsSessionGrant(stakes.value))

/**
 * "Always allow" exists only when this exact call deepens into an honest
 * whitelist rule (a bash command's two-token prefix, a path's parent
 * directory — deriveWhitelistForTool returns undefined for everything else).
 * The button text IS the granted scope, so the click can never silently
 * widen beyond what the label said.
 */
const whitelist = computed(() => (isActionable.value
  ? deriveWhitelistForTool(commandId.value, props.block.args ?? undefined)
  : undefined))

function approve() {
  // The block.id doubles as the approval id. Only resolveApproval drives the
  // turn forward — the live card is a synthetic block floating in the dock
  // (message-id `__live__`) or a read-only replay, never a block bound to a
  // real message, so there is nothing in the transcript to patch.
  store.resolveApproval(props.block.id, 'allow')
}

function approveForSession() {
  store.resolveApproval(props.block.id, 'allow_session')
}

function approveAlways() {
  store.resolveApproval(props.block.id, 'allow_always')
}

function reject() {
  store.resolveApproval(props.block.id, 'deny')
}
</script>

<template>
  <div
    class="permission-card"
    :class="[`is-${block.status}`, { 'is-review': needsReviewSurface }]"
    role="group"
    :aria-label="t('agent.approval.title', { action: commandId })"
  >
    <div class="perm-head">
      <span class="perm-tool mono">{{ commandId }}</span>
      <span v-if="!isPending" class="perm-status">{{ resolvedLabel }}</span>
    </div>
    <p v-if="block.reason" class="perm-reason">{{ block.reason }}</p>

    <p v-if="needsReviewSurface && isPending" class="perm-review-note">
      {{ t('agent.approval.reviewRequired') }}
    </p>

    <div class="perm-args">
      <span class="perm-args-label">{{ t('agent.approval.arguments') }}</span>
      <SchemaForm v-if="hasArgs" :schema="argsSchema" :model-value="block.args ?? {}" readonly />
      <p v-else class="perm-args-empty">{{ t('agent.approval.noArguments') }}</p>
    </div>

    <div v-if="isActionable" class="perm-actions">
      <AppButton size="sm" variant="subtle" class="perm-deny" @click="reject">
        {{ t('agent.approval.deny') }}
      </AppButton>
      <!--
        The approval ladder reads as increasing commitment: Deny → Allow for
        session → Always allow {scope} → Allow once, and each step must read
        as stronger than the one before it. The middle steps use the `default`
        variant (filled neutral surface) so they sit visibly between the quiet
        `subtle` Deny and the `primary` Allow once — before, all three shared
        two variants and "Allow for session" was indistinguishable from Deny,
        an easy mis-click when reaching for "yes but limited".

        "Allow for this session" records a standing grant for this action
        (NodeApprovalCoordinator.sessionGrants), so subsequent calls this
        session skip the prompt. Only rendered when `allowsSessionGrant(stakes)`
        is true — i.e. the inline tier, never the document tier. See
        registry.ts.

        "Always allow" renders only when this call derives an honest whitelist
        rule (a bash command's two-token prefix, a path's parent directory).
        Its label names the granted scope, and the answer both settles this
        approval and persists a priority -1 rule into the workspace policy —
        below every hand-written rule, above the ladder's default ask.
      -->
      <AppButton
        v-if="whitelist"
        size="sm"
        variant="default"
        class="perm-grant"
        :title="t('agent.approval.allowAlwaysTitle')"
        @click="approveAlways"
      >
        {{ t('agent.approval.allowAlways', { scope: whitelist.scope }) }}
      </AppButton>
      <AppButton
        v-if="canGrantForSession"
        size="sm"
        variant="default"
        class="perm-grant"
        @click="approveForSession"
      >
        {{ t('agent.approval.allowSession') }}
      </AppButton>
      <AppButton
        size="sm"
        class="perm-approve"
        :variant="needsReviewSurface ? 'danger' : 'primary'"
        @click="approve"
      >
        {{ t('agent.approval.allowOnce') }}
      </AppButton>
    </div>
  </div>
</template>

<style scoped>
/*
  A full border, never a side stripe. The 3px left stripe this replaces is the
  single most recognizable tell of a generated interface, and here it was doing
  real damage beyond that: paired with a warning wash it made "waiting for your
  decision" read as "something went wrong". §8.5 is explicit that suspension is
  not an error.

  Pending is carried by border weight and a quiet surface tint, and the document
  tier gets more weight than the inline one — the visual hierarchy matches the
  approval ladder instead of shouting equally at everything.
*/
.permission-card {
  margin: var(--space-2) 0;
  padding: var(--space-2) var(--space-3);
  border: var(--line-w) solid var(--line-seam-strong);
  border-radius: var(--radius-sm);
  background: var(--color-bg-card);
}
.permission-card.is-review {
  border-color: var(--color-warning-text);
  background: color-mix(in srgb, var(--color-warning) 7%, var(--color-bg-card));
}
.permission-card.is-confirmed { border-color: var(--color-success-text); background: transparent; }
/* Aborted and timed-out approvals are neutral outcomes, not failures (see the
   header contract and TurnOutcomeCard): they keep a quiet panel border and
   just recede via opacity. Only an explicit rejection reads as an error. */
.permission-card.is-rejected { border-color: var(--color-error-text); background: transparent; opacity: 0.7; }
.permission-card.is-aborted,
.permission-card.is-timeout { border-color: var(--line-seam); background: transparent; opacity: 0.7; }

.perm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.perm-tool {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text);
}
.perm-status {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.perm-reason {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  line-height: 1.5;
}

.perm-review-note {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  line-height: 1.5;
  /* Body weight, not muted: this is the sentence that must actually be read. */
  color: var(--color-text);
}

.perm-args {
  margin-top: var(--space-2);
}
/*
  Sentence case at body size. The 10px uppercase tracked micro-label this
  replaces failed twice: it is the saturated AI eyebrow, and muted 10px text is
  nowhere near the 4.5:1 PRODUCT.md targets.
*/
.perm-args-label {
  display: block;
  margin-bottom: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.perm-args-empty {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.perm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
</style>
