import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_AGENT_TOOL_SETTINGS, type RuntimeEvent, type ThinkingLevel } from '../src/contracts/agent-runtime'
import { DEFAULT_MODEL_ID, DEFAULT_PROVIDER_ID } from '../src/services/catalog/providerCatalog'
import { resolveComponents } from './component_config.cjs'
import { resolveRuntimePaths, resolvedSettings } from './runtime_config.cjs'
import { createSystemAssetCatalog } from './system_asset_catalog.cjs'
import { ensureNativeCli, ensurePythonLaunchers, ensureSearchTools, pinSearchToolLookup } from './skill_runtime.cjs'
import { runAgentHarness } from './agent/harness-runner'
import { createAgentRuntime } from './agent/agent-runtime'

interface HarnessRequest {
  workspace: string
  prompts: string[]
  providerId?: string
  modelId?: string
  thinkingLevel?: ThinkingLevel
  pauseBetweenPromptsMs: number
}

async function main(): Promise<void> {
  console.log = (...args: unknown[]) => console.error(...args)
  const request = parseArgs(process.argv.slice(2))
  const settingsPath = desktopSettingsPath()
  const runtimePaths = resolveRuntimePaths({ settingsFile: settingsPath })
  const workspaceId = registeredWorkspaceId(runtimePaths.workspaceRegistryFile, request.workspace)
  const productRoot = resolveComponents({ isDev: true }).scientific.root
  const settings = resolvedSettings(settingsPath)
  const backend = settings.backend ?? {}
  const systemAssets = createSystemAssetCatalog({ productRoot })
  ensurePythonLaunchers({ toolsDir: runtimePaths.agentToolsRoot })

  let nativeCliPath: string | undefined
  try {
    nativeCliPath = ensureNativeCli({ isDev: true, toolsDir: runtimePaths.agentToolsRoot }) ?? undefined
  } catch (error) {
    console.error('[agent-harness] tdeasenexus-toolbox provisioning skipped:', error)
  }
  // Same search-tool policy as the desktop composition root: provision the
  // bundled rg/fd into the managed bin, then pin rg/fd lookup to it and
  // forbid Pi's runtime GitHub download — the harness must be deterministic.
  try {
    ensureSearchTools({ isDev: true, toolsDir: runtimePaths.agentToolsRoot })
  } catch (error) {
    console.error('[agent-harness] search tools provisioning skipped:', error)
  }
  pinSearchToolLookup({ toolsDir: runtimePaths.agentToolsRoot })

  const listeners: Array<(sessionId: string, event: RuntimeEvent) => void> = []
  const runtime = createAgentRuntime({
    settingsPath,
    systemRoot: runtimePaths.systemRoot,
    agentDir: runtimePaths.agentRoot,
    managedBinDir: runtimePaths.agentToolsRoot,
    systemAssets,
    resolveWorkspaceRoot: async (id) => {
      if (id !== workspaceId) throw new Error(`Workspace is not registered: ${id}`)
      return request.workspace
    },
    backendConnection: () => ({
      baseUrl: `http://${backend.host ?? '127.0.0.1'}:${backend.port ?? 8000}`,
      accessToken: backend.accessToken ?? process.env.TDEASE_ACCESS_TOKEN ?? null,
      // The harness is the agent principal: prefer the agent token so the
      // irreversible scopes stay out of the AI's reach.
      agentToken: backend.agentToken ?? backend.accessToken ?? process.env.TDEASE_ACCESS_TOKEN ?? null,
    }),
    nativeCliPath,
    systemAssetsRoot: productRoot,
    systemCacheRoot: runtimePaths.systemCacheRoot,
    isDev: true,
    push: {
      turnEvent: (sessionId, event) => { for (const listener of listeners) listener(sessionId, event) },
    },
  })

  const sessionId = `harness_${crypto.randomUUID()}`
  const summary = await runAgentHarness({
    runtime,
    onEvent: (handler) => {
      listeners.push(handler)
      return () => { const index = listeners.indexOf(handler); if (index >= 0) listeners.splice(index, 1) }
    },
    sessionDir: path.join(request.workspace, '.tdease', 'sessions', sessionId),
    binding: {
      workspaceId,
      sessionId,
      mindset: 'explorer',
      authority: 'auto',
      model: {
        providerId: request.providerId ?? DEFAULT_PROVIDER_ID,
        modelId: request.modelId ?? DEFAULT_MODEL_ID,
      },
      thinkingLevel: request.thinkingLevel ?? 'off',
      agentTools: DEFAULT_AGENT_TOOL_SETTINGS,
      ptcEnabled: true,
    },
    prompts: request.prompts,
    pauseBetweenPromptsMs: request.pauseBetweenPromptsMs,
  })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
  if (summary.outcomes.some((outcome) => outcome !== 'resolved')) process.exitCode = 1
}

