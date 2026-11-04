declare const brand: unique symbol

export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name }

export type WorkspaceId = Brand<string, 'WorkspaceId'>
export type RunId = Brand<string, 'RunId'>
export type ResultId = Brand<string, 'ResultId'>
export type CanvasId = Brand<string, 'CanvasId'>
export type PlanRef = Brand<string, 'PlanRef'>
export type Sha256 = Brand<string, 'Sha256'>
export type RelativePath = Brand<string, 'RelativePath'>

export function asWorkspaceId(value: string): WorkspaceId {
  return nonEmpty(value, 'WorkspaceId') as WorkspaceId
}

export function asRunId(value: string): RunId {
  return nonEmpty(value, 'RunId') as RunId
}

export function asResultId(value: string): ResultId {
  return nonEmpty(value, 'ResultId') as ResultId
}

export function asCanvasId(value: string): CanvasId {
  return nonEmpty(value, 'CanvasId') as CanvasId
}

export function asPlanRef(value: string): PlanRef {
  return nonEmpty(value, 'PlanRef') as PlanRef
}

export function asSha256(value: string): Sha256 {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Sha256 must contain 64 hexadecimal characters')
  return value.toLowerCase() as Sha256
}

export function asRelativePath(value: string): RelativePath {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
    throw new Error('RelativePath must be a non-empty relative path')
  }
  if (normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('RelativePath must not escape its root or contain empty segments')
  }
  return normalized as RelativePath
}

function nonEmpty(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} must not be empty`)
  return normalized
}
