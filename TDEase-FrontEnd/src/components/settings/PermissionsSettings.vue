<!--
  PermissionsSettings — sixth Settings section, the
  one `SettingsDocument.vue`'s header used to record as missing.

  This reads the REAL decision model and nothing invented on top of it:
  `PERMISSION_ACTIONS` and `resolvePermission` come straight from
  `services/agent/permissionResolver.ts`, and the two contexts shown for each
  action come straight from `contextFor('ask' | 'auto')` in
  `services/permissionMode.ts` — the exact function the agent runtime itself
  calls to gate a tool. Reconstructing a parallel copy of that mapping here
  would silently drift from the real one (permissionMode.ts's own contract-test
  comment says as much), so this component imports it instead of restating
  it.

  Two decision tiers, one semantics: ACTION-LEVEL rules merge into the coarse
  ceiling deny-dominantly (a workspace can only tighten the Authority ladder);
  rules carrying a `match` predicate (command regex / path globs, priority,
  note) are the pi-permission-style override channel — at call time the
  highest-priority matching rule decides, and with no match the coarse ceiling
  decides. The preview panel runs exactly that evaluation on a sample
  command/path, so what the user previews is what a newly bound session will
  enforce.

  Workspace overrides live in `.tdease/permissions.json` (version 2, v1 files
  still load) and are edited here through the same gated workspace file IPC
  every other workspace file uses (no dedicated channel, no new trust
  surface). Validation on load is the runtime's own
  `parseWorkspacePermissionPolicy`; save round-trips the draft through the
  same parser, so the editor can never persist a file a bind would reject.
