import { describe, expect, it } from 'vitest'
import {
  branch,
  groupIdsOf,
  groupLeaf,
  isGroupInTree,
  parentBranchOf,
  removeLeaf,
  replaceLeaf,
  replaceNode,
} from './editorLayout'

/**
 * The tree's invariants, asserted as pure cases — this is the test surface
 * the old inline-in-store arrangement could not offer (every case would have
 * needed a mounted Pinia store with persistence side effects).
 */
describe('editorLayout', () => {
  //        A
  //   ── h ──┬───
  //   B      C
  //        ── v ──
  //        D  E
  const tree = branch(
    'horizontal',
    groupLeaf('B'),
    branch('vertical', groupLeaf('D'), groupLeaf('E')),
  )

  it('walks leaf ids depth-first, left before right', () => {
    expect(groupIdsOf(tree)).toEqual(['B', 'D', 'E'])
    expect(groupIdsOf(groupLeaf('solo'))).toEqual(['solo'])
  })

  it('answers membership for any depth', () => {
    expect(isGroupInTree(tree, 'E')).toBe(true)
    expect(isGroupInTree(tree, 'X')).toBe(false)
    expect(isGroupInTree(null, 'X')).toBe(false)
  })

  it('replaces a leaf at depth and keeps untouched branches by reference', () => {
    const next = replaceLeaf(tree, 'D', groupLeaf('Z'))
    expect(groupIdsOf(next)).toEqual(['B', 'Z', 'E'])
    // Only the spine down to the replaced leaf is rebuilt.
    expect(next.left).toBe(tree.left)
    expect((next.right as { left: unknown }).left).not.toBe((tree.right as { left: unknown }).left)
    // Replacing nothing returns the same object.
    expect(replaceLeaf(tree, 'X', groupLeaf('Z'))).toBe(tree)
  })

  it('removes a leaf so the SIBLING absorbs its slot, at every depth', () => {
    // Depth 1: removing B promotes the whole right subtree to the root.
    const withoutB = removeLeaf(tree, 'B')!
    expect(groupIdsOf(withoutB)).toEqual(['D', 'E'])
    expect(withoutB).toBe(tree.right)

    // Depth 2: removing E turns the inner branch into the leaf D.
    const withoutE = removeLeaf(tree, 'E')!
    expect(groupIdsOf(withoutE)).toEqual(['B', 'D'])

    // Removing the root's leaf returns null — the caller rebuilds.
    expect(removeLeaf(groupLeaf('B'), 'B')).toBeNull()
  })

  it('removal is a no-op (same object) for a foreign id', () => {
    expect(removeLeaf(tree, 'X')).toBe(tree)
  })

  it('finds the branch whose DIRECT child is the leaf', () => {
    expect(parentBranchOf(tree, 'B')?.orientation).toBe('horizontal')
    expect(parentBranchOf(tree, 'D')?.orientation).toBe('vertical')
    // A nested leaf is not a direct child of the root.
    expect(parentBranchOf(tree, 'E')).not.toBe(tree)
    expect(parentBranchOf(groupLeaf('B'), 'B')).toBeNull()
  })

  it('replaces a subtree BY REFERENCE (rotation) without touching siblings', () => {
    const inner = tree.right
    const rotated = branch('horizontal', inner.right, inner.left)
    const next = replaceNode(tree, inner, rotated)
    expect(groupIdsOf(next)).toEqual(['B', 'E', 'D'])
    expect(next.left).toBe(tree.left)
  })

  it('branch() defaults the ratio to a half split', () => {
    expect(branch('vertical', groupLeaf('a'), groupLeaf('b')).ratio).toBe(0.5)
  })
})
