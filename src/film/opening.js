/* the opening film's hooks in the live scene and the hand-over to the live book */
import * as THREE from 'three';
import { clamp, lerp, smooth, mulberry32, fbm, cv } from '../lib/textures.js';
import { intro } from '../core/launch.js';
import { easeSine } from '../core/easing.js';
import { FS, OPEN, PAGE_H, PAGE_W, ROCK_TOP, SC, VH, VW } from '../core/config.js';
import { camera } from '../scene/renderer.js';
import { spinGrp } from '../scene/rig.js';
import { borderArt, drawTitle, gilt, pageBackground, runeStroke, setTitleHidden } from '../book/print.js';
import { BURN_T, burnNoise, CHAR, COOL_T, EMBER, NIB_DX, NIB_DY, ramp, setBurnNoise, SINGE, softMask } from '../ink/paint.js';
import { lend, pageEntry, paintPage } from '../book/pages.js';
import { pagePointWorld } from '../book/leaves.js';
import { invalidateLayout, layout, st } from '../book/state.js';
import { camTarget, fitDistance, homeQuat, orbit, spinGoal } from '../book/view.js';
import { homeSpread } from '../ink/storage.js';
import { nextSmoke, smokeAge, smokeKind, smokeLife, smokePos, smokeSeed, smokeVel, smokeWait } from '../fx/ink-fx.js';
import { coverAnim } from '../book/turning.js';
import { seekSpread } from '../book/seek.js';
import { refreshUI } from '../ui/controls.js';
import { frame, liveFov, onResize, setStory, update } from '../app/loop.js';

/* the title page's ornament, gilt and lettering catch a light that runs out from the
   middle of the sheet (reach 0..1) and leaves them glowing warm (amt fades it) */
const shineMasks = new Map();
let shineLayer = null;
function pageShine(n, amt, reach){
  const e = pageEntry(n), W = e.glow.width, H = e.glow.height;
  if(amt <= 0){ if(e.glowing){ e.glowing = true; paintPage(n); } return; }
  let mask = shineMasks.get(n);
  if(!mask){
    const art = cv(PAGE_W, PAGE_H), a = art.getContext('2d');
    a.drawImage(borderArt(), 0, 0);
    a.drawImage(gilt().color, 0, 0);
    if(n === 0) drawTitle(a);
    mask = cv(W, H);
    const m = mask.getContext('2d');
    m.filter = 'blur(2px)'; m.globalAlpha = 0.7;
    m.drawImage(art, 0, 0, W, H);
    m.filter = 'none'; m.globalAlpha = 1;
    m.drawImage(art, 0, 0, W, H);
    shineMasks.set(n, mask);
    shineLayer = shineLayer || cv(W, H);
  }
  const L = shineLayer.getContext('2d');
  L.globalCompositeOperation = 'source-over';
  L.clearRect(0, 0, W, H);
  const cx = W/2, cy = H*0.42, R = Math.max(1, Math.hypot(W, H)*0.62*reach);
  const gr = L.createRadialGradient(cx, cy, 0, cx, cy, R);
  gr.addColorStop(0, 'rgba(255,170,60,.55)');
  gr.addColorStop(0.78, 'rgba(255,190,90,.85)');
  gr.addColorStop(0.93, 'rgba(255,240,200,1)');
  gr.addColorStop(1, 'rgba(255,220,150,0)');
  L.fillStyle = gr;
  L.fillRect(0, 0, W, H);
  L.globalCompositeOperation = 'destination-in';
  L.drawImage(mask, 0, 0);
  const g = e.glow.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.globalAlpha = clamp(amt, 0, 1);
  g.drawImage(shineLayer, 0, 0);
  g.globalAlpha = 1;
  e.glowTex.needsUpdate = true;
  e.mat.emissiveIntensity = 3.2;
  e.glowing = true;
}
/* the film opens the book on a bare title page; the lettering soaks up into the sheet
   from the middle outward, raggedly, like ink taken up by the fibres, as the circle
   comes down on it (reach 0..1) */
