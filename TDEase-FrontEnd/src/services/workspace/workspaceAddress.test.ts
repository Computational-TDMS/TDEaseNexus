import { describe, expect, it } from 'vitest'
import { displayRelativePath, isInsideWorkspace, workspaceFilePath } from './workspaceAddress'

/**
 * The renderer twin of `electron/path_containment.cjs` — the pinned contract
 * is its semantics: segment-wise containment (never a raw string prefix),
 * win32 case-insensitivity for drive/UNC paths, and fail-closed denial of
 * absolute relatives and `..` escapes. Windows behavior is exercised through
 * drive-letter shapes, so it holds on any CI host.
 */
describe('workspaceAddress', () => {
  describe('workspaceFilePath', () => {
    it('joins a relative path onto the root in the root separator convention', () => {
      expect(workspaceFilePath('demo', 'raw/sample.raw')).toBe('demo/raw/sample.raw')
      expect(workspaceFilePath('C:/ws', 'plots/census.png')).toBe('C:/ws/plots/census.png')
      expect(workspaceFilePath('C:\\ws', 'plots/census.png')).toBe('C:\\ws\\plots\\census.png')
      expect(workspaceFilePath('/home/u/ws', 'data/x.csv')).toBe('/home/u/ws/data/x.csv')
    })

    it('normalizes mixed separators and redundant segments instead of copying them', () => {
      expect(workspaceFilePath('C:\\ws', 'a/./b\\..\\c.txt')).toBe('C:\\ws\\a\\c.txt')
      expect(workspaceFilePath('C:/ws', '.tdease/attachments/shot.png')).toBe('C:/ws/.tdease/attachments/shot.png')
    })

    it('resolves `..` that stays under the root', () => {
      expect(workspaceFilePath('C:/ws', 'sub/../x.txt')).toBe('C:/ws/x.txt')
    })

    it('fails closed on absolute relatives', () => {
      expect(() => workspaceFilePath('C:/ws', 'C:/evil.txt')).toThrow()
      expect(() => workspaceFilePath('C:/ws', '\\\\srv\\share\\x')).toThrow()
      expect(() => workspaceFilePath('demo', '/etc/passwd')).toThrow()
    })

    it('fails closed on `..` climbing above the root', () => {
      expect(() => workspaceFilePath('C:/ws', '../outside.txt')).toThrow()
      expect(() => workspaceFilePath('C:/ws', 'a/../../outside.txt')).toThrow()
      expect(() => workspaceFilePath('demo', '../../outside.txt')).toThrow()
    })

    it('fails closed on an empty part or an empty root', () => {
      expect(() => workspaceFilePath('C:/ws', '')).toThrow()
      expect(() => workspaceFilePath('C:/ws', '   ')).toThrow()
      expect(() => workspaceFilePath('', 'x.txt')).toThrow()
    })
  })

  describe('isInsideWorkspace', () => {
    it('counts the root itself and direct children as inside', () => {
      expect(isInsideWorkspace('C:/ws', 'C:/ws')).toBe(true)
      expect(isInsideWorkspace('C:/ws', 'C:/ws/sub/deep/file.png')).toBe(true)
      expect(isInsideWorkspace('demo', 'demo/analysis.py')).toBe(true)
    })

    it('compares segment-wise, so a sibling with the root as string prefix stays outside', () => {
      expect(isInsideWorkspace('C:/ws', 'C:/wsfoo/x.png')).toBe(false)
    })

    it('resolves `..` before deciding', () => {
      expect(isInsideWorkspace('C:/ws', 'C:/ws/sub/../x.txt')).toBe(true)
      expect(isInsideWorkspace('C:/ws', 'C:/ws/sub/../../outside.txt')).toBe(false)
    })

    it('is case-insensitive for Windows drive paths, case-sensitive for posix ones', () => {
      expect(isInsideWorkspace('C:/WS', 'c:/ws/plots/x.png')).toBe(true)
      expect(isInsideWorkspace('C:\\WS', 'c:\\ws\\plots\\x.png')).toBe(true)
      expect(isInsideWorkspace('/home/ws', '/HOME/ws/x.png')).toBe(false)
    })

    it('rejects candidates on another drive or grammar', () => {
      expect(isInsideWorkspace('C:/ws', 'D:/ws/x.png')).toBe(false)
      expect(isInsideWorkspace('C:/ws', '/etc/passwd')).toBe(false)
      expect(isInsideWorkspace('demo', '/etc/passwd')).toBe(false)
    })

    it('fails closed on an empty root', () => {
      expect(isInsideWorkspace('', 'x.txt')).toBe(false)
    })
  })

  describe('displayRelativePath', () => {
    it('round-trips a workspace file back to its relative key', () => {
      expect(displayRelativePath('C:/ws', 'C:/ws/plots/census.png')).toBe('plots/census.png')
      expect(displayRelativePath('C:\\ws', 'C:\\ws\\plots\\census.png')).toBe('plots/census.png')
      expect(displayRelativePath('demo', 'demo/analysis.py')).toBe('analysis.py')
    })

    it('keeps an outside path as itself instead of throwing', () => {
      expect(displayRelativePath('C:/ws', 'C:/Users/ray/Desktop/shot.png')).toBe('C:/Users/ray/Desktop/shot.png')
    })
  })
})
