/* spells: ink that runs on to the next page, pages wiped clean and the ink called back */
import * as THREE from 'three';
import { lerp } from '../lib/textures.js';
import { easeSine } from '../core/easing.js';
import { MOD, N, PAGE_H, PAGE_W, SC } from '../core/config.js';
import { scene } from '../scene/renderer.js';
import { layoutText, textBox } from './layout.js';
import { addVapor } from './paint.js';
import { defaultFont, pageCache, pageEntry, pageFont, pages, paintPage } from '../book/pages.js';
import { pagePointWorld } from '../book/leaves.js';
import { st } from '../book/state.js';
import { handsOf, lastWritten, saveSoon } from './storage.js';
import { toast } from '../ui/toast.js';
import { burning, enterWriting, quill, readOnly, setBlinkPhase, setLastGood, writing } from './writing.js';
import { sparkMat } from '../fx/ink-fx.js';
import { sfx } from '../audio/sound.js';
import { burstMat, particlePool } from '../fx/magic.js';
import { seekSpread } from '../book/seek.js';


function spreadOf(n){ return n <= 0 ? 0 : (n % 2 ? (n + 1)/2 : n/2); }
const seek = { goal: null, resume: null, keepQuill: false, flourish: true };
let lastErase = null;
function setLastErase(v){ lastErase = v; }

/* golden wisps carrying the words over to the next page */
const WISPS = 96;
const wispGeo = new THREE.BufferGeometry();
const wispPos = new Float32Array(WISPS*3), wispAlpha = new Float32Array(WISPS);
const wispPath = new Float32Array(WISPS*9), wispT = new Float32Array(WISPS), wispDur = new Float32Array(WISPS).fill(1), wispLive = new Uint8Array(WISPS);
wispGeo.setAttribute('position', new THREE.BufferAttribute(wispPos, 3));
wispGeo.setAttribute('alpha', new THREE.BufferAttribute(wispAlpha, 1));
const wispMat = sparkMat.clone();
wispMat.uniforms.uScale = { get value(){ return burstMat.uniforms.uScale.value*4.5; }, set value(v){} };
wispMat.fragmentShader = `varying float vA;
  void main(){ float d = length(gl_PointCoord - 0.5); float core = pow(smoothstep(0.22, 0.0, d), 1.5), halo = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vec3(1.0, 0.8, 0.45)*(2.6*core + 0.45*halo*halo)*vA, 1.0); }`;
const wisps = new THREE.Points(wispGeo, wispMat);
wisps.frustumCulled = false;
scene.add(wisps);
const trail = particlePool(320, burstMat);
let wispNext = 0, wispsLive = 0;
const _wa = new THREE.Vector3(), _wb = new THREE.Vector3(), _wn = new THREE.Vector3();
function emitWisps(fromN, toN, count){
  const bf = textBox(fromN), bt = toN === null ? null : textBox(toN);
  for(let i=0;i<count;i++){
    const a = pagePointWorld(fromN, lerp(bf.x, bf.x + bf.w, Math.random()), bf.bottom - Math.random()*36*SC);
    _wa.copy(a.p); _wn.copy(a.n);
    if(bt) _wb.copy(pagePointWorld(toN, lerp(bt.x, bt.x + bt.w*0.7, Math.random()), bt.y + Math.random()*28*SC).p);
    else{
      const c = pagePointWorld(fromN, fromN % 2 ? 0 : PAGE_W, PAGE_H*(0.82 + Math.random()*0.16));
      _wb.copy(c.p).addScaledVector(c.n, 0.25);
    }
    const s = wispNext; wispNext = (wispNext + 1) % WISPS;
    const P = wispPath, o = s*9, up = 0.7 + Math.random()*0.6;
    P[o] = _wa.x; P[o+1] = _wa.y; P[o+2] = _wa.z;
    P[o+3] = (_wa.x + _wb.x)/2 + _wn.x*up + (Math.random() - 0.5)*0.5;
    P[o+4] = (_wa.y + _wb.y)/2 + _wn.y*up + 0.35;
    P[o+5] = (_wa.z + _wb.z)/2 + _wn.z*up + (Math.random() - 0.5)*0.5;
    P[o+6] = _wb.x; P[o+7] = _wb.y; P[o+8] = _wb.z;
    wispT[s] = -i*0.011; wispDur[s] = 0.55 + Math.random()*0.25; wispLive[s] = 1;
  }
  wispsLive = 1;
}
function stepWisps(dt){
  trail.step(dt, 1.4, 0.06);
  if(!wispsLive) return;
  let any = 0;
  for(let s=0;s<WISPS;s++){
    if(!wispLive[s]){ wispAlpha[s] = 0; continue; }
    any = 1;
    wispT[s] += dt;
    const k = wispT[s]/wispDur[s];
    if(k < 0){ wispAlpha[s] = 0; continue; }
    if(k >= 1){ wispLive[s] = 0; wispAlpha[s] = 0; continue; }
    const e = easeSine(k), u = 1 - e, o = s*9, P = wispPath;
    for(let c=0;c<3;c++) wispPos[s*3+c] = u*u*P[o+c] + 2*u*e*P[o+3+c] + e*e*P[o+6+c];
    wispPos[s*3+1] += Math.sin(k*8 + s)*0.025;
    wispAlpha[s] = Math.sin(Math.PI*k)*0.9;
    if(Math.random() < dt*9) trail.emit(wispPos[s*3], wispPos[s*3+1], wispPos[s*3+2], (Math.random() - 0.5)*0.08, 0.04, (Math.random() - 0.5)*0.08, 0.45 + Math.random()*0.35, 0.35);
  }
  wispsLive = any;
  wispGeo.attributes.position.needsUpdate = true;
  wispGeo.attributes.alpha.needsUpdate = true;
}

