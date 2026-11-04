/**
 * Node-side skill catalog: lists and reads System + Workspace SKILL.md files.
 *
 * The renderer reached skills through `skill.list` / `skill.read` Studio
 * commands, which the desktop backed with a System bridge (IPC) and a Workspace
 * bridge (IPC). In Node the agent runtime owns both bridges directly, so this
 * module wraps the pure `sharedLocalSkillCatalog` (from
 * `src/services/catalog/localSkillCatalog`) with the two bridge shapes it expects and
 * exposes the small surface the Studio `skill.*` commands consume.
 *
 * Why reuse sharedLocalSkillCatalog and not reimplement: the dedup, collision
 * detection, name validation (`[A-Za-z0-9_-]+`) and scope-prefixing
 * (`system:` / `workspace:`) are already correct there and tested. A second
 * implementation would only drift.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

import { frontmatterDescription, sharedLocalSkillCatalog } from '../../src/services/catalog/localSkillCatalog'
import type { NodeSystemAssets } from './node-system-assets'
import type { NodeWorkspaceBridge } from './node-workspace-bridge'

export interface NodeSkillEntry {
  name: string
  scope: 'system' | 'workspace'
  description?: string
}

export interface NodeSkillContent {
  id: string
  scope: 'system' | 'workspace'
  content: string
  /** Present when `content` is one requested skill-relative resource. */
  resource?: string
  /** Skill-relative files, listed with the entry rather than every resource. */
  resources?: ReadonlyArray<string>
}

export interface NodeSkillCollision {
  name: string
  sources: ReadonlyArray<string>
}

export interface NodeSkillCatalog {
  list(): Promise<ReadonlyArray<NodeSkillEntry>>
  /**
   * List entries WITH descriptions resolved from SKILL.md frontmatter, for the
   * compact prompt skill index. Unlike `list()` this reads every SKILL.md once
   * (the shared catalog caches both per root; `invalidate()` drops them).
   */
  index(): Promise<ReadonlyArray<NodeSkillEntry>>
  read(id: string, resource?: string): Promise<NodeSkillContent>
  collisions(): Promise<ReadonlyArray<NodeSkillCollision>>
  /** Drop cached listings/contents so the next call re-reads disk. */
  invalidate(): void
}

export function createNodeSkillCatalog(
  workspaceRoot: string,
  workspace: NodeWorkspaceBridge,
  system: NodeSystemAssets,
): NodeSkillCatalog {
  // localSkillCatalog's SystemTextBridge needs `readText(relative)` and
  // optionally `listFiles(relative)`. NodeSystemAssets already has both — same
  // signature, no adapter needed.
  const systemBridge = {
    readText: (relative: string) => system.readText(relative),
    listFiles: (relative: string) => system.listFiles(relative),
  }

  // localSkillCatalog's WorkspaceTextBridge needs `readText(root, relative)`
  // and optionally `listDir(root, relative)` returning `{ name, isDir }[]`.
  // The WorkspaceBridge interface has `readText` but not `listDir`, so listDir
  // is provided here against the contained `.tdease/skills` directory: skills
  // are discovered as top-level directories under it, one per skill.
  const workspaceBridge = {
    readText: (root: string, relative: string) => workspace.readText(root, relative),
    listDir: async (root: string, relative: string): Promise<ReadonlyArray<{ name: string; isDir: boolean }>> => {
      const dir = path.resolve(root, relative)
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return []
      }
      return entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
    },
  }

  const inner = sharedLocalSkillCatalog(workspaceRoot, { system: systemBridge, workspace: workspaceBridge })

  return {
    async list() {
      return (await inner.list()).map((entry) => ({
        name: entry.name,
        scope: entry.scope,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
      }))
    },
    async index() {
      // The prompt skill index is assembled once per turn; drop the per-root
      // caches first so a turn always sees the skills tree as it is on disk.
      // Without this, SKILL.md edits are invisible to a running app (index AND
      // agent skill.read) because invalidate() has no other caller. Lost once
      // in a refactor round (2026-10-14) and re-applied — keep it.
      inner.invalidate()
      return Promise.all((await inner.list()).map(async (entry) => {
        let description: string | undefined
        try {
          description = frontmatterDescription((await inner.read(entry.name)).content)
        } catch {
          description = undefined
        }
        return {
          name: entry.name,
          scope: entry.scope,
          ...(description !== undefined ? { description } : {}),
        }
      }))
    },
    async read(id, requestedResource) {
      const skill = await inner.read(id)
      const name = skill.id.split(':')[1]
      const resources = skill.scope === 'system'
        ? (await system.listFiles(`skills/${name}`)).filter(isUsefulResource)
        : await workspaceResources(workspaceRoot, name)
      if (!requestedResource) {
        return { id: skill.id, scope: skill.scope, content: skill.content, resources }
      }

      const resource = normalizeResource(requestedResource)
      if (!resources.includes(resource)) throw new Error(`Unknown skill resource: ${skill.id}/${resource}`)
      const content = skill.scope === 'system'
        ? await system.readText(`skills/${name}/${resource}`)
        : await workspace.readText(workspaceRoot, `.tdease/skills/${name}/${resource}`)
      return { id: skill.id, scope: skill.scope, resource, content }
    },
    async collisions() {
      return (await inner.collisions()).map((collision) => ({
        name: collision.name,
        sources: collision.sources,
      }))
    },
    invalidate: () => inner.invalidate(),
  }
}

async function workspaceResources(workspaceRoot: string, skillName: string): Promise<ReadonlyArray<string>> {
  const root = path.join(workspaceRoot, '.tdease', 'skills', skillName)
  const resources: string[] = []
  async function walk(directory: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(target)
      else if (entry.isFile()) {
        const relative = path.relative(root, target).split(path.sep).join('/')
        if (isUsefulResource(relative)) resources.push(relative)
      }
    }
  }
  await walk(root)
  return resources.sort()
}

function isUsefulResource(relative: string): boolean {
  const segments = relative.split('/')
  return relative !== 'SKILL.md'
    && !segments.some((segment) => segment === '__pycache__' || segment.startsWith('.'))
    && !relative.endsWith('.pyc')
}

function normalizeResource(value: string): string {
  const resource = value.trim()
  const segments = resource.split('/')
  if (!resource || resource.includes('\\') || path.posix.isAbsolute(resource)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('skill resource must be a contained skill-relative path')
  }
  return resource
}
