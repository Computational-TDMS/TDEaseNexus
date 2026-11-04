/**
 * Named presets for the custom-endpoint dialog.
 *
 * The static catalog already carries 40 first-class providers, so what is
 * left for a "custom" OpenAI-compatible endpoint is mostly LOCAL inference
 * servers — the ones with fixed, well-known ports — plus the fully manual
 * path. Cloud presets are deliberately absent: relay/gateway URLs are
 * account-specific and rot; the manual path covers them.
 *
 * A preset only prefills name/baseUrl in the dialog; nothing is written
 * until the user saves.
 */

export interface CustomEndpointPreset {
  id: string
  name: string
  baseUrl: string
}

export const CUSTOM_ENDPOINT_PRESETS: CustomEndpointPreset[] = [
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { id: 'llamacpp', name: 'llama.cpp', baseUrl: 'http://localhost:8080/v1' },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1' },
  { id: 'jan', name: 'Jan', baseUrl: 'http://127.0.0.1:1337/v1' },
]

/** The no-preset path: every field stays user-typed. */
export const MANUAL_ENDPOINT_ID = 'manual'