let titleFull = null, titleBare = null, titleMix = null, titleMask = null, soak = null;
function titleReveal(reach){
  const e = pageEntry(0);
  if(!titleFull){
    titleFull = lend(pageBackground(0));
    setTitleHidden(true); titleBare = lend(pageBackground(0)); setTitleHidden(false);
    titleMix = lend(cv(PAGE_W, PAGE_H)); titleMask = cv(PAGE_W, PAGE_H);
    const w = PAGE_W >> 2, h = PAGE_H >> 2;
    soak = { w, h, c: cv(w, h), n: fbm(w, h, 7, 9, 4, 4242) };
  }
  if(reach >= 1) e.bg = titleFull;
  else if(reach <= 0) e.bg = titleBare;
  else {
    const { w, h, c, n } = soak, sc = c.getContext('2d'), img = sc.createImageData(w, h), d = img.data;
    const cx = w/2, cy = h*0.42, R = Math.hypot(w, h)*0.62;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const i = y*w + x, r = Math.hypot(x - cx, y - cy)/R;
      const v = (reach - r)/0.16 + (n[i] - 0.5)*1.6;
      d[i*4 + 3] = 255*smooth(clamp(v, 0, 1));
    }
    sc.putImageData(img, 0, 0);
    const m = titleMask.getContext('2d'), x = titleMix.getContext('2d');
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, PAGE_W, PAGE_H);
    m.drawImage(titleFull, 0, 0);
    m.globalCompositeOperation = 'destination-in';
    m.imageSmoothingQuality = 'high';
    m.drawImage(c, 0, 0, PAGE_W, PAGE_H);
    x.drawImage(titleBare, 0, 0);
    x.drawImage(titleMask, 0, 0);
    e.bg = titleMix;
  }
  e.inkKey = null;
  paintPage(0);
}
/* the film's circle lies on the title page as light, and from it a spark flies to each
   letter of the lettering, which then burns in exactly as a letter written in the book
   does (burnLetter): the paper browns in its shape, a ragged white-gold front eats
   through it along the pen's slant, the stroke glows ember and cools into ink.
   The letters are the title page's own, cut apart where its ink has gaps.
   o: { M (sigil units -> page px), sig (circle's light 0..1), t, start (when the first
   letter catches), done } */
let tb = null;
function burnInit(){
  titleReveal(-1);
  const W = PAGE_W, H = PAGE_H;
  const d = cv(W, H), dc = d.getContext('2d');
  dc.drawImage(titleBare, 0, 0);
  dc.globalCompositeOperation = 'difference';
  dc.drawImage(titleFull, 0, 0);
  const px = dc.getImageData(0, 0, W, H).data, inkA = new Uint8ClampedArray(W*H);
  for(let i=0;i<W*H;i++) inkA[i] = Math.min(255, (px[i*4] + px[i*4+1] + px[i*4+2])*1.6);
  /* lines: runs of rows with ink; letters: runs of columns with ink within a line */
  const rowInk = y => { for(let x=0;x<W;x++) if(inkA[y*W + x] > 40) return true; return false; };
  const bands = [];
  for(let y=0;y<H;y++){
    if(!rowInk(y)) continue;
    const last = bands[bands.length - 1];
    if(last && y - last.y1 <= 6*FS) last.y1 = y; else bands.push({ y0: y, y1: y });
  }
  const glyphs = [];
  bands.forEach((b, bi)=>{
    const cols = [];
    for(let x=0;x<W;x++){ let on = false; for(let y=b.y0;y<=b.y1 && !on;y++) on = inkA[y*W + x] > 40; cols.push(on); }
    let x = 0;
    while(x < W){
      if(!cols[x]){ x++; continue; }
      let x1 = x;
      while(x1 + 1 < W && (cols[x1 + 1] || (x1 + 3 < W && cols[x1 + 2] && !cols[x1 + 1] && false))) x1++;
      const last = glyphs[glyphs.length - 1];
      if(last && last.band === bi && x - last.x1 < 1) last.x1 = x1;
      else glyphs.push({ band: bi, x0: x, x1, y0: b.y0, y1: b.y1 });
      x = x1 + 1;
    }
  });
  if(!burnNoise) setBurnNoise(fbm(256, 256, 12, 12, 3, 4242));
  tb = { W, H, inkA, bands, glyphs, mix: lend(cv(W, H)), done: cv(W, H), tmp: cv(W, H), cvs: [cv(8, 8), cv(8, 8), cv(8, 8)], M: null };
  tb.done.getContext('2d').drawImage(titleBare, 0, 0);
}
/* when each letter catches, after the first: line after line down the page, each
   from its first letter to its last as a hand would write it, the next line starting
   while the last is still being written; the ornaments go quicker */
