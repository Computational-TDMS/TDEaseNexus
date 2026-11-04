/**
 * Tests for splitTopLevelBlocks — the prefix-stable block splitter behind the
 * streaming markdown cache. The properties under test are the ones the cache
 * depends on: blocks split at blank lines outside fences, blanks stay
 * attached to the preceding block, fences (open or unterminated) hold their
 * content together, and appending text never mutates an earlier block.
 */
import { describe, expect, it } from 'vitest'
import { splitTopLevelBlocks } from './markdown-blocks'

describe('splitTopLevelBlocks', () => {
  it('splits paragraphs at blank lines, keeping the separator on the previous block', () => {
    const blocks = splitTopLevelBlocks('第一段。\n\n第二段。\n\n第三段。')
    expect(blocks).toEqual(['第一段。\n', '第二段。\n', '第三段。'])
  })

  it('keeps a fenced code block with its internal blank lines as ONE block', () => {
    const src = '说明：\n\n```python\nx = 1\n\ny = 2\n```\n\n结尾。'
    const blocks = splitTopLevelBlocks(src)
    expect(blocks).toEqual(['说明：\n', '```python\nx = 1\n\ny = 2\n```\n', '结尾。'])
  })

  it('holds an unterminated fence (mid-stream state) in one tail block', () => {
    const blocks = splitTopLevelBlocks('前文。\n\n```js\nconst a = 1;\n\n\nconst b = 2;')
    expect(blocks).toEqual(['前文。\n', '```js\nconst a = 1;\n\n\nconst b = 2;'])
  })

  it('is prefix-stable: appending text never mutates an earlier block', () => {
    const before = splitTopLevelBlocks('段落一。\n\n段落二的开头')
    const after = splitTopLevelBlocks('段落一。\n\n段落二的开头，继续写。\n\n```py\ncode\n```')
    expect(after.length).toBe(3)
    expect(after[0]).toBe(before[0])
    // The previously-open tail becomes a closed block; its text may only grow.
    expect(after[1]!.startsWith(before[1]!)).toBe(true)
  })

  it('drops leading blanks before the first content line', () => {
    expect(splitTopLevelBlocks('\n\n\n开头')).toEqual(['开头'])
  })

  it('returns a single empty-ish block for blank-only input and [] for empty', () => {
    expect(splitTopLevelBlocks('')).toEqual([])
    expect(splitTopLevelBlocks('\n\n\n')).toEqual([])
  })

  it('treats a tilde fence like a backtick fence and requires a longer/equal close', () => {
    const src = '~~~\n代码\n~~~\n\n后文'
    expect(splitTopLevelBlocks(src)).toEqual(['~~~\n代码\n~~~\n', '后文'])
  })
})