/* ---------------- a full page runs on to the next ---------------- */
/* the lines that no longer fit go over to the next page, pushing what is
   there along, page after page; null when even the last page is full */
function pour(n, v, caret, hv){
  const out = new Map(), hout = new Map(), moves = [];
  let page = n, text = v, hands = hv, cp = n, ci = caret, inc = null;
  const joinSep = (a, b) => a && b && !/\s$/.test(a) && !/^\s/.test(b) ? ' ' : '';
  for(;;){
    const lay = layoutText(text, pageFont(page), page === n ? textBox(page) : { ...textBox(page), flow: true });
    if(lay.ok){ out.set(page, text); hout.set(page, hands); break; }
    const bad = lay.lines.findIndex(ln => ln.y + lay.size*0.3 > lay.box.bottom);
    const cut = lay.lines[bad].start;
    const m = page + 1;
    if(cut <= 0 || m >= 2*N) return null;
    let keep = text.slice(0, cut), kh = hands.slice(0, cut);
    if(keep.endsWith('\n')){ keep = keep.slice(0, -1); kh = kh.slice(0, -1); }
    const moved = text.slice(cut), nextT = pages[m].t;
    const sep = joinSep(moved, nextT);
    out.set(page, keep); hout.set(page, kh);
    if(cp === page){
      if(ci >= cut){ cp = m; ci -= cut; }
      else ci = Math.min(ci, keep.length);
    }
    moves.push({ from: page, to: m, count: moved.length + sep.length });
    inc = { t: moved, h: hands.slice(cut) };
    hands = inc.h.concat(sep ? [inc.h[inc.h.length - 1]] : [], handsOf(m));
    page = m; text = moved + sep + nextT;
  }
  return { out, hout, moves, cp, ci };
}
/* the words arriving on a page write themselves in, one after another */
function applyPour(n, res){
  const now = performance.now();
  const f = pages[n].f || defaultFont;
  res.out.forEach((T, p)=>{
    const pg = pages[p];
    let born;
    if(p === n) born = (pg.born || []).slice(0, T.length);
    else{
      const mv = res.moves.find(m => m.to === p), old = pg.born || [];
      born = Array.from({length: mv.count}, (_, i)=> now + 260 + Math.min(i*11, 480))
        .concat(Array.from({length: pg.t.length}, (_, i)=> old[i] || 0)).slice(0, T.length);
      if(!pg.f) pg.f = f;
      pg.c = true;
    }
    pg.t = T; pg.a = res.hout.get(p); pg.born = born;
    if(pageCache.has(p)){ burning.add(p); paintPage(p, now); }
  });
  if(!pages[n].f) pages[n].f = defaultFont;
  res.moves.forEach(mv=>{
    if(spreadOf(mv.from) !== st.k) return;
    const same = spreadOf(mv.to) === st.k;
    emitWisps(mv.from, same ? mv.to : null, same ? 44 : 26);
  });
  sfx.flow();
  if(res.cp !== n) quillTo(res.cp, res.ci);
  else{
    quill.value = pages[n].t;
    quill.setSelectionRange(res.ci, res.ci);
    setLastGood({ v: quill.value, a: res.ci, b: res.ci });
    setBlinkPhase(0);
    paintPage(n);
  }
  saveSoon(true);
}
/* the quill moves to page m; on another spread the leaves turn under it */
function quillTo(m, idx){
  if(m < 1 || m >= 2*N) return false;
  if(idx === undefined) idx = pages[m].t.length;
  enterWriting(m, idx);
  st.focusSide = m % 2 ? -1 : 1; st.focusTo = 1;
  const k = spreadOf(m);
  if(k !== st.k || st.flight) seekSpread(k, { keepQuill: true, flourish: false });
  return true;
}

