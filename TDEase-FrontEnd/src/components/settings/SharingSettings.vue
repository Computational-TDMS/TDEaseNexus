<template>
  <div class="settings-tab-content active" data-tab="sharing">
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settingsSharing.title') }}</h2>
      </div>
      <p class="section-lead">{{ t('workbench.settingsSharing.lead') }}</p>
      <div class="surface-card">
        <Field :label="t('workbench.settingsSharing.enable')">
          <template #default>
            <el-switch v-model="enabled" :disabled="!bridge" @change="write" />
          </template>
        </Field>

        <template v-if="bridge">
          <Field :label="t('workbench.settingsSharing.workspace')">
            <template #default="{ id }">
              <select :id="id" v-model="workspaceId" class="settings-select" :disabled="!workspaces.length" @change="write">
                <option v-if="!workspaces.length" value="">{{ t('workbench.settingsSharing.noWorkspace') }}</option>
                <option v-for="ws in workspaces" :key="ws.workspace_id" :value="ws.workspace_id">{{ ws.name || ws.workspace_id }}</option>
              </select>
            </template>
          </Field>

          <Field :label="t('workbench.settingsSharing.network')">
            <template #default="{ id }">
              <select :id="id" v-model="mode" class="settings-select" :disabled="!enabled" @change="write">
                <option value="loopback">{{ t('workbench.settingsSharing.loopback') }}</option>
                <option value="lan">{{ t('workbench.settingsSharing.lan') }}</option>
              </select>
            </template>
          </Field>

          <!-- LAN mode is plaintext HTTP on 0.0.0.0: the invitation tokens,
               the AI conversation and workspace files all cross the network
               unencrypted. The mode stays available (it is the feature's
               point), but enabling it must be an informed choice. -->
          <p v-if="mode === 'lan'" class="share-warn" role="status">
            {{ t('workbench.settingsSharing.lanPlaintextWarning') }}
          </p>

          <Field :label="t('workbench.settingsSharing.port')">
            <template #default="{ id }">
              <input
                :id="id" v-model.number="port" class="settings-input" type="number" min="0" max="65535"
                :disabled="!enabled" :placeholder="t('workbench.settingsSharing.portAuto')" @change="write"
              >
            </template>
          </Field>

          <div class="row row-inline">
            <div class="row-text">
              <div class="row-label">
                <template v-if="status?.running && status.url">
                  {{ t('workbench.settingsSharing.runningAt') }} <code>{{ status.url }}</code>
                </template>
                <template v-else-if="enabled">{{ t('workbench.settingsSharing.startPending') }}</template>
                <template v-else>{{ t('workbench.settingsSharing.stopped') }}</template>
              </div>
            </div>
            <div v-if="enabled" class="row-control">
              <AppButton size="sm" @click="disable">{{ t('workbench.settingsSharing.revoke') }}</AppButton>
            </div>
          </div>
        </template>

        <p v-else class="row-label">{{ t('workbench.settingsSharing.desktopOnly') }}</p>
      </div>
    </section>

    <!-- Invitations: one named guest, one secret, one tier, one revoke
         button. This IS the sharing permission model — the host hands out
         capability by name and takes it back the same way. -->
    <section v-if="bridge" class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settingsSharing.invites.title') }}</h2>
      </div>

      <!-- Create: name + tier. The full token shows exactly once, after
           creation, with a copy button — the API-key philosophy. -->
      <div class="surface-card">
        <div class="row row-inline">
          <div class="row-text">
            <input
              v-model="newName" class="settings-input invite-name" type="text"
              :placeholder="t('workbench.settingsSharing.invites.namePlaceholder')" maxlength="40" spellcheck="false"
              @keyup.enter="createInvite"
            >
            <select v-model="newTier" class="settings-select">
              <option value="view">{{ tierLabel('view') }}</option>
              <option value="continue">{{ tierLabel('continue') }}</option>
            </select>
          </div>
          <div class="row-control">
            <AppButton size="sm" variant="primary" :disabled="!newName.trim() || creating" @click="createInvite">
              {{ t('workbench.settingsSharing.invites.create') }}
            </AppButton>
          </div>
        </div>

        <div v-if="freshToken" class="fresh-token" role="status">
          <p class="fresh-token__title">{{ t('workbench.settingsSharing.invites.freshTitle', { name: freshToken.name }) }}</p>
          <div class="token-row">
            <code class="token-input">{{ freshToken.token }}</code>
            <AppButton size="sm" @click="copyFreshToken">{{ copied ? t('workbench.settingsSharing.invites.copied') : t('workbench.settingsSharing.invites.copy') }}</AppButton>
            <AppButton size="sm" variant="subtle" @click="freshToken = null">{{ t('workbench.settingsSharing.invites.dismiss') }}</AppButton>
          </div>
          <p class="fresh-token__hint">{{ t('workbench.settingsSharing.invites.freshHint') }}</p>
        </div>

        <div v-for="invite in invites" :key="invite.id" class="row row-inline invite-row" :class="{ revoked: invite.revokedAt }">
          <div class="row-text">
            <div class="row-label">
              {{ invite.name }}
              <span class="invite-tier" :data-tier="invite.tier">{{ tierLabel(invite.tier) }}</span>
              <span v-if="invite.revokedAt" class="invite-revoked">{{ t('workbench.settingsSharing.invites.revoked') }}</span>
            </div>
            <div class="row-hint">
              {{ t('workbench.settingsSharing.invites.created') }} {{ fmtDate(invite.createdAt) }}
              <template v-if="lastSeenOf(invite.id)">
                · {{ t('workbench.settingsSharing.invites.lastSeen') }} {{ fmtDate(lastSeenOf(invite.id)!) }}
              </template>
              · <code class="token-preview">{{ invite.tokenPreview }}</code>
            </div>
          </div>
          <div class="row-control">
            <template v-if="!invite.revokedAt">
              <AppButton size="sm" variant="subtle" @click="reveal(invite)">
                {{ revealedId === invite.id ? t('workbench.settingsSharing.invites.hide') : t('workbench.settingsSharing.invites.copyAgain') }}
              </AppButton>
              <AppButton size="sm" variant="subtle" :class="{ 'revoke-armed': revokeArmedId === invite.id }" @click="revoke(invite)">
                {{ revokeArmedId === invite.id ? t('workbench.settingsSharing.invites.revokeConfirm') : t('workbench.settingsSharing.invites.revoke') }}
              </AppButton>
            </template>
          </div>
        </div>

        <p v-if="invites.length === 0" class="invite-empty">{{ t('workbench.settingsSharing.invites.empty') }}</p>
      </div>
    </section>

    <!-- Audit: the "who did what" tail. Names, not tokens. -->
    <section v-if="bridge && audit.length > 0" class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settingsSharing.audit.title') }}</h2>
      </div>
      <div class="surface-card audit-list">
        <div v-for="(entry, index) in audit" :key="index" class="audit-row">
          <span class="audit-at mono">{{ fmtDate(entry.at) }}</span>
          <span class="audit-name">{{ entry.name }}</span>
          <span :class="['audit-action', entry.action]">{{ auditLabel(entry.action) }}</span>
          <span class="audit-detail" :title="entry.detail">{{ entry.detail || '—' }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Field from '@/components/primitives/Field.vue'
import AppButton from '@/components/primitives/AppButton.vue'
import {
  desktopShareBridge,
  desktopWorkspaceRegistryBridge,
  type ShareConfigBridgeResult,
  type ShareInvitePublic,
  type ShareMode,
} from '@/services/desktop/desktopBridge'
import type { WorkspaceRegistry } from '@/services/workspace/workspaceRegistry'

const { t } = useI18n()
const bridge = desktopShareBridge()

// Static label maps, not `tier.${...}` concatenation — a constructed key is
// invisible to check:i18n and to grep, which is exactly how the permissions
// decision labels shipped missing. The Record types make a missing variant a
// compile error instead of a runtime raw key.
const TIER_LABEL_KEYS = {
  view: 'workbench.settingsSharing.tier.view',
  continue: 'workbench.settingsSharing.tier.continue',
  control: 'workbench.settingsSharing.tier.control',
} as const
const AUDIT_LABEL_KEYS = {
  login: 'workbench.settingsSharing.audit.login',
  'login-denied': 'workbench.settingsSharing.audit.login-denied',
  prompt: 'workbench.settingsSharing.audit.prompt',
  'prompt-denied': 'workbench.settingsSharing.audit.prompt-denied',
  revoked: 'workbench.settingsSharing.audit.revoked',
} as const
type AuditAction = keyof typeof AUDIT_LABEL_KEYS

function tierLabel(tier: ShareInvitePublic['tier']): string {
  return t(TIER_LABEL_KEYS[tier])
}
function auditLabel(action: string): string {
  return t(AUDIT_LABEL_KEYS[action as AuditAction] ?? AUDIT_LABEL_KEYS.login)
}

const config = ref<ShareConfigBridgeResult['config'] | null>(null)
const status = ref<ShareConfigBridgeResult['status'] | null>(null)
const inviteStatuses = ref<ShareConfigBridgeResult['inviteStatuses']>([])
const audit = ref<ShareConfigBridgeResult['audit']>([])
const enabled = ref(false)
const mode = ref<ShareMode>('loopback')
const port = ref(0)
const workspaceId = ref('')
const workspaces = ref<WorkspaceRegistry['workspaces']>([])

const invites = ref<ShareInvitePublic[]>([])

// ── Invitation management ────────────────────────────────────────────────────

const newName = ref('')
const newTier = ref<'view' | 'continue'>('view')
const creating = ref(false)
/** Shown exactly once after creation — then never again without a reveal. */
const freshToken = ref<{ name: string; token: string } | null>(null)
const copied = ref(false)
const revealedId = ref<string | null>(null)
const revealedTokens = ref(new Map<string, string>())
const revokeArmedId = ref<string | null>(null)
let revokeTimer: ReturnType<typeof setTimeout> | null = null

async function refresh(): Promise<void> {
  if (!bridge) return
  const result = await bridge.readConfig()
  config.value = result.config
  status.value = result.status
  inviteStatuses.value = result.inviteStatuses
  audit.value = [...result.audit].reverse()
  enabled.value = result.config.enabled
  mode.value = result.config.mode
  port.value = result.config.port
  workspaceId.value = result.config.workspaceId
  invites.value = result.config.invites
}

async function write(): Promise<void> {
  if (!bridge) return
  const result = await bridge.writeConfig({
    enabled: enabled.value && Boolean(workspaceId.value),
    mode: mode.value,
    port: Number.isFinite(port.value) ? port.value : 0,
    workspaceId: workspaceId.value,
  })
  config.value = result.config
  status.value = result.status
  enabled.value = result.config.enabled
  await refresh()
}

async function createInvite(): Promise<void> {
  const name = newName.value.trim()
  if (!name || !bridge || creating.value) return
  creating.value = true
  try {
    const invite = await bridge.createInvite({ name, tier: newTier.value })
    newName.value = ''
    freshToken.value = { name: invite.name, token: invite.token }
    copied.value = false
    await refresh()
  } catch (cause) {
    freshToken.value = null
    void cause
  } finally {
    creating.value = false
  }
}

async function copyFreshToken(): Promise<void> {
  if (!freshToken.value) return
  await navigator.clipboard?.writeText(freshToken.value.token).catch(() => undefined)
  copied.value = true
}

/** Explicit re-copy: the stored secret comes back for THIS invite only. */
async function reveal(invite: ShareInvitePublic): Promise<void> {
  if (!bridge) return
  if (revealedId.value === invite.id) {
    revealedId.value = null
    return
  }
  const known = revealedTokens.value.get(invite.id)
  if (known) {
    await navigator.clipboard?.writeText(known).catch(() => undefined)
    revealedId.value = invite.id
    return
  }
  try {
    const { token } = await bridge.revealInviteToken(invite.id)
    revealedTokens.value.set(invite.id, token)
    await navigator.clipboard?.writeText(token).catch(() => undefined)
    revealedId.value = invite.id
  } catch { /* the row keeps its preview; a failed reveal is silent */ }
}

/** Two-step revoke: the guest's cookie AND live stream die immediately. */
async function revoke(invite: ShareInvitePublic): Promise<void> {
  if (!bridge) return
  if (revokeArmedId.value !== invite.id) {
    revokeArmedId.value = invite.id
    if (revokeTimer) clearTimeout(revokeTimer)
    revokeTimer = setTimeout(() => { revokeArmedId.value = null }, 3000)
    return
  }
  revokeArmedId.value = null
  await bridge.revokeInvite(invite.id).catch(() => undefined)
  revealedTokens.value.delete(invite.id)
  if (revealedId.value === invite.id) revealedId.value = null
  await refresh()
}

function lastSeenOf(inviteId: string): string | null {
  return inviteStatuses.value.find((entry) => entry.inviteId === inviteId)?.lastSeenAt ?? null
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

async function disable(): Promise<void> {
  enabled.value = false
  await write()
}

onMounted(async () => {
  if (!bridge) return
  await refresh()
  // The share exposes exactly one REGISTERED workspace; the picker reads the
  // same registry the enforcement resolves against (through the bridge, per
  // the components-touch-no-IPC architecture gate).
  try {
    const registry = desktopWorkspaceRegistryBridge()
    if (registry) workspaces.value = (await registry.list()).workspaces
  } catch { /* the picker degrades to the current id */ }
})

onScopeDispose(() => { if (revokeTimer) clearTimeout(revokeTimer) })
</script>

<style scoped>
.token-row { display: flex; gap: 8px; align-items: center; }
.token-input { flex: 1; font-family: var(--font-mono, monospace); }
code { font-family: var(--font-mono, monospace); font-size: 12px; }
.mono { font-family: var(--font-mono, monospace); }
.share-warn {
  margin: 0;
  padding: var(--space-1-5) var(--space-2-5);
  font-size: var(--text-label);
  line-height: 1.5;
  color: var(--color-warning-text, var(--color-warning));
  background: color-mix(in srgb, var(--color-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);
  border-radius: var(--radius-sm);
}

/* ─── Section shell (matches the other settings panels) ─── */
.section { margin-bottom: 40px; }
.section:last-child { margin-bottom: 0; }
.section-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
.section-title { font-size: var(--text-lg); font-weight: 600; color: var(--color-text); letter-spacing: 0.05em; margin: 0; }
.section-lead { margin: -8px 0 var(--space-4); font-size: var(--text-sm); line-height: 1.5; color: var(--color-text-muted); }
.surface-card { display: flex; flex-direction: column; background: var(--color-bg-secondary); border: var(--line-w) solid var(--line-hairline); border-radius: 8px; }
.surface-card > .field, .row { padding: var(--space-2) var(--space-4); position: relative; }
.surface-card > .field + .field::before,
.surface-card > .field + .row::before,
.surface-card > .row + .field::before,
.surface-card > .row + .row::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: var(--color-border);
}
.row-inline { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
.row-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.invite-name .row-text { flex-direction: row; }
.row-label { font-size: var(--text-md); color: var(--color-text); font-weight: 500; }
.row-hint { font-size: var(--text-label); color: var(--color-text-muted); line-height: 1.4; }
.row-control { flex-shrink: 0; display: flex; align-items: center; gap: var(--space-2); }

.settings-input {
  width: 100%; font-family: var(--font-body); font-size: var(--text-base); color: var(--color-text);
  background: var(--color-bg-secondary); border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm); padding: var(--space-1-5) var(--space-2-5); outline: none;
  transition: border-color 0.2s ease;
}
.settings-input:focus { border-color: var(--color-ring); }
.settings-input::placeholder { color: var(--color-text-muted); }
.settings-select {
  font-family: var(--font-body); font-size: var(--text-base); color: var(--color-text);
  background: var(--color-bg-secondary); border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm); padding: var(--space-1-5) var(--space-2-5); outline: none;
  cursor: pointer; width: 200px;
}
.invite-name { max-width: 240px; }

/* ─── Invitations ─── */
.invite-row.revoked .row-label { color: var(--color-text-muted); text-decoration: line-through; }
.invite-tier {
  margin-left: var(--space-2); padding: 0 var(--space-1-5);
  font-size: 0.62rem; font-weight: 600; line-height: 1.6; border-radius: var(--radius-xs);
  background: var(--color-bg-tertiary); color: var(--color-text-secondary);
}
.invite-tier[data-tier='continue'] { color: var(--color-primary); background: var(--color-primary-soft); }
.invite-revoked { margin-left: var(--space-2); font-size: 0.62rem; color: var(--status-failed); }
.token-preview { color: var(--color-text-muted); }
.revoke-armed { color: var(--status-failed); border-color: color-mix(in srgb, var(--status-failed) 40%, transparent); }
.invite-empty { padding: var(--space-4); font-size: var(--text-sm); color: var(--color-text-muted); text-align: center; }

.fresh-token { display: flex; flex-direction: column; gap: var(--space-1-5); padding: var(--space-3) var(--space-4); position: relative; }
.fresh-token__title { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--color-text); }
.fresh-token__hint { margin: 0; font-size: var(--text-label); color: var(--color-text-muted); }

/* ─── Audit ─── */
.audit-list { font-size: var(--text-sm); }
.audit-row { display: grid; grid-template-columns: 150px 110px 110px 1fr; gap: var(--space-2); padding: var(--space-1) var(--space-3); align-items: baseline; }
.audit-row + .audit-row { border-top: 1px solid var(--color-border); }
.audit-at { font-size: var(--text-label); color: var(--color-text-muted); }
.audit-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-action { font-size: var(--text-label); color: var(--color-text-secondary); }
.audit-action.prompt-denied, .audit-action.login-denied { color: var(--color-warning-text, var(--color-warning)); }
.audit-action.revoked { color: var(--status-failed); }
.audit-action.prompt { color: var(--color-success-text, var(--color-success)); }
.audit-detail { font-size: var(--text-label); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