-->
<template>
  <div class="settings-tab-content" data-tab="permissions">
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settingsPermissions.precedenceTitle') }}</h2>
      </div>
      <p class="section-lead">{{ t('workbench.settingsPermissions.precedenceDescription') }}</p>
      <div class="precedence-row">
        <span
          v-for="decision in precedenceOrder"
          :key="decision"
          :class="['decision-chip', `is-${decision}`]"
        >{{ decisionLabel(decision) }}</span>
      </div>
    </section>

    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settingsPermissions.actionsTitle') }}</h2>
      </div>
      <p class="section-lead">{{ t('workbench.settingsPermissions.actionsDescription') }}</p>
      <p class="section-lead policy-note">{{ t('workbench.settingsPermissions.defaultPolicyNote') }}</p>
      <div class="surface-card">
        <div class="perm-row perm-head">
          <span>{{ t('workbench.settingsPermissions.columnAction') }}</span>
          <span>{{ t('workbench.settingsPermissions.columnAsk') }}</span>
          <span>{{ t('workbench.settingsPermissions.columnAuto') }}</span>
        </div>
        <div v-for="row in actionRows" :key="row.action" class="perm-row">
          <span class="perm-action mono">{{ row.action }}</span>
          <span :class="['decision-chip', `is-${row.ask}`]">{{ decisionLabel(row.ask) }}</span>
          <span :class="['decision-chip', `is-${row.auto}`]">{{ decisionLabel(row.auto) }}</span>
        </div>
      </div>
    </section>

    <section class="section" data-testid="workspace-overrides">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settingsPermissions.workspaceTitle') }}</h2>
        <div v-if="hasWorkspace" class="section-actions">
          <AppButton size="sm" @click="addRule">{{ t('workbench.settingsPermissions.addRule') }}</AppButton>
          <AppButton variant="primary" size="sm" class="save-rules" :disabled="!dirty || saving" @click="save">{{ t('workbench.settingsPermissions.saveRules') }}</AppButton>
        </div>
      </div>
      <p class="section-lead">{{ t('workbench.settingsPermissions.workspaceDescription') }}</p>

      <div v-if="!hasWorkspace" class="gap-notice">
        <p class="gap-description">{{ t('workbench.settingsPermissions.workspaceNone') }}</p>
      </div>
      <template v-else>
        <p v-if="loadError" class="load-error">{{ t('workbench.settingsPermissions.loadFailed', { error: loadError }) }}</p>
        <div class="surface-card">
          <div v-if="rows.length > 0" class="rule-row rule-head">
            <span>{{ t('workbench.settingsPermissions.columnAction') }}</span>
            <span>{{ t('workbench.settingsPermissions.columnDecision') }}</span>
            <span>{{ t('workbench.settingsPermissions.columnPriority') }}</span>
            <span aria-hidden="true"></span>
          </div>
          <p v-if="rows.length === 0 && !loadError" class="rules-empty">{{ t('workbench.settingsPermissions.rulesEmpty') }}</p>
          <div v-for="(row, index) in rows" :key="index" class="rule-block">
            <div class="rule-row">
              <select v-model="row.action" class="settings-select rule-action" :aria-label="t('workbench.settingsPermissions.columnAction')">
                <option v-for="action in PERMISSION_ACTIONS" :key="action" :value="action">{{ action }}</option>
              </select>
              <select v-model="row.decision" class="settings-select rule-decision" :aria-label="t('workbench.settingsPermissions.columnDecision')">
                <option v-for="decision in decisions" :key="decision" :value="decision">{{ decisionLabel(decision) }}</option>
              </select>
              <input
                v-model="row.priority"
                type="text"
                inputmode="numeric"
                class="settings-input rule-priority mono"
                :placeholder="'0'"
                :aria-label="t('workbench.settingsPermissions.columnPriority')"
              >
              <button type="button" class="rule-remove" :title="t('workbench.settingsPermissions.removeRule')" @click="removeRow(index)">✕</button>
            </div>
            <div class="rule-row rule-match">
              <input
                v-model="row.command"
                type="text"
                class="settings-input mono"
                :placeholder="t('workbench.settingsPermissions.matchCommandPlaceholder')"
                :aria-label="t('workbench.settingsPermissions.matchCommandLabel')"
              >
              <input
                v-model="row.paths"
                type="text"
                class="settings-input mono"
                :placeholder="t('workbench.settingsPermissions.matchPathsPlaceholder')"
                :aria-label="t('workbench.settingsPermissions.matchPathsLabel')"
              >
              <input
                v-model="row.note"
                type="text"
                class="settings-input"
                :placeholder="t('workbench.settingsPermissions.notePlaceholder')"
                :aria-label="t('workbench.settingsPermissions.noteLabel')"
              >
            </div>
          </div>
        </div>
        <div class="surface-card preview-card">
          <div class="preview-grid">
            <label class="preview-field">
              <span>{{ t('workbench.settingsPermissions.previewCommand') }}</span>
              <input v-model="previewCommand" type="text" class="settings-input mono" :placeholder="'git status'">
              <span v-if="previewShell" class="preview-result">
                <span class="mono preview-action">shell.exec</span>
                <span :class="['decision-chip', `is-${previewShell.ask}`]">{{ decisionLabel(previewShell.ask) }}</span>
                <span :class="['decision-chip', `is-${previewShell.auto}`]">{{ decisionLabel(previewShell.auto) }}</span>
              </span>
            </label>
            <label class="preview-field">
              <span>{{ t('workbench.settingsPermissions.previewPath') }}</span>
              <input v-model="previewPath" type="text" class="settings-input mono" :placeholder="'analysis/notes.md'">
              <span v-if="previewPathCall" class="preview-result">
                <span class="mono preview-action">workspace.write</span>
                <span :class="['decision-chip', `is-${previewPathCall.ask}`]">{{ decisionLabel(previewPathCall.ask) }}</span>
                <span :class="['decision-chip', `is-${previewPathCall.auto}`]">{{ decisionLabel(previewPathCall.auto) }}</span>
              </span>
            </label>
          </div>
          <p class="apply-note">{{ t('workbench.settingsPermissions.previewNote') }}</p>
        </div>
        <p v-if="justSaved" class="apply-note saved">{{ t('workbench.settingsPermissions.rulesSaved') }}</p>
        <p v-else class="apply-note">{{ t('workbench.settingsPermissions.bindNote') }}</p>
      </template>
    </section>
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settingsPermissions.sandboxTitle') }}</h2>
      </div>
      <p class="section-lead">{{ t('workbench.settingsPermissions.sandboxDescription') }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PERMISSION_ACTIONS,
  evaluatePermissionDecision,
  parseWorkspacePermissionPolicy,
  resolvePermission,
  sortPermissionRules,
  type PermissionAction,
  type PermissionDecision,
  type PermissionMatch,
  type PermissionMode,
  type PermissionRule,
} from '@/services/agent/permissionResolver'
import { contextFor } from '@/services/agent/permissionMode'
import { serializePolicy } from '@/services/agent/permissionWhitelist'
import { defaultPolicyFor } from '@/services/agent/defaultPermissionPolicy'
import { useWorkspaceStore } from '@/stores/workspace'
import { desktopWorkspaceBridge } from '@/services/desktop/desktopBridge'
import AppButton from '@/components/primitives/AppButton.vue'

