/**
 * html-fit — scale-to-width for chat-embedded HTML documents.
 *
 * The transcript's inline HTML frame (markdown-hydration `md-media-frame`) is
 * a sandboxed iframe with an opaque origin: the parent page cannot reach in to
 * measure the framed document, so the fit must run inside it. `injectHtmlFit`
 * is applied to the workspace bytes just before they become the iframe's blob
 * URL — the file on disk is never touched — and prepends one self-contained
 * script that measures the document's natural scrollWidth and, when it
 * exceeds the viewport, sets `zoom` on <html> to viewport/natural. Wide
 * charts and fixed-width pages show their full horizontal span instead of
 * hiding behind a horizontal scrollbar; fluid pages measure at their own
 * viewport and are left untouched. Content is never scaled UP, and vertical
 * scrolling is unchanged.
 *
 * `zoom` (standard Chromium, and this app ships Electron 37) reflows rather
 * than transforms, so no phantom horizontal scrollbar survives the fit and
 * the natural width is recoverable by clearing it — the re-fit on resize /
 * load / fonts / body growth clears, re-measures, re-applies. The transient
 * clear lands in the same frame as the re-apply, so a ResizeObserver on
 * <body> sees only the settled box and the loop terminates.
 */

const FIT_MARKER = 'data-tdz-html-fit'

const FIT_SCRIPT = `<script ${FIT_MARKER}>(function(){
"use strict";
var root=document.documentElement;
function naturalWidth(){
  if(!root)return 0;
  var body=document.body;
  return Math.max(root.scrollWidth,body?body.scrollWidth:0);
}
function fit(){
  if(!root)return;
  root.style.zoom="";
  var w=naturalWidth(),vw=window.innerWidth;
  if(vw>0&&w>vw)root.style.zoom=String(vw/w);
}
var raf=0;
function schedule(){
  if(raf)return;
  raf=requestAnimationFrame(function(){raf=0;fit()});
}
window.addEventListener("resize",schedule);
window.addEventListener("load",schedule);
document.addEventListener("DOMContentLoaded",schedule);
if(document.fonts&&document.fonts.ready){document.fonts.ready.then(schedule);}
if(typeof ResizeObserver==="function"){
  var ro=new ResizeObserver(schedule);
  var observeBody=function(){if(document.body)ro.observe(document.body);};
  if(document.body)observeBody();
  else document.addEventListener("DOMContentLoaded",observeBody,{once:true});
}
schedule();
})();</script>`

const HEAD_RE = /<head\b[^>]*>/i
const HTML_RE = /<html\b[^>]*>/i

/** Prepend the fit script into an HTML document's text. Idempotent: a
 *  document already carrying the marker passes through untouched. Documents
 *  without a <head> get the script right after <html> (the parser routes it
 *  into the implicit head) or plain-prepended for fragments. */
export function injectHtmlFit(html: string): string {
  if (html.includes(FIT_MARKER)) return html
  const anchor = HEAD_RE.exec(html) ?? HTML_RE.exec(html)
  if (anchor) {
    const at = anchor.index + anchor[0].length
    return html.slice(0, at) + FIT_SCRIPT + html.slice(at)
  }
  return FIT_SCRIPT + html
}
