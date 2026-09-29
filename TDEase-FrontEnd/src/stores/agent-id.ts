/**
 * Id minting for the agent store's slices. One process-wide counter backs the
 * display vocabulary (`msg-N`, `blk-N`, `approval-N`); session ids are a
 * separate, stronger vocabulary.
 */

let idSeq = 0
export function nextId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

export function nextSessionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  // Session IDs name durable Workspace directories. Unlike display-block IDs,
  // they must survive a renderer reload without being reused.
  return uuid ? `s_${uuid}` : nextId('s')
}