const { t } = useI18n()
const workspaceStore = useWorkspaceStore()

// Highest rank wins in resolvePermission (permissionResolver.ts: allow:0 <
// ask:1 < deny:2) — this literal order is that same precedence, spelled out
// for display rather than re-derived, so it can never silently disagree
// with the resolver it describes without a passing type/test catching it.
const precedenceOrder: PermissionDecision[] = ['deny', 'ask', 'allow']
const decisions: PermissionDecision[] = ['allow', 'ask', 'deny']

// Static map, not `decision${...}` concatenation: a constructed key is
// invisible to every audit (vue-tsc, check-i18n, grep), which is exactly how
// these three labels shipped missing from all three locales — the whole
// decision table rendered raw key paths. The Record type makes a missing
// PermissionDecision a compile error instead of a runtime raw string.
const DECISION_LABEL_KEYS: Record<PermissionDecision, string> = {
  allow: 'workbench.settingsPermissions.decisionAllow',
  ask: 'workbench.settingsPermissions.decisionAsk',
  deny: 'workbench.settingsPermissions.decisionDeny',
}

function decisionLabel(decision: PermissionDecision): string {
  return t(DECISION_LABEL_KEYS[decision])
}

// Baseline Authority contexts. Workspace rules are loaded for the bound
// session and merged by contextFor() before runtime registration.
const modes: PermissionMode[] = ['ask', 'auto']
const contextByMode = Object.fromEntries(modes.map((mode) => [mode, contextFor(mode)])) as Record<PermissionMode, ReturnType<typeof contextFor>>

const actionRows = computed(() => PERMISSION_ACTIONS.map((action) => ({
  action,
  ask: resolvePermission(contextByMode.ask, action),
  auto: resolvePermission(contextByMode.auto, action),
})))

// ── Workspace overrides editor ───────────────────────────────────────────────
//
// The runtime re-reads `.tdease/permissions.json` on every agent:bind-session
// (electron/agent/agent-runtime.ts loadPermissionProfile) with the same strict
// parser used on load below — the editor cannot emit anything that parser
// rejects, and a hand-edited file the parser DOES reject surfaces as loadFailed
// instead of silently vanishing. v2 rules may carry a match predicate
// (command regex / path globs), a priority and a note; match-less rules keep
// the v1 tighten-only semantics. Save round-trips the draft through the
// runtime parser, so a bad regex or glob is rejected here with the parser's
// own message instead of poisoning the next bind.

const POLICY_PATH = '.tdease/permissions.json'

interface RuleDraft {
  action: PermissionAction
  decision: PermissionDecision
  priority: string
  command: string
  paths: string
  note: string
}

function emptyDraft(): RuleDraft {
  return { action: 'shell.exec', decision: 'deny', priority: '', command: '', paths: '', note: '' }
}

function draftOfRule(rule: PermissionRule): RuleDraft {
  return {
    action: rule.action,
    decision: rule.decision,
    priority: rule.priority === undefined ? '' : String(rule.priority),
    command: rule.match?.command ?? '',
    paths: rule.match?.paths?.join(', ') ?? '',
    note: rule.note ?? '',
  }
}

