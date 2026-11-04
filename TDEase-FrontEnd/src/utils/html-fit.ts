/**
 * html-fit — the ONE runtime script injected into every chat-embedded HTML
 * document (full documents and wrapped fragments alike). Two jobs, both
 * of which must run INSIDE the frame because the transcript's inline iframe
 * is sandboxed with an opaque origin and cannot be measured from the parent:
 *
 *   fit     — when the document's natural scrollWidth exceeds the viewport,
 *             set `zoom` on <html> to viewport/natural so wide charts show
 *             their full horizontal span instead of a horizontal scrollbar.
 *             Content is never scaled UP, and `zoom` reflows (Chromium; this
 *             app ships Electron 37) so the natural width stays recoverable —
 *             the re-fit on resize / load / fonts / body growth clears,
 *             re-measures, re-applies, and the transient clear lands in the
 *             same frame as the re-apply so the ResizeObserver loop
 *             terminates.
 *
 *   report  — postMessage the frame's settled height (zoom-compensated) to
 *             the parent as {type:'tdz:frame-height', h}. HTML frames
 *             auto-fit their content (nothing hidden); the parent CACHES the
 *             reported height per path and restores it synchronously on
 *             virtualized remounts (markdown-hydration), so the remount
 *             reset→grow cycle that used to flicker cannot recur. No
 *             listener (e.g. standalone export) → no-op.
 *
 * Applied to the workspace bytes just before they become the iframe's blob
 * URL — the file on disk is never touched.
 */

const FIT_MARKER = 'data-tdz-html-fit'
const HEIGHT_MSG = 'tdz:frame-height'

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
function report(){
  if(!root||!parent||parent===window)return;
  var z=1;
  try{z=parseFloat(root.style.zoom)||1;}catch(e){}
  var body=document.body;
  var h=Math.max(root.scrollHeight,body?body.scrollHeight:0);
  if(h>0){try{parent.postMessage({type:"${HEIGHT_MSG}",h:Math.round(h*z)},"*");}catch(e){}}
}
function settle(){
  fit();
  report();
}
var raf=0;
function schedule(){
  if(raf)return;
  raf=requestAnimationFrame(function(){raf=0;settle();});
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

/** The height message type the parent listens for — exported so hydration
 *  and any future host surfaces stay coupled to one literal. */
export const FRAME_HEIGHT_MESSAGE = HEIGHT_MSG
