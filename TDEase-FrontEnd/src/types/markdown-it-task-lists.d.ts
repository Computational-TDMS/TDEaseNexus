/**
 * Type declaration for markdown-it-task-lists, which ships no bundled types.
 * The plugin is a markdown-it PluginSimple (configures the renderer to emit
 * checkbox-enabled list items).
 */
declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it'
  const plugin: MarkdownIt.PluginSimple
  export default plugin
}
