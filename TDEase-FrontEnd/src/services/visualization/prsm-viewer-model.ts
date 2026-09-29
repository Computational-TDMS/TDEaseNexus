import {
  FragmentationCalculator,
  activationToIonTypes,
  type IonType,
  type MatchedFragment,
} from '@/composables/ms2-sequence'
import { parseProteoformAnnotation } from '@/utils/proforma'
import type { MsAlignSpectrum } from './msalign'

export interface PrsmViewerModel {
  sequence: string
  modifications: ReturnType<typeof parseProteoformAnnotation>['modifications']
  spectrum: MsAlignSpectrum
  matchedFragments: MatchedFragment[]
}

export interface PrsmMatchOptions {
  ionTypes?: IonType[]
  maxCharge?: number
  tolerancePpm?: number
  includeNeutralLosses?: boolean
}

const PROFORMA_KEYS = ['Proteoform', 'proteoform', 'Proteoform annotation', 'proteoform_annotation', 'ProForma', 'proforma']
const SPECTRUM_ID_KEYS = ['Spectrum ID', 'spectrum_id', 'SpectrumID', 'spectrumId']

export function composePrsmViewerModel(
  row: Record<string, unknown>,
  spectra: MsAlignSpectrum[],
  options: PrsmMatchOptions = {},
): PrsmViewerModel | null {
  const proforma = stringField(row, PROFORMA_KEYS)
  const spectrumId = numberField(row, SPECTRUM_ID_KEYS)
  if (!proforma || spectrumId === undefined) return null
  const spectrum = spectra.find(item => item.spectrumId === spectrumId || item.scan === spectrumId)
  if (!spectrum) return null

  const parsed = parseProteoformAnnotation(proforma)
  if (!parsed.sequence) return null
  const calculator = new FragmentationCalculator()
  const ionTypes = options.ionTypes ?? activationToIonTypes(spectrum.activation ?? '')
  const theoretical = calculator.computeFragments(
    parsed.sequence,
    ionTypes,
    options.maxCharge ?? 2,
    parsed.modifications,
    options.includeNeutralLosses ?? false,
  )
  return {
    sequence: parsed.sequence,
    modifications: parsed.modifications,
    spectrum,
    matchedFragments: calculator.matchPeaks(
      spectrum.peaks,
      theoretical,
      options.tolerancePpm ?? 20,
      undefined,
      'best',
    ),
  }
}

function stringField(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function numberField(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(row[key])
    if (Number.isFinite(value)) return value
  }
  return undefined
}
