/**
 * Grapheme splitting — used by streaming tail-fade to wrap the last N
 * user-perceived characters (not UTF-16 code units) of an inflight message
 * in a fade span. Emoji / combining marks / CJK are handled correctly via
 * Intl.Segmenter; falls back to code-point iteration when unavailable.
 *
 * Ported from openhanako desktop/src/react/utils/grapheme.ts.
 */

let graphemeSegmenter: Intl.Segmenter | null | undefined;

function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter !== undefined) return graphemeSegmenter;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  } else {
    graphemeSegmenter = null;
  }
  return graphemeSegmenter;
}

export function splitGraphemes(text: string): string[] {
  if (!text) return [];
  const segmenter = getGraphemeSegmenter();
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), entry => entry.segment);
}