function ruleOfDraft(draft: RuleDraft): PermissionRule {
  const match: PermissionMatch = {}
  if (draft.command.trim()) match.command = draft.command.trim()
  const paths = draft.paths.split(',').map((glob) => glob.trim()).filter(Boolean)
  if (paths.length) match.paths = paths
  return {
    action: draft.action,
    decision: draft.decision,
    ...(Object.keys(match).length ? { match } : {}),
    ...(draft.priority.trim() !== '' ? { priority: Number(draft.priority) } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  }
}

const rows = ref<RuleDraft[]>([])
const loadedSignature = ref('[]')
const loadError = ref<string | null>(null)
const saving = ref(false)
const justSaved = ref(false)

const hasWorkspace = computed(() => Boolean(workspaceStore.workspacePath))

function signature(drafts: RuleDraft[]): string {
  // Array order is significant now (equal-priority ties keep write order), so
  // no sorting — the signature is the rule list exactly as it will be saved.
  return JSON.stringify(drafts.map(ruleOfDraft))
}

const dirty = computed(() => signature(rows.value) !== loadedSignature.value)

function addRule() {
  rows.value = [...rows.value, emptyDraft()]
}

function removeRow(index: number) {
  rows.value = rows.value.filter((_, i) => i !== index)
}

/**
 * The runtime's own evaluation, previewed on a concrete call: the coarse
 * ladder (contextFor + match-less draft rules) decides the fallback, then the
 * parameterized draft rules override exactly as a bound session would —
 * identical functions, identical order, no parallel preview semantics.
 */
function previewCall(action: PermissionAction, input: Readonly<Record<string, unknown>> | undefined): Record<PermissionMode, PermissionDecision> | null {
  if (!input) return null
  const rules = rows.value.map(ruleOfDraft)
  const overrides = sortPermissionRules(rules.filter((rule) => rule.match))
  return Object.fromEntries(modes.map((mode) => {
    const context = contextFor(mode, rules.filter((rule) => !rule.match))
    // The evaluator only consults ceiling[action], so the preview computes
    // one entry instead of the whole ladder — the cast keeps the production
    // full-ceiling contract intact for the runtime's own call sites. Under
    // ask authority the shipped default review policy joins the overrides,
    // exactly as loadPermissionProfile mounts it.
    const ceiling = { [action]: resolvePermission(context, action) } as Record<PermissionAction, PermissionDecision>
    const withPolicy = [...overrides, ...defaultPolicyFor(mode)]
    return [mode, evaluatePermissionDecision(withPolicy, ceiling, action, input).decision]
  })) as Record<PermissionMode, PermissionDecision>
}

const previewCommand = ref('')
const previewPath = ref('')
const previewShell = computed(() => previewCall(
  'shell.exec',
  previewCommand.value.trim() ? { command: previewCommand.value.trim() } : undefined,
))
const previewPathCall = computed(() => previewCall(
  'workspace.write',
  previewPath.value.trim() ? { path: previewPath.value.trim() } : undefined,
))

async function loadOverrides() {
  rows.value = []
  loadedSignature.value = '[]'
  loadError.value = null
  const root = workspaceStore.workspacePath
  const bridge = desktopWorkspaceBridge()
  if (!root || !bridge) return
  try {
    if (!(await bridge.exists(root, POLICY_PATH))) return
    const policy = parseWorkspacePermissionPolicy(await bridge.readText(root, POLICY_PATH))
    rows.value = policy.rules.map(draftOfRule)
    loadedSignature.value = signature(rows.value)
  } catch (error) {
    // A broken hand-edited file must not be silently replaced on the next
    // save — the error names the file and the save path is an explicit repair.
    loadError.value = error instanceof Error ? error.message : String(error)
  }
}

async function save() {
  const root = workspaceStore.workspacePath
  const bridge = desktopWorkspaceBridge()
  if (!root || !bridge || !dirty.value) return
  saving.value = true
  try {
    const rules = rows.value.map(ruleOfDraft)
    // One serialization for both validate and write, through the runtime's
    // own helper: an invalid regex rejects the save with the exact message a
    // bind would throw, and the file on disk is always the canonical shape.
    const body = serializePolicy(rules)
    parseWorkspacePermissionPolicy(body)
    await bridge.writeTextAtomic(root, POLICY_PATH, body)
    loadedSignature.value = signature(rows.value)
    justSaved.value = true
    setTimeout(() => { justSaved.value = false }, 2500)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

onMounted(loadOverrides)
watch(() => workspaceStore.workspacePath, loadOverrides)
</script>

<style scoped>
.settings-tab-content { width: 100%; max-width: 100%; min-width: 0; }

.section { margin-bottom: 40px; }
.section:last-child { margin-bottom: 0; }

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.section-actions { display: flex; align-items: center; gap: var(--space-2); }

.section-title {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--color-text);
  letter-spacing: 0.05em;
  margin: 0;
}

.section-lead {
  margin: -8px 0 var(--space-4);
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--color-text-muted);
}
.policy-note {
  margin-top: calc(var(--space-2) * -1);
  padding: var(--space-2) var(--space-3);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
}

.surface-card {
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: 8px;
}

/* ─── Precedence chips ─── */
.precedence-row { display: flex; align-items: center; gap: var(--space-2); }

.decision-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-1-5) var(--space-2-5);
  border-radius: var(--radius-sm);
  font-size: var(--text-label);
  font-weight: 600;
  letter-spacing: 0.03em;
  border: 1px solid transparent;
}
.decision-chip.is-deny { color: var(--color-error-text); background: color-mix(in srgb, var(--color-error) 12%, transparent); border-color: color-mix(in srgb, var(--color-error) 30%, transparent); }
.decision-chip.is-ask { color: var(--color-warning-text); background: color-mix(in srgb, var(--color-warning) 12%, transparent); border-color: color-mix(in srgb, var(--color-warning) 30%, transparent); }
.decision-chip.is-allow { color: var(--color-success-text); background: color-mix(in srgb, var(--color-success) 12%, transparent); border-color: color-mix(in srgb, var(--color-success) 30%, transparent); }

