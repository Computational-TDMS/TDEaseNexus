/**
 * toolbox-result — a typed one-glance summary of a `tdeasenexus-toolbox`
 * call (the Rust mass-spec kernel, reached through bash).
 *
 * Every toolbox command answers in one envelope
 * `{tool, command, params, elapsedMs, warnings, result}`
 * (spec/RUST-MS-CONTRACT.md). The transcript keeps only a bounded head of a
 * tool's output, so the summary is honest about what it saw: a complete
 * envelope yields the verdict (hits, candidates, closure); a cut or
 * redirected one yields just the command and its key parameters — never a
 * guessed verdict.
 */
import type { ToolCall } from '@/stores/chat-types'
import { bareToolName } from './tool-identity'

export type ToolboxTone = 'neutral' | 'positive' | 'negative'
export interface ToolboxRow { label: string; value: string; detail?: string }
export interface ToolboxSummary {
  command: string
  /** Key request parameters, already formatted ("317.39 Da ± 0.03"). */
  params: string[]
  /** The verdict line; absent when the envelope was not fully visible. */
  verdict?: { text: string; tone: ToolboxTone }
  rows: ToolboxRow[]
  elapsedMs?: number
  warnings: number
  /** The envelope was cut or redirected — only the request is known. */
  partial: boolean
}

const CLI = /(?:^|[\s;&|(])(?:tdeasenexus|tdnexus)-toolbox(?:\.exe)?\s+([a-z][a-z0-9-]*)/i

const fmt = (n: unknown, digits = 4): string =>
  typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 10 ** digits) / 10 ** digits) : String(n)

/** Flag values from the command line: `--target-mass 317.39` / `--tol=0.03`. */
function flag(command: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const match = new RegExp(`--${name}(?:=|\\s+)("[^"]*"|\\S+)`).exec(command)
    if (match) return match[1]!.replace(/^"|"$/g, '')
  }
  return undefined
}

function paramsFrom(command: string, params: Record<string, any> | undefined): string[] {
  const out: string[] = []
  const mass = params?.targetMass ?? params?.mass ?? flag(command, 'target-mass', 'mass', 'shift')
  const tol = params?.tolerance ?? flag(command, 'tolerance', 'tol')
  const unit = params?.toleranceUnit ?? flag(command, 'tolerance-unit') ?? (tol !== undefined ? 'Da' : '')
  if (mass !== undefined) out.push(`${fmt(Number(mass))} Da${tol !== undefined ? ` ± ${tol} ${String(unit).replace(/^da$/i, 'Da')}` : ''}`)
  const file = params?.file ?? flag(command, 'file', 'input', 'spectrum')
  if (file) out.push(String(file).split(/[\\/]/).pop()!)
  const scan = params?.scan ?? flag(command, 'scan', 'scans')
  if (scan !== undefined) out.push(`scan ${Array.isArray(scan) ? scan.join(',') : scan}`)
  const library = params?.library ?? flag(command, 'library')
  if (typeof library === 'string') out.push(`library ${library}`)
  else if (Array.isArray(library)) out.push(`library ${library.length} mods`)
  return out
}

function modTitles(candidate: any): string {
  const mods = Array.isArray(candidate?.modifications) ? candidate.modifications : []
  return mods.map((m: any) => `${m.count > 1 ? `${m.count}×` : ''}${m.title ?? m.name ?? '?'}`).join(' + ')
}

