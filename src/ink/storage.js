/* keeping the book: autosave, hands, backups and the text download */
import { clamp } from '../lib/textures.js';
import { FONTS, LS_KEY, N } from '../core/config.js';
import { defaultFont, pageCache, pages, paintPage, setDefaultFont } from '../book/pages.js';
import { st } from '../book/state.js';
import { toast } from '../ui/toast.js';
import { burning, composing, editSpan, exitWriting, quill, setLastGood, writing } from './writing.js';
import { setLastErase, spreadOf } from './spells.js';
import { seekSpread } from '../book/seek.js';
import { refreshUI } from '../ui/controls.js';


let saveTm = 0;
/* every browser that writes in the book is one hand with its own mark; each
   letter keeps the mark of the hand that wrote it, whoever erases or moves it */
const HAND_KEY = 'liber-arcanum.hand';
const BROWSER_HAND = (()=>{
  let h = null;
  try{ h = localStorage.getItem(HAND_KEY); }catch(e){}
  if(!/^h[0-9a-z]{8,}$/.test(h || '')){
    h = 'h' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    try{ localStorage.setItem(HAND_KEY, h); }catch(e){}
  }
  return h;
})();
/* in a shared book the hand is the signed-in person, and the book lives
   under a key of its own */
let HAND = BROWSER_HAND, bookKey = LS_KEY, shelf = null, booted = false;
function setShelf(v){ shelf = v; }
function setBooted(v){ booted = v; }
function handsOf(n){
  const pg = pages[n];
  if(!pg.a || pg.a.length !== pg.t.length) pg.a = Array(pg.t.length).fill(HAND);
  return pg.a;
}
/* hands are stored once per book, each page as runs of [hand, letters] */
function packHands(a, list){
  const runs = [];
  a.forEach(h=>{
    let i = list.indexOf(h);
    if(i < 0){ i = list.length; list.push(h); }
    const r = runs[runs.length - 1];
    if(r && r[0] === i) r[1]++; else runs.push([i, 1]);
  });
  return runs;
}
function unpackHands(runs, list, len){
  if(!Array.isArray(runs) || !Array.isArray(list)) return null;
  const a = [];
  for(const r of runs){
    const h = list[r && r[0]], c = r ? r[1]|0 : 0;
    if(typeof h !== 'string' || c <= 0 || a.length + c > len) return null;
    for(let i=0;i<c;i++) a.push(h);
  }
  return a.length === len ? a : null;
}
function serialise(){
  const out = {}, hands = [HAND];
  pages.forEach((p,n)=>{
    if(!p.t && !p.f) return;
    const o = { t:p.t, f:p.f };
    if(p.c) o.c = 1;
    if(p.t) o.a = packHands(handsOf(n), hands);
    out[n] = o;
  });
  return { pages: out, hands, open: st.open, k: st.k, w: lastWritten, font: defaultFont, fv: 5 };
}
function saveNow(quiet){
  clearTimeout(saveTm);
  try{
    localStorage.setItem(bookKey, JSON.stringify(serialise()));
    if(!quiet) toast('✒  INSCRIBED');
  }catch(e){ toast('COULD NOT SAVE', 2200); }
  if(bookKey === LS_KEY && pages.some(p => p.t)) keepForever();
  if(shelf){ shelf.sync(); if(bookKey === LS_KEY) shelf.keepSoon(); }
}
/* the browser is asked once, after the first writing, not to clear this site's
   storage by itself (Safari otherwise may, after a week without a visit) */
let persistAsked = false;
function keepForever(){
  if(persistAsked) return;
  persistAsked = true;
  try{
    const s = navigator.storage;
    if(s && s.persisted && s.persist) s.persisted().then(on => on || s.persist()).catch(()=>{});
  }catch(e){}
}
/* the book opens on its title page, or, once there is writing in it, on the
   page last written on (failing that, the last page that has any ink) */
