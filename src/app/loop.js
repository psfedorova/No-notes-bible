/* the frame loop: update, render, resize and the phone's pixel budget */
import * as THREE from 'three';
import { clamp, lerp, smooth } from '../lib/textures.js';
import { FILM, intro } from '../core/launch.js';
import { damp, easeIO, glideStep, sdamp } from '../core/easing.js';
import { CVR, CW, GROUND_Y, HI_RES, LIFT_H, measureViewport, N, OPEN, PAGE_H, PAGE_W, PH, PW, ROCK_TOP, VH, VW, XJ_C, XJ_O, ZB } from '../core/config.js';
import { camera, deskRatio, DPR, gemLight, PR_LEVELS, PR_PIN, renderer, scene, setDPR, setShadowDirty, shadowDirty, shadowKey } from '../scene/renderer.js';
import { BEAM_AT, beamMotes, beamU, dust, rayGroup } from '../scene/sunbeam.js';
import { composer } from '../scene/post.js';
import { bookRoot, floatGrp, spinGrp } from '../scene/rig.js';
import { matGold } from '../book/materials.js';
import { caretXY } from '../ink/layout.js';
import { GLOW_T } from '../ink/paint.js';
import { freeCanvas, pageCache, pageEntry, pages, paintPage } from '../book/pages.js';
import { frontGem } from '../book/boards.js';
import { stepGems } from '../book/sapphire.js';
import { FLOAT_T, leaves, pagePointWorld } from '../book/leaves.js';
import { layout, st } from '../book/state.js';
import { angVel, atHome, CAM_REACH, camElevation, camTarget, fitDistance, frameTheta, inertia, onePage, orbit, ORBIT_EL, pageMid, pageScroll, releaseFrame, rotateBy, setInertia, setPagePerPx, setPageScroll, setSpinAnim, sideOf, spinAnim, spinGoal, stepFrame, uiInsets, visibleBand, WRITE_EL } from '../book/view.js';
import { booted, homePage, homeSpread } from '../ink/storage.js';
import { blinkPhase, burning, quill, setBlinkPhase, writing } from '../ink/writing.js';
import { inkSparkMat, smokeMat, sparkMat, stepSmoke, stepSparks } from '../fx/ink-fx.js';
import { sfx } from '../audio/sound.js';
import { auraMat, burstMat, dustMat, flyMat, moteMat, stepMagic, stepMotes } from '../fx/magic.js';
import { fireflyMat } from '../scene/forest-life.js';
import { g, liftGate, pinch, rotating, setWriteOnOpen, writeOnOpen, writePose } from '../input/gestures.js';
import { coverAnim, coverEvent, coverLanded, fallCover, setCoverAnim, stepFall, stepFlight } from '../book/turning.js';
import { seek, spreadOf, stepWisps } from '../ink/spells.js';
import { stepRiffle, stepSeek } from '../book/seek.js';
import { refreshUI } from '../ui/controls.js';
import { meterTick } from '../ui/fps.js';
import { rockTime } from '../scene/rock.js';
import { backdrop, FOREST_CAP } from '../scene/forest.js';
import { nearTime } from '../scene/plants.js';
import { camBlend, stepCamBlend } from '../film/opening.js';

const liveFov = ()=> clamp(2*Math.atan(Math.tan(20*Math.PI/180)*0.8/(VW/VH))*180/Math.PI, 40, 62);
function onResize(){
  if(!measureViewport()) return;
  /* moved to a bigger screen, a computer keeps within its pixel budget */
  if(HI_RES && !PR_PIN && Math.abs(deskRatio() - DPR) > 0.01){ setDPR(deskRatio()); renderer.setPixelRatio(DPR); composer.setPixelRatio(DPR); }
  renderer.setSize(VW, VH, false);
  composer.setSize(VW, VH);
  camera.aspect = VW/VH;
  /* a tall screen sees wider rather than standing farther back: the forest is a
     picture taken from one point, and only holds its shape near it */
  camera.fov = liveFov();
  camera.updateProjectionMatrix();
  sparkMat.uniforms.uScale.value = VH*DPR*0.012;
  inkSparkMat.uniforms.uScale.value = VH*DPR*0.011;
  smokeMat.uniforms.uScale.value = VH*DPR*0.011;
  moteMat.uniforms.uScale.value = VH*DPR*0.009;
  auraMat.uniforms.uScale.value = VH*DPR*0.08;
  burstMat.uniforms.uScale.value = VH*DPR*0.015;
  dustMat.uniforms.uScale.value = VH*DPR*0.34;
  flyMat.uniforms.uScale.value = VH*DPR*0.16;
  fireflyMat.uniforms.uScale.value = VH*DPR*0.16;
  beamMotes.material.uniforms.uScale.value = VH*DPR*0.05;
}
addEventListener('resize', onResize);
try{ new ResizeObserver(()=>onResize()).observe(document.documentElement); }catch(_){}