function summarize(command: string, result: any): Pick<ToolboxSummary, 'verdict' | 'rows'> {
  const candidates: any[] = Array.isArray(result?.candidates) ? result.candidates : []
  switch (command) {
    case 'unimod-search':
    case 'unimod-solve': {
      const n = typeof result?.matchCount === 'number' ? result.matchCount : candidates.length
      if (n === 0) return { verdict: { text: 'no match', tone: 'negative' }, rows: [] }
      return {
        verdict: { text: `${n} match${n === 1 ? '' : 'es'}${result?.truncated ? ' (truncated)' : ''}`, tone: 'positive' },
        rows: candidates.slice(0, 3).map((c) => ({
          label: modTitles(c) || c.title || c.name || '—',
          value: c.absoluteErrorPpm !== undefined ? `${fmt(c.absoluteErrorPpm, 1)} ppm` : c.absoluteErrorDa !== undefined ? `${fmt(c.absoluteErrorDa)} Da` : '',
        })),
      }
    }
    case 'resolve-shift': {
      if (candidates.length === 0) return { verdict: { text: 'cannot close the shift', tone: 'negative' }, rows: [] }
      const top = candidates.slice(0, 3).map((c) => {
        const placement = Array.isArray(c.alternatives?.[0]) ? c.alternatives[0] : Array.isArray(c.placement) ? c.placement : []
        const names = placement.map((p: any) => (Array.isArray(p) ? `${p[0]}@${p[1]}` : String(p))).join(' + ')
        return { label: names || c.model || '—', value: c.score !== undefined ? `score ${fmt(c.score, 2)}` : '', detail: c.alternativePlacements ? `${c.alternativePlacements} placements` : undefined }
      })
      const shift = result?.observedShift !== undefined ? ` for +${fmt(result.observedShift, 3)} Da` : ''
      return { verdict: { text: `${candidates.length} model${candidates.length === 1 ? '' : 's'}${shift}`, tone: candidates.length === 1 ? 'positive' : 'neutral' }, rows: top }
    }
    case 'fragment-compare': {
      const r = result?.comparisons?.[0]?.result ?? result
      const cands: any[] = Array.isArray(r?.candidates) ? r.candidates : []
      const disc = typeof r?.discriminatingIonCount === 'number' ? r.discriminatingIonCount : undefined
      return {
        verdict: disc !== undefined ? { text: `${disc} discriminating ion${disc === 1 ? '' : 's'}`, tone: disc > 0 ? 'positive' : 'neutral' } : undefined,
        rows: cands.slice(0, 3).map((c) => ({
          label: `model ${c.candidateId}`,
          value: c.coverage !== undefined ? `${Math.round(c.coverage * 100)}% coverage` : '',
          detail: c.discriminatingMatched !== undefined ? `${c.discriminatingMatched} discriminating matched` : undefined,
        })),
      }
    }
    default:
      return { rows: [] }
  }
}

/** The typed summary for a toolbox call, or null for any other tool call. */
export function toolboxSummary(tool: Pick<ToolCall, 'name' | 'args' | 'resultPreview' | 'status'>): ToolboxSummary | null {
  if (bareToolName(tool.name) !== 'bash') return null
  const commandLine = typeof tool.args?.command === 'string' ? tool.args.command : ''
  const cli = CLI.exec(commandLine)
  const text = tool.resultPreview?.text ?? ''
  let envelope: any
  if (text.trimStart().startsWith('{') && !tool.resultPreview?.truncated) {
    try { envelope = JSON.parse(text) } catch { envelope = undefined }
  }
  const isEnvelope = envelope && typeof envelope.command === 'string' && /toolbox/.test(String(envelope.tool ?? ''))
  if (!cli && !isEnvelope) return null
  const command = isEnvelope ? envelope.command : cli![1]!.toLowerCase()
  const base: ToolboxSummary = {
    command,
    params: paramsFrom(commandLine, isEnvelope ? envelope.params : undefined),
    rows: [],
    warnings: isEnvelope && Array.isArray(envelope.warnings) ? envelope.warnings.length : 0,
    elapsedMs: isEnvelope && typeof envelope.elapsedMs === 'number' ? envelope.elapsedMs : undefined,
    partial: !isEnvelope,
  }
  if (!isEnvelope || tool.status !== 'succeeded') return base
  return { ...base, ...summarize(command, envelope.result) }
}