let lastWritten = null;
function setLastWritten(v){ lastWritten = v; }
function homePage(){
  let w = lastWritten;
  if(!(w >= 1 && w < 2*N && pages[w].t)){
    w = 0;
    for(let n=2*N-1;n>=1;n--) if(pages[n].t){ w = n; break; }
  }
  return w;
}
function homeSpread(){ return spreadOf(homePage()); }
function saveSoon(quiet){ clearTimeout(saveTm); saveTm = setTimeout(()=>saveNow(quiet), 450); }
function applyData(d){
  pages.forEach(p=>{ p.t=''; p.f=null; p.born=null; p.c=false; p.a=null; });
  if(d && d.pages) Object.entries(d.pages).forEach(([n,v])=>{
    const i = n|0;
    if(i>=0 && i<pages.length && v){
      pages[i].t = String(v.t||'').slice(0, 6000); pages[i].f = FONTS.some(f=>f.id===v.f) ? v.f : null; pages[i].c = !!v.c;
      /* a book from before hands were kept was written in this browser */
      pages[i].a = unpackHands(v.a, d.hands, pages[i].t.length);
    }
  });
  /* books saved under an older default hand move onto Chronicle; a page given
     any of today's other hands on purpose keeps it */
  setDefaultFont('chronicle');
}
function loadAll(){
  let d = null;
  try{ d = JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){}
  if(d){
    applyData(d);
    lastWritten = (d.w|0) >= 1 ? d.w|0 : null;
    st.open = !!d.open;
    st.k = homeSpread();
    return;
  }
  /* the first build stored HTML per page under liber-arcanum.page.N */
  const OLD_FIRST = 'Booke of Shadowes';
  try{
    for(let n=0;n<14;n++){
      const v = localStorage.getItem(`liber-arcanum.page.${n}`);
      if(!v || v.includes(OLD_FIRST)) continue;
      const host = document.createElement('div');
      host.innerHTML = v.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(div|p)>/gi,'\n');
      pages[n].t = (host.textContent || '').replace(/ /g,' ').replace(/\n+$/,'');
    }
  }catch(e){}
}
/* another tab of the same book saved: take its pages, so this tab never
   writes an older copy back over them when it closes */
