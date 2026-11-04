/**
 * Model capability normalization — the ONE seam a resolved model crosses on
 * its way into a session (SessionHost.initialize; subagent hosts converge on
 * the same initialize), and the only place allowed to know how capability
 * sources rank.
 *
 * Why this exists: capability facts reach the wire through overlapping
 * layers — user-declared settings metadata, the bundled catalog card, the
 * register-branch defaults, and API-verified corrections. When every layer
 * guessed on its own, the guesses compounded silently: a thinking level the
 * user picked was clamped UP to the model's maximum (billed at high reasoning
 * for a requested low), vision was dropped, windows were wrong. The rules
 * here are the opposite:
 *
 *   1. Precedence is explicit. Settings metadata (the user's declared truth)
 *      wins, then API-verified family corrections, then the catalog card as
 *      shipped, then the standard conservative map for cards that declare
 *      nothing.
 *   2. The UI selection is a CEILING, not a suggestion. When the model
 *      cannot honor the requested thinking level, resolution walks DOWN and
 *      never up — "unresolvable" must cost fewer tokens, not more. Pi's own
 *      clamp promotes (its walk starts upward), so the requested level is
 *      resolved HERE, before the session ever sees it; Pi's clamp then has
 *      nothing left to do.
 */

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat'
import type { Api, Model } from '@earendil-works/pi-ai'

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Pi's own level ordering (pi-ai EXTENDED_THINKING_LEVELS). */
export const THINKING_LEVEL_ORDER: ReadonlyArray<ThinkingLevel> = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]

export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>

/** The slice of settings-declared model metadata this layer consumes (the
 *  same block NodeProviderRegistry reads as `modelMeta`). Anything declared
 *  here overrides the card; undeclared fields fall through. */
export interface ModelCapabilityMeta {
  reasoning?: boolean
  input?: ReadonlyArray<string>
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: ThinkingLevelMap
}

/** A resolved Pi model, narrowed to what this layer reads or copies. */
export interface CapabilityModel {
  provider: string
  id: string
  baseUrl?: string
  reasoning?: boolean
  input?: ReadonlyArray<string>
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: ThinkingLevelMap
  /** pi-ai wire-compat slice this layer may correct. getCompat merges each
   *  field over its URL detection, so a partial object is enough. Typed by
   *  indexed access into pi's own `Model` rather than a hand-written shape:
   *  a closed local shape shares no optional property with the Anthropic /
   *  Bedrock members, so it rejects the very `Model` this seam is handed. */
  compat?: Model<Api>['compat']
}

/**
 * Standard map for cards that declare nothing (custom-configured providers):
 * the OpenAI-compatible common denominator. `minimal` and the extreme tiers
 * stay excluded until something actually declares them — an unknown model is
 * never advertised as max-capable.
 */
const STANDARD_THINKING_MAP: ThinkingLevelMap = {
  minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null,
}

/**
 * API-verified corrections — upstream cards that are wrong for their whole
 * family. DeepSeek's cards declare low/medium unsupported, so Pi's upward
 * clamp silently promoted every requested low/medium to high; the live API
 * accepts and honors them (verified against api.deepseek.com 2026-09-02:
 * HTTP 200, distinct reasoning volume per level). Keyed by provider; an
 * exact `provider/modelId` entry wins when a specific card diverges.
 */
const VERIFIED_THINKING_MAPS: Record<string, ThinkingLevelMap> = {
  deepseek: { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'max' },
}

/**
 * Z.ai / bigmodel endpoints: pi-ai's URL detection predates GLM-5's effort
 * contract and reports supportsReasoningEffort=false for EVERY model on these
 * hosts, so the resolved level rode the wire as a bare thinking on/off toggle
 * — low, medium and high all thought at the server's own effort (measured live
 * 2026-09-23 on glm-5.3-flash: reasoning_effort low=6 vs high=634 reasoning
 * tokens on one trivial question). pi's own bundled zai-coding-cn cards carry
 * the real contract for the generation that honors it — GLM-5.x:
 * supportsReasoningEffort=true plus this exact map (medium unsupported,
 * thinking never fully off). Applied only where upstream verified it; 4.x
 * keeps the older toggle behavior.
 */
const ZAI_EFFORT_HOSTS = ['open.bigmodel.cn', 'api.z.ai']
const GLM5_THINKING_MAP: ThinkingLevelMap = {
  off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max',
}

function isZaiEffortCapable(model: Pick<CapabilityModel, 'id' | 'baseUrl'>): boolean {
  const url = model.baseUrl ?? ''
  return /^glm-5/.test(model.id) && ZAI_EFFORT_HOSTS.some((host) => url.includes(host))
}

/**
 * Apply the precedence chain to one resolved model. Declared-here fields of
 * the settings metadata win; the thinking map resolves as settings → verified
 * correction (exact id, then provider family) → the card's own map → the
 * standard conservative map. All other card fields pass through untouched.
 */
export function normalizeModelCard<Model extends CapabilityModel>(
  model: Model,
  settingsMeta?: ModelCapabilityMeta | undefined,
): Model {
  const verified = VERIFIED_THINKING_MAPS[`${model.provider}/${model.id}`]
    ?? VERIFIED_THINKING_MAPS[model.provider]
  const zaiEffort = isZaiEffortCapable(model)
  const thinkingLevelMap = settingsMeta?.thinkingLevelMap
    ?? verified
    ?? (zaiEffort ? GLM5_THINKING_MAP : undefined)
    ?? model.thinkingLevelMap
    ?? STANDARD_THINKING_MAP
  return {
    ...model,
    ...(settingsMeta?.reasoning !== undefined ? { reasoning: settingsMeta.reasoning } : {}),
    ...(settingsMeta?.input !== undefined ? { input: settingsMeta.input } : {}),
    ...(settingsMeta?.contextWindow !== undefined ? { contextWindow: settingsMeta.contextWindow } : {}),
    ...(settingsMeta?.maxTokens !== undefined ? { maxTokens: settingsMeta.maxTokens } : {}),
    thinkingLevelMap,
    // A partial compat is enough: pi's getCompat merges this field over its
    // (outdated) URL detection instead of replacing the whole object.
    ...(zaiEffort ? { compat: { ...(model.compat ?? {}), supportsReasoningEffort: true } } : {}),
  }
}

/**
 * The effective thinking level for a user selection: the selected level when
 * the model supports it, otherwise the nearest LOWER supported level — never
 * a promotion. A reasoning model whose card supports nothing selectable
 * floors at 'off' (disabled), and a non-reasoning model always resolves to
 * 'off'. The result is always a level Pi's own clamp accepts unchanged.
 */
export function resolveThinkingLevel(
  model: Pick<CapabilityModel, 'reasoning' | 'thinkingLevelMap'>,
  selected: ThinkingLevel,
): ThinkingLevel {
  const supported = getSupportedThinkingLevels(model as never) as ThinkingLevel[]
  if (supported.includes(selected)) return selected
  let index = THINKING_LEVEL_ORDER.indexOf(selected)
  if (index === -1) index = THINKING_LEVEL_ORDER.length - 1
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const candidate = THINKING_LEVEL_ORDER[cursor]
    if (supported.includes(candidate)) return candidate
  }
  return supported[0] ?? 'off'
}
