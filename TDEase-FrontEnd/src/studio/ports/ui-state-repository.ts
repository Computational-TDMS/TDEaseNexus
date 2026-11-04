// UiStateRepository — STUDIO-FRONTEND-BUSINESS-LOGIC.md §9.2.
//
// The only Client port that writes anything durable, so it is the only place a
// fifth truth can appear by accident. Three rules bind every implementation and
// every caller:
//
//   1. Deleting this state loses nothing but layout. If any value has its only
//      copy here, it is misplaced.
//   2. No session-scoped handle is persisted (e.g. a `planRef` that expires
//      with the session — such documents are dropped on restore, not restored
//      broken).
//   3. No derived flag is persisted (e.g. `dirty` is a claim about editor
//      state; recompute it, never read it from here).
//
// The contract is a namespaced key/value store rather than a document-specific
// one because the persisted set is open: `stores/documents` keeps its open tab
// list under a single key, while `stores/uiLayout` keeps pane widths, collapse
// flags and the active Rail section. A document-shaped port would serve only
// the first of those.

/**
 * Durable, workspace-scoped view state.
 *
 * Guarantees every adapter owes its callers:
 *
 * - `read` never throws. A missing, unparseable or otherwise corrupt entry
 *   yields `fallback`, so a first run and a damaged cache are the same case.
 * - `write` never throws and makes no durability promise to the caller; it may
 *   be deferred or coalesced. Nothing may depend on the value being readable
 *   back synchronously.
 * - `clear` removes every entry for the workspace and cancels writes still
 *   pending for it, so cleared state cannot be resurrected by an in-flight
 *   write.
 *
 * `T` is named by the caller at the point of use; the repository stores and
 * returns it without inspecting it.
 */
export interface UiStateRepository {
  read<T>(workspaceId: string, key: string, fallback: T): T
  write<T>(workspaceId: string, key: string, value: T): void
  clear(workspaceId: string): void
}