/* ─── Action rows ─── */
.perm-row {
  display: grid;
  grid-template-columns: 1fr 110px 110px;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-4);
  position: relative;
}
.perm-row + .perm-row::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: var(--color-border);
}
.perm-head {
  font-size: var(--domain-text-meta);
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.perm-action {
  font-size: var(--text-sm);
  color: var(--color-text);
}
.mono { font-family: var(--font-mono); }

/* ─── Workspace overrides editor ─── */
.rule-block { position: relative; }
.rule-block + .rule-block::before,
.rule-block + .rules-empty::before,
.rules-empty + .rule-block::before,
.rule-head + .rule-block::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: var(--color-border);
}
.rule-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) 110px 88px 36px;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1-5) var(--space-4);
  position: relative;
}
.rule-match {
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1.4fr) minmax(0, 1fr);
  padding-top: 0;
  padding-bottom: var(--space-2);
}
.rule-head {
  font-size: var(--domain-text-meta);
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding-bottom: var(--space-2);
}
.rules-empty {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.settings-select {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  outline: none;
  cursor: pointer;
  width: 100%;
  min-width: 0;
}
.settings-select:focus { border-color: var(--color-ring); }
.settings-input {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
  outline: none;
  width: 100%;
  min-width: 0;
}
.settings-input:focus { border-color: var(--color-ring); }
.settings-input.mono { font-family: var(--font-mono); }
.rule-action { font-family: var(--font-mono); }
.preview-card { margin-top: var(--space-3); padding: var(--space-3) var(--space-4); gap: var(--space-2); }
.preview-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
}
.preview-field { display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--text-label); color: var(--color-text-muted); }
.preview-result { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-1); }
.preview-action { font-size: var(--text-label); color: var(--color-text); }
.save-rules { height: var(--space-6); padding: 0 var(--space-3); }
.rule-remove {
  width: var(--space-6);
  height: var(--space-6);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--text-sm);
}
.rule-remove:hover { color: var(--color-error-text); background: color-mix(in srgb, var(--color-error) 10%, transparent); }

.load-error {
  margin: 0 0 var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--color-error-text);
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
}

.apply-note {
  margin: var(--space-2) 0 0;
  font-size: var(--text-label);
  color: var(--color-text-muted);
}
.apply-note.saved { color: var(--color-success-text); }

/* ─── No-workspace notice ─── */
.gap-notice {
  padding: var(--space-4) var(--space-4);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
}
.gap-description {
  margin: 0;
  font-size: var(--text-sm);
  line-height: 1.55;
  color: var(--color-text-muted);
}
</style>