let last = performance.now(), clock = 0, bobAmt = 1;
/* the opening played live (film/capture.js): it moves the scene ahead of each update */
let story = null;
function setStory(fn){ story = fn; }
const _bc = new THREE.Vector3(), _rd = new THREE.Vector3(), _rc = new THREE.Vector3();
const EYE_SPHERE = 20;
function update(dt){
  clock += dt;
  if(story) story(dt);
  stepFrame(dt);
  const theta0 = st.theta;
  if(g && g.mode === 'cover'){
    st.theta = damp(st.theta, g.goal, 18, dt);
  }else if(coverAnim && coverAnim.glide){
    const done = glideStep(coverAnim.glide, dt);
    st.theta = clamp(coverAnim.glide.x, 0, OPEN);
    if(done){ if(coverAnim.to === 0) releaseFrame(); st.theta = coverAnim.to; setCoverAnim(null); if(Math.abs(st.thetaVel) > 0.6) sfx.land(); refreshUI(); }
  }else if(coverAnim && coverAnim.fall){
    if(stepFall(coverAnim.fall, dt)){ st.theta = 0; setCoverAnim(null); releaseFrame(); refreshUI(); }
  }else if(coverAnim && coverAnim.path){
    const A = coverAnim;
    A.t += dt;
    while(A.i < A.path.length && A.t >= A.path[A.i].d){
      const sg = A.path[A.i];
      if(sg.fire && !sg.fired) coverEvent(sg.fire);
      if(sg.end) coverEvent(sg.end);
      A.t -= sg.d; A.from = sg.to; A.i++;
    }
    if(A.i >= A.path.length){
      st.theta = A.path.length ? A.path[A.path.length - 1].to : A.to;
      if(A.fallV !== undefined) setCoverAnim(fallCover(A.fallV));
      else { setCoverAnim(null); coverLanded(A); refreshUI(); }
    }
    else{
      const sg = A.path[A.i], k = A.t/sg.d;
      if(sg.fire && !sg.fired && sg.at !== undefined && k >= sg.at){ sg.fired = true; coverEvent(sg.fire); }
      st.theta = lerp(A.from, sg.to, sg.e(k));
    }
  }
  st.thetaVel = damp(st.thetaVel, (st.theta - theta0)/Math.max(dt, 1e-3), 14, dt);
  if(writeOnOpen && !coverAnim && st.open && st.theta >= OPEN - 1e-3){ setWriteOnOpen(false); writePose(); }
  stepFlight(dt);
  stepRiffle(dt);
  for(const L of leaves) if(L.flt < FLOAT_T) L.flt += dt;
  if(spinAnim){
    spinAnim.t += dt;
    const k = Math.min(1, spinAnim.t/spinAnim.dur);
    spinGrp.quaternion.slerpQuaternions(spinAnim.q0, spinAnim.q1, easeIO(k));
    spinGoal.copy(spinGrp.quaternion);
    if(k >= 1) setSpinAnim(null);
  }else{
    if(inertia){
      rotateBy(angVel.x*dt, angVel.y*dt);
      const f = Math.exp(-dt*3.4);
      angVel.x *= f; angVel.y *= f;
      if(Math.hypot(angVel.x, angVel.y) < 0.03) setInertia(false);
    }
    /* still on the rock it turns lazily, it follows the hand once it has risen */
    spinGrp.quaternion.slerp(spinGoal, 1 - Math.exp(-dt*lerp(7, 16, liftGate())));
  }
  /* the book rises off the rock to be turned and settles back when it is home */
  const wantLift = rotating || inertia || !atHome() ? 1 : 0;
  st.lift = lerp(st.lift, wantLift, 1 - Math.exp(-dt*(wantLift ? 3.2 : 2.4)));
  if(st.lift < 0.0005) st.lift = 0;
  if(writing){
    setBlinkPhase(blinkPhase + dt);
  }
  /* letters burning in: repaint at ~30 fps while any is still lit */
  if(burning.size){
    const now = performance.now();
    burning.forEach(n=>{
      const e = pageCache.get(n);
      if(!e){ burning.delete(n); return; }
      const lastBorn = (pages[n].born || []).reduce((a,b)=>Math.max(a, b||0), 0);
      /* a phone sends the whole page to the GPU at most 30 times a second while letters
         burn in, and 12 while only the caret breathes */
      if(!HI_RES && now - (e.paintedAt || 0) < ((now - lastBorn)/1000 < GLOW_T || (pages[n].vapor && pages[n].vapor.length) ? 33 : 80)) return;
      e.paintedAt = now;
      paintPage(n, now);
      if(!(writing && writing.n === n) && (now - lastBorn)/1000 > GLOW_T && !(pages[n].vapor && pages[n].vapor.length)){ burning.delete(n); paintPage(n, now); }
    });
  }
  stepSparks(dt);
  stepSmoke(dt);
  stepMotes(dt);
  stepMagic(dt);
  stepWisps(dt);
  stepSeek();
  /* centre of the tome, so it turns about its own middle; while it is being
     shut the half on the rock stays where it lies */
  const b = FILM && st.rootB !== undefined ? st.rootB : smooth(clamp(frameTheta()/OPEN,0,1));
  bookRoot.position.set(-lerp((XJ_C + CW - 0.13)/2, 0, b), 0, -lerp(0, ZB*0.4, b));
  bobAmt = lerp(bobAmt, st.bob*st.lift, 1 - Math.exp(-dt*2));
  const restY = ROCK_TOP + 0.004 - (ZB - CVR - 0.004 + bookRoot.position.z);
  floatGrp.position.y = restY + st.lift*LIFT_H + st.hover + Math.sin(clock*0.78)*0.10*bobAmt + Math.sin(clock*1.3)*0.025*st.hover/0.3;
  st.joltV += (-260*st.jolt - 10*st.joltV)*Math.min(dt, 0.05);
  st.jolt += st.joltV*Math.min(dt, 0.05);
  floatGrp.position.y += st.jolt;
  floatGrp.rotation.z = Math.sin(clock*0.53)*0.012*bobAmt + st.jolt*0.25;
  /* camera: high and to the south, following the book up and down; while
     writing it leans in over the page, looking down on it like a reader */
  /* the camera watches the board swing over and leans in only once it is down */
  const opening = coverAnim && coverAnim.to === OPEN && st.theta < OPEN*0.8;
  /* one page at a time, the eye comes down over a page as soon as the book lies open */
  const one = onePage();
  if(one !== st.onePage){ st.onePage = one; refreshUI(); }
  if(!one || !st.open) st.paged = false;
  else if(!st.paged && !coverAnim && !camBlend && st.theta > OPEN - 1e-3){
    st.paged = true; st.focusTo = 1;
    const h = homePage();
    st.focusSide = st.k === 0 ? 1 : st.k === N ? -1 : spreadOf(h) === st.k ? sideOf(h) : st.focusSide;
    refreshUI();
  }
  sdamp(st, 'focus', opening ? 0 : st.focusTo, 0.55, dt);
  const fz = smooth(clamp(st.focus, 0, 1));
  const fitW = 2*Math.tan(camera.fov*Math.PI/360), ui = uiInsets();
  const fitWide = PW/(fitW*(VW/VH)*(1 - 2*ui.s/VW));
  let pageD = Math.max(PH/(fitW*(1 - 2*ui.v/VH)), fitWide);
  /* writing, the book lies square to the eye: the page under the quill is
     looked straight down on, centred, whole between the buttons and the pager */
  if(writing && atHome()){
    let c = pagePointWorld(writing.n, PAGE_W/2, PAGE_H/2).p;
    if(one){
      /* on a phone the page keeps the whole width of the screen, and when the keyboard
         leaves too little of it for the whole page, the line being written is kept in
         the middle of what is left, as a writer slides the sheet up the desk */
      pageD = fitWide;
      const vis = visibleBand(), top = Math.max(vis.top, ui.top + 6);
      const h = Math.max(40, vis.top + vis.h - (vis.h > VH*0.9 ? ui.bot : 6) - top);
      const perPx = 2*pageD*Math.tan(camera.fov*Math.PI/360)/VH;
      const e = pageCache.get(writing.n), half = h*perPx/2/PH*PAGE_H;
      let py = PAGE_H/2;
      setPagePerPx(perPx/PH*PAGE_H);
      if(half < PAGE_H/2 && e && e.lay){
        const lay = e.lay, cy = caretXY(lay, clamp(quill.selectionEnd, 0, pages[writing.n].t.length)).y - lay.size*0.35;
        const base = clamp(cy, half, PAGE_H - half);
        py = clamp(base + pageScroll, half, PAGE_H - half);
        setPageScroll(py - base);
      }else setPageScroll(0);
      c = pagePointWorld(writing.n, PAGE_W/2, py).p;
      /* centred in the free band, not in the screen: the eye moves towards the reader */
      _bc.set(0, -1, 0).applyQuaternion(camera.quaternion).setY(0);
      const sh = (VH/2 - (top + h/2))*perPx/Math.max(1e-3, _bc.length());
      _bc.normalize();
      c = { x: c.x + _bc.x*sh, z: c.z + _bc.z*sh };
    }
    _bc.set(fz*c.x, floatGrp.position.y, fz*c.z);
  }else if(one && st.open){
    /* the middle of the page as it lies, taken while nothing is in the air, so a leaf
       going over does not drag the eye with it */
    pageD = fitWide;
    if(!st.flight && !st.riffle && st.theta > OPEN - 1e-3) for(const sd of [-1, 1]){
      const n = sd > 0 ? 2*st.k : 2*st.k - 1;
      if(n >= 0 && n < 2*N){ const c = pagePointWorld(n, PAGE_W/2, PAGE_H/2).p; pageMid[sd] = { x: c.x, z: c.z }; }
    }
    const c = pageMid[st.focusSide] || { x: st.focusSide*(XJ_O + PW*0.5), z: 0.12 };
    _bc.set(fz*c.x, floatGrp.position.y, fz*c.z);
  }else _bc.set(fz*st.focusSide*(XJ_O + PW*0.5), floatGrp.position.y, fz*0.12);
  sdamp(camTarget, 'x', _bc.x, 0.4, dt); sdamp(camTarget, 'y', _bc.y, 0.3, dt); sdamp(camTarget, 'z', _bc.z, 0.4, dt);
  /* the forest is a picture taken from one point: the further the eye stands from it the
     more it slides apart (low by the stream it tears along the bank and round the trunks),
     so the eye keeps within about two metres of that point, wherever it looks from. The
     book is always let in whole, however far that takes it */
  _rd.subVectors(camera.position, camTarget).normalize();
  _rc.subVectors(camTarget, FOREST_CAP);
  const rb = _rd.dot(_rc), reach = Math.max(fitDistance(), Math.min(CAM_REACH, -rb + Math.sqrt(Math.max(0, rb*rb - _rc.lengthSq() + EYE_SPHERE*EYE_SPHERE))));
  st.zoom = Math.min(st.zoom, Math.max(1, reach/fitDistance()));
  sdamp(st, 'camD', lerp(Math.min(fitDistance()*st.zoom, reach), pageD, fz), 0.45, dt);
  if(st.camEl === undefined) st.camEl = camElevation();
  const el0 = sdamp(st, 'camEl', lerp(camElevation(), WRITE_EL, fz), 0.5, dt);
  /* walking round the rock: a flick coasts on, the eye never sinks into the
     ground, and leaning in to write brings it back to the reader's side */
  if(orbit.coast){
    orbit.azTo += orbit.vx*dt; orbit.elTo += orbit.vy*dt;
    const f = Math.exp(-dt*3.2);
    orbit.vx *= f; orbit.vy *= f;
    if(Math.hypot(orbit.vx, orbit.vy) < 0.02) orbit.coast = false;
  }
  orbit.elTo = clamp(orbit.elTo, ORBIT_EL[0] - camElevation(), ORBIT_EL[1] - camElevation());
  /* the forest is a picture taken from one point a metre over the floor: from much higher
     the stream's bank, which that point never saw, tears into smears and straight seams,
     so looking round the eye rises no more than 60 cm above it */
  const elTop = Math.asin(clamp((FOREST_CAP.y + 6 - camTarget.y)/Math.max(1e-3, st.camD), -1, 1));
  orbit.elTo = Math.min(orbit.elTo, Math.max(0, elTop - camElevation()));
  if(fz < 0.001 && Math.abs(orbit.azTo) > Math.PI){ const w = Math.round(orbit.azTo/(2*Math.PI))*2*Math.PI; orbit.azTo -= w; orbit.az -= w; }
  sdamp(orbit, 'az', orbit.azTo, 0.22, dt); sdamp(orbit, 'el', orbit.elTo, 0.22, dt);
  /* leaning over a page to read or write, the eye is close and may look straight down */
  const az = orbit.az*(1 - fz), el = Math.min(clamp(el0 + orbit.el*(1 - fz), ORBIT_EL[0], Math.max(ORBIT_EL[1], el0)), Math.max(elTop, lerp(ORBIT_EL[0], el0, fz)));
  const ce = Math.cos(el)*st.camD;
  camera.position.set(camTarget.x + Math.sin(az)*ce, camTarget.y + Math.sin(el)*st.camD, camTarget.z + Math.cos(az)*ce);
  camera.position.y = Math.max(camera.position.y, GROUND_Y + 1.0);
  /* closed, the view is lifted a little above the book, so the forest beyond it shows */
  const lift = lerp(2.4, 0, smooth(clamp(frameTheta()/OPEN, 0, 1)))*(1 - fz);
  _bc.set(camTarget.x, camTarget.y + lift, camTarget.z);
  camera.lookAt(_bc);
  if(camBlend) stepCamBlend(dt);
  if(window.__filmCam) window.__filmCam(dt);
  layout(false);
  floatGrp.updateMatrixWorld(true);

  /* the gilt breathes with a faint light of its own */
  matGold.emissiveIntensity = 0.05 + 0.07*Math.pow(0.5 + 0.5*Math.sin(clock*0.7), 2) + st.aura*0.2 + st.gemFlare*0.3;
  stepGems();
  /* held above the stone: from inside the bezel it turned the gold green */
  gemLight.position.set(0, 0, 0.35); frontGem.localToWorld(gemLight.position);
  gemLight.intensity = st.gemFlare*0.8 + st.aura*0.35;
  rayGroup.children.forEach(m=>{ m.material.opacity = m.userData.base*(0.7 + 0.35*Math.sin(clock*0.3 + m.userData.ph)); });
  rockTime.value = clock; nearTime.value = clock;
  beamU.uTime.value = clock;
  /* leaning in close to write, the reader is inside the light: it thins so the page stays clear */
  beamU.uK.value = lerp(0.35, 1, smooth(clamp((camera.position.distanceTo(BEAM_AT) - 8)/10, 0, 1)));
  if(backdrop){ backdrop.material.uniforms.uTime.value = clock; backdrop.material.uniforms.uCam.value.copy(camera.position); }
  const p = dust.geometry.attributes.position, sd = dust.userData.seed;
  for(let i=0;i<p.count;i++){
    let y = p.getY(i) + dt*(0.05 + (sd[i]%10)*0.01);
    let x = p.getX(i) + Math.sin(clock*0.3 + sd[i])*dt*0.08;
    if(y > 8){ y = -0.5; x = (Math.random()-0.5)*18; }
    p.setY(i, y); p.setX(i, x);
  }
  p.needsUpdate = true;
}
function frame(fixed){
  const w = innerWidth || 0, h = innerHeight || 0;
  if(w >= 2 && h >= 2 && (w !== VW || h !== VH)) onResize();
  const now = performance.now();
  const raw = fixed || (now-last)/1000, dt = Math.min(0.05, raw);
  last = now;
  adaptPixels(raw);
  update(dt);
  /* the bob and the jolt die away without ever reaching nought, and for minutes they move
     the book by less than an atom: only a move past a hundredth of a millimetre counts */
  const m = bookRoot.matrixWorld.elements;
  for(let i=0;i<16;i++) if(Math.abs(m[i] - shadowKey[i]) > 1e-4){ shadowKey.set(m); setShadowDirty(true); break; }
  renderer.shadowMap.needsUpdate = shadowDirty;
  setShadowDirty(false);
  if(backdrop) backdrop.draw();
  composer.render(dt);
  prewarmPages(now);
}
/* a phone that cannot keep up draws fewer pixels: frames are timed while the loop runs
   uncapped (not resting at 30), and after a second and a half below 42 a second it steps
   one rung down the ladder, after three quick spells in a row one back up. A rung that
   ran slow is not tried again for a while, longer each time, so it does not see-saw.
   A step down that won nothing (the time goes somewhere other than the pixels) is taken
   back, and the ladder stays there for two minutes rather than blur the book for naught.
   The new size is taken only while nothing moves, since the new targets take a moment */
