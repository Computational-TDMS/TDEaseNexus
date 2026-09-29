/**
 * editorLayout — the pure module behind the editor group area.
 *
 * The document surface is a recursive BINARY layout tree: a leaf names an
 * editor group, a branch is an orientation + two children + the first
 * child's size ratio. Splitting replaces a leaf with a branch (any group can
 * split again in any direction); closing rebalances the tree so the sibling
 * absorbs the slot. Binary keeps every node renderable by one two-pane split
 * component; VSCode's n-ary grid adds no user-visible capability beyond it.
 *
 * This module is the tree's ONLY implementation: the type, the query and
 * rebalancing primitives, and nothing else — no reactivity, no persistence,
 * no group records. `stores/documents.ts` owns the reactive root and the
 * side effects (persist, focus fallback) and composes these primitives; that
 * split is what makes the tree's invariants testable as pure table-driven
 * cases instead of through a mounted store.
 *
 * Every mutation returns a NEW tree object (or the same reference when
 * nothing changed), so a renderer keyed on the root reference sees exactly
 * one new object per edit.
 */

/** One node of the layout tree: a group leaf or a binary branch. */
export type LayoutNode =
  | { kind: 'group'; id: string }
  | {
    kind: 'branch'
    orientation: 'horizontal' | 'vertical'
    /** First child's share of the container, 0..1 (clamped on use). */
    ratio: number
    left: LayoutNode
    right: LayoutNode
  }

export function groupLeaf(id: string): LayoutNode {
  return { kind: 'group', id }
}

export function branch(
  orientation: 'horizontal' | 'vertical',
  left: LayoutNode,
  right: LayoutNode,
  ratio = 0.5,
): LayoutNode {
  return { kind: 'branch', orientation, ratio, left, right }
}

/** Leaf ids in depth order (left first). */
export function groupIdsOf(node: LayoutNode, acc: string[] = []): string[] {
  if (node.kind === 'group') acc.push(node.id)
  else { groupIdsOf(node.left, acc); groupIdsOf(node.right, acc) }
  return acc
}

/** Whether the tree contains the group leaf `groupId`. */
export function isGroupInTree(node: LayoutNode | null, groupId: string): boolean {
  if (!node) return false
  if (node.kind === 'group') return node.id === groupId
  return isGroupInTree(node.left, groupId) || isGroupInTree(node.right, groupId)
}

/** Replace the leaf named `groupId` with `replacement` (new tree object). */
export function replaceLeaf(node: LayoutNode, groupId: string, replacement: LayoutNode): LayoutNode {
  if (node.kind === 'group') return node.id === groupId ? replacement : node
  const left = replaceLeaf(node.left, groupId, replacement)
  const right = replaceLeaf(node.right, groupId, replacement)
  if (left === node.left && right === node.right) return node
  return { ...node, left, right }
}

/** Replace an arbitrary subtree by reference (branch rotation). */
export function replaceNode(node: LayoutNode, target: LayoutNode, replacement: LayoutNode): LayoutNode {
  if (node === target) return replacement
  if (node.kind === 'group') return node
  const left = replaceNode(node.left, target, replacement)
  const right = replaceNode(node.right, target, replacement)
  if (left === node.left && right === node.right) return node
  return { ...node, left, right }
}

/**
 * Remove the leaf named `groupId`; the sibling absorbs its slot. Returns
 * null when the root itself was the removed leaf — the caller decides what
 * an emptied root means (the store rebuilds one empty group).
 */
export function removeLeaf(node: LayoutNode, groupId: string): LayoutNode | null {
  if (node.kind === 'group') return node.id === groupId ? null : node
  if (node.left.kind === 'group' && node.left.id === groupId) return node.right
  if (node.right.kind === 'group' && node.right.id === groupId) return node.left
  const left = removeLeaf(node.left, groupId)
  if (left === null) return node.right
  const right = removeLeaf(node.right, groupId)
  if (right === null) return left
  if (left === node.left && right === node.right) return node
  return { ...node, left, right }
}

/** The branch whose direct child is `groupId`'s leaf (its split parent). */
export function parentBranchOf(node: LayoutNode, groupId: string): Extract<LayoutNode, { kind: 'branch' }> | null {
  if (node.kind === 'group') return null
  if (node.left.kind === 'group' && node.left.id === groupId) return node
  if (node.right.kind === 'group' && node.right.id === groupId) return node
  return parentBranchOf(node.left, groupId) ?? parentBranchOf(node.right, groupId)
}
