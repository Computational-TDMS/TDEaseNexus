import { describe, expect, it } from 'vitest'
import { resolveMs2SelectionContext } from './composition'

describe('resolveMs2SelectionContext', () => {
  it('prefers identity-first selectedRefs', () => {
    const context = resolveMs2SelectionContext(
      [
        { 'Prsm ID': '1', Proteoform: 'A' },
        { 'Prsm ID': '2', Proteoform: 'B' },
      ],
      { selectedRefs: [{ field: 'Prsm ID', value: '2' }], selectedIndices: new Set<number>() } as any,
    )

    expect(context.selectedPrsmId).toBe(2)
    expect(context.selectedRow).toMatchObject({ 'Prsm ID': '2' })
  })

  it('falls back to row-index selections for compatibility', () => {
    const context = resolveMs2SelectionContext(
      [
        { 'Prsm ID': '10' },
        { 'Prsm ID': '20' },
      ],
      { selectedIndices: new Set<number>([1]), selectedRefs: [] } as any,
    )

    expect(context.selectedPrsmId).toBe(20)
    expect(context.selectedRow).toMatchObject({ 'Prsm ID': '20' })
  })

  it('treats out-of-range numeric selections as PrSM IDs', () => {
    const context = resolveMs2SelectionContext(
      [
        { 'Prsm ID': '10' },
        { 'Prsm ID': '20' },
      ],
      { selectedIndices: new Set<number>([20]), selectedRefs: [] } as any,
    )

    expect(context.selectedPrsmId).toBe(20)
    expect(context.selectedRow).toMatchObject({ 'Prsm ID': '20' })
  })

  it('accepts legacy selectedRef val fields', () => {
    const context = resolveMs2SelectionContext(
      [
        { 'Prsm ID': '1', Proteoform: 'A' },
        { 'Prsm ID': '2', Proteoform: 'B' },
      ],
      { selectedRefs: [{ field: 'Prsm ID', val: '2' }], selectedIndices: new Set<number>() } as any,
    )

    expect(context.selectedPrsmId).toBe(2)
    expect(context.selectedRow).toMatchObject({ 'Prsm ID': '2' })
  })

  it('defaults to the first PRSM row when nothing is selected', () => {
    const context = resolveMs2SelectionContext(
      [
        { 'Prsm ID': '10', Proteoform: 'A' },
        { 'Prsm ID': '20', Proteoform: 'B' },
      ],
      null,
    )

    expect(context.selectedPrsmId).toBe(10)
    expect(context.selectedRow).toMatchObject({ 'Prsm ID': '10' })
  })
})