let prSum = 0, prN = 0, prQuick = 0, prWant = -1, prDown = null, prStop = 0;
const prBan = new Map();
function adaptPixels(raw){
  if(PR_PIN || HI_RES) return;
  const now = performance.now(), i = PR_LEVELS.indexOf(DPR);
  if(document.hidden || raw > 0.25 || still()){ prSum = 0; prN = 0; }
  else if((prSum += raw, ++prN, prSum >= 1.5)){
    const avg = prSum/prN, down = prDown;
    prSum = 0; prN = 0; prDown = null;
    if(down && i === down.from + 1 && avg > down.avg*0.9){ prWant = down.from; prStop = now + 120000; }
    else if(avg > 1/42){
      prQuick = 0;
      if(i < PR_LEVELS.length - 1 && prStop < now){
        const b = prBan.get(i) || { n: 0 };
        b.n++; b.until = now + 15000*Math.pow(3, b.n - 1);
        prBan.set(i, b);
        prDown = { from: i, avg };
        prWant = i + 1;
      }
    }else if(avg < 1/56){
      const b = prBan.get(i - 1);
      if(++prQuick >= 3 && i > 0 && !(b && b.until > now)){ prWant = i - 1; prQuick = 0; }
    }else prQuick = 0;
  }
  if(prWant < 0 || g || pinch || st.flight || st.riffle || coverAnim || spinAnim) return;
  setDPR(PR_LEVELS[prWant]);
  prWant = -1;
  renderer.setPixelRatio(DPR);
  composer.setPixelRatio(DPR);
  onResize();
}
/* the spreads either side of the one in view (or the one a closed book will open on) are
   painted and sent to the GPU ahead, a page at a time while nothing moves, so neither a
   turn nor the opening has to stop and paint eight pages in one frame */
