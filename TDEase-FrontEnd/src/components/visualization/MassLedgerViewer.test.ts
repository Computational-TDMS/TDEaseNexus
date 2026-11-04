import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import MassLedgerViewer from './MassLedgerViewer.vue'
import { parseMassLedger } from '@/services/visualization/massLedger'

/**
 * The ledger's presentation contract: one signed row per term, the residual
 * row only when the kernel carries one, the sum rule, and the three closure
 * boxes — all numbers the kernel's own, at four decimals.
 */
const MODEL = parseMassLedger({
  sequence: 'MGNCGSNPKT',
  observedShift: 317.3952,
  candidates: [{
    combination: 'Myristoyl+Palmitoyl',
    combinationMass: 317.3951,
    massErrorDa: 0.0001,
    score: 0.82,
    proforma: '(MGN)[+210.1984]C[+238.2297]GSNPKT',
  }],
})

describe('MassLedgerViewer', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function mountViewer() {
    return mount(MassLedgerViewer, { props: { model: MODEL } })
  }

  it('renders one signed row per term plus the sum rule', () => {
    const wrapper = mountViewer()
    const rows = wrapper.findAll('.mass-ledger__row')
    // Two terms + the sum row; no residual row (freeMass absent).
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('+210.1984')
    expect(rows[1].text()).toContain('+238.2297')
    expect(rows[2].text()).toContain('+317.3951')
  })

  it('shows the closure verdict: observed vs model vs error in Da and ppm', () => {
    const wrapper = mountViewer()
    const boxes = wrapper.findAll('.mass-ledger__box')
    expect(boxes).toHaveLength(3)
    expect(boxes[0].text()).toContain('317.3952')
    expect(boxes[1].text()).toContain('317.3951')
    expect(boxes[2].text()).toContain('0.0001 Da')
    expect(boxes[2].text()).toMatch(/0\.32 ppm/)
  })

  it('renders the residual row only when the kernel carries a free mass', () => {
    const withResidual = parseMassLedger({
      sequence: 'PEPTIDE',
      observedShift: 300,
      candidates: [{
        combination: 'X',
        combinationMass: 250,
        freeMass: 50,
        massErrorDa: 0,
        score: 0.1,
        proforma: '(PT)[+250]IDE',
      }],
    })
    const wrapper = mount(MassLedgerViewer, { props: { model: withResidual } })
    const rows = wrapper.findAll('.mass-ledger__row')
    expect(rows).toHaveLength(3)
    expect(rows[1].text()).toContain('+50.0000')
  })

  it('names the shift when a term carries no modification name', () => {
    const wrapper = mountViewer()
    expect(wrapper.findAll('.mass-ledger__row')[0].text()).toContain('质量位移')
  })
})
