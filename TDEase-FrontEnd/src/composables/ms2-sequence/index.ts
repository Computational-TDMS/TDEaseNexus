/**
 * Exports for all MS2 Sequence Viewer modules
 */

export { FragmentationCalculator, isPrefixIon, createFragmentationCalculator, ACTIVATION_IONS, activationToIonTypes } from './fragmentation'
export type {
  IonType,
  NeutralLoss,
  Modification,
  TheoreticalFragment,
  SpectrumPeak,
  MatchedFragment,
  SequenceAnalysisInput,
  SequenceAnalysisResult,
  CleavageScore,
} from './fragmentation'

export { InteractionManager } from './interaction'
export type { InteractionState } from './interaction'

export {
  AA_MASSES,
  PROTON_MASS,
  H2O_MASS,
  ELECTRON_MASS,
  CO_MASS,
  NH3_MASS,
  NEUTRAL_LOSS_H2O,
  NEUTRAL_LOSS_NH3,
  NEUTRAL_LOSS_CO,
  ION_OFFSETS,
} from './fragmentation'

export { EditBuffer, createBufferState, DEFAULT_CONFIG } from './buffer'
export type {
  SequenceData,
  MS2SpectrumData,
  MS2SequenceViewerInput,
  ViewerConfig,
  BufferState,
} from './buffer'
