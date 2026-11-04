import type { SpectrumPeak } from '@/composables/ms2-sequence'

export interface MsAlignSpectrum {
  spectrumId: number
  scan?: number
  activation?: string
  precursorMz?: number
  precursorCharge?: number
  peaks: SpectrumPeak[]
  metadata: Record<string, string>
}

const NUMBER_KEYS = {
  spectrumId: ['SPECTRUM_ID', 'ID'],
  scan: ['SCANS', 'SCAN'],
  precursorMz: ['PRECURSOR_MZ'],
  precursorCharge: ['PRECURSOR_CHARGE', 'CHARGE'],
} as const

export function parseMsAlign(raw: string): MsAlignSpectrum[] {
  const spectra: MsAlignSpectrum[] = []
  let metadata: Record<string, string> | null = null
  let peaks: SpectrumPeak[] = []

  const finish = () => {
    if (!metadata) return
    const spectrumId = numberFrom(metadata, NUMBER_KEYS.spectrumId)
    if (spectrumId !== undefined) {
      spectra.push({
        spectrumId,
        scan: numberFrom(metadata, NUMBER_KEYS.scan),
        activation: valueFrom(metadata, ['ACTIVATION', 'FRAG_METHOD']),
        precursorMz: numberFrom(metadata, NUMBER_KEYS.precursorMz),
        precursorCharge: numberFrom(metadata, NUMBER_KEYS.precursorCharge),
        peaks,
        metadata,
      })
    }
    metadata = null
    peaks = []
  }

  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.toUpperCase() === 'BEGIN IONS') {
      finish()
      metadata = {}
      continue
    }
    if (line.toUpperCase() === 'END IONS') {
      finish()
      continue
    }
    if (!metadata) continue
    const separator = line.indexOf('=')
    if (separator > 0) {
      metadata[line.slice(0, separator).trim().toUpperCase()] = line.slice(separator + 1).trim()
      continue
    }
    const fields = line.split(/\s+/)
    const mz = Number(fields[0])
    const intensity = Number(fields[1])
    const charge = fields[2] === undefined ? undefined : Number(fields[2])
    if (!Number.isFinite(mz) || !Number.isFinite(intensity)) continue
    peaks.push({
      index: peaks.length,
      mz,
      intensity,
      charge: Number.isFinite(charge) ? charge : undefined,
      isDeconvoluted: Number.isFinite(charge),
    })
  }
  finish()
  return spectra
}

function valueFrom(metadata: Record<string, string>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key]
    if (value) return value
  }
  return undefined
}

function numberFrom(metadata: Record<string, string>, keys: readonly string[]): number | undefined {
  const value = valueFrom(metadata, keys)
  if (value === undefined) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