let warmAt = 0;
function prewarmPages(now){
  if(!booted || now - warmAt < 120 || st.flight || st.riffle || coverAnim || g || pinch) return;
  const c = st.open ? st.k : homeSpread();
  if(!HI_RES) restPages(now);
  for(const i of (HI_RES ? [c - 1, c, c - 2, c + 1, c - 3, c + 2] : [c - 1, c, c + 1])){
    if(i < 0 || i >= N) continue;
    for(const n of [2*i, 2*i + 1]){
      if(pageCache.has(n)) continue;
      const e = pageEntry(n);
      renderer.initTexture(e.tex); renderer.initTexture(e.glowTex);
      warmAt = now;
      return;
    }
  }
}
/* a page left alone for a while keeps only its copy on the GPU: the background is
   painted again from its seed, and the page canvas sized again, the next time it changes */
function restPages(now){
  pageCache.forEach((e, n)=>{
    if(!e.canvas.width || e.glowing || burning.has(n) || (writing && writing.n === n) || now - e.used < 4000) return;
    renderer.initTexture(e.tex); renderer.initTexture(e.glowTex);
    [e.bg, e.inked, e.canvas, e.glow].forEach(freeCanvas);
    e.bg = null; e.inked = null; e.inkKey = null;
  });
}
/* left alone, the book draws at most 30 frames a second, and 60 while it moves, even on a
   120 Hz screen: the water and the fireflies still move, and a GPU kept cool has its full
   speed when a finger comes down. A touch, a key or any motion of the book brings back
   every frame for a few seconds */
