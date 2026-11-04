import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  applyProxyEnv,
  noProxyWithLoopback,
  normalizeProxyConfig,
  updaterProxyRules,
} from './proxy-config'

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const
const saved: Record<string, string | undefined> = {}
beforeAll(() => { for (const name of PROXY_VARS) saved[name] = process.env[name] })
afterEach(() => { for (const name of PROXY_VARS) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name] } })

describe('normalizeProxyConfig', () => {
  it('keeps a valid http(s) URL and rejects everything else as off', () => {
    expect(normalizeProxyConfig({ url: ' http://127.0.0.1:7890 ', noProxy: ' corp.internal ' }))
      .toEqual({ url: 'http://127.0.0.1:7890', noProxy: 'corp.internal' })
    expect(normalizeProxyConfig({ url: 'socks5://x:1' }).url).toBe('')
    expect(normalizeProxyConfig({ url: 'not a url' }).url).toBe('')
    expect(normalizeProxyConfig('junk').url).toBe('')
    expect(normalizeProxyConfig(undefined).url).toBe('')
  })
})

describe('noProxyWithLoopback', () => {
  it('always pins loopback entries, deduped', () => {
    expect(noProxyWithLoopback('')).toBe('localhost,127.0.0.1,::1')
    expect(noProxyWithLoopback('127.0.0.1, corp.internal ,localhost'))
      .toBe('localhost,127.0.0.1,::1,corp.internal')
  })
})

describe('applyProxyEnv', () => {
  it('sets both cases of the proxy vars and forces loopback into NO_PROXY', () => {
    applyProxyEnv({ url: 'http://proxy.local:8080', noProxy: 'a.com' })
    expect(process.env.HTTP_PROXY).toBe('http://proxy.local:8080')
    expect(process.env.https_proxy).toBe('http://proxy.local:8080')
    expect(process.env.NO_PROXY).toContain('127.0.0.1')
    expect(process.env.NO_PROXY).toContain('a.com')
  })

  it('clearing deletes every variant so no stale copy keeps children proxied', () => {
    process.env.http_proxy = 'http://stale:1'
    applyProxyEnv({ url: '', noProxy: '' })
    for (const name of PROXY_VARS) expect(process.env[name]).toBeUndefined()
  })

  it('rebuilds the dispatcher through the injected applier', () => {
    const configureDispatcher = vi.fn()
    applyProxyEnv({ url: 'http://p:1', noProxy: '' }, { configureDispatcher })
    expect(configureDispatcher).toHaveBeenCalledTimes(1)
    applyProxyEnv({ url: '', noProxy: '' }, { configureDispatcher })
    expect(configureDispatcher).toHaveBeenCalledTimes(2)
  })
})

describe('updaterProxyRules', () => {
  it('fixed rules while proxied, system mode when off', () => {
    expect(updaterProxyRules({ url: 'http://p:1', noProxy: '' })).toMatchObject({
      mode: 'fixed_servers',
      proxyRules: 'http://p:1',
      proxyBypassRules: expect.stringContaining('localhost'),
    })
    expect(updaterProxyRules({ url: '', noProxy: '' })).toEqual({ mode: 'system' })
  })
})
