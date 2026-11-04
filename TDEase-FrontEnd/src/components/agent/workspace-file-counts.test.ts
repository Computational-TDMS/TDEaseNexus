import { describe, expect, it } from 'vitest'
import { countWorkspaceFiles } from './workspace-file-counts'
import type { FileTreeNode } from '@/types/workspace-data'

function file(name: string): FileTreeNode {
  return { name, path: name, type: 'file' }
}

function dir(name: string, children: FileTreeNode[]): FileTreeNode & { children: FileTreeNode[] } {
  return { name, path: name, type: 'directory', children }
}

describe('countWorkspaceFiles', () => {
  it('counts raw spectra and fasta files, case-insensitively', () => {
    const tree = [
      dir('raw', [file('sample_a.raw'), file('sample_b.mzML'), file('notes.txt')]),
      dir('fasta', [file('reference.fasta')]),
    ]
    expect(countWorkspaceFiles(tree)).toEqual({ rawFileCount: 2, fastaFileCount: 1 })
  })

  it('returns zero for an empty tree', () => {
    expect(countWorkspaceFiles([])).toEqual({ rawFileCount: 0, fastaFileCount: 0 })
  })
})
