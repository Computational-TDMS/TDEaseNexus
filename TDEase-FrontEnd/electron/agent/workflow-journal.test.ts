import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkflowJournal,
  hashAgentCall,
  type JournalEntry,
} from './workflow-journal'

const RESULT_A: JournalEntry['result'] = { findings: ['a'], confidence: 'high' }
const RESULT_B: JournalEntry['result'] = { findings: ['b'], confidence: 'low' }

function entry(index: number, prompt: string, result: unknown, state: JournalEntry['state'] = 'returned'): JournalEntry {
  return { index, promptHash: hashAgentCall(prompt), result, state }
}

describe('workflow-journal', () => {
  it('lookup returns an appended entry with matching (index, promptHash)', () => {
    const journal = createWorkflowJournal({ runId: 'r1' })
    journal.append(entry(0, 'scan routes', RESULT_A))
    journal.append(entry(1, 'audit file', RESULT_B))
    expect(journal.size).toBe(2)
    const hit = journal.lookup(0, hashAgentCall('scan routes'))
    expect(hit?.result).toEqual(RESULT_A)
    expect(journal.lookup(1, hashAgentCall('audit file'))?.result).toEqual(RESULT_B)
  })

  it('lookup misses on a different promptHash (a re-run with an edited prompt)', () => {
    const journal = createWorkflowJournal({ runId: 'r1' })
    journal.append(entry(0, 'scan routes', RESULT_A))
    expect(journal.lookup(0, hashAgentCall('scan routes edited'))).toBeUndefined()
    expect(journal.lookup(1, hashAgentCall('scan routes'))).toBeUndefined() // wrong index
  })

  it('resume loads prior entries from disk and reuses them; fresh appends overwrite in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-journal-'))
    try {
      const persistPath = join(dir, 'workflows', 'r1.json')
      // First run: cache two calls, persist to disk.
      const first = createWorkflowJournal({ runId: 'r1', persistPath })
      first.append(entry(0, 'scan', RESULT_A))
      first.append(entry(1, 'audit', RESULT_B))
      const onDisk = JSON.parse(readFileSync(persistPath, 'utf8')) as { runId: string; entries: JournalEntry[] }
      expect(onDisk.runId).toBe('r1')
      expect(onDisk.entries).toHaveLength(2)

      // Resume: a fresh journal instance loads the prior file as read-only cache.
      const resumed = createWorkflowJournal({ runId: 'r1', persistPath, resume: true })
      expect(resumed.lookup(0, hashAgentCall('scan'))?.result).toEqual(RESULT_A)
      expect(resumed.lookup(1, hashAgentCall('audit'))?.result).toEqual(RESULT_B)
      // A re-run of call 1 (edited prompt) replaces the prior entry at that index,
      // not duplicates it; the on-disk file reflects the latest prefix.
      resumed.append(entry(1, 'audit edited', RESULT_A))
      expect(resumed.size).toBe(2)
      const afterRerun = JSON.parse(readFileSync(persistPath, 'utf8')) as { entries: JournalEntry[] }
      expect(afterRerun.entries).toHaveLength(2)
      expect(afterRerun.entries[1].promptHash).toBe(hashAgentCall('audit edited'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