let activeAt = 0, drawnAt = 0;
['pointerdown', 'pointermove', 'keydown', 'input'].forEach(t=>addEventListener(t, ()=>{ activeAt = performance.now(); }, { capture:true, passive:true }));
function still(){
  return !story && performance.now() - activeAt > 2500 && !g && !pinch && !st.flight && !st.riffle
    && !coverAnim && !spinAnim && !inertia && !orbit.coast && seek.goal === null;
}
/* a moment when nothing is turned, thrown, riffled or played: the late loads lay their
   pictures in then, so an upload never lands in the middle of a gesture */
function calm(){
  const quiet = ()=> !story && !g && !pinch && !st.flight && !st.riffle && !coverAnim && !spinAnim && !inertia && !orbit.coast;
  return new Promise(r=>{ const check = ()=> quiet() ? r() : setTimeout(check, 150); check(); });
}
/* the screen's own frame interval decides which of its frames are drawn: the one nearest
   the step, so a 120 Hz screen draws every other frame, while a 75 or 144 Hz one draws
   at 75 or 72 a second rather than falling to 37 or 48 */
let rafDt = 1000/60, rafAt = 0;
function rafLoop(now){
  requestAnimationFrame(rafLoop);
  if(rafAt) rafDt += (Math.min(50, now - rafAt) - rafDt)*0.1;
  rafAt = now;
  const step = still() ? 1000/30 : 1000/60;
  if(now - drawnAt < step - rafDt*0.6) return;
  drawnAt = now;
  frame();
  meterTick(now, step > 20);
}
/* rAF sleeps in a hidden tab: a turn or an opening already under way still plays out
   (screenshots of a hidden tab stay real), then the book sleeps until it is shown */
