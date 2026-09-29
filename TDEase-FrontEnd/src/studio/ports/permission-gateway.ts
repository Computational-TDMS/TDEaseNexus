import type { PermissionAction, PermissionDecision } from '@/services/agent/permissionResolver'

export interface PermissionGateway {
  decide(action: PermissionAction): PermissionDecision
  request(action: PermissionAction, reason: string): Promise<boolean>
}
