import { describe, expect, it } from 'vitest'

import { ResultDeduplicator } from './result-dedup'

const big = (fill: string) => `node card for ${fill} ` + 'x'.repeat(500)

describe('ResultDeduplicator', () => {
  it('passes a first large result through unchanged', () => {
    const dedup = new ResultDeduplicator()
    const text = big('toppic')
    expect(dedup.filter(text, 'tdease.nodes.get')).toBe(text)
  })

  it('suppresses a byte-identical repeat with a placeholder naming the first tool', () => {
    const dedup = new ResultDeduplicator()
    dedup.filter(big('toppic'), 'tdease.nodes.get')
    const again = dedup.filter(big('toppic'), 'tdease.nodes.get')
    expect(again).toContain('[duplicate suppressed]')
    expect(again).toContain('tdease.nodes.get')
    expect(again).toContain('"refresh": true')
    expect(again.length).toBeLessThan(400)
  })

  it('suppresses identity across different tools — the copy is in context either way', () => {
    const dedup = new ResultDeduplicator()
    dedup.filter(big('shared'), 'tdease.skill.read')
    expect(dedup.filter(big('shared'), 'tdease.templates.get')).toContain('[duplicate suppressed]')
  })

  it('leaves short results alone — a repeat is cheaper than the explanation', () => {
    const dedup = new ResultDeduplicator()
    const status = '{"state":"running"}'
    dedup.filter(status, 'tdease.runs.status')
    expect(dedup.filter(status, 'tdease.runs.status')).toBe(status)
  })

  it('force (refresh) returns the full text again', () => {
    const dedup = new ResultDeduplicator()
    const text = big('informed-proteomics')
    dedup.filter(text, 'tdease.nodes.get')
    expect(dedup.filter(text, 'tdease.nodes.get', true)).toBe(text)
  })

  it('different content is never suppressed', () => {
    const dedup = new ResultDeduplicator()
    dedup.filter(big('a'), 'tdease.nodes.get')
    const other = dedup.filter(big('b'), 'tdease.nodes.get')
    expect(other).not.toContain('[duplicate suppressed]')
  })
})
