import type { JsonSchema } from './registry'

/**
 * Shared command-arg vocabulary: the schema builders and arg coercers every
 * command family uses. Family modules import these next to `../registry`;
 * nothing here knows a port or a family — helpers that bind one family's
 * input live inside that family's module.
 */

export const EMPTY_ARGS: JsonSchema = {
  type: 'object', additionalProperties: false, properties: {},
}

export function objectSchema(properties: Readonly<Record<string, JsonSchema>>, required: ReadonlyArray<string> = []): JsonSchema {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) }
}

export function stringSchema(): JsonSchema { return { type: 'string', minLength: 1 } }

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`)
  return value
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  return requiredString(args, key)
}

export function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`)
  return value as number
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`)
  return value
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

export function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${key} must be an array of strings`)
  return [...value]
}

export function optionalRecord(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  return requiredRecord(args, key)
}

export function requiredRecord(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key]
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${key} must be an object`)
  return { ...(value as Record<string, unknown>) }
}
