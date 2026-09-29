/**
 * de-DE message assembly — a lazy chunk for one non-fallback locale.
 *
 * Bundled behind a dynamic import by `locales/index.ts` (see its LOADER
 * table): en-US (the source of truth and the fallback) ships in the entry
 * chunk; this module keeps all five de-DE JSON files in a single async chunk
 * instead of five. Mirror of `zh-CN.messages.ts`.
 */
import deDECommon from './de-DE/common.json'
import deDEAgent from './de-DE/agent.json'
import deDEVisualization from './de-DE/visualization.json'
import deDEWorkflow from './de-DE/workflow.json'
import deDEWorkbench from './de-DE/workbench.json'

export const deDEMessages = {
  common: deDECommon,
  visualization: deDEVisualization,
  workflow: deDEWorkflow,
  workbench: deDEWorkbench,
  agent: deDEAgent,
}
