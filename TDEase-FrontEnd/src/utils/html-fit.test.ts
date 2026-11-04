import { describe, expect, it } from 'vitest'
import { injectHtmlFit } from './html-fit'

/**
 * Chat-embedded HTML documents serve through injectHtmlFit: the sandboxed
 * iframe's opaque origin bars the parent page from measuring the framed
 * document, so the scale-to-width script ships inside the bytes. The injector
 * is a pure string pass — these tests pin the insertion contract; the script's
 * runtime behavior lives in the browser (Electron e2e), not in jsdom.
 */
describe('injectHtmlFit', () => {
  it('inserts the fit script right after <head>', () => {
    const out = injectHtmlFit('<!DOCTYPE html><html><head><title>t</title></head><body></body></html>')
    expect(out.startsWith('<!DOCTYPE html><html><head>')).toBe(true)
    expect(out).toContain('data-tdz-html-fit')
    expect(out.indexOf('data-tdz-html-fit')).toBeLessThan(out.indexOf('<title>'))
  })

  it('falls back to right after <html> when there is no <head>', () => {
    const out = injectHtmlFit('<html><body style="width:1400px">wide</body></html>')
    expect(out).toContain('<html><script data-tdz-html-fit')
  })

  it('prepends the fit script to a bare fragment', () => {
    const out = injectHtmlFit('<div>report</div>')
    expect(out.startsWith('<script data-tdz-html-fit')).toBe(true)
  })

  it('is idempotent — a document already carrying the marker passes through', () => {
    const once = injectHtmlFit('<html><head></head><body></body></html>')
    expect(injectHtmlFit(once)).toBe(once)
    expect(once.match(/data-tdz-html-fit/g)).toHaveLength(1)
  })

  it('carries no nested </script> that could close the injected tag early', () => {
    const out = injectHtmlFit('<html><head></head></html>')
    const inner = out.slice(out.indexOf('>') + 1, out.lastIndexOf('</script>'))
    expect(inner).not.toContain('</script')
  })

  it('reports the frame height to the parent after settling', () => {
    // html frames auto-fit: the settled height (zoom-compensated) goes to the
    // parent, which sizes the iframe and caches the value per path so
    // virtualized remounts restore it synchronously.
    const out = injectHtmlFit('<html><head></head><body><div>fig</div></body></html>')
    expect(out).toContain('tdz:frame-height')
    expect(out).toContain('postMessage')
    expect(out).toContain('scrollHeight')
    // zoom-compensated: the report multiplies by the root zoom the fit applied
    expect(out).toContain('root.style.zoom')
  })
})
