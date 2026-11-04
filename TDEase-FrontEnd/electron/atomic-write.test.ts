import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mergeProviderConfig, updateSettingsFile } from './atomic-write'

describe('mergeProviderConfig', () => {
  it('shallow-merges a credential write over the existing block', () => {
    expect(mergeProviderConfig(
      { apiKey: 'old', baseUrl: 'https://a', models: { m: { contextWindow: 1 } } },
      { apiKey: 'new' },
    )).toEqual({ apiKey: 'new', baseUrl: 'https://a', models: { m: { contextWindow: 1 } } })
  })

  it('a credential clear keeps the frozen models map and drops the rest', () => {
    expect(mergeProviderConfig(
      { apiKey: 'sk', baseUrl: 'https://a', models: { m: { contextWindow: 1 } } },
      {},
    )).toEqual({ models: { m: { contextWindow: 1 } } })
  })

  it('a clear with nothing worth keeping drops the whole block', () => {
    expect(mergeProviderConfig({ apiKey: 'sk', baseUrl: 'https://a' }, {})).toBeNull()
    expect(mergeProviderConfig(undefined, {})).toBeNull()
  })
})

describe('updateSettingsFile', () => {
  let root: string
  let settingsPath: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-atomic-write-'))
    settingsPath = path.join(root, 'settings.json')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('serializes the whole read-modify-write: concurrent updates lose nothing', async () => {
    writeFileSync(settingsPath, `${JSON.stringify({ n: 0 })}\n`, 'utf8')

    await Promise.all(Array.from({ length: 20 }, () =>
      updateSettingsFile(settingsPath, (doc) => ({ ...(doc ?? {}), n: ((doc?.n as number) ?? 0) + 1 }))))

    expect((JSON.parse(readFileSync(settingsPath, 'utf8')) as { n: number }).n).toBe(20)
  })

  it('aborts without writing when the transform returns null (never invents a file)', async () => {
    await expect(updateSettingsFile(settingsPath, () => null)).resolves.toBe(false)
    expect(existsSync(settingsPath)).toBe(false)

    writeFileSync(settingsPath, `${JSON.stringify({ keep: true })}\n`, 'utf8')
    await expect(updateSettingsFile(settingsPath, () => null)).resolves.toBe(false)
    expect((JSON.parse(readFileSync(settingsPath, 'utf8')) as { keep: boolean }).keep).toBe(true)
  })

  it('hands the transform null for a missing or corrupt document', async () => {
    const seen: Array<Record<string, unknown> | null> = []
    await updateSettingsFile(settingsPath, (doc) => { seen.push(doc); return null })
    writeFileSync(settingsPath, '{not json', 'utf8')
    await updateSettingsFile(settingsPath, (doc) => { seen.push(doc); return null })
    expect(seen).toEqual([null, null])
  })

  it('preserves keys the transform did not touch', async () => {
    writeFileSync(settingsPath, `${JSON.stringify({ schemaVersion: 3, compaction: { keepRecentTokens: 200 } })}\n`, 'utf8')
    await updateSettingsFile(settingsPath, (doc) => ({ ...(doc ?? {}), providers: { deepseek: { apiKey: 'sk' } } }))
    const doc = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(doc.schemaVersion).toBe(3)
    expect(doc.compaction).toEqual({ keepRecentTokens: 200 })
    expect(doc.providers).toEqual({ deepseek: { apiKey: 'sk' } })
  })
})
