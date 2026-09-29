/**
 * Central export point for type definitions.
 */

// Visualization types — the core type system
export * from './visualization'

// Selection types — unified scope model
export * from './selection'

export interface SlashCommand {
  name: string
  aliases?: string[]
  description?: string
  usage?: string
  permission?: 'anyone' | 'owner' | 'admin'
}