addEventListener('storage', e=>{
  if(e.key !== bookKey || !e.newValue) return;
  let d = null;
  try{ d = JSON.parse(e.newValue); }catch(err){ return; }
  clearTimeout(saveTm);
  applyData(d);
  lastWritten = (d.w|0) >= 1 ? d.w|0 : null;
  if(writing){
    const n = writing.n, i = Math.min(quill.selectionEnd, pages[n].t.length);
    quill.value = pages[n].t; quill.setSelectionRange(i, i);
    setLastGood({ v: quill.value, a: i, b: i });
  }
  pageCache.forEach((_, n)=>paintPage(n));
});
const fileDate = () => new Date().toISOString().slice(0,10);
function download(name, text, type){
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
}
function exportText(){
  saveNow(true);
  const parts = [];
  pages.forEach((p, n)=>{
    if(n < 1 || !p.t.trim()) return;
    const who = shelf && shelf.shared() ? [...new Set(handsOf(n))].map(h => shelf.name(h)).filter(Boolean) : [];
    parts.push(`Page ${n + 1}${who.length ? ' · ' + who.join(', ') : ''}\n\n${p.t.trim()}`);
  });
  if(!parts.length){ toast('THE BOOK IS STILL EMPTY', 1600); return; }
  download(`liber-arcanum-${fileDate()}.txt`, `Liber Arcanum\n\n\n${parts.join('\n\n\n')}\n`, 'text/plain;charset=utf-8');
  toast('DOWNLOADED', 1800);
}
/* the pages of another book are taken up in place of these */
function useBook(key, hand, booting){
  if(writing) exitWriting();
  saveNow(true);
  clearTimeout(saveTm);
  bookKey = key; HAND = hand; setLastErase(null);
  let d = null;
  try{ d = JSON.parse(localStorage.getItem(key)); }catch(e){}
  applyData(d);
  lastWritten = d && (d.w|0) >= 1 ? d.w|0 : null;
  pageCache.forEach((_, n)=>paintPage(n));
  if(booting || !st.open) st.k = st.open ? homeSpread() : st.k;
  else seekSpread(homeSpread(), { flourish: false });
  refreshUI();
}
/* the private book as it is saved, wherever the reader is now */
function personalData(){
  if(bookKey === LS_KEY) return serialise();
  let d = null;
  try{ d = JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){}
  return d && d.pages ? d : { pages: {}, hands: [BROWSER_HAND] };
}
/* a copy taken into the private book: every letter in it becomes this browser's */
function takePersonal(d){
  const data = { ...d, hands: (Array.isArray(d.hands) ? d.hands : []).map(()=> BROWSER_HAND), open: st.open, k: st.k };
  if(bookKey !== LS_KEY){
    try{ localStorage.setItem(LS_KEY, JSON.stringify(data)); }catch(e){ toast('COULD NOT SAVE', 2200); }
    return;
  }
  if(writing) exitWriting();
  clearTimeout(saveTm);
  applyData(data);
  lastWritten = (data.w|0) >= 1 ? data.w|0 : null;
  pageCache.forEach((_, n)=>paintPage(n));
  if(!st.open) st.k = homeSpread();
  else seekSpread(homeSpread(), { flourish: false });
  saveNow(true);
  refreshUI();
}
/* a file that keeps everything: the letters, whose they are and the hands they are written in */
function saveCopy(personal){
  saveNow(true);
  const d = personal ? personalData() : serialise();
  const book = { pages: d.pages || {}, hands: d.hands || [], w: d.w || null, font: d.font || null, fv: d.fv || 5 };
  const name = personal || !shelf || !shelf.shared() ? 'private-book' : 'shared-book';
  download(`liber-arcanum-${name}-${fileDate()}.json`, JSON.stringify({ liber: 'arcanum', v: 1, book }), 'application/json');
  toast('BACKED UP TO A FILE', 1800);
}
const copyPicker = document.createElement('input');
copyPicker.type = 'file'; copyPicker.accept = '.json,application/json'; copyPicker.hidden = true;
document.body.appendChild(copyPicker);
copyPicker.addEventListener('change', async ()=>{
  const f = copyPicker.files && copyPicker.files[0];
  copyPicker.value = '';
  if(!f) return;
  let d = null;
  try{ d = JSON.parse(await f.text()); }catch(e){}
  const book = d && d.liber === 'arcanum' && d.book && typeof d.book.pages === 'object' ? d.book : null;
  if(!book){ toast('THIS IS NOT A BACKUP OF THE BOOK', 2400); return; }
  const now = personalPages().length;
  if(now && shelf){
    const yes = await shelf.ask({
      title: 'RESTORE FROM A FILE',
      text: `It replaces your private book, ${now} written ${now === 1 ? 'page' : 'pages'}`,
      yes: 'Replace my private book', no: 'Cancel',
      extra: { label: 'Back it up first', fn: ()=> saveCopy(true) },
    });
    if(!yes) return;
  }
  if(shelf && shelf.shared()) shelf.personal();
  takePersonal(book);
  toast('THE BACKUP IS YOUR PRIVATE BOOK NOW', 2400);
});
/* the pages written in this browser's own book, wherever the reader is now */
function personalPages(){
  let list = pages.map((p, n)=>({ n, t: p.t, a: bookKey === LS_KEY ? handsOf(n) : null, f: p.f, c: p.c }));
  if(bookKey !== LS_KEY){
    let d = null;
    try{ d = JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){}
    list = Object.entries((d && d.pages) || {}).map(([n, v])=>{
      const t = String(v.t || '');
      return { n: n|0, t, a: unpackHands(v.a, d.hands, t.length) || Array(t.length).fill(BROWSER_HAND), f: v.f || null, c: !!v.c };
    });
  }
  return list.filter(p => p.n >= 1 && p.n < 2*N && p.t);
}
/* letters that came from another hand over the network burn in where they land */
function applyPage(n, t, a, f, c, quiet){
  if(composing && writing && writing.n === n) return false;
  const pg = pages[n], now = performance.now(), sp = editSpan(pg.t, t), ob = pg.born || [];
  const step = Math.min(14, 900/Math.max(1, sp.ins));
  pg.born = quiet ? null : Array.from({length: sp.at}, (_, i)=> ob[i] || 0)
    .concat(Array.from({length: sp.ins}, (_, i)=> now + i*step), Array.from({length: t.length - sp.at - sp.ins}, (_, i)=> ob[sp.at + sp.del + i] || 0));
  pg.t = t; pg.a = a.slice(); pg.f = FONTS.some(x => x.id === f) ? f : pg.f; pg.c = !!c && !!t;
  if(writing && writing.n === n){
    let i = quill.selectionEnd;
    if(i >= sp.at + sp.del) i += sp.ins - sp.del; else if(i > sp.at) i = sp.at;
    i = clamp(i, 0, t.length);
    quill.value = t; quill.setSelectionRange(i, i);
    setLastGood({ v: t, a: i, b: i });
  }
  if(pageCache.has(n)){ if(!quiet) burning.add(n); paintPage(n, now); }
  saveSoon(true);
  return true;
}
function exportFile(){
  saveNow(true);
  const data = { format:'liber-arcanum', version:2, savedAt:new Date().toISOString(), ...serialise() };
  download(`liber-arcanum-${fileDate()}.json`, JSON.stringify(data, null, 2), 'application/json');
  toast('BACKUP DOWNLOADED', 1800);
}

export {
  applyPage, booted, BROWSER_HAND, copyPicker, exportFile, exportText, HAND, handsOf,
  homePage, homeSpread, lastWritten, loadAll, personalData, personalPages, saveCopy,
  saveNow, saveSoon, setBooted, setLastWritten, setShelf, shelf, takePersonal, useBook
};