function parseArgs(argv: string[]): HarnessRequest {
  const values = new Map<string, string[]>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw usage(`Invalid argument: ${key ?? ''}`)
    const name = key.slice(2)
    if (name !== 'workspace' && name !== 'prompt' && name !== 'prompt-file' && name !== 'provider' && name !== 'model' && name !== 'thinking' && name !== 'pause-between-prompts') {
      throw usage(`Unknown argument: ${key}`)
    }
    values.set(name, [...(values.get(name) ?? []), value])
  }
  const workspaceValue = values.get('workspace')?.at(-1)?.trim()
  if (!workspaceValue) throw usage('Missing --workspace')
  const workspace = path.resolve(workspaceValue)
  if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw usage(`Workspace is not a directory: ${workspace}`)
  }
  const inlinePrompts = values.get('prompt') ?? []
  const filePrompts = (values.get('prompt-file') ?? []).map((file) => {
    const promptFile = path.resolve(file)
    if (!fs.statSync(promptFile, { throwIfNoEntry: false })?.isFile()) {
      throw usage(`Prompt file is not a file: ${promptFile}`)
    }
    return fs.readFileSync(promptFile, 'utf8')
  })
  const prompts = [...inlinePrompts, ...filePrompts].map((value) => value.trim()).filter(Boolean)
  if (prompts.length === 0) throw usage('Missing --prompt')
  const providerId = values.get('provider')?.at(-1)?.trim() || undefined
  const modelId = values.get('model')?.at(-1)?.trim() || undefined
  const thinking = values.get('thinking')?.at(-1)?.trim()
  if (thinking && !['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) {
    throw usage(`Invalid thinking level: ${thinking}`)
  }
  const pauseText = values.get('pause-between-prompts')?.at(-1)?.trim() ?? '0'
  const pauseSeconds = Number(pauseText)
  if (!Number.isFinite(pauseSeconds) || pauseSeconds < 0 || pauseSeconds > 1800) {
    throw usage('pause-between-prompts must be between 0 and 1800 seconds')
  }
  return {
    workspace,
    prompts,
    providerId,
    modelId,
    thinkingLevel: thinking as ThinkingLevel | undefined,
    pauseBetweenPromptsMs: Math.round(pauseSeconds * 1000),
  }
}

function desktopSettingsPath(): string {
  const profile = process.platform === 'win32'
    ? path.join(requiredEnvironment('APPDATA'), 'TDEase')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'TDEase')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'TDEase')
  const settings = path.join(profile, 'system', 'settings.json')
  if (!fs.statSync(settings, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Product settings are missing: ${settings}`)
  }
  return settings
}

function registeredWorkspaceId(registryPath: string, workspace: string): string {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
    workspaces?: Array<{ workspace_id?: string; local_path?: string }>
  }
  const normalized = path.resolve(workspace).toLowerCase()
  const match = registry.workspaces?.find((entry) =>
    typeof entry.local_path === 'string' && path.resolve(entry.local_path).toLowerCase() === normalized)
  if (!match?.workspace_id) throw new Error(`Workspace is not registered in TDEase: ${workspace}`)
  return match.workspace_id
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required to resolve the TDEase profile`)
  return value
}

function usage(message: string): Error {
  return new Error(`${message}\nUsage: agent-harness --workspace PATH [--provider ID --model ID --thinking LEVEL --pause-between-prompts SECONDS] (--prompt TEXT | --prompt-file PATH)`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
