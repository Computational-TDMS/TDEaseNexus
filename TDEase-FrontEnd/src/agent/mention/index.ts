/**
 * @-mention headless model — the explicit-reference replacement for the
 * removed bounded-focus axis. See `AGENT-CONTRACT.md` §3 (rewritten).
 *
 * Surface:
 *  - parse / serialize:   `parseMentions`, `tokenToText`, `insertMentionToken`,
 *                         `mentionFragmentAtCaret`, `skillFragmentAtCaret`
 *  - resolve:             `resolveMention`, `resolveMentions`, `MentionSources`
 *  - render to snapshot:  `composeReferencedContext`, `REFERENCED_SECTION_HEADING`
 */
export type { MentionKind, MentionToken } from './mention-token'
export {
  MENTION_REGEX,
  isMentionKind,
  parseMentions,
  tokenToText,
  insertMentionToken,
  mentionFragmentAtCaret,
  skillFragmentAtCaret,
} from './mention-token'

export type { MentionSources, ResolvedMention } from './mention-source'
export {
  resolveMention,
  resolveMentions,
  capFileBody,
  notFoundLabel,
  FILE_BODY_BYTE_CAP,
} from './mention-source'

export { composeReferencedContext, REFERENCED_SECTION_HEADING } from './mention-context'
