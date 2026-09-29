import type { CommandDefinition } from '../registry'
import { EMPTY_ARGS, objectSchema, optionalString, requiredString, stringSchema } from '../args'
import type { NodeDetail, NodeSummary } from '../../ports/backend-gateway'

/**
 * Agent-facing node rendering — progressive disclosure. The full NodeDetail
 * (rules.smk text + readme + capability patterns) runs ~50k chars per node;
 * session audits showed those cards riding the context (and re-billed on
 * every later request) when the model only needed IO wiring facts. The
 * digest keeps description head + capability IO/params compact and points at
 * `part` fetches for the two long texts.
 */
function renderNodeForAgent(result: unknown): string {
  const node = result as Partial<NodeDetail>
  if (!node || typeof node !== 'object' || typeof node.id !== 'string') return String(result)
  if (typeof node.rulesText === 'string' && node.capabilities === undefined) return node.rulesText
  if (typeof node.readme === 'string' && node.capabilities === undefined) return node.readme
  const lines: string[] = [
    `node ${node.id}${node.version !== undefined ? ` v${node.version}` : ''}${node.digest ? ` digest ${String(node.digest).slice(0, 12)}` : ''}`,
  ]
  if (node.description) lines.push(head(node.description, 600))
  const caps = node.capabilities ?? []
  lines.push('', `capabilities (${caps.length}):`)
  for (const cap of caps) {
    lines.push(`## ${cap.name} — ${cap.message}`)
    for (const input of cap.inputs ?? []) lines.push(`  in  ${input.name} = ${input.pattern}`)
    for (const output of cap.outputs ?? []) lines.push(`  out ${output.name} = ${output.pattern}`)
    const params = (cap.params ?? []).map((param) => param.name).join(', ')
    if (params) lines.push(`  params: ${params}`)
    // Inline # comments from rules.smk are the parameter's usage note — the
    // author documented the knob where it is defined; surface it verbatim.
    for (const param of cap.params ?? []) {
      if (param.comment) lines.push(`    # ${param.name}: ${param.comment}`)
    }
    // The invocation line is the one fact a digest reader cannot invent:
    // how the executable is addressed (explicit path, never a bare name).
    const shell = cap.shell?.replace(/\s+/g, ' ').trim()
    if (shell) lines.push(`  shell: ${shell}`)
  }
  if (node.rulesText !== undefined) {
    lines.push('', `rules.smk: ${node.rulesText.split('\n').length} lines — call nodes.get {id, part: "rules"} for the full file`)
  }
  if (node.readme !== undefined) {
    lines.push(`readme: ${node.readme.length} chars — call nodes.get {id, part: "readme"} if the usage guide is needed`)
  }
  return lines.join('\n')
}

function renderNodeListForAgent(result: unknown): string {
  const nodes = Array.isArray(result) ? (result as ReadonlyArray<Partial<NodeSummary>>) : []
  return [`nodes (${nodes.length}):`, ...nodes.map((node) => `- ${node.id}${node.version !== undefined ? ` v${node.version}` : ''}: ${head(node.description ?? '', 160)}`)].join('\n')
}

function head(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** Backend node catalog and Client System workflow templates (`studio.discovery`). */
export function discoveryCommands(): ReadonlyArray<CommandDefinition> {
  return ([
    {
      id: 'nodes.list', title: 'List Nodes',
      exposure: { mindsets: 'scientific', setting: 'discovery' },
      summary: 'List executable Backend workflow nodes when configuring or running a Backend workflow; not for analysis of existing local results.',
      args: EMPTY_ARGS, mutates: false,
      run: (_args, context) => context.studio.discovery.listNodes(),
      renderForAgent: renderNodeListForAgent,
    },
    {
      id: 'nodes.get', title: 'Read Node',
      exposure: { mindsets: 'scientific', setting: 'discovery' },
      summary: 'Read one node: compact digest (capabilities IO/params, description head) by default; part: "rules" | "readme" fetches one long text in full.',
      args: objectSchema({
        id: stringSchema(),
        part: { type: 'string', enum: ['rules', 'readme'], description: 'Optional: fetch only the full rules.smk text or the usage guide instead of the digest.' },
      }, ['id']), mutates: false,
      run: async (args, context) => {
        const detail = await context.studio.discovery.getNode(requiredString(args, 'id'))
        // `part` projects to a single long text; the render then passes it
        // through raw instead of digesting. The Studio palette never sends
        // `part`, so its full-detail behavior is unchanged.
        const part = optionalString(args, 'part')
        if (part === 'rules') return { id: detail.id, rulesText: detail.rulesText }
        if (part === 'readme') return { id: detail.id, readme: detail.readme }
        return detail
      },
      renderForAgent: renderNodeForAgent,
    },
    {
      id: 'nodes.install', title: 'Install Node Package',
      exposure: { mindsets: 'all', setting: 'workflow' },
      summary: 'Install a new data-processing Node package for the user by copying a Workspace folder (it must contain rules.smk) into the LOCAL Backend node catalog. Refuses when the Backend connection is remote — that host owns its own catalog.',
      args: objectSchema({
        path: stringSchema(),
      }, ['path']), mutates: true, permission: 'workspace.write',
      enabled: (context) => context.nodeCatalog !== undefined,
      run: (args, context) => context.nodeCatalog!.install(requiredString(args, 'path')),
      renderForAgent: (result) => {
        const outcome = result as { nodeId: string; targetDir: string; files: number }
        return `installed node package ${outcome.nodeId} (${outcome.files} files) into ${outcome.targetDir} — visible to nodes.list immediately`
      },
    },
    {
      id: 'templates.list', title: 'List Workflow Templates',
      exposure: { mindsets: 'scientific', setting: 'discovery' },
      summary: 'List workflow templates when the user is configuring a new Backend workflow; not for interpreting existing result files.',
      args: EMPTY_ARGS, mutates: false,
      run: (_args, context) => context.studio.discovery.listTemplates(),
    },
    {
      id: 'templates.get', title: 'Read Workflow Template',
      exposure: { mindsets: 'scientific', setting: 'discovery' },
      summary: 'Read one local, immutable Client System template and its text files.',
      args: objectSchema({ id: stringSchema() }, ['id']), mutates: false,
      run: (args, context) => context.studio.discovery.getTemplate(requiredString(args, 'id')),
    },
  ] satisfies CommandDefinition[])
}
