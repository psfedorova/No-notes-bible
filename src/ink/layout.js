/* text layout: the one geometry the ink and the caret share */
import { clamp, cv } from '../lib/textures.js';
import { capFont, fontCss, FS, SC } from '../core/config.js';
import { pages } from '../book/pages.js';

function textBox(n){
  const recto = n%2===0;
  const x = (recto ? 50 : 40)*SC, w = (340-50-40)*SC;
  const y = (n===0 ? 236 : 46)*SC;
  return { x, y, w, bottom: 414*SC, flow: !!(pages[n] && pages[n].c) };
}

/* ---------------- text layout: the one geometry the ink and caret share ---------------- */
const measCtx = cv(8,8).getContext('2d');
function layoutText(text, f, box){
  const size = f.size*FS, lh = Math.round(size*(f.lead || 1.38));
  measCtx.font = fontCss(f, size);
  const lines = [];
  let cap = null;
  const first = text.charAt(0);
  if(first && !box.flow && /\p{L}/u.test(first)){
    /* a raised initial: a big figured capital standing on the first line's
       baseline, the rest of the word running on from it */
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
  let i = 0;
  const L = text.length;
  while(true){
    const nl = text.indexOf('\n', i);
    const pe = nl < 0 ? L : nl;
    let ls = i;
    if(ls === pe) lines.push({ start:ls, end:pe });
    while(ls < pe){
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
        else if(end === ls+skip) end = ls+skip+1;
      }
      lines.push({ start:ls, end, skip });
      ls = end;
    }
    if(nl < 0) break;
    i = nl + 1;
    if(i > L) break;
  }
  if(!lines.length) lines.push({ start:0, end:0 });
  let ok = true;
  const y0 = box.y + (cap ? Math.max(size*0.98, cap.size*0.74) : size*0.98);
  lines.forEach((ln, li)=>{
    ln.x0 = xStart(li);
    ln.y = y0 + li*lh;
    const skip = ln.skip || 0;
    ln.xs = [];
    for(let j=0;j<=ln.end-ln.start;j++){
      if(skip && j===0) ln.xs.push(box.x);
      else ln.xs.push(ln.x0 + meas(text.slice(ln.start+skip, ln.start+j)));
    }
    if(ln.y + size*0.3 > box.bottom) ok = false;
  });
  if(cap) cap.y = y0;
  return { lines, cap, ok, size, lh, f, box };
}
/* the band a line's ink can reach, in font sizes above and below its baseline:
   the burn and the evaporation clip to it, so descenders burn with their letter */
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
  /* the trailing space of a wrapped line belongs to the next line's caret */
  let idx = ln.start + best;
  const nxt = lay.lines[li+1];
  if(nxt && idx === ln.end && nxt.start === ln.end && ln.end > ln.start) idx = ln.end - 1;
  return idx;
}
/* where character idx sits: its line, pen position and advance, in canvas px */
function glyphBox(lay, text, idx){
  if(lay.cap && idx === 0) return { x: lay.cap.x, y: lay.cap.y, w: lay.cap.w, cap: true, ln: null };
  const li = lineOf(lay, idx), ln = lay.lines[li];
  const j = idx - ln.start;
  if(j < 0 || j+1 >= ln.xs.length) return null;
  return { x: ln.xs[j], y: ln.y, w: ln.xs[j+1] - ln.xs[j], ln };
}

export {
  caretXY, glyphBox, indexAt, indexOnLine, INK_DN, INK_UP, layoutText, textBox
};
