import { describe, expect, it } from 'vitest'
import { setSideChatDraft, takeSideChatDraft } from './side-chat-drafts'

describe('side-chat-drafts', () => {
  it('hands the seeded draft over exactly once (consume-once)', () => {
    setSideChatDraft('s_child', '关于这段内容：\n> 引文')
    expect(takeSideChatDraft('s_child')).toBe('关于这段内容：\n> 引文')
    // A re-opened panel must never resurrect an old quote.
    expect(takeSideChatDraft('s_child')).toBeUndefined()
  })

  it('returns undefined for sessions that were never seeded', () => {
    expect(takeSideChatDraft('s_unknown')).toBeUndefined()
  })
})