function titleBurnPlan(pace = 1){
  if(!tb) burnInit();
  const B = tb.bands, H = tb.H;
  return tb.glyphs.map(g=>{
    const b = B[g.band], xs = tb.glyphs.filter(q=>q.band === g.band);
    const bx0 = xs[0].x0, bx1 = xs[xs.length - 1].x1, ornament = (b.y1 - b.y0) < H*0.012 || xs.length < 4;
    g.s = pace*(g.band*0.32 + ((g.x0 + g.x1)/2 - bx0)/Math.max(1, bx1 - bx0)*(ornament ? 0.5 : 1.0));
    return { px: (g.x0 + g.x1)/2, py: (g.y0 + g.y1)/2, s: g.s };
  });
}
function sigilLines(M, blur, col, wk = 1){
  const c = cv(PAGE_W, PAGE_H), x = c.getContext('2d');
  x.setTransform(...M);
  x.strokeStyle = x.fillStyle = col; x.lineCap = 'round'; x.lineJoin = 'round';
  if(blur) x.filter = `blur(${blur}px)`;
  const ring = (r, lw)=>{ x.lineWidth = lw*wk; x.beginPath(); x.arc(0, 0, r, 0, Math.PI*2); x.stroke(); };
  ring(118, 1.7); ring(112, 0.9); ring(84, 1.2); ring(80, 0.7); ring(30, 1.0);
  for(let i=0;i<7;i++){ const a = -Math.PI/2 + i*Math.PI*2/7; x.beginPath(); x.arc(Math.cos(a)*118, Math.sin(a)*118, 3.2, 0, Math.PI*2); x.fill(); }
  x.lineWidth = 1.1*wk; x.beginPath();
  for(let i=0;i<=7;i++){ const a = -Math.PI/2 + i*3*Math.PI*2/7; i ? x.lineTo(Math.cos(a)*80, Math.sin(a)*80) : x.moveTo(Math.cos(a)*80, Math.sin(a)*80); }
  x.stroke();
  const rnd = mulberry32(777);
  x.lineWidth = 1.1*wk;
  for(let i=0;i<28;i++){ x.save(); x.rotate(i/28*Math.PI*2); x.translate(0, -98); runeStroke(x, Math.floor(rnd()*6), 7, 3.6); x.restore(); }
  return c;
}
function titleBurn(o){
  if(!tb) burnInit();
  const e = pageEntry(0), T = tb, W = T.W, H = T.H;
  const g = e.glow.getContext('2d'), gw = e.glow.width, gh = e.glow.height;
  if(o.done){
    e.bg = titleFull; e.inkKey = null; paintPage(0);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(0, 0, gw, gh);
    e.glowTex.needsUpdate = true; e.mat.emissiveIntensity = 0; e.glowing = false;
    return;
  }
  if(!T.M || T.M.join() !== o.M.join()){
    T.M = o.M.slice();
    T.sigLine = sigilLines(T.M, 0, 'rgb(255,214,140)', 1.1);
    T.sigSoft = sigilLines(T.M, 4*SC, 'rgb(255,170,80)', 2.0);
  }
  const m = T.mix.getContext('2d'), dn = T.done.getContext('2d');
  /* the light is gathered aside: painting the page clears its glow layer */
  if(!T.acc || T.acc.width !== gw) T.acc = cv(gw, gh);
  const g0 = g, ga = T.acc.getContext('2d');
  { const g = ga;
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(0, 0, gw, gh);
  g.globalCompositeOperation = 'lighter';
  if(o.sig > 0){
    g.globalAlpha = o.sig*0.55; g.drawImage(T.sigSoft, 0, 0, gw, gh);
    g.globalAlpha = o.sig; g.drawImage(T.sigLine, 0, 0, gw, gh);
    g.globalAlpha = 1;
  }
  m.globalCompositeOperation = 'source-over'; m.globalAlpha = 1;
  m.drawImage(T.done, 0, 0);
  const Tb = BURN_T, C = COOL_T, PRE = Tb*0.4, RIM = 0.08, CH = CHAR, HOT = 0.06, nk = 1/FS, s = 60*FS;
  const live = [];
  for(const G of T.glyphs){
    if(G.finished) continue;
    const age = o.t - (o.start + G.s);
    if(age < -PRE) continue;
    if(age > Tb + 2.8*C){
      G.finished = true;
      dn.save(); dn.beginPath(); dn.rect(G.x0 - s*0.2, G.y0 - s*0.2, G.x1 - G.x0 + s*0.6, G.y1 - G.y0 + s*0.4); dn.clip();
      dn.drawImage(titleFull, 0, 0); dn.restore();
      m.save(); m.beginPath(); m.rect(G.x0 - s*0.2, G.y0 - s*0.2, G.x1 - G.x0 + s*0.6, G.y1 - G.y0 + s*0.4); m.clip();
      m.drawImage(titleFull, 0, 0); m.restore();
      continue;
    }
    live.push([G, age]);
  }
  for(const [G, age] of live){
    const X0 = Math.max(0, Math.floor(G.x0 - s*0.14)), Y0 = Math.max(0, Math.floor(G.y0 - s*0.12));
    const X1 = Math.min(W, Math.ceil(G.x1 + s*0.32)), Y1 = Math.min(H, Math.ceil(G.y1 + s*0.12));
    const w = X1 - X0, h = Y1 - Y0;
    const ink = new Uint8ClampedArray(w*h*4);
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const X = X0 + x;
      ink[(y*w + x)*4 + 3] = X >= G.x0 && X <= G.x1 ? T.inkA[(Y0 + y)*W + X] : 0;
    }
    const soft = softMask(ink, w, h, Math.max(1, Math.round(2.4*FS)));
    const sMin = G.x0*NIB_DX + G.y0*NIB_DY, sSpan = Math.max(1, G.x1*NIB_DX + G.y1*NIB_DY - sMin);
    const [cc, pc, lc] = T.cvs;
    [cc, pc, lc].forEach(c=>{ if(c.width < w || c.height < h){ c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); } });
    const cover = new ImageData(w, h), paint = new ImageData(w, h), glow = new ImageData(w, h);
    const cd = cover.data, pd = paint.data, ld = glow.data, rise = age*70;
    for(let y=0, p=0; y<h; y++){
      const Y = Y0 + y, ny = ((Y*nk) & 255) << 8, fy = (((Y*nk*1.7 + rise) | 0) & 255) << 8;
      for(let x=0; x<w; x++, p+=4){
        const a = ink[p+3]/255, sa = soft[p>>2];
        if(sa < 0.004) continue;
        const X = X0 + x;
        const F = clamp((X*NIB_DX + Y*NIB_DY - sMin)/sSpan, -0.2, 1.2)*0.74 + burnNoise[ny | ((X*nk) & 255)]*0.42 - 0.08;
        const la = age - Tb*F;
        if(la < 0){
          cd[p+3] = Math.min(255, sa*640);
          if(la > -PRE){
            const k = 1 + la/PRE, q = k*k, c = la > -CH ? 1 + la/CH : 0;
            pd[p] = lerp(120, 30, c); pd[p+1] = lerp(66, 14, c); pd[p+2] = lerp(28, 6, c);
            pd[p+3] = Math.min(1, (a*0.55 + sa*0.1)*q + (a*0.9 + sa*0.25)*c)*255;
            if(la > -HOT){ const e2 = a*(1 + la/HOT)*0.3; ld[p] = 210; ld[p+1] = 90; ld[p+2] = 30; ld[p+3] = e2*255; }
          }
          continue;
        }
        if(la < HOT) cd[p+3] = Math.min(255, sa*640)*(1 - la/HOT);
        const fl = burnNoise[fy | (((X*nk*1.7) | 0) & 255)];
        const edge = clamp((1 - sa)*2.5, 0, 1);
        const heat = Math.min(1, Math.exp(-la/(C*(0.55 + 1.1*edge)))*(0.72 + 0.56*fl));
        const rim = la < RIM ? 1 - la/RIM : 0;
        if(heat < 0.01 && rim === 0) continue;
        if(a > 0.004){
          const c = ramp(heat, SINGE), r = rim*0.8;
          pd[p] = lerp(c[0], 255, r); pd[p+1] = lerp(c[1], 246, r); pd[p+2] = lerp(c[2], 220, r);
          pd[p+3] = a*Math.min(1, heat*3 + rim)*255;
        }
        const c = ramp(heat, EMBER);
        const ea = Math.min(1, a*Math.min(1, heat*1.6) + sa*(rim*0.55 + heat*0.3));
        ld[p] = lerp(c[0], 255, rim); ld[p+1] = lerp(c[1], 240, rim); ld[p+2] = lerp(c[2], 205, rim);
        ld[p+3] = ea*255;
      }
    }
    /* the letter as it ends, the parchment still unburnt over it, its colour, its light */
    m.save(); m.beginPath(); m.rect(X0, Y0, w, h); m.clip();
    m.drawImage(titleFull, 0, 0);
    cc.getContext('2d').putImageData(cover, 0, 0);
    const t2 = T.tmp.getContext('2d');
    t2.globalCompositeOperation = 'source-over'; t2.clearRect(X0, Y0, w, h);
    t2.drawImage(titleBare, X0, Y0, w, h, X0, Y0, w, h);
    t2.globalCompositeOperation = 'destination-in';
    t2.drawImage(cc, 0, 0, w, h, X0, Y0, w, h);
    t2.globalCompositeOperation = 'source-over';
    m.drawImage(T.tmp, X0, Y0, w, h, X0, Y0, w, h);
    pc.getContext('2d').putImageData(paint, 0, 0);
    m.drawImage(pc, 0, 0, w, h, X0, Y0, w, h);
    m.restore();
    lc.getContext('2d').putImageData(glow, 0, 0);
    ga.drawImage(lc, 0, 0, w, h, X0*gw/W, Y0*gh/H, w*gw/W, h*gh/H);
  }
  }
  e.bg = T.mix; e.inkKey = null; paintPage(0);
  g0.globalCompositeOperation = 'source-over'; g0.globalAlpha = 1;
  g0.drawImage(T.acc, 0, 0);
  e.glowTex.needsUpdate = true; e.mat.emissiveIntensity = 1.4; e.glowing = true;
}
/* a puff of smoke off the title page at (px, py) */
function pagePuff(px, py){
  const { p, n: nrm } = pagePointWorld(0, px, py);
  const s = nextSmoke();
  smokePos[s*3] = p.x + nrm.x*0.01; smokePos[s*3+1] = p.y + nrm.y*0.01; smokePos[s*3+2] = p.z + nrm.z*0.01;
  smokeVel[s*3] = (Math.random() - 0.5)*0.03; smokeVel[s*3+1] = 0.16 + Math.random()*0.08; smokeVel[s*3+2] = (Math.random() - 0.5)*0.03;
  smokeWait[s] = 0; smokeKind[s] = 0; smokeAge[s] = 0; smokeLife[s] = 1.3 + Math.random()*0.8; smokeSeed[s] = Math.random();
}
/* the live book takes over from the film's last frame: the eye starts where the film's
   camera stood, cropped or letterboxed to this screen as the video was (intro.fit is
   object-fit), holds there while the pictures cross, then eases to this screen's own
   framing. A touch or a key hurries it, and the buttons and the invitation wait for it */
