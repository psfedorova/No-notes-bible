/* writing: the hidden quill that takes the keyboard and puts its letters on the page */
import { clamp } from '../lib/textures.js';
import { fontCss } from '../core/config.js';
import { caretXY, indexOnLine, layoutText, textBox } from './layout.js';
import { addVapor } from './paint.js';
import { defaultFont, pageCache, pageEntry, pageFont, pages, paintPage } from '../book/pages.js';
import { st } from '../book/state.js';
import { onePage, setPageScroll } from '../book/view.js';
import { HAND, handsOf, saveNow, saveSoon, setLastWritten, shelf } from './storage.js';
import { toast } from '../ui/toast.js';
import { emitSmoke, emitSparks } from '../fx/ink-fx.js';
import { sfx } from '../audio/sound.js';
import { applyPour, erasePages, lastErase, pour, pullBack, quillTo, restoreErased } from './spells.js';
import { openSeek, openSpells } from '../ui/dialogs.js';
import { refreshUI } from '../ui/controls.js';

const quill = document.getElementById('quill');
let writing = null;           // { n }
let composing = false;
let lastGood = { v:'', a:0, b:0 };
function setLastGood(v){ lastGood = v; }
const pageNoEl = document.getElementById('pageNo');
const burning = new Set();    // pages with letters still glowing

/* a keeper the creator lets only read turns the pages but cannot take the quill */
const readOnly = ()=> !!shelf && shelf.readOnly();
function enterWriting(n, idx){
  if(readOnly()){ toast('YOU CAN ONLY READ THIS BOOK', 2200); return; }
  if(writing && writing.n !== n) exitWriting(true);
  const fresh = !writing;
  writing = { n };
  pageEntry(n);
  if(fresh) quill.value = pages[n].t;
  const i = clamp(idx === undefined ? quill.value.length : idx, 0, quill.value.length);
  quill.focus({ preventScroll:true });
  quill.setSelectionRange(i, i);
  lastGood = { v:quill.value, a:i, b:i };
  blinkPhase = 0;
  st.bob = 0;
  burning.add(n);
  paintPage(n);
  refreshUI();
}
function exitWriting(keepFocus){
  if(!writing) return;
  const n = writing.n;
  writing = null;
  if(!keepFocus){ quill.blur(); if(!onePage()) st.focusTo = 0; }
  paintPage(n);
  saveNow(true);
  st.bob = 1;
  refreshUI();
}
/* where an edit changed the text: the common head, then what went and what came */
/* what one stroke of the quill did: at `at`, `del` letters went and `ins`
   came; given the selection it was made on (a, b) and the caret after (c),
   a letter typed beside the same letter of another hand is not taken for theirs */
