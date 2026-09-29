/**
 * Permission mode helpers for the Renderer.
 *
 * The Renderer-side Agent composition root that used to live here is gone: the
 * full AgentRuntime now runs in Electron main (electron/agent/**), and the
 * Renderer only submits commands + renders events. What remains is the pure
 * permission vocabulary the UI still needs: the `PermissionMode` axis (ask /
 * auto) and `contextFor`, which the PermissionsSettings panel and the runs
 * store use to project the same deny > ask > allow ladder main enforces.
 *
 * Kept as a thin module (not deleted) precisely because these are pure,
 * side-effect-free derivations over `permissionResolver` — the same logic
 * main's NodePermissionGateway freezes into the SessionBinding.permissionCeiling
 * at bind time. There is no second permission model here.
 */

import {
  resolvePermission,
  systemRulesForMode,
  type PermissionAction,
  type PermissionContext,
  type PermissionDecision,
  type PermissionMode,
} from './permissionResolver'

export type { PermissionMode }

/**
 * The permission axis (orthogonal to the agent mindset axis). Maps onto the
 * SAME permissionResolver main uses — `contextFor` wraps `systemRulesForMode`,
 * the single source of truth for the ladder (read → allow; writes → allow only
 * in auto; destructive/shell actions always ask), so Renderer and main cannot
 * drift.
 *
 * There is no 'deny' tier in this two-level model — read tools always run,
 * side-effecting tools either ask (ask mode) or run (auto mode). The
 * resolver's deny-dominant rank is retained for Workspace `.tdease/permissions.json`
 * rules, which deny dominates regardless of mode.
 */

/**
 * Build the permission context for a given PermissionMode.
 *
 * Exported so the PermissionsSettings panel can show the real resolved
 * decisions instead of a parallel copy that would silently drift, and so the
 * runs store answers `decide()` the same way main's frozen ceiling does.
 *
 * `workspaceRules` carries the Workspace's own `.tdease/permissions.json`
 * deny/ask/allow rules; deny dominates the mode's defaults (the resolver ranks
 * deny > ask > allow), so a Workspace can lock down an action neither mode
 * would otherwise gate.
 */
export function contextFor(
  mode: PermissionMode,
  workspaceRules: PermissionContext['workspace'] = [],
): PermissionContext {
  return { system: systemRulesForMode(mode), user: [], workspace: workspaceRules }
}

export { resolvePermission }
export type { PermissionAction, PermissionContext, PermissionDecision }