let camBlend = null;
const settled = intro ? (()=>{ let r; const p = new Promise(x=>r=x); return { p, r }; })() : null;
const BLEND_EVENTS = ['pointerdown', 'wheel', 'keydown'];
const hurryBlend = ()=>{ if(camBlend) camBlend.rate = 5; };
const settle = ()=>{
  document.documentElement.classList.remove('settling');
  for(const ev of BLEND_EVENTS) removeEventListener(ev, hurryBlend, { capture: true });
  if(settled) settled.r();
};
const _cq = new THREE.Quaternion();
function startCamBlend(pose, hold){
  if(!pose) return;
  const A = pose.aspect, B = VW/VH;
  const widthFits = intro.fit === 'contain' ? B < A : B > A;
  const t = Math.tan(pose.fov*Math.PI/360)*(widthFits ? A/B : 1);
  camBlend = { p: new THREE.Vector3().fromArray(pose.pos), q: new THREE.Quaternion().fromArray(pose.quat),
    fov: Math.atan(t)*360/Math.PI, t: -hold, d: 1.0, rate: 1 };
}
function stepCamBlend(dt){
  const B = camBlend;
  B.t += dt*B.rate;
  const k = easeSine(clamp(B.t/B.d, 0, 1));
  _cq.copy(camera.quaternion);
  camera.position.lerpVectors(B.p, camera.position, k);
  camera.quaternion.slerpQuaternions(B.q, _cq, k);
  camera.fov = lerp(B.fov, liveFov(), k);
  camera.updateProjectionMatrix();
  if(k >= 1){ camBlend = null; settle(); }
}
/* 'open': the film ran to its end, so the book lies open on its title page as the
   film left it, and then turns to the page last written on. 'closed': the film never
   played (no autoplay, reduced motion), its first frame stood in, and the book opens now */
