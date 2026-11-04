import defaultModelsJson from '../default-models.json'
import { PROVIDERS, type ProviderDef } from './provider-definitions'

const defaultModels = defaultModelsJson as unknown as Record<string, string[]>

export const DEFAULT_PROVIDER_ID = 'deepseek'
export const DEFAULT_MODEL_ID = 'deepseek-v4-flash'

export interface ProviderInfo {
  id: string
  displayName: string
  authType: 'api-key' | 'oauth' | 'none'
  defaultBaseUrl: string
  defaultApi: string
  /** Marquee vendor — pickers surface these uncollapsed (undefined = fold). */
  featured?: boolean
  /** Vendor console page where an API key is issued. */
  keyUrl?: string
  models: string[]
}

export interface CredentialInput {
  apiKey?: string
  baseUrl?: string
  headers?: Record<string, string>
}

function toProviderInfo(provider: ProviderDef): ProviderInfo {
  return { ...provider, models: defaultModels[provider.id] ?? [] }
}

export function listProviders(): ProviderInfo[] {
  return PROVIDERS.map(toProviderInfo)
}

export function listModels(providerId: string): string[] {
  return defaultModels[providerId] ?? []
}