function editSpan(oldV, newV, a, b, c){
  const lo = Math.min(oldV.length, newV.length);
  let p = 0;
  while(p < lo && oldV[p] === newV[p]) p++;
  let s = 0;
  while(s < lo - p && oldV[oldV.length-1-s] === newV[newV.length-1-s]) s++;
  const least = { at: p, del: oldV.length - p - s, ins: newV.length - p - s };
  /* a reading from the selection is taken only if it deletes no more than
     the plainest reading does */
  if(a !== undefined){
    const d = oldV.length - newV.length;
    const fits = (at, del, ins) => at >= 0 && del >= 0 && ins >= 0 && at + del <= oldV.length &&
      del <= least.del && oldV.length - del + ins === newV.length &&
      newV.slice(0, at) === oldV.slice(0, at) && newV.slice(at + ins) === oldV.slice(at + del);
    for(const [at, del, ins] of [[a, b - a, b - a - d], [c, a - c, 0], [a, d, 0], [a, d + c - a, c - a]])
      if(fits(at, del, ins)) return { at, del, ins };
  }
  return least;
}
function refuseStroke(msg){
  quill.value = lastGood.v;
  quill.setSelectionRange(lastGood.a, lastGood.b);
  toast(msg, 2200);
}
/* keep one birth time per character, so new letters can burn in */
function trackBirths(n, oldV, newV){
  const now = performance.now();
  const old = pages[n].born || [];
  let p = 0;
  const lo = Math.min(oldV.length, newV.length);
  while(p < lo && oldV[p] === newV[p]) p++;
  let s = 0;
  while(s < lo - p && oldV[oldV.length-1-s] === newV[newV.length-1-s]) s++;
  const ins = newV.length - p - s;
  const born = Array.from({length:p}, (_, i)=>old[i] || 0);
  for(let i=0;i<ins;i++) born.push(now);
  for(let i=oldV.length - s; i<oldV.length; i++) born.push(old[i] || 0);
  pages[n].born = born;
  return { at: p, count: ins };
}
function onQuillInput(){
  if(!writing) return;
  setPageScroll(0);
  const n = writing.n, v = quill.value;
  const sp = editSpan(pages[n].t, v, lastGood.a, lastGood.b, quill.selectionEnd), was = handsOf(n);
  const hands = was.slice(0, sp.at).concat(Array(sp.ins).fill(HAND), was.slice(sp.at + sp.del));
  const lay = layoutText(v, pageFont(n), textBox(n));
  if(!lay.ok){
    if(composing) return;
    const res = pour(n, v, quill.selectionEnd, hands);
    if(!res){ refuseStroke('THE BOOK IS FULL'); return; }
    trackBirths(n, pages[n].t, v);
    applyPour(n, res);
    setLastWritten(writing ? writing.n : n);
    return;
  }
  const old = pages[n].t, cut = editSpan(old, v), e0 = pageCache.get(n);
  if(cut.del > 0 && e0 && e0.lay){
    addVapor(n, old, e0.lay, cut.at, cut.at + cut.del, cut.del > 40 ? Math.min(0.07, 0.9/Math.max(1, e0.lay.lines.length)) : 0);
    if(!cut.ins) sfx.vanish(cut.del > 1);
  }
  const ins = trackBirths(n, old, v);
  pages[n].t = v;
  pages[n].a = hands;
  setLastWritten(n);
  if(!v) pages[n].c = false;
  if(!pages[n].f) pages[n].f = defaultFont;
  lastGood = { v, a:quill.selectionStart, b:quill.selectionEnd };
  blinkPhase = 0;
  burning.add(n);
  document.fonts.load(fontCss(pageFont(n), 40), v.slice(-24) || 'a').then(()=>{ if(pageCache.has(n)) paintPage(n); }).catch(()=>{});
  paintPage(n);
  if(ins.count > 0 && ins.count < 40){
    emitSparks(n, lay, v, ins.at, ins.count);
    emitSmoke(n, lay, v, ins.at, ins.count);
    sfx.burn(ins.at === 0 && !!lay.cap);
    if(/[.!?]/.test(v.charAt(ins.at + ins.count - 1))) sfx.chime();
  }
  if(cut.del > ins.count) pullBack(n);
  saveSoon(false);
}
quill.addEventListener('input', onQuillInput);
quill.addEventListener('compositionstart', ()=>{ composing = true; });
quill.addEventListener('compositionend', ()=>{ composing = false; onQuillInput(); });
const onSel = ()=>{
  if(!writing) return;
  blinkPhase = 0;
  if(!composing){ lastGood.a = quill.selectionStart; lastGood.b = quill.selectionEnd; }
  paintPage(writing.n);
};
document.addEventListener('selectionchange', ()=>{ if(document.activeElement === quill) onSel(); });
quill.addEventListener('keyup', onSel);
quill.addEventListener('keydown', e=>{
  e.stopPropagation();
  if(!writing) return;
  const n = writing.n;
  if(e.key === 'Escape'){ e.preventDefault(); exitWriting(); return; }
  const mod = e.metaKey || e.ctrlKey;
  if(mod && e.code === 'KeyE'){ e.preventDefault(); erasePages([n]); return; }
  if(mod && e.code === 'KeyZ' && !e.shiftKey && lastErase && restoreErased()){ e.preventDefault(); return; }
  if(mod && e.code === 'KeyG'){ e.preventDefault(); openSeek(); return; }
  if(mod && e.code === 'Slash'){ e.preventDefault(); openSpells(); return; }
  if(mod && e.key === 'Enter'){ e.preventDefault(); quillTo(n + 1, 0); return; }
  if(e.key === 'PageDown' || e.key === 'PageUp'){ e.preventDefault(); quillTo(n + (e.key === 'PageDown' ? 1 : -1)); return; }
  if(e.key === 'Backspace' && !mod && !e.altKey && quill.selectionStart === 0 && quill.selectionEnd === 0 && n > 1){ e.preventDefault(); quillTo(n - 1); return; }
  if((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'ы')){ e.preventDefault(); saveNow(); return; }
  if(e.key === 'Tab'){ e.preventDefault(); quill.setRangeText('    ', quill.selectionStart, quill.selectionEnd, 'end'); onQuillInput(); return; }
  const lay = pageEntry(n).lay;
  if(!lay) return;
  const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  const homeEnd = (e.key === 'Home' || e.key === 'End') && !e.metaKey && !e.ctrlKey;
  if(!vertical && !homeEnd) return;
  e.preventDefault();
  const dirBack = quill.selectionDirection === 'backward';
  const focus = dirBack ? quill.selectionStart : quill.selectionEnd;
  const anchor = dirBack ? quill.selectionEnd : quill.selectionStart;
  const c = caretXY(lay, focus);
  let to;
  if(vertical){
    const li = c.li + (e.key === 'ArrowUp' ? -1 : 1);
    if(li < 0) to = 0;
    else if(li >= lay.lines.length) to = quill.value.length;
    else to = indexOnLine(lay, li, c.x);
  }else{
    const ln = lay.lines[c.li];
    to = e.key === 'Home' ? ln.start : (lay.lines[c.li+1] && lay.lines[c.li+1].start === ln.end && ln.end > ln.start ? ln.end-1 : ln.end);
  }
  if(e.shiftKey) quill.setSelectionRange(Math.min(anchor,to), Math.max(anchor,to), to < anchor ? 'backward' : 'forward');
  else quill.setSelectionRange(to, to);
  onSel();
});
let blinkPhase = 0;
function setBlinkPhase(v){ blinkPhase = v; }

export {
  blinkPhase, burning, composing, editSpan, enterWriting, exitWriting, onSel, pageNoEl,
  quill, readOnly, setBlinkPhase, setLastGood, writing
};
