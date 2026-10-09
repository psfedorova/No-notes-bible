import * as THREE from 'three';
import { clamp, lerp, smooth } from '../lib/textures.js';
import { glideFrom } from '../core/easing.js';
import { CVR, CW, N, OPEN, PAGE_H, PAGE_W, PH, PW, VH, VW } from '../core/config.js';
import { camera, canvasEl } from '../scene/renderer.js';
import { bookRoot, spinGrp } from '../scene/rig.js';
import { indexAt, layoutText, textBox } from '../ink/layout.js';
import { pageEntry, pageFont, pages, paintPage } from '../book/pages.js';
import { frontGrp } from '../book/boards.js';
import { backGrp } from '../book/sapphire.js';
import { spineMesh } from '../book/spine.js';
import { flightAngleFn, hingeOf, layoutCtx, leaves, restParams } from '../book/leaves.js';
import { _H, invalidateLayout, st } from '../book/state.js';
import { angVel, atHome, camGoal, camTarget, glideSpin, homeQuat, inertia, onePage, orbit, pagePerPx, pageScroll, pageStep, pan, qOpenHome, resetPan, rotateBy, setClosedHome, setInertia, setPageScroll, setSpinAnim, shownPage, spinAnim, spinGoal, stepPage } from '../book/view.js';
import { homePage, homeSpread } from '../ink/storage.js';
import { enterWriting, exitWriting, onSel, quill, writing } from '../ink/writing.js';
import { sfx } from '../audio/sound.js';
import { coverAnim, flip, setCoverAnim, setOpen, setResumeWriting } from '../book/turning.js';
import { spreadOf } from '../ink/spells.js';
import { refreshUI } from '../ui/controls.js';
import { settled } from '../film/opening.js';

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pickables(){
  const list = [];
  const c = st.k;
  if(st.riffle){}
  else if(!st.flight){
    if(c > 0) list.push(leaves[c-1].mesh);
    if(c < N) list.push(leaves[c].mesh);
  }else list.push(leaves[st.flight.j].mesh);
  list.forEach(m=>{ const L = leaves[m.userData.leaf]; if(L.bsDirty){ L.geo.computeBoundingSphere(); L.bsDirty = false; } });
  frontGrp.traverse(o=>{ if(o.isMesh && !o.userData.noPick) list.push(o); });
  backGrp.traverse(o=>{ if(o.isMesh && !o.userData.noPick) list.push(o); });
  list.push(spineMesh);
  return list;
}
function pickAt(cx, cy){
  ndc.set((cx/VW)*2-1, -(cy/VH)*2+1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(pickables(), false);
  if(!hits.length) return null;
  let h = hits[0];
  const o = h.object, ud = o.userData;
  if(ud.grab === 'leaf'){
    const open = st.open && Math.abs(st.theta-OPEN) < 1e-3 && !st.flight && !st.riffle;
    if(open){
      const isTop = x => x.object.userData.grab === 'leaf' && x.face &&
        ((x.object.userData.leaf === st.k && x.face.materialIndex === 0) || (x.object.userData.leaf === st.k-1 && x.face.materialIndex === 1));
      const top = hits.find(x => x.distance < h.distance + 0.25 && isTop(x));
      if(top) h = top;
      else{
        const right = ud.leaf >= st.k, j = right ? st.k : st.k-1;
        if(j >= 0 && j < N) return { type:'page', n: right ? 2*j : 2*j+1, leaf:j, side: right ? 'right' : 'left', uv:{ x: right ? 1 : 0, y: h.uv ? h.uv.y : 0.5 }, s: leaves[j].len, y: h.uv ? h.uv.y : 0.5 };
      }
    }
    const i = h.object.userData.leaf, mi = h.face ? h.face.materialIndex : 2;
    const L = leaves[i];
    if(open && mi === 0 && i === st.k) return { type:'page', n:2*i, leaf:i, side:'right', uv:h.uv, s: h.uv.x*L.len, y: h.uv.y };
    if(open && mi === 1 && i === st.k-1) return { type:'page', n:2*i+1, leaf:i, side:'left', uv:h.uv, s:(1-h.uv.x)*L.len, y: h.uv.y };
    return { type:'book', point: h.point };
  }
  if(ud.grab === 'front'){
    const lp = frontGrp.worldToLocal(h.point.clone());
    return { type:'front', local: lp, outer: lp.x > CW*0.42, inner: lp.z < CVR*0.5 };
  }
  return { type:'book', board: true, point: h.point };
}
function pageOfBook(h){
  if(!h || h.type !== 'book' || !h.point || !st.open || Math.abs(st.theta - OPEN) > 1e-3 || st.flight || st.riffle) return null;
  const lp = bookRoot.worldToLocal(h.point.clone()), right = lp.x > 0, j = right ? st.k : st.k - 1;
  if(j < 0 || j >= N) return null;
  const y = clamp(lp.y/PH + 0.5, 0, 1);
  return { type:'page', n: right ? 2*j : 2*j + 1, leaf: j, side: right ? 'right' : 'left', uv: { x: right ? 1 : 0, y }, s: leaves[j].len, y };
}
function toScreen(v){ const p = v.clone().project(camera); return { x:(p.x*0.5+0.5)*VW, y:(-p.y*0.5+0.5)*VH }; }

const _tmpV = new THREE.Vector3();
function flightPointAt(fl, p, sG, yN){
  const C = layoutCtx(fl.j + p, st.theta);
  hingeOf(C, fl.j, _H);
  const PR = restParams(C, fl.j, false, _H), PL = restParams(C, fl.j, true, _H);
  const angleAt = flightAngleFn(PR, PL, { p, lead: fl.lead, lag: fl.lag, gy: fl.gy, sagK: fl.sagK }, yN);
  let x = _H.x, z = _H.z;
  const steps = Math.max(1, Math.round(sG/leaves[fl.j].ds));
  const ds = sG/steps;
  for(let m=0;m<steps;m++){ const a = angleAt((m+0.5)*ds); x += Math.cos(a)*ds; z += Math.sin(a)*ds; }
  _tmpV.set(x, yN*PH/2, z);
  return bookRoot.localToWorld(_tmpV);
}
function solveDragP(fl, px, py, prev){
  const f = p=>{ const s = toScreen(flightPointAt(fl, p, fl.sG, fl.yN)), b = (p - prev)*140; return (s.x-px)*(s.x-px) + (s.y-py)*(s.y-py) + b*b; };
  let best = 0, bd = Infinity;
  const NS = 40;
  for(let i=0;i<=NS;i++){ const p = i/NS, d = f(p); if(d < bd){ bd = d; best = p; } }
  let lo = Math.max(0, best - 1/NS), hi = Math.min(1, best + 1/NS);
  for(let it=0; it<14; it++){
    const m1 = lo + (hi-lo)/3, m2 = hi - (hi-lo)/3;
    if(f(m1) < f(m2)) hi = m2; else lo = m1;
  }
  return (lo+hi)/2;
}
function coverPointAt(theta, local){
  const C = layoutCtx(st.k, theta);
  const x = C.ex + C.dx*local.x - C.nx*local.z, z = C.ez + C.dz*local.x - C.nz*local.z;
  _tmpV.set(x, local.y, z);
  return bookRoot.localToWorld(_tmpV);
}
function solveCoverTheta(local, px, py, prev){
  const f = t=>{ const s = toScreen(coverPointAt(t, local)), b = (t - prev)*45; return (s.x-px)*(s.x-px)+(s.y-py)*(s.y-py) + b*b; };
  let best = 0, bd = Infinity;
  const NS = 40;
  for(let i=0;i<=NS;i++){ const t = i/NS*OPEN, d = f(t); if(d < bd){ bd = d; best = t; } }
  let lo = Math.max(0, best - OPEN/NS), hi = Math.min(OPEN, best + OPEN/NS);
  for(let it=0; it<14; it++){
    const m1 = lo + (hi-lo)/3, m2 = hi - (hi-lo)/3;
    if(f(m1) < f(m2)) hi = m2; else lo = m1;
  }
  return (lo+hi)/2;
}

const THRESH = { mouse:6, pen:10, touch:14 };
const FAR_ZOOM = 1.25, ZMIN = 0.15, MAG_MIN = 0.5;
function anchorAt(x, y){
  ndc.set((x/VW)*2-1, -(y/VH)*2+1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(pickables(), false)[0];
  return hit ? hit.point.clone() : camTarget.clone();
}
const vcam = new THREE.PerspectiveCamera();
function grip(x, y, k){
  const w = new THREE.Vector3().subVectors(camera.position, camTarget).normalize();
  return { a: anchorAt(x, y), w, k, D: st.camDTo || st.camD, c: camGoal.clone(), lift: st.camLift || 0, bx: camGoal.x - pan.x, bz: camGoal.z - pan.z };
}
function holdAt(G, x, y, s){
  const D = G.D*s;
  vcam.copy(camera);
  vcam.position.copy(G.c).addScaledVector(G.w, D);
  vcam.lookAt(G.c.x, G.c.y + G.lift*Math.min(1, G.k*s), G.c.z);
  vcam.updateMatrixWorld();
  ndc.set((x/VW)*2-1, -(y/VH)*2+1);
  ray.setFromCamera(ndc, vcam);
  const r = ray.ray.direction;
  if(Math.abs(r.y) < 0.02) return;
  const t = (G.a.y - G.w.y*D - G.c.y)/r.y;
  if(t <= 0) return;
  pan.x = G.a.x - G.w.x*D - r.x*t - G.bx;
  pan.z = G.a.z - G.w.z*D - r.z*t - G.bz;
}
const magnified = () => st.open && st.focusTo > 0.5 && st.mag < 0.97;
const pointers = new Map();
let g = null;
let pinch = null;

canvasEl.addEventListener('contextmenu', e=>e.preventDefault());
canvasEl.addEventListener('mousedown', e=>{ if(writing) e.preventDefault(); });
['pointerdown', 'keydown'].forEach(t=>addEventListener(t, ()=>{ sfx.wake(); Promise.resolve(settled && settled.p).then(()=> sfx.ambience()); }, { once:true, capture:true }));
canvasEl.addEventListener('pointerdown', e=>{
  try{ canvasEl.setPointerCapture(e.pointerId); }catch(_){}
  pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
  if(pointers.size === 2){
    drop();
    const [[ia, a], [ib, b]] = pointers;
    const mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
    pan.coast = false; orbit.coast = false; orbit.vx = orbit.vy = 0;
    pinch = { ia, ib, d: Math.max(20, Math.hypot(a.x-b.x, a.y-b.y)), z: st.zoom, m: st.mag, mx, my, sx: mx, sy: my, ang: Math.atan2(b.y-a.y, b.x-a.x), tw: 0, twist: false,
              G: null, read: onePage() && st.open && st.focusTo > 0.5 };
    pinch.G = grip(mx, my, pinch.read ? st.mag : st.zoom);
    return;
  }
  if(pointers.size > 2) return;
  drop();
  setInertia(false); angVel.x = angVel.y = 0;
  orbit.coast = false; orbit.vx = orbit.vy = 0;
  pan.coast = false; pan.vx = pan.vz = 0;
  const cut = spinAnim && { left: spinAnim.dur - spinAnim.t, settle: spinAnim.settle };
  if(spinAnim){ setSpinAnim(null); spinGoal.copy(spinGrp.quaternion); }
  const hit = e.button === 2 ? null : pickAt(e.clientX, e.clientY) || (e.pointerType === 'touch' && !st.open ? pickNear(e.clientX, e.clientY) : null);
  g = { id:e.pointerId, cut, sx:e.clientX, sy:e.clientY, px:e.clientX, py:e.clientY, t:performance.now(),
        moved:0, hit, mode:'pending', force: e.button === 2 || e.button === 1, q0: spinGoal.clone(), o0: [orbit.azTo, orbit.elTo],
        slop: THRESH[e.pointerType] || THRESH.mouse, pan: e.pointerType === 'touch' && magnified(), far: e.pointerType === 'touch' && st.open && st.focusTo < 0.5 && (st.zoom > FAR_ZOOM || Math.abs(orbit.azTo) > 0.35) };
  const now = performance.now(), again = now - downs.t < 450 && Math.hypot(e.clientX - downs.x, e.clientY - downs.y) < 8;
  downs.n = again ? downs.n + 1 : 1; downs.t = now; downs.x = e.clientX; downs.y = e.clientY;
  const at = e.pointerType !== 'touch' && !g.force && hit && hit.s < PW*0.95 ? textAt(hit) : null;
  if(at === null) return;
  if(e.shiftKey){
    const a = quill.selectionDirection === 'backward' ? quill.selectionEnd : quill.selectionStart;
    g.mode = 'select'; g.anchor = a; select(a, at);
  }else if(downs.n >= 2){
    const [a, b] = downs.n === 2 ? wordAround(quill.value, at) : paragraphAround(quill.value, at);
    g.mode = 'select'; g.anchor = a; select(a, b);
  }else if(overText(hit)) g.anchor = at;
});
function drop(){
  const gg = g;
  if(!gg) return;
  g = null; rotating = false;
  document.body.classList.remove('grabbing');
  if(gg.mode === 'turn') endTurn(true);
  else if(gg.mode === 'cover') endCover(true);
}
function rebase(){
  const [[ia, a], [ib, b]] = pointers;
  const mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
  pinch.sx += mx - pinch.mx; pinch.sy += my - pinch.my;
  Object.assign(pinch, { ia, ib, d: Math.max(20, Math.hypot(a.x-b.x, a.y-b.y)), z: st.zoom, m: st.mag, mx, my, ang: Math.atan2(b.y-a.y, b.x-a.x) });
  pinch.G = pinch.G && grip(mx, my, pinch.read ? st.mag : st.zoom);
}
function pickNear(x, y){
  for(const r of [10, 22]) for(let k=0;k<8;k++){
    const h = pickAt(x + Math.cos(k*Math.PI/4)*r, y + Math.sin(k*Math.PI/4)*r);
    if(h) return h;
  }
  return null;
}
function overText(h){
  const lay = pageEntry(h.n).lay;
  if(!lay) return false;
  const x = h.uv.x*PAGE_W, y = (1-h.uv.y)*PAGE_H, pad = lay.size*0.6;
  return lay.lines.some(ln => ln.end > ln.start && y > ln.y - lay.size*1.05 && y < ln.y + lay.size*0.4
    && x > Math.min(ln.xs[0], ln.xs[ln.xs.length - 1]) - pad && x < Math.max(ln.xs[0], ln.xs[ln.xs.length - 1]) + pad);
}
const downs = { t: 0, x: 0, y: 0, n: 0 };
function textAt(h){
  if(!h || h.type !== 'page' || !writing || h.n !== writing.n) return null;
  const en = pageEntry(h.n);
  if(!en.lay) paintPage(h.n);
  return en.lay ? indexAt(en.lay, h.uv.x*PAGE_W, (1-h.uv.y)*PAGE_H) : null;
}
function select(a, b){
  quill.focus({ preventScroll:true });
  quill.setSelectionRange(Math.min(a, b), Math.max(a, b), b < a ? 'backward' : 'forward');
  onSel();
}
const WORD = /[\p{L}\p{N}'’-]/u;
function wordAround(t, i){
  let a = i, b = i;
  if(!WORD.test(t[a] || '') && a > 0 && WORD.test(t[a-1])) a = b = i - 1;
  while(a > 0 && WORD.test(t[a-1])) a--;
  while(b < t.length && WORD.test(t[b])) b++;
  return [a, Math.max(a, b)];
}
function paragraphAround(t, i){
  const a = t.lastIndexOf('\n', i - 1) + 1, nl = t.indexOf('\n', i);
  return [a, nl < 0 ? t.length : nl];
}
canvasEl.addEventListener('pointermove', e=>{
  const pp = pointers.get(e.pointerId);
  if(pp){ pp.x = e.clientX; pp.y = e.clientY; }
  if(pinch && pointers.size >= 2){
    if(e.pointerId !== pinch.ia && e.pointerId !== pinch.ib) return;
    const a = pointers.get(pinch.ia), b = pointers.get(pinch.ib);
    const d = Math.max(20, Math.hypot(a.x-b.x, a.y-b.y)), mx = (a.x+b.x)/2, my = (a.y+b.y)/2, k = 0.0052;
    const ang = Math.atan2(b.y-a.y, b.x-a.x), da = Math.atan2(Math.sin(ang - pinch.ang), Math.cos(ang - pinch.ang));
    pinch.ang = ang; pinch.tw += da;
    if(!pinch.twist && Math.abs(pinch.tw) > 0.22) pinch.twist = true;
    if(pinch.read){
      const m = pinch.m*pinch.d/d;
      if(m > 1.08 || pinch.twist || (st.mag > 0.97 && m > 0.97 && Math.hypot(mx - pinch.sx, my - pinch.sy) >= 24)){
        pinch.read = false; resetPan(); lookAway();
        pinch.d = d; pinch.z = st.zoom = 1; pinch.mx = mx; pinch.my = my; pinch.G = null;
        return;
      }
      const to = clamp(m, MAG_MIN, 1);
      if(to < 0.97 && writing) exitWriting();
      st.mag = to;
      holdAt(pinch.G, mx, my, to/pinch.G.k);
      pinch.mx = mx; pinch.my = my;
      return;
    }
    st.zoom = clamp(pinch.z*pinch.d/d, ZMIN, 3.2);
    lookAway();
    if(st.zoom < 0.9 && !pinch.twist){
      if(!pinch.G) pinch.G = grip(mx, my, st.zoom);
      holdAt(pinch.G, mx, my, st.zoom/pinch.G.k);
    }else{
      pinch.G = null;
      orbit.azTo -= (mx-pinch.mx)*k; orbit.elTo += (my-pinch.my)*k;
      if(pinch.twist) orbit.azTo += da;
    }
    pinch.mx = mx; pinch.my = my;
    return;
  }
  if(!g || g.id !== e.pointerId){ hover(e.clientX, e.clientY); return; }
  let dx = e.clientX - g.px, dy = e.clientY - g.py;
  g.px = e.clientX; g.py = e.clientY;
  g.moved += Math.abs(dx) + Math.abs(dy);
  if(g.mode === 'pending' && g.anchor !== undefined){
    if(Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < g.slop) return;
    g.mode = 'select';
  }
  if(g.mode === 'select'){
    const at = textAt(pickAt(e.clientX, e.clientY));
    if(at !== null) select(g.anchor, at);
    return;
  }
  if(g.mode === 'pending'){
    if(Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < g.slop) return;
    if(g.far) g.force = true;
    if(g.pan){ g.mode = 'pan'; g.G = grip(g.sx, g.sy, st.mag); return; }
    const h = g.hit && g.hit.type === 'book' && !g.force ? pageOfBook(g.hit) || g.hit : g.hit;
    const sideways = Math.abs(e.clientX - g.sx) > Math.abs(e.clientY - g.sy)*0.8;
    const back = e.clientX > g.sx;
    if(!g.force && h && h.type === 'page' && sideways && (h.side === 'left') !== back){
      g.mode = 'swept';
      pageStep(back ? -1 : 1);
      return;
    }
    if(!g.force && onePage() && st.open && sideways && !(h && h.type === 'page')){
      g.mode = 'swept';
      stepPage(back ? -1 : 1);
      return;
    }
    if(!g.force && onePage() && st.open && st.focusTo > 0.5 && !sideways){
      g.mode = 'scroll'; g.scroll0 = pageScroll;
      return;
    }
    if(!g.force && h && h.type === 'page' && st.open && st.theta > OPEN - 1e-3 && !st.flight && !st.riffle && !coverAnim) startTurn(h);
    else if(!g.force && h && h.type === 'front' && st.open && h.inner && st.k === 0 && h.outer && !st.flight && !st.riffle) startCover(h);
    else if(g.force || st.open){ g.mode = 'orbit'; lookAway(); dx = e.clientX - g.sx; dy = e.clientY - g.sy; }
    else { g.mode = 'rot'; rotating = true; lookAway(); dx = e.clientX - g.sx; dy = e.clientY - g.sy; }
    document.body.classList.add('grabbing');
  }
  if(g.mode === 'rot'){
    const k = 0.0065;
    rotateBy(dx*k, dy*k);
    const now = performance.now(), dt = clamp((now - (g.lt||now-16))/1000, 0.004, 0.1);
    g.lt = now;
    const a = 1 - Math.exp(-dt*18);
    angVel.x = clamp(lerp(angVel.x, dx*k/dt, a), -9, 9);
    angVel.y = clamp(lerp(angVel.y, dy*k/dt, a), -9, 9);
    return;
  }
  if(g.mode === 'orbit'){
    const k = 0.0052;
    orbit.azTo -= dx*k; orbit.elTo += dy*k;
    const now = performance.now(), dt = clamp((now - (g.lt||now-16))/1000, 0.004, 0.1);
    g.lt = now;
    const a = 1 - Math.exp(-dt*18);
    orbit.vx = clamp(lerp(orbit.vx, -dx*k/dt, a), -6, 6);
    orbit.vy = clamp(lerp(orbit.vy, dy*k/dt, a), -4, 4);
    return;
  }
  if(g.mode === 'pan'){
    const x0 = pan.x, z0 = pan.z;
    holdAt(g.G, e.clientX, e.clientY, 1);
    const now = performance.now(), dt = clamp((now - (g.lt||now-16))/1000, 0.004, 0.1);
    g.lt = now;
    const a = 1 - Math.exp(-dt*18);
    pan.vx = lerp(pan.vx, (pan.x - x0)/dt, a); pan.vz = lerp(pan.vz, (pan.z - z0)/dt, a);
    return;
  }
  if(g.mode === 'turn'){
    const fl = st.flight;
    fl.goal = solveDragP(fl, e.clientX, e.clientY, fl.goal);
    return;
  }
  if(g.mode === 'scroll'){ setPageScroll(g.scroll0 - (e.clientY - g.sy)*pagePerPx); return; }
  if(g.mode === 'cover'){
    g.goal = solveCoverTheta(g.local, e.clientX, e.clientY, g.goal);
  }
});
let rotating = false;
let homeTimer = 0, homeDue = false;
const UP = new THREE.Vector3(0, 1, 0);
function restWhereTurned(){
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(spinGoal);
  return new THREE.Quaternion().setFromUnitVectors(n, UP).multiply(spinGoal).normalize();
}
function returnHome(wait = 700){
  clearTimeout(homeTimer); homeDue = false;
  homeTimer = setTimeout(function check(){
    if(g || pinch){ homeDue = true; return; }
    if(orbit.coast || inertia){ homeTimer = setTimeout(check, 150); return; }
    if(!st.open && !spinAnim && !atHome()) setClosedHome(restWhereTurned());
    if(!atHome() && !spinAnim) glideSpin(homeQuat(), st.open ? 1.4 : 2.2, st.lift < 0.05);
  }, st.open ? wait : Math.max(wait, 3000));
}
function recenter(){ orbit.coast = false; orbit.azTo = 0; orbit.elTo = 0; resetPan(); }
function lookAway(){
  st.focusTo = 0;
  if(writing) exitWriting();
}
function liftGate(){ return smooth(clamp(st.lift*1.6, 0, 1)); }
function endPointer(e, cancelled){
  const gg = g && g.id === e.pointerId ? g : null;
  releasePointer(e, cancelled);
  if(homeDue && !g && !pinch) returnHome();
  if(gg && gg.cut && !g && !spinAnim && !inertia && !atHome() && spinGoal.angleTo(gg.q0) < 1e-3)
    glideSpin(homeQuat(), Math.max(0.8, gg.cut.left), gg.cut.settle);
}
function releasePointer(e, cancelled){
  pointers.delete(e.pointerId);
  try{ canvasEl.releasePointerCapture(e.pointerId); }catch(_){}
  if(pinch){
    if(pointers.size < 2){
      const p = pinch;
      pinch = null; rotating = false;
      returnHome();
      if(onePage() && st.open && st.focusTo < 0.5 && st.zoom < 0.8){
        const h = pickAt(p.mx, p.my);
        if(h && h.type === 'page' && !st.flight && !st.riffle) st.focusSide = h.side === 'right' ? 1 : -1;
        resetPan(); st.zoom = 1; st.focusTo = 1; refreshUI();
      }
    }else if(e.pointerId === pinch.ia || e.pointerId === pinch.ib) rebase();
    return;
  }
  if(!g || g.id !== e.pointerId) return;
  const gg = g; g = null;
  rotating = false;
  document.body.classList.remove('grabbing');
  if(gg.mode === 'turn'){ endTurn(cancelled); return; }
  if(gg.mode === 'select') return;
  const tap = !cancelled && performance.now() - gg.t < 350 && gg.moved < 18;
  if(gg.mode === 'cover'){ if(tap && !st.open) click(gg.hit); else endCover(cancelled); return; }
  if((gg.mode === 'rot' || gg.mode === 'orbit') && tap){
    setInertia(false); orbit.coast = false; angVel.x = angVel.y = 0; orbit.vx = orbit.vy = 0;
    if(gg.mode === 'rot') spinGoal.copy(gg.q0); else { orbit.azTo = gg.o0[0]; orbit.elTo = gg.o0[1]; }
    click(gg.hit);
    return;
  }
  if(gg.mode === 'rot'){
    if(performance.now() - (gg.lt||0) < 70 && Math.hypot(angVel.x, angVel.y) > 0.25) setInertia(true);
    returnHome();
    return;
  }
  if(gg.mode === 'orbit'){
    if(performance.now() - (gg.lt||0) < 70 && Math.hypot(orbit.vx, orbit.vy) > 0.2) orbit.coast = true;
    returnHome(atHome() ? 700 : 2500);
    return;
  }
  if(gg.mode === 'pan'){
    if(gg.moved < 18 && performance.now() - gg.t < 350 && !cancelled){ pan.vx = pan.vz = 0; click(gg.hit); return; }
    if(performance.now() - (gg.lt||0) < 70 && Math.hypot(pan.vx, pan.vz) > 0.3) pan.coast = true;
    return;
  }
  if(gg.mode === 'swept' || gg.mode === 'scroll') return;
  if(!cancelled) click(gg.hit);
}
canvasEl.addEventListener('pointerup', e=>endPointer(e, false));
canvasEl.addEventListener('pointercancel', e=>endPointer(e, true));
canvasEl.addEventListener('lostpointercapture', e=>{ if(pointers.has(e.pointerId)) endPointer(e, true); });
let padUntil = 0;
canvasEl.addEventListener('wheel', e=>{
  e.preventDefault();
  if(e.ctrlKey){ st.zoom = clamp(st.zoom * Math.exp(e.deltaY*0.01), ZMIN, 3.2); return; }
  const now = performance.now();
  if(e.deltaMode === 0 && (e.deltaX !== 0 || !Number.isInteger(e.deltaY))) padUntil = now + 400;
  if(now >= padUntil){ st.zoom = clamp(st.zoom * Math.exp(e.deltaY*0.0012), ZMIN, 3.2); return; }
  if(g && g.mode !== 'pending') return;
  const k = 0.0045;
  orbit.coast = false; orbit.vx = orbit.vy = 0;
  lookAway();
  orbit.azTo += e.deltaX*k;
  orbit.elTo -= e.deltaY*k;
  returnHome();
}, { passive:false });
/* Safari reports a trackpad pinch as gesture events, not ctrl+wheel; on iOS a touch pinch sends them too, and the pointer pinch owns that */
let gestureZoom = null, touches = 0;
['touchstart', 'touchend', 'touchcancel'].forEach(t=>addEventListener(t, e=>{ touches = e.touches.length; }, { passive:true, capture:true }));
const touchPinch = () => pinch || touches > 0;
addEventListener('gesturestart', e=>{ e.preventDefault(); gestureZoom = touchPinch() ? null : st.zoom; });
addEventListener('gesturechange', e=>{ e.preventDefault(); if(gestureZoom !== null && !touchPinch()) st.zoom = clamp(gestureZoom / Math.max(0.05, e.scale), ZMIN, 3.2); });
addEventListener('gestureend', e=>{ e.preventDefault(); gestureZoom = null; });

function startTurn(h){
  if(writing){ setResumeWriting(true); exitWriting(true); }
  const right = h.side === 'right';
  st.flight = { j: right ? st.k : st.k-1, p: right ? 0 : 1, dragging:true, lead:0, lag:0, sagK:0.35, vel:0,
                gy: clamp(h.y*2-1, -1, 1), sG: clamp(h.s, PW*0.4, PW), yN: clamp(h.y*2-1, -1, 1), anim:null, settle:null };
  st.flight.goal = st.flight.p;
  g.mode = 'turn';
  sfx.page();
}
function endTurn(cancelled){
  const fl = st.flight;
  if(!fl || !fl.dragging) return;
  fl.dragging = false;
  const from = fl.j < st.k ? 1 : 0, need = onePage() ? 0.2 : 0.5;
  let to = Math.abs(fl.goal - from) > need ? 1 - from : from;
  if(!cancelled){ if(fl.vel > 1.2) to = 1; else if(fl.vel < -1.2) to = 0; }
  else to = fl.j < st.k ? 1 : 0;
  fl.settle = glideFrom(fl.p, fl.vel, to, Math.max(0.32, 0.9*Math.abs(to - fl.p)));
  if(onePage() && (to === 1) !== (fl.j < st.k)){ st.focusSide = to === 1 ? -1 : 1; st.focusTo = 1; }
  refreshUI();
}
function startCover(h){
  if(writing) exitWriting();
  if(!st.open && st.theta < 1e-3 && !coverAnim){ st.k = homeSpread(); invalidateLayout(); }
  g.mode = 'cover';
  g.local = h.local;
  g.goal = st.theta;
  setCoverAnim(null);
}
function endCover(cancelled){
  let open = st.theta > OPEN*0.5;
  if(!cancelled){ if(st.thetaVel > 2.2) open = true; else if(st.thetaVel < -2.2) open = false; }
  setOpen(open, true);
}

const EDGE_TURN = 0.84;
function click(hit){
  if(!hit){ if(writing) exitWriting(); else st.focusTo = 0; return; }
  recenter();
  if(!st.open){ writePose(); return; }
  if(hit.type === 'front' || hit.board){ if(!st.flight && !st.riffle) setOpen(false); return; }
  if(hit.type === 'page' && st.open){
    if(hit.s > PW*EDGE_TURN && atHome() && !spinAnim && !overText(hit)){ pageStep(hit.side === 'right' ? 1 : -1); return; }
    if(hit.n === 0){ if(writing) exitWriting(); st.focusSide = 1; st.focusTo = 1; return; }
    const e = pageEntry(hit.n);
    if(!e.lay) paintPage(hit.n);
    const idx = indexAt(e.lay, hit.uv.x*PAGE_W, (1-hit.uv.y)*PAGE_H);
    writePose(hit.n, idx);
    return;
  }
  writePose();
}
let writeOnOpen = false;
function setWriteOnOpen(v){ writeOnOpen = v; }
function writePose(n, idx){
  if(st.flight || st.riffle) return;
  recenter();
  if(n === 0) n = idx = undefined;
  if(!st.open){
    const h = homePage();
    if(!coverAnim){ st.k = spreadOf(h); invalidateLayout(); }
    if(n === undefined && h >= 1 && st.k === spreadOf(h)) n = h;
    setOpen(true);
  }
  const homing = spinAnim && spinAnim.q1.angleTo(qOpenHome) < 1e-4;
  if(!homing && (!atHome() || spinAnim)) glideSpin(qOpenHome, 1.4, st.lift < 0.05);
  st.zoom = 1;
  if(st.k === 0){
    if(coverAnim){ writeOnOpen = true; return; }
    st.focusSide = -1; st.focusTo = 1;
    setResumeWriting(true); flip(1);
    return;
  }
  if(n === undefined) n = onePage() ? shownPage() : nextWritablePage();
  st.focusSide = n % 2 === 0 ? 1 : -1;
  st.focusTo = 1;
  if(writing && writing.n === n){
    quill.focus({preventScroll:true});
    if(idx !== undefined){ quill.setSelectionRange(idx, idx); onSel(); }
  }else enterWriting(n, idx);
}
function nextWritablePage(){
  const left = 2*st.k - 1, right = 2*st.k;
  if(st.k >= N) return left;
  if(left < 1) return right;
  const room = layoutText(pages[left].t + '\nmm', pageFont(left), textBox(left)).ok;
  return room ? left : right;
}
let hoverRaf = 0, hoverXY = null;
function hover(x, y){
  hoverXY = [x,y];
  if(hoverRaf) return;
  hoverRaf = requestAnimationFrame(()=>{
    hoverRaf = 0;
    if(!hoverXY || g) return;
    const h = pickAt(hoverXY[0], hoverXY[1]);
    const b = document.body.classList;
    b.remove('cur-turn','cur-text','cur-pointer');
    if(!h) return;
    if(h.type === 'page') b.add(h.s > PW*EDGE_TURN && !overText(h) ? 'cur-turn' : h.n === 0 ? 'cur-pointer' : 'cur-text');
    else if(!st.open) b.add('cur-pointer');
  });
}

export {
  g, liftGate, pickAt, pinch, rotating, setWriteOnOpen, writeOnOpen, writePose
};
