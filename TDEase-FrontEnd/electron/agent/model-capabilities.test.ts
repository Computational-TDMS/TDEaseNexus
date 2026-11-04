import { describe, expect, it } from 'vitest'

import { normalizeModelCard, resolveThinkingLevel } from './model-capabilities'

/**
 * The capability seam's two contracts: an explicit precedence chain for
 * capability facts, and a CEILING on the user's thinking selection —
 * resolution walks down, never up.
 */

const DEEPSEEK_STYLE_CARD = {
  provider: 'deepseek',
  id: 'deepseek-chat',
  reasoning: true,
  // The upstream card shape that started this: low/medium declared
  // unsupported, so Pi's upward clamp promoted requested low/medium to high.
  thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high' },
}

describe('normalizeModelCard precedence', () => {
  it('applies the API-verified family correction over a wrong card', () => {
    const model = normalizeModelCard(DEEPSEEK_STYLE_CARD)
    expect(model.thinkingLevelMap).toMatchObject({ low: 'low', medium: 'medium', high: 'high', xhigh: 'max' })
  })

  it('falls back from an unknown exact id to the provider-family correction', () => {
    const model = normalizeModelCard({
      provider: 'deepseek',
      id: 'deepseek-special',
      thinkingLevelMap: { low: 'low' },
    })
    expect(model.thinkingLevelMap).toMatchObject({ low: 'low' })
  })

  it('lets settings metadata win over everything, per declared field', () => {
    const model = normalizeModelCard(
      { provider: 'zai', id: 'glm-4.6', reasoning: true, contextWindow: 200_000 },
      { reasoning: false, contextWindow: 1_000_000 },
    )
    expect(model.reasoning).toBe(false)
    expect(model.contextWindow).toBe(1_000_000)
  })

  it('gives a card that declares nothing the standard conservative map', () => {
    const model = normalizeModelCard({ provider: 'my-relay', id: 'some-model', reasoning: true })
    // minimal and the extreme tiers excluded; the mid tiers honest.
    expect(model.thinkingLevelMap).toMatchObject({ minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null })
  })

  it('passes cards through untouched when everything already agrees', () => {
    const card = { provider: 'anthropic', id: 'claude-x', reasoning: true }
    const model = normalizeModelCard(card)
    expect(model).toEqual({ ...card, thinkingLevelMap: { minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null } })
  })

  it('restores GLM-5 effort support on zai hosts that TDEase registered itself', () => {
    // The user's provider ids ('glm', 'zhipu-coding-cn') miss pi's catalog, so
    // the register branch rebuilds a bare model and pi's URL detection drops
    // supportsReasoningEffort for every bigmodel host — every level thought at
    // the server's default. The seam restores the bundled-card contract.
    const model = normalizeModelCard({
      provider: 'glm',
      id: 'glm-5.3-flash',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      reasoning: true,
    })
    expect(model.thinkingLevelMap).toMatchObject({ off: null, low: 'low', medium: null, high: 'high', max: 'max' })
    expect(model.compat).toMatchObject({ supportsReasoningEffort: true })
    // Works regardless of the user's provider naming — the URL decides.
    const renamed = normalizeModelCard({
      provider: 'my-glm-relay',
      id: 'glm-5.3',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      reasoning: true,
    })
    expect(renamed.compat).toMatchObject({ supportsReasoningEffort: true })
  })

  it('leaves non-GLM-5 and non-zai models on their previous contract', () => {
    // GLM-4.x: upstream never verified effort there — no correction.
    const glm4 = normalizeModelCard({
      provider: 'zhipu-coding-cn',
      id: 'glm-4.7',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      reasoning: true,
    })
    expect(glm4.compat).toBeUndefined()
    expect(glm4.thinkingLevelMap).toMatchObject({ low: 'low', medium: 'medium', high: 'high' })
    // Same id on a non-zai host: no correction either.
    const proxied = normalizeModelCard({
      provider: 'my-relay',
      id: 'glm-5.3',
      baseUrl: 'https://relay.example.com/v1',
      reasoning: true,
    })
    expect(proxied.compat).toBeUndefined()
  })
})

describe('resolveThinkingLevel ceiling semantics', () => {
  it('honors a supported selection verbatim', () => {
    const model = normalizeModelCard(DEEPSEEK_STYLE_CARD)
    expect(resolveThinkingLevel(model, 'low')).toBe('low')
    expect(resolveThinkingLevel(model, 'high')).toBe('high')
  })

  it('never promotes: an unsupported selection walks DOWN', () => {
    // A card that nulls medium must not turn a requested medium into high —
    // the exact behavior the DeepSeek audit caught (billed high for low).
    const model = normalizeModelCard({
      provider: 'some-family',
      id: 'some-model',
      reasoning: true,
      thinkingLevelMap: { low: 'low', medium: null, high: 'high' },
    })
    expect(resolveThinkingLevel(model, 'medium')).toBe('low')
  })

  it('resolves an unknown model down from max, and never above high', () => {
    // No declared map: xhigh/max are unverifiable, so a picked max lands on
    // high — the highest HONEST tier — never a fabricated extreme.
    const model = normalizeModelCard({ provider: 'my-relay', id: 'some-model', reasoning: true })
    expect(resolveThinkingLevel(model, 'max')).toBe('high')
    expect(resolveThinkingLevel(model, 'xhigh')).toBe('high')
    expect(resolveThinkingLevel(model, 'low')).toBe('low')
  })

  it('floors a non-reasoning model at off', () => {
    const model = normalizeModelCard({ provider: 'x', id: 'y', reasoning: false })
    expect(resolveThinkingLevel(model, 'high')).toBe('off')
  })

  it('GLM-5 on a zai host: low stays low, unsupported tiers walk down, off floors at low', () => {
    const model = normalizeModelCard({
      provider: 'glm',
      id: 'glm-5.3-flash',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      reasoning: true,
    })
    // The whole point of the fix: the picked level rides the wire verbatim.
    expect(resolveThinkingLevel(model, 'low')).toBe('low')
    expect(resolveThinkingLevel(model, 'high')).toBe('high')
    // medium/xhigh unsupported per the upstream card — walk down, never up.
    expect(resolveThinkingLevel(model, 'medium')).toBe('low')
    expect(resolveThinkingLevel(model, 'xhigh')).toBe('high')
    expect(resolveThinkingLevel(model, 'max')).toBe('max')
    // The card declares thinking never fully off — the honest floor is low.
    expect(resolveThinkingLevel(model, 'off')).toBe('low')
  })
})
