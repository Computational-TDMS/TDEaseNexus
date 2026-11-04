import { describe, expect, it } from 'vitest'
import { projectResultAvailability } from './result-availability'

describe('result availability', () => {
  it('keeps publication truth independent from cache presence', () => {
    expect(projectResultAvailability({ published: false, cachedDigestMatches: true, cachedDigestConflicts: false })).toBe('unavailable')
    expect(projectResultAvailability({ published: true, cachedDigestMatches: false, cachedDigestConflicts: false })).toBe('remote')
    expect(projectResultAvailability({ published: true, cachedDigestMatches: true, cachedDigestConflicts: false })).toBe('cached')
  })

  it('surfaces digest conflicts before cached availability', () => {
    expect(projectResultAvailability({ published: true, cachedDigestMatches: true, cachedDigestConflicts: true })).toBe('conflict')
  })
})
