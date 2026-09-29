import { describe, it, expect } from 'vitest'
import { parseHex, mixSrgb, relativeLuminance, contrastRatio } from './color.mjs'

describe('parseHex', () => {
  it('parses 6-digit hex', () => {
    expect(parseHex('#1e1e2e')).toEqual({ r: 30, g: 30, b: 46 })
  })

  it('parses 3-digit hex by doubling each nibble', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseHex('#000')).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('parses 8-digit hex, ignoring the alpha channel', () => {
    expect(parseHex('#11696dff')).toEqual({ r: 17, g: 105, b: 109 })
  })

  it('accepts a bare hex string without a leading #', () => {
    expect(parseHex('ffffff')).toEqual({ r: 255, g: 255, b: 255 })
  })
})

describe('mixSrgb', () => {
  it('at 0% returns b unchanged', () => {
    expect(mixSrgb({ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, 0)).toEqual({ r: 0, g: 255, b: 0 })
  })

  it('at 100% returns a unchanged', () => {
    expect(mixSrgb({ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, 100)).toEqual({ r: 255, g: 0, b: 0 })
  })

  it('matches a hand-computed 25%/75% blend of black and white', () => {
    // round(0*0.25 + 255*0.75) = round(191.25) = 191, all channels equal.
    expect(mixSrgb({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 25)).toEqual({ r: 191, g: 191, b: 191 })
  })

  it('matches a hand-computed 50%/50% blend of black and white', () => {
    // round(0*0.5 + 255*0.5) = round(127.5) = 128.
    expect(mixSrgb({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 50)).toEqual({ r: 128, g: 128, b: 128 })
  })

  it('matches a hand-computed 40%/60% blend of an arbitrary pair', () => {
    // r: round(200*0.4 + 0*0.6) = 80
    // g: round(100*0.4 + 0*0.6) = 40
    // b: round(50*0.4  + 0*0.6) = 20
    expect(mixSrgb({ r: 200, g: 100, b: 50 }, { r: 0, g: 0, b: 0 }, 40)).toEqual({ r: 80, g: 40, b: 20 })
  })
})

describe('relativeLuminance', () => {
  it('is 1 for white', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6)
  })

  it('is 0 for black', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 6)
  })
})

describe('contrastRatio — WCAG anchors', () => {
  it('black on white is 21:1', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 2)
  })

  it('white on white is 1:1', () => {
    expect(contrastRatio({ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6)
  })

  it('is symmetric regardless of fg/bg order', () => {
    const a = { r: 30, g: 30, b: 46 }
    const b = { r: 239, g: 241, b: 245 }
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10)
  })

  it('#767676 on white is the canonical ~4.54:1 AA boundary pair (hand-computed)', () => {
    // L(#767676) = ((0.4627 + 0.055) / 1.055)^2.4 ≈ 0.18128 (all channels equal)
    // L(white)   = 1
    // ratio = (1 + 0.05) / (0.18128 + 0.05) ≈ 4.541
    expect(contrastRatio(parseHex('#767676'), parseHex('#ffffff'))).toBeCloseTo(4.54, 1)
  })

  it('#595959 on white is the canonical ~7.0:1 AAA boundary pair (hand-computed)', () => {
    // L(#595959) = ((0.34902 + 0.055) / 1.055)^2.4 ≈ 0.09989 (all channels equal)
    // ratio = 1.05 / 0.14989 ≈ 7.006
    expect(contrastRatio(parseHex('#595959'), parseHex('#ffffff'))).toBeCloseTo(7.0, 1)
  })
})
