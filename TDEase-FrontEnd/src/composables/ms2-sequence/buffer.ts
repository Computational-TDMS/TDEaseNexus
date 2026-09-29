/**
 * Buffer edit-mode management
 * Temporary editing of sequence and modifications, with apply/discard support
 */

import type { Modification, SpectrumPeak } from './fragmentation'

export interface SequenceData {
  value: string
  length: number
  firstPosition?: number
  lastPosition?: number
}

export interface MS2SpectrumData {
  peaks: SpectrumPeak[]
  precursorMz: number
  precursorCharge: number
  retentionTime?: number
  collisionEnergy?: number
  activationMethod?: string
}

export interface MS2SequenceViewerInput {
  sequence: SequenceData
  spectrum: MS2SpectrumData
  modifications: Modification[]
  breakpoints?: number[]
  metadata?: {
    prsmId?: number
    spectrumId?: number
    proteinAccession?: string
    precursorMz?: number
    precursorCharge?: number
    retentionTime?: number
    source?: string
  }
}

export interface ViewerConfig {
  ionTypes: ('a' | 'b' | 'c' | 'x' | 'y' | 'z')[]
  maxFragmentCharge: number
  tolerancePpm: number
  toleranceDa?: number
  matchType: 'best' | 'all' // IPSA best-match vs traditional match-all
  minIntensity?: number
  minRelativeIntensity?: number
  showMatchedPeaks: boolean
  showUnmatchedPeaks: boolean
  showNeutralLosses: boolean
  enableBuffer: boolean
}

export const DEFAULT_CONFIG: ViewerConfig = {
  ionTypes: ['b', 'y'],
  maxFragmentCharge: 2,
  tolerancePpm: 10, // aligned with TopPIC `-e 10` and the paper-case fragment tolerance
  matchType: 'best', // default: IPSA best-match strategy
  showMatchedPeaks: true,
  showUnmatchedPeaks: true,
  showNeutralLosses: true,
  enableBuffer: true,
}

export interface BufferState {
  isEditing: boolean
  hasUnsavedChanges: boolean
  originalInput: MS2SequenceViewerInput | null
  bufferInput: MS2SequenceViewerInput | null
}

/**
 * Buffer edit manager
 */
export class EditBuffer {
  private originalInput: MS2SequenceViewerInput | null = null
  private bufferInput: MS2SequenceViewerInput | null = null
  private isDirty = false

  /**
   * Start editing (snapshot the original state)
   */
  startEdit(input: MS2SequenceViewerInput): void {
    this.originalInput = JSON.parse(JSON.stringify(input))
    this.bufferInput = JSON.parse(JSON.stringify(input))
    this.isDirty = false
  }

  /**
   * Modify the sequence
   */
  editSequence(newSequence: string): void {
    if (!this.bufferInput) return
    this.bufferInput.sequence.value = newSequence
    this.bufferInput.sequence.length = newSequence.length
    this.isDirty = true
  }

  /**
   * Add a modification
   */
  addModification(mod: Modification): void {
    if (!this.bufferInput) return
    this.bufferInput.modifications.push({ ...mod })
    this.isDirty = true
  }

  /**
   * Remove a modification
   */
  removeModification(modId: string): void {
    if (!this.bufferInput) return
    this.bufferInput.modifications = this.bufferInput.modifications.filter(m => m.id !== modId)
    this.isDirty = true
  }

  /**
   * Update a modification
   */
  updateModification(modId: string, updates: Partial<Modification>): void {
    if (!this.bufferInput) return
    const index = this.bufferInput.modifications.findIndex(m => m.id === modId)
    if (index >= 0) {
      this.bufferInput.modifications[index] = { ...this.bufferInput.modifications[index], ...updates }
      this.isDirty = true
    }
  }

  /**
   * Apply the edits
   */
  apply(): MS2SequenceViewerInput | null {
    if (!this.bufferInput) return null
    this.originalInput = JSON.parse(JSON.stringify(this.bufferInput))
    const result = this.bufferInput
    this.bufferInput = null
    this.isDirty = false
    return result
  }

  /**
   * Discard the edits
   */
  discard(): MS2SequenceViewerInput | null {
    this.bufferInput = null
    this.isDirty = false
    return this.originalInput
  }

  /**
   * Get the current state
   */
  getCurrent(): MS2SequenceViewerInput | null {
    return this.bufferInput || this.originalInput
  }

  /**
   * Whether there are unapplied changes
   */
  hasUnsavedChanges(): boolean {
    return this.isDirty
  }

  /**
   * Whether edit mode is active
   */
  isEditing(): boolean {
    return this.bufferInput !== null
  }

  /**
   * Reset to the original state
   */
  reset(): void {
    this.bufferInput = null
    this.isDirty = false
  }
}

/**
 * Create a buffer state
 */
export function createBufferState(): BufferState {
  return {
    isEditing: false,
    hasUnsavedChanges: false,
    originalInput: null,
    bufferInput: null,
  }
}