function takeOver(mode, poses){
  const pose = poses && poses[intro.kind];
  if(mode === 'open'){ st.open = true; st.k = 0; }
  else { st.open = false; st.k = homeSpread(); }
  invalidateLayout();
  st.theta = st.open ? OPEN : 0;
  spinGrp.quaternion.copy(homeQuat());
  spinGoal.copy(spinGrp.quaternion);
  orbit.az = orbit.azTo = orbit.el = orbit.elTo = 0;
  st.zoom = 1;
  layout(true);
  st.camD = fitDistance();
  camTarget.set(0, ROCK_TOP + 0.4, 0);
  onResize();
  for(let i=0;i<150;i++) update(1/30);
  startCamBlend(pose && (mode === 'open' ? pose.end : pose.start), 0.3);
  if(camBlend) for(const ev of BLEND_EVENTS) addEventListener(ev, hurryBlend, { capture: true, passive: true });
  else settle();
  refreshUI();
  frame();
  setTimeout(()=>{
    if(mode === 'open'){ if(homeSpread() !== st.k) seekSpread(homeSpread()); }
    else if(!st.open && !coverAnim) seekSpread(homeSpread(), { flourish: false });
  }, mode === 'open' ? 1300 : 1500);
}

/* the opening played live, on the scene itself: the story (film/capture.js) runs on the
   frame loop's time and hands the eye to the live camera over its last second, then the
   book turns to the page last written on. Cut short, the book opens at once and the eye
   eases from wherever the story had it to the reader's place */
function playLive(L){
  setStory(dt=>L.tick(dt));
  L.done = how=>{
    setStory(null);
    if(how === 'skip'){
      startCamBlend({ pos: camera.position.toArray(), quat: camera.quaternion.toArray(), fov: camera.fov, aspect: camera.aspect }, 0);
      camBlend.d = 1.4;
      for(const ev of BLEND_EVENTS) addEventListener(ev, hurryBlend, { capture: true, passive: true });
    }else settle();
    refreshUI();
    if(intro.end) intro.end();
    setTimeout(()=>{ if(homeSpread() !== st.k) seekSpread(homeSpread()); }, how === 'skip' ? 1800 : 900);
  };
  if(intro.started) intro.started(L);
  refreshUI();
}

export {
  camBlend, pagePuff, pageShine, playLive, settled, stepCamBlend, takeOver, titleBurn,
  titleBurnPlan, titleReveal
};
