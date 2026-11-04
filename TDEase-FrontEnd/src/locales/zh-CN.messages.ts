/**
 * zh-CN message assembly — the ONE lazy chunk for the non-fallback locale.
 *
 * Bundled behind a dynamic import by `locales/index.ts`: en-US (the source of
 * truth and the fallback) ships in the entry chunk, zh-CN (~92KB raw) is
 * fetched only when a Chinese locale is actually detected or selected. This
 * module exists so all five zh-CN JSON files land in a single async chunk
 * instead of five.
 */
import zhCNCommon from './zh-CN/common.json'
import zhCNAgent from './zh-CN/agent.json'
import zhCNVisualization from './zh-CN/visualization.json'
import zhCNWorkflow from './zh-CN/workflow.json'
import zhCNWorkbench from './zh-CN/workbench.json'

export const zhCNMessages = {
  common: zhCNCommon,
  visualization: zhCNVisualization,
  workflow: zhCNWorkflow,
  workbench: zhCNWorkbench,
  agent: zhCNAgent,
}
