import { describe, expect, it } from 'vitest'
import {
  createWorkspacePromptSnapshotStore,
  createWorkspaceSessionLog,
  listWorkspaceSessionMetadata,
  writeWorkspaceSessionMetadata,
  type WorkspaceTextBridge,
} from './agentSessionStorage'

function memoryWorkspace(): WorkspaceTextBridge & { files: Map<string, string> } {
  const files = new Map<string, string>()
  const key = (root: string, relative: string) => `${root}/${relative}`
  return {
    files,
    async exists(root, relative) {
      return files.has(key(root, relative))
    },
    async readText(root, relative) {
      const content = files.get(key(root, relative))
      if (content === undefined) {
        const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
        throw error
      }
      return content
    },
    async appendText(root, relative, content) {
      const file = key(root, relative)
      files.set(file, `${files.get(file) ?? ''}${content}`)
    },
    async writeTextAtomic(root, relative, content) {
      files.set(key(root, relative), content)
    },
    async listDir(root, relative) {
      if (relative !== '.tdease/sessions') return []
      const prefix = `${root}/${relative}/`
      const names = new Set([...files.keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0]))
      return [...names].map(name => ({ name, isDir: true }))
    },
  }
}

describe('Agent session storage adapters', () => {
  it('keeps logs and prompt snapshots below the one session root', async () => {
    const workspace = memoryWorkspace()
    const log = createWorkspaceSessionLog(workspace, 'C:/workspace', 'session_1')
    await log.append({
      type: 'turn.started', turn_id: 'turn_1', user_message: 'inspect', prompt_snapshot_digest: 'a'.repeat(64),
      model: 'fixture', mindset: 'auto', authority: 'ask',
    })
    const snapshots = createWorkspacePromptSnapshotStore(workspace, 'C:/workspace', 'session_1')
    await snapshots.write('b'.repeat(64), 'frozen prompt')

    expect(workspace.files.get('C:/workspace/.tdease/sessions/session_1/events.jsonl')).toContain('turn.started')
    await expect(snapshots.read('b'.repeat(64))).resolves.toBe('frozen prompt')
  })

  it('retains empty-file presence independently of event count', async () => {
    const workspace = memoryWorkspace()
    workspace.files.set('C:/workspace/.tdease/sessions/session_1/events.jsonl', '')

    await expect(createWorkspaceSessionLog(workspace, 'C:/workspace', 'session_1').readWithPresence())
      .resolves.toEqual({ exists: true, events: [] })
    await expect(createWorkspaceSessionLog(workspace, 'C:/workspace', 'session_2').readWithPresence())
      .resolves.toEqual({ exists: false, events: [] })
  })

  it('does not issue a read for a session log that does not exist', async () => {
    const workspace = memoryWorkspace()
    let reads = 0
    const readText = workspace.readText.bind(workspace)
    workspace.readText = async (...args) => {
      reads += 1
      return readText(...args)
    }

    await expect(createWorkspaceSessionLog(workspace, 'C:/workspace', 'session_new').readWithPresence())
      .resolves.toEqual({ exists: false, events: [] })
    expect(reads).toBe(0)
  })

  it('persists and lists session metadata from the Workspace session directory', async () => {
    const workspace = memoryWorkspace()
    await writeWorkspaceSessionMetadata(workspace, 'C:/workspace', {
      version: 1,
      id: 'session_1',
      title: 'Soybean run',
      createdAt: 10,
      updatedAt: 20,
      archived: false,
      mindset: 'executor',
    })

    await expect(listWorkspaceSessionMetadata(workspace, 'C:/workspace')).resolves.toEqual([{
      version: 1,
      id: 'session_1',
      title: 'Soybean run',
      createdAt: 10,
      updatedAt: 20,
      archived: false,
      mindset: 'executor',
    }])
  })
})