/* ---------------- a page wiped clean, and the ink called back ---------------- */
/* the whole page goes, whoever wrote it; in a shared book the page is kept
   in its history first, so any keeper can bring it back later */
function erasePages(list){
  if(readOnly()){ toast('YOU CAN ONLY READ THIS BOOK', 2200); return; }
  const now = performance.now(), gone = [];
  list.forEach(n=>{
    if(n < 1 || n >= 2*N || !pages[n].t) return;
    const pg = pages[n], hands = handsOf(n);
    const e = pageEntry(n);
    burning.add(n);
    paintPage(n, now);
    addVapor(n, pg.t, e.lay, 0, pg.t.length, Math.min(0.07, 0.9/Math.max(1, e.lay.lines.length)));
    gone.push({ n, t: pg.t, a: hands.slice(), f: pg.f, c: pg.c, left: '' });
    pg.t = ''; pg.a = []; pg.born = null; pg.c = false;
    if(writing && writing.n === n){
      quill.value = ''; quill.setSelectionRange(0, 0);
      setLastGood({ v: '', a: 0, b: 0 });
    }
    paintPage(n, now);
  });
  if(!gone.length){ toast('NOTHING TO ERASE', 1800); return; }
  lastErase = { pages: gone, at: now };
  sfx.erase();
  saveSoon(true);
  toast(`ERASED · ${MOD}Z BRINGS IT BACK`, 2800);
}
/* the ink comes back and writes itself in, letter by letter */
function restoreErased(){
  if(readOnly()) return false;
  if(!lastErase || performance.now() - lastErase.at > 60000) return false;
  const back = lastErase.pages.filter(p => pages[p.n].t === p.left);
  lastErase = null;
  if(!back.length) return false;
  const now = performance.now();
  back.forEach(p=>{
    const pg = pages[p.n];
    const step = Math.min(14, 1500/Math.max(1, p.t.length));
    pg.t = p.t; pg.a = p.a; pg.f = p.f; pg.c = p.c; pg.vapor = null;
    let j = 0;
    pg.born = p.a.map(()=> now + 120 + (j++)*step);
    if(writing && writing.n === p.n){
      quill.value = pg.t; quill.setSelectionRange(pg.t.length, pg.t.length);
      setLastGood({ v: pg.t, a: pg.t.length, b: pg.t.length });
    }
    if(pageCache.has(p.n)){ burning.add(p.n); paintPage(p.n, now); }
  });
  sfx.shimmer();
  saveSoon(true);
  toast('THE INK RETURNS', 1600);
  return true;
}
/* one page at a time, never the whole book: the page under the quill, else
   the one page of the open spread that has writing on it */
function eraseTargets(){
  if(writing) return [writing.n];
  if(!st.open) return [];
  return [2*st.k - 1, 2*st.k].filter(n => n >= 1 && n < 2*N && pages[n].t);
}
function eraseHere(){
  if(!writing && !st.open){ toast('OPEN THE BOOK FIRST', 1400); return; }
  const list = eraseTargets();
  if(list.length === 2){
    if(list.includes(lastWritten)) return erasePages([lastWritten]);
    toast('CHOOSE THE PAGE IN THE ⋯ MENU', 2000);
    return;
  }
  erasePages(list);
}

export {
  applyPour, eraseHere, erasePages, eraseTargets, lastErase, pour, quillTo,
  restoreErased, seek, setLastErase, spreadOf, stepWisps, trail
};