setInterval(()=>{ if(document.hidden && !FILM && !still()) frame(); }, 250);

/* while the veil is still up: the spread the book will open on is painted and sent to the
   GPU, and every shader is built, the hidden ones (glows, sparks) and a written page's
   too. Left to the first opening, they froze it for a second on a phone */
async function warmUp(){
  const c = st.open ? st.k : homeSpread();
  const near = new Set();
  for(let i=Math.max(0, c - (HI_RES ? 2 : 1));i<=Math.min(N - 1, c + 1);i++) near.add(i);
  /* the film leaves the book open on its title page: that spread too, alone on a phone */
  if(intro) for(let i=0;i<=(HI_RES ? 1 : 0);i++) near.add(i);
  for(const i of near) for(const n of [2*i, 2*i + 1]){
    const e = pageEntry(n);
    renderer.initTexture(e.tex); renderer.initTexture(e.glowTex);
  }
  layout(true);
  const L = leaves[Math.min(N - 1, c)].mesh, mats = L.material.slice();
  L.material[0] = pageEntry(2*Math.min(N - 1, c)).mat;
  /* one real frame with nothing hidden and nothing culled: compile() alone keys the
     shaders without the shadows and lights a real frame has, and builds them twice */
  const hidden = [], culled = [];
  scene.traverse(o=>{
    if(!o.visible){ hidden.push(o); o.visible = true; }
    if(o.frustumCulled){ culled.push(o); o.frustumCulled = false; }
  });
  try{ if(backdrop) backdrop.draw(); composer.render(0); }catch(_){}
  hidden.forEach(o=>{ o.visible = false; });
  culled.forEach(o=>{ o.frustumCulled = true; });
  L.material = mats;
  await new Promise(r=>requestAnimationFrame(()=>r()));
}

export {
  calm, clock, frame, liveFov, onResize, rafLoop, setStory, update, warmUp
};
