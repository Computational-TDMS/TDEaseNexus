/**
 * useWorkspaceRailPanel — shared open/close state for the workspace rail
 * panel (the collapsible column that opens from the top-left workspace
 * button: recent workspaces + the folder picker).
 *
 * The rail button OWNS the rendering and positioning; this module only
 * carries the boolean so other surfaces can REQUEST the panel — the
 * Welcome surface's open-workspace-folder action opens exactly this panel
 * instead of spawning a parallel picker of its own. One workspace-choosing
 * UI, one place it lives.
 */
import { ref } from 'vue'

const open = ref(false)

export function useWorkspaceRailPanel() {
  return { open }
}
