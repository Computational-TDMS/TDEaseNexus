import { asSha256 } from '@/studio/domain/identity'
import type { TemplateDetail, TemplateSummary } from '@/studio/ports/backend-gateway'
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'

interface SystemAssetBridge {
  listFiles(relative: string): Promise<ReadonlyArray<string>>
  readText(relative: string): Promise<string>
}

interface TemplateManifest {
  id: string
  version: string
  name: string
  description: string
  nodes?: string[]
}

export interface TemplateCatalog {
  list(): Promise<ReadonlyArray<TemplateSummary>>
  get(id: string): Promise<TemplateDetail>
}

export function createSystemTemplateCatalog(bridge?: SystemAssetBridge): TemplateCatalog {
  const assets = () => bridge ?? desktopSystemAssetBridge()
  const readManifest = async (id: string) => {
    assertTemplateId(id)
    return parseManifest(await assets().readText(`templates/${id}/template.json`), id)
  }

  return {
    async list() {
      const files = await assets().listFiles('templates')
      const ids = [...new Set(files
        .filter((path) => /^[^/]+\/template\.json$/.test(path))
        .map((path) => path.slice(0, path.indexOf('/'))))].sort()
      return Promise.all(ids.map(async (id) => summarize(await readManifest(id), await templateDigest(assets(), id, files))))
    },

    async get(id) {
      assertTemplateId(id)
      const allFiles = await assets().listFiles('templates')
      const prefix = `${id}/`
      const paths = allFiles.filter((path) => path.startsWith(prefix)).sort()
      if (!paths.includes(`${id}/template.json`)) throw new Error(`Unknown System template: ${id}`)
      const entries = await Promise.all(paths.map(async (path) => [path.slice(prefix.length), await assets().readText(`templates/${path}`)] as const))
      const files = Object.fromEntries(entries)
      const manifest = parseManifest(files['template.json'] ?? '', id)
      return {
        ...summarize(manifest, await digestEntries(entries)),
        files,
        readme: files['README.md'] ?? '',
      }
    },
  }
}

function desktopSystemAssetBridge(): SystemAssetBridge {
  const desktop = (globalThis as { tdeaseDesktop?: TDEaseDesktop })
  const bridge = desktop.tdeaseDesktop?.system
  if (!bridge) throw new Error('Client System template assets are unavailable')
  return bridge
}

function assertTemplateId(id: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`Invalid template id: ${id}`)
}

function parseManifest(raw: string, expectedId: string): TemplateManifest {
  const value = JSON.parse(raw) as Partial<TemplateManifest>
  if (value.id !== expectedId || typeof value.version !== 'string' || typeof value.name !== 'string'
    || typeof value.description !== 'string' || (value.nodes !== undefined && !Array.isArray(value.nodes))) {
    throw new Error(`Invalid System template manifest: ${expectedId}`)
  }
  return value as TemplateManifest
}

function summarize(manifest: TemplateManifest, digest: ReturnType<typeof asSha256>): TemplateSummary {
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    nodes: [...(manifest.nodes ?? [])],
    digest,
  }
}

async function templateDigest(bridge: SystemAssetBridge, id: string, allFiles: ReadonlyArray<string>) {
  const prefix = `${id}/`
  const paths = allFiles.filter((path) => path.startsWith(prefix)).sort()
  const entries = await Promise.all(paths.map(async (path) => [path.slice(prefix.length), await bridge.readText(`templates/${path}`)] as const))
  return digestEntries(entries)
}

async function digestEntries(entries: ReadonlyArray<readonly [string, string]>) {
  const canonical = entries.map(([path, content]) => `${path}\0${content}`).sort().join('\0')
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return asSha256(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''))
}
