/**
 * Synthesizes a `JSONSchemaObject` from a tool call's argument shape, so the
 * approval card can render args through the shared `SchemaForm` primitive in
 * read-only mode instead of a raw JSON dump (
 * "It renders args, not intent").
 *
 * The registered command surface does not carry a per-command JSON Schema
 * today (see the task report), so this infers one from the value shape at
 * render time — string/number/boolean/string-array map to `SchemaForm`'s
 * supported shapes; anything else (nested object, mixed array) is left
 * `unsupported`, which `SchemaForm` already renders as a labelled JSON
 * preview rather than silently dropping the field.
 */
import type { JSONSchemaObject, JSONSchemaProperty } from '@/components/primitives/SchemaForm.vue'

export function inferArgsSchema(args: Record<string, unknown> | undefined): JSONSchemaObject {
  const properties: Record<string, JSONSchemaProperty> = {}
  for (const [key, value] of Object.entries(args ?? {})) {
    properties[key] = inferProperty(value)
  }
  return { type: 'object', properties }
}

function inferProperty(value: unknown): JSONSchemaProperty {
  if (typeof value === 'string') return { type: 'string', format: value.length > 80 ? 'multiline' : undefined }
  if (typeof value === 'number') return { type: 'number' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return { type: 'array', items: { enum: value as string[] }, enum: value as string[] }
  }
  return { type: 'object' }
}
