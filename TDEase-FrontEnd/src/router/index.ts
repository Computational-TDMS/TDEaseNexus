/**
 * TDEaseNexus router — one route.
 *
 * The workbench is the entire application surface now: opening a Workspace
 * lands directly on `AppShell`, which composes every region (Rail,
 * Navigator, Document surface, Inspector, Agent dock, Activity dock, Status
 * bar). The previous two-page model (`/studio`, `/agent`) and the
 * short-lived `/explore` and `/settings` routes are deleted — Settings
 * becomes a document kind opened from the command palette, not a route a
 * user can be stranded in (§3.1).
 *
 * `vue-router` stays only for deep-link restoration (`?doc=run:run_x&sub=…`),
 * added in a later slice — hash history is kept so the app keeps working
 * under Electron's `file://` protocol without server-side routing.
 *
 * `pages/*.vue` are NOT deleted here. They remain in the tree, unrouted, as
 * reference material for the S1–S7 migrations and are removed by whichever
 * slice replaces each one.
 */

import { createRouter, createWebHashHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import AppShell from '@/components/workbench/AppShell.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'Workbench',
    component: AppShell,
  },
  {
    // Catch-all: every deleted route (/agent, /explore, /studio, /settings,
    // anything else) redirects home instead of 404-ing.
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
]

const router = createRouter({
  // Hash mode — works with Electron file:// protocol without server-side routing
  history: createWebHashHistory(),
  routes,
})

export default router
