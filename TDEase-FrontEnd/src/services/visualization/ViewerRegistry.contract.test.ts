import { describe, expect, it } from 'vitest'

import viewerContractSource from './viewerContract?raw'
import { viewerRegistry } from './ViewerRegistry'

describe('ViewerRegistry contract', () => {
  it('keeps the viewer contract module framework-free (external-package boundary)', () => {
    expect(viewerContractSource).not.toMatch(/from\s+['"]vue['"]/)
  })

  it('is one static truth with a complete port contract for every viewer', () => {
    const registrations = viewerRegistry.list()
    const ids = registrations.map(registration => registration.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(registrations.length).toBeGreaterThan(0)

    for (const registration of registrations.filter(item => !item.id.startsWith('_node_'))) {
      expect(registration.ports, registration.id).toBeDefined()
      expect(registration.ports?.data.length, registration.id).toBeGreaterThan(0)
    }
  })

  it('fails closed for an unknown viewer', () => {
    expect(() => viewerRegistry.require('missing-viewer')).toThrowError(/missing-viewer/)
  })
})
