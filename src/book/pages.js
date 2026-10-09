import * as THREE from 'three';
import { cv, tex } from '../lib/textures.js';
import { fontById, HI_RES, N, PAGE_H, PAGE_W } from '../core/config.js';
import { pageBackground, pageMaterial } from './print.js';
import { caretXY, layoutText, textBox } from '../ink/layout.js';
import { caretBreath, drawGlow, drawInkBase, drawInkOverlay, drawVapor } from '../ink/paint.js';
import { burning, quill, writing } from '../ink/writing.js';

const pages = Array.from({length:N*2}, ()=>({ t:'', f:null, born:null }));
let defaultFont = 'chronicle';
function setDefaultFont(v){ defaultFont = v; }
const pageFont = n => fontById(pages[n].f || defaultFont);


const pageCache = new Map();
const CACHE_MAX = HI_RES ? 12 : 8;
function pageEntry(n){
  let e = pageCache.get(n);
  if(!e){
    const canvas = cv(PAGE_W, PAGE_H);
    const glow = cv(PAGE_W/2, PAGE_H/2);
    const mat = pageMaterial(canvas);
    const glowTex = tex(glow, {srgb:true, wrap:false});
    mat.emissive = new THREE.Color(0xffffff);
    mat.emissiveMap = glowTex;
    mat.emissiveIntensity = 0;
    e = { bg: pageBackground(n), canvas, glow, tex: mat.map, glowTex, mat, used: 0, lay: null, glowing: false };
    pageCache.set(n, e);
    paintPage(n);
  }
  e.used = performance.now();
  return e;
}
const lent = new WeakSet();
function lend(c){ lent.add(c); return c; }
function freeCanvas(c){ if(c && !lent.has(c)) c.width = c.height = 0; }
function trimCache(keep){
  if(pageCache.size <= CACHE_MAX) return;
  const list = [...pageCache.entries()].filter(([n])=>!keep.has(n)).sort((a,b)=>a[1].used-b[1].used);
  while(pageCache.size > CACHE_MAX && list.length){
    const [n, e] = list.shift();
    e.tex.dispose(); e.glowTex.dispose(); e.mat.dispose();
    [e.canvas, e.glow, e.bg, e.inked].forEach(freeCanvas);
    pageCache.delete(n);
  }
}
function unborn(pg, now){
  const b = pg.born, L = Math.min(pg.t.length, b ? b.length : 0);
  let a = -1, z = -1;
  for(let i=0;i<L;i++) if(b[i] > now){ if(a < 0) a = i; z = i; }
  return a < 0 ? null : { a, b: z + 1 };
}
function paintPage(n, now){
  const e = pageCache.get(n);
  if(!e) return;
  now = now || performance.now();
  if(!e.bg) e.bg = pageBackground(n);
  if(!e.canvas.width){ e.canvas.width = PAGE_W; e.canvas.height = PAGE_H; e.glow.width = PAGE_W/2; e.glow.height = PAGE_H/2; }
  const ctx = e.canvas.getContext('2d');
  const editing = writing && writing.n === n;
  const hide = unborn(pages[n], now);
  if(hide) burning.add(n);
  const tkey = pages[n].t + '\u0001' + pageFont(n).id + (pages[n].c ? '\u0001c' : ''), key = tkey + (hide ? '\u0001' + hide.a + ',' + hide.b : '');
  if(e.inkKey !== key || !e.inked){
    if(!e.inked) e.inked = cv(PAGE_W, PAGE_H);
    const ic = e.inked.getContext('2d');
    ic.drawImage(e.bg, 0, 0);
    if(e.layKey !== tkey || !e.lay){ e.lay = layoutText(pages[n].t, pageFont(n), textBox(n)); e.layKey = tkey; }
    drawInkBase(ic, pages[n].t, e.lay, hide);
    e.inkKey = key;
  }
  const lay = e.lay;
  ctx.drawImage(e.inked, 0, 0);
  let sel = null, caret = null;
  if(editing){
    const a = quill.selectionStart, b = quill.selectionEnd;
    sel = { a:Math.min(a,b), b:Math.max(a,b), caret: a === b };
    if(a === b){ sel.b = a; caret = caretXY(lay, a); }
  }
  const breath = editing ? caretBreath() : 1;
  const burns = drawInkOverlay(ctx, pages[n].t, lay, sel, pages[n].born, now, e.bg, breath);
  if(pages[n].vapor && pages[n].vapor.length) burns.push(...drawVapor(ctx, n, now));
  e.tex.needsUpdate = true;
  let lit = drawGlow(e.glow.getContext('2d'), lay, burns, caret, breath);
  if(lit || e.glowing){
    e.glowTex.needsUpdate = true;
    e.mat.emissiveIntensity = lit ? 1.4 : 0;
  }
  e.glowing = lit;
  if(!editing && !burning.has(n) && !e.live){ freeCanvas(e.inked); e.inked = null; e.inkKey = null; }
}
function relayPage(n){
  const e = pageCache.get(n);
  if(!e) return;
  e.layKey = null; e.inkKey = null;
  paintPage(n);
}
/* a font arrived: lay the ink out again and redraw the printed page numbers and title; the opening keeps its own title */
function freshPages(){
  pageCache.forEach((e, n)=>{
    if(!e.live && !lent.has(e.bg)){ freeCanvas(e.bg); e.bg = null; }
    relayPage(n);
  });
}

export {
  defaultFont, freeCanvas, freshPages, lend, pageCache, pageEntry, pageFont, pages, paintPage,
  relayPage, setDefaultFont, trimCache
};
