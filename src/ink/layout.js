import { clamp, cv } from '../lib/textures.js';
import { capFont, fontCss, FS, SC } from '../core/config.js';
import { pages } from '../book/pages.js';

function textBox(n){
  const recto = n%2===0;
  const x = (recto ? 50 : 40)*SC, w = (340-50-40)*SC;
  const y = (n===0 ? 236 : 46)*SC;
  return { x, y, w, bottom: 414*SC, flow: !!(pages[n] && pages[n].c) };
}

const measCtx = cv(8,8).getContext('2d');
const graphemes = typeof Intl === 'object' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const GLUE = /[\p{M}\u200D\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/uy;
const STRONG = /\p{L}/u, RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const NO_CAP = /[\u0590-\u08FF\u1800-\u18AF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
/* where s may be cut: never inside a surrogate pair or a grapheme (a letter and its marks, an emoji sequence) */
function edges(s){
  const b = new Uint8Array(s.length + 1);
  b[0] = b[s.length] = 1;
  if(graphemes){ for(const g of graphemes.segment(s)) b[g.index] = 1; return b; }
  for(let i=1;i<s.length;i++){
    const c = s.charCodeAt(i), p = s.charCodeAt(i - 1);
    GLUE.lastIndex = i;
    b[i] = (c & 0xFC00) === 0xDC00 && (p & 0xFC00) === 0xD800 || p === 0x200D || GLUE.test(s) ? 0 : 1;
  }
  return b;
}
function cutAt(text, lo, at, pe){
  const a = Math.max(lo, at - 32), z = Math.min(pe, at + 32), b = edges(text.slice(a, z));
  for(let i=at; i>lo; i--) if(b[i - a]) return i;
  for(let i=at+1; i<z; i++) if(b[i - a]) return i;
  return z;
}
function layoutText(text, f, box){
  const size = f.size*FS, lh = Math.round(size*(f.lead || 1.38));
  measCtx.font = fontCss(f, size);
  const lines = [];
  let cap = null;
  const first = text.charAt(0);
  GLUE.lastIndex = 1;
  if(first && !box.flow && /\p{L}/u.test(first) && !NO_CAP.test(first) && !GLUE.test(text)){
    const capSize = size*2.45;
    measCtx.font = capFont(f, capSize);
    const cm = measCtx.measureText(first);
    const cw = Math.max(cm.width, cm.actualBoundingBoxRight);
    cap = { ch:first, size:capSize, w: cw + size*0.06, l: Math.max(0, cm.actualBoundingBoxLeft), lines:1, x: box.x };
    measCtx.font = fontCss(f, size);
  }
  const W = box.w;
  const avail = li => W - (cap && li < cap.lines ? cap.w : 0);
  const xStart = li => box.x + (cap && li < cap.lines ? cap.w : 0);
  const meas = s => measCtx.measureText(s).width;
  const y0 = box.y + (cap ? Math.max(size*0.98, cap.size*0.74) : size*0.98);
  const past = li => y0 + li*lh + size*0.3 > box.bottom;
  const full = ()=> lines.length > 0 && past(lines.length - 1);
  let i = 0;
  const L = text.length;
  para: while(true){
    const nl = text.indexOf('\n', i);
    const pe = nl < 0 ? L : nl;
    const m = STRONG.exec(text.slice(i, Math.min(pe, i + 400)));
    const rtl = !!m && RTL.test(m[0]);
    let ls = i;
    if(ls === pe){ if(full()) break; lines.push({ start:ls, end:pe, rtl }); }
    while(ls < pe){
      if(full()) break para;
      const li = lines.length;
      const skip = (cap && ls === 0) ? 1 : 0;
      const maxW = avail(li);
      let end = ls + skip, lastBreak = -1;
      while(end < pe){
        const ch = text[end];
        const w = meas(text.slice(ls+skip, end+1));
        if(w > maxW && ch !== ' '){ break; }
        end++;
        if(ch === ' ') lastBreak = end;
      }
      if(end < pe){
        if(lastBreak > ls+skip) end = lastBreak;
        else end = cutAt(text, ls+skip, Math.max(end, ls+skip+1), pe);
      }
      lines.push({ start:ls, end, skip, rtl });
      ls = end;
    }
    if(nl < 0) break;
    i = nl + 1;
    if(i > L) break;
  }
  if(!lines.length) lines.push({ start:0, end:0 });
  let ok = true, cut = L;
  lines.forEach((ln, li)=>{
    ln.x0 = ln.rtl ? box.x + W : xStart(li);
    ln.y = y0 + li*lh;
    const skip = ln.skip || 0, a0 = ln.start + skip, b = edges(text.slice(a0, ln.end)), dir = ln.rtl ? -1 : 1;
    ln.xs = [];
    for(let j=0;j<=ln.end-ln.start;j++){
      if(skip && j===0) ln.xs.push(box.x);
      else ln.xs.push(b[j - skip] ? ln.x0 + dir*meas(text.slice(a0, ln.start+j)) : NaN);
    }
    for(let j=ln.xs.length-2;j>=0;j--) if(ln.xs[j] !== ln.xs[j]) ln.xs[j] = ln.xs[j+1];
    if(ok && past(li)){ ok = false; cut = ln.start; }
  });
  if(cap) cap.y = y0;
  return { lines, cap, ok, cut, size, lh, f, box };
}
const INK_UP = 1.05, INK_DN = 0.42;
function lineOf(lay, idx){
  let best = 0;
  for(let i=0;i<lay.lines.length;i++) if(lay.lines[i].start <= idx) best = i;
  return best;
}
function caretXY(lay, idx){
  const li = lineOf(lay, idx), ln = lay.lines[li];
  const j = clamp(idx - ln.start, 0, ln.xs.length-1);
  return { x: ln.xs[j], y: ln.y, li };
}
function indexAt(lay, px, py){
  let li = 0, bd = Infinity;
  lay.lines.forEach((ln, i)=>{ const d = Math.abs(py - (ln.y - lay.size*0.35)); if(d < bd){ bd = d; li = i; } });
  return indexOnLine(lay, li, px);
}
function indexOnLine(lay, li, px){
  const ln = lay.lines[li];
  let best = 0, bd = Infinity;
  for(let j=0;j<ln.xs.length;j++){
    const d = Math.abs(ln.xs[j]-px);
    if(d < bd){ bd = d; best = j; }
  }
  let idx = ln.start + best;
  const nxt = lay.lines[li+1];
  if(nxt && idx === ln.end && nxt.start === ln.end && ln.end > ln.start) idx = ln.end - 1;
  return idx;
}
function glyphBox(lay, text, idx){
  if(lay.cap && idx === 0) return { x: lay.cap.x, y: lay.cap.y, w: lay.cap.w, cap: true, ln: null };
  const li = lineOf(lay, idx), ln = lay.lines[li];
  const j = idx - ln.start;
  if(j < 0 || j+1 >= ln.xs.length) return null;
  const a = ln.xs[j], b = ln.xs[j+1];
  return a === b ? null : { x: Math.min(a, b), y: ln.y, w: Math.abs(b - a), ln };
}

export {
  caretXY, glyphBox, indexAt, indexOnLine, INK_DN, INK_UP, layoutText, textBox
};
