/**
 * The shipped default review policy for Ask authority: the
 * system reviews shell activity itself instead of prompting the user for
 * every mutating call. Adapted from the pi-permission-system reference
 * config: dangerous operations are isolated (deny), risky ones ask, and the
 * innocuous majority of shell commands simply run (a catch-all allow).
 *
 * The rules are parameterized (permissionResolver's override channel) at
 * priority −2, which fixes the review contract without any extra machinery:
 *
 *   hand-written rules (≥ 0)  >  whitelist (−1)  >  this policy (−2)  >  ladder
 *
 * So a card-approved whitelist entry silences a policy ask, a hand-written rule always outranks both, and the coarse ladder
 * still decides whatever the policy does not match. The policy mounts ONLY
 * under `ask` authority — `auto` keeps its original run-through behavior —
 * and the permission-gateway's destructive-command blacklist plus credential
 * denial hold in every mode regardless of anything here.
 *
 * Within the −2 tier the sort's deny > ask > allow tie-break reproduces the
 * reference config's most-restrictive-first matching, so write order below
 * is readability only. Notes surface on approval cards as the review reason.
 */

import type { AgentPermissionAction } from '@/contracts/agent-runtime'
import type { PermissionMode } from './permissionResolver'
import type { PermissionRule } from './permissionResolver'

export const DEFAULT_POLICY_PRIORITY = -2

const ISOLATE_NOTE = 'isolated by the shipped review policy'
const ALLOW_NOTE = 'innocuous command — runs without prompting'

const CREDENTIAL_COMMAND_PATTERN = '\\.ssh|\\.gnupg|id_rsa|id_ed25519|\\.netrc|\\.pypirc'

/** Credential-ish workspace paths: denied for reads AND writes. The env glob
 *  is suffix-exact (files named `.env`), so `.env.example` stays reachable. */
const CREDENTIAL_PATH_GLOBS = ['**/*.pem', '**/*.key', '**/*.env', '**/*id_rsa*', '**/*credentials*']

function deny(action: AgentPermissionAction, match: { command?: string; paths?: string[] }, note: string): PermissionRule {
  return { action, decision: 'deny', match, priority: DEFAULT_POLICY_PRIORITY, note }
}

function ask(action: AgentPermissionAction, match: { command?: string; paths?: string[] }, note: string): PermissionRule {
  return { action, decision: 'ask', match, priority: DEFAULT_POLICY_PRIORITY, note }
}

/** One fresh rule list per call — bindings deep-freeze what they take. */
export function defaultPolicyRules(): PermissionRule[] {
  return [
    // ── shell.exec: the dangerous set is isolated outright ────────────────
    deny('shell.exec', { command: CREDENTIAL_COMMAND_PATTERN },
      'credential material access is isolated'),
    deny('shell.exec', { command: 'git filter-branch|diskpart|bcdedit' },
      ISOLATE_NOTE),

    // ── shell.exec: the risky set asks ────────────────────────────────────
    ask('shell.exec', { command: '\\brm\\s+(-[a-zA-Z]*r|--recursive)' },
      'recursive deletion needs review'),
    ask('shell.exec', { command: '\\b(chmod|chown)\\s+(-R|--recursive)\\b' },
      'recursive permission change needs review'),
    ask('shell.exec', { command: '\\b(sudo|doas|su)\\b' },
      'elevated execution needs review'),
    ask('shell.exec', { command: '\\b(ssh|scp|sftp|rsync)\\b' },
      'remote access needs review'),
    ask('shell.exec', { command: 'git push\\b|git reset --hard|git clean\\s+-[a-zA-Z]*f|git checkout -- |git restore \\.|git branch -D|git filter-repo' },
      'git history/remote mutation needs review'),
    ask('shell.exec', { command: '\\b(npm|pnpm|yarn)\\s+(publish|login|adduser)\\b|\\b(npm|pnpm)\\s+(i|install|add|uninstall)\\s+(-g|--global)\\b|\\byarn\\s+global\\b' },
      'package publish/global install needs review'),
    ask('shell.exec', { command: '\\bdocker\\s+(system\\s+prune|volume\\s+rm|rm\\s+-f|rmi)\\b|\\bkubectl\\s+delete\\b|\\bhelm\\s+uninstall\\b' },
      'infrastructure mutation needs review'),
    ask('shell.exec', { command: '\\bcrontab\\b|\\blaunchctl\\b|\\bosascript\\b|\\bdefaults\\s+write\\b|\\breg\\s+(add|delete|import)\\b|\\bschtasks\\s+/(create|delete|change)\\b' },
      'system configuration needs review'),
    ask('shell.exec', { command: '\\b(killall|pkill)\\b|\\bkill\\s+-9\\b' },
      'force-terminating processes needs review'),

    // ── shell.exec: everything else simply runs ───────────────────────────
    // Sorted after every deny/ask above by the tie-break, this is the
    // default review payoff: git status, python, ls, package runs … no prompt.
    { action: 'shell.exec', decision: 'allow', match: { command: '[\\s\\S]*' }, priority: DEFAULT_POLICY_PRIORITY, note: ALLOW_NOTE },

    // ── workspace paths: credential-ish files are isolated ───────────────
    ...CREDENTIAL_PATH_GLOBS.map((glob) => deny('workspace.read', { paths: [glob] }, ISOLATE_NOTE)),
    ...CREDENTIAL_PATH_GLOBS.map((glob) => deny('workspace.write', { paths: [glob] }, ISOLATE_NOTE)),
    ask('workspace.write', { paths: ['**/*secret*'] },
      'secrets-shaped file needs review'),
  ]
}

/**
 * The policy mounts only under Ask authority; Auto keeps its original
 * behavior (the gateway's mode-independent guards remain the boundary).
 */
export function defaultPolicyFor(mode: PermissionMode): PermissionRule[] {
  return mode === 'ask' ? defaultPolicyRules() : []
}
