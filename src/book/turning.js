/* open, close and flip: the cover's fall and a leaf's flight */
import { clamp, lerp, smooth } from '../lib/textures.js';
import { damp, easeFlip, easeSine, glideFrom, glideStep, sdamp } from '../core/easing.js';
import { N, OPEN, PW } from '../core/config.js';
import { spinGrp } from '../scene/rig.js';
import { AIR, LAG_MAX, land, leaves } from './leaves.js';
import { queue, st } from './state.js';
import { closedQuat, freeFrame, glideSpin, holdFrame, qOpenHome, setClosedHome } from './view.js';
import { saveSoon } from '../ink/storage.js';
import { exitWriting, pageNoEl, writing } from '../ink/writing.js';
import { sfx } from '../audio/sound.js';
import { emitDustPuff, emitOpenBurst } from '../fx/magic.js';
import { setWriteOnOpen, writePose } from '../input/gestures.js';
import { seek } from '../ink/spells.js';
import { flightPace } from './seek.js';
import { refreshUI } from '../ui/controls.js';

let coverAnim = null;
function setCoverAnim(v){ coverAnim = v; }
/* opening: the book rises a hand's breadth, the board is eased off the block,
   rests a moment, then swings over with its weight while warm light and gold
   leave the pages. closing: the board is lifted past upright, hangs, and falls
   shut under its own weight with a thud and a breath of dust */
function coverPath(open){
  const th = st.theta, segs = [];
  if(open){
    if(th < 0.1){
      /* the stone wakes first, so the light that follows has a cause */
      st.gemFlare = Math.max(st.gemFlare, 0.8);
      segs.push({ d:0.6, to:0.12, e:easeSine }, { d:0.3, to:0.145, e:easeSine });
      segs.push({ d:1.75, to:OPEN, e:easeSine, at:0.45, fire:'burst' });
    }else segs.push({ d:Math.max(0.6, 1.75*(OPEN - th)/OPEN), to:OPEN, e:easeSine });
    st.hoverTo = 0.3; st.auraTo = 1; st.glowTo = 1;
    sfx.shimmer();
  }else{
    /* the board is lifted just past upright and let go still moving, so it
       tips over by itself; fallCover takes it from there */
    const d = Math.max(0.28, 0.95*(th - TIP)/(OPEN - TIP));
    st.hoverTo = 0.16; st.auraTo = 0.45; st.glowTo = 0;
    if(th <= TIP) return fallCover(Math.min(st.thetaVel, 0));
    segs.push({ d, to:TIP, e:easeLift });
    return { path: segs, i:0, t:0, from: th, to: 0, fallV: (TIP - th)*EASE_LIFT_END/d };
  }
  return { path: segs, i:0, t:0, from: th, to: open ? OPEN : 0 };
}
/* a stiff board on its hinge: gravity pulls harder the lower it gets, then the
   air caught between board and block cushions the last few degrees before it
   shuts with a small rebound */
const TIP = 1.5, FALL_G = 16, FALL_AIR = 3.5, FALL_CUSHION = 0.6;
const easeLift = t => (1 - Math.cos(Math.PI*0.8*t))/(1 - Math.cos(Math.PI*0.8));
const EASE_LIFT_END = Math.PI*0.8*Math.sin(Math.PI*0.8)/(1 - Math.cos(Math.PI*0.8));
function fallCover(v){ return { fall: { v, hits: 0, done: false }, to: 0 }; }
function stepFall(F, dt){
  let th = st.theta;
  const n = Math.ceil(dt/0.004), h = dt/n;
  for(let i=0;i<n && !F.done;i++){
    let a = -FALL_G*Math.cos(th);
    if(F.v < 0 && th < FALL_CUSHION) a -= FALL_AIR*F.v/(th + 0.05)*(1 - th/FALL_CUSHION);
    F.v += a*h; th += F.v*h;
    if(th <= 0){
      th = 0;
      const hit = -F.v;
      if(!F.hits) coverImpact(hit);
      F.hits++;
      if(hit < 0.3 || F.hits > 3) F.done = true;
      else F.v = hit*0.2;
    }
  }
  st.theta = th;
  return F.done;
}
function coverImpact(speed){
  coverEvent('thud');
  st.joltV -= clamp(speed, 0.6, 3)*0.9;
}
function coverEvent(name){
  if(name === 'burst') emitOpenBurst();
  else if(name === 'settle'){ st.hoverTo = 0; }
  else if(name === 'thud'){
    st.auraTo = 0; st.hoverTo = 0; st.gemFlare = 1;
    emitDustPuff();
    sfx.thud();
  }
}
function coverLanded(A){
  if(A.to === OPEN){ st.hoverTo = 0; st.auraTo = 0; st.glowTo = 0; sfx.land(); }
}
/* thrown: the board swings on with the speed the hand gave it; an animation
   already under way is also carried on, never restarted from rest */
function setOpen(open, thrown){
  if((st.flight || st.riffle) && open === false) return;
  if(!open) setWriteOnOpen(false);
  if(writing && !open) exitWriting();
  if(!open && seek.goal !== null){ seek.goal = null; seek.resume = null; pageNoEl.classList.remove('seeking'); }
  const wasOpen = st.open;
  st.open = open;
  const to = open ? OPEN : 0;
  const dur = 1.15*Math.max(0.35, Math.abs(to - st.theta)/OPEN);
  if(!open) coverAnim = coverPath(false);
  else if(thrown || (coverAnim && Math.abs(st.thetaVel) > 0.05)){
    coverAnim = { glide: glideFrom(st.theta, st.thetaVel, to, dur), to };
    st.hoverTo = st.auraTo = st.glowTo = 0;
  }else coverAnim = coverPath(open);
  if(Math.abs(to - st.theta) > 0.4) sfx.creak(open);
  if(wasOpen !== open){
    const from = open ? closedQuat() : qOpenHome, home = spinGrp.quaternion.angleTo(from) < 0.07;
    if(open){ freeFrame(); if(home) glideSpin(qOpenHome, 2.2, st.lift < 0.05); }
    else{ if(home) setClosedHome(qOpenHome); holdFrame(home ? qOpenHome : null, st.lift < 0.05); }
  }
  saveSoon(true);
  refreshUI();
}
function animateFlight(to){
  const fl = st.flight;
  fl.anim = { from: fl.p, to, t:0, dur: Math.max(0.32, 0.9*Math.abs(to - fl.p)) };
}
function landFlight(to){
  const fl = st.flight;
  st.k = to === 1 ? fl.j + 1 : fl.j;
  /* turned in a hurry the next leaf is already on its way down: no air is left
     under this one for it to land on */
  land(leaves[fl.j], fl.lag*clamp(2 - flightPace(), 0, 1), to);
  st.flight = null;
  sfx.settle();
  saveSoon(true);
  refreshUI();
  if(queue.length){ flip(queue.shift()); return; }
  /* back on the title page the reader went there to look: the quill stays down */
  if(resumeWriting){ resumeWriting = false; if(st.k > 0) writePose(); }
}
let resumeWriting = false;
function setResumeWriting(v){ resumeWriting = v; }
function flip(dir, magic){
  if(!st.open || st.theta < OPEN - 1e-3 || coverAnim){ return; }
  if(st.riffle) return;
  if(!magic && seek.goal !== null){ seek.goal = null; seek.resume = null; st.auraTo = 0; pageNoEl.classList.remove('seeking'); }
  if(writing && !(magic && seek.keepQuill)){ resumeWriting = !magic; exitWriting(true); }
  if(st.flight){ if(queue.length < 8) queue.push(dir); return; }
  if(dir > 0 && st.k < N){
    st.flight = { j: st.k, p:0, dragging:false, lead:0, lag:0, sagK:1, vel:0, gy:-0.85, sG:PW, yN:-1, anim:null, settle:null };
    animateFlight(1);
    magic && flightPace() > 2 ? sfx.flick() : sfx.page();
  }else if(dir < 0 && st.k > 0){
    st.flight = { j: st.k-1, p:1, dragging:false, lead:0, lag:0, sagK:1, vel:0, gy:-0.85, sG:PW, yN:-1, anim:null, settle:null };
    animateFlight(0);
    magic && flightPace() > 2 ? sfx.flick() : sfx.page();
  }
}
function stepFlight(dt){
  const fl = st.flight;
  if(!fl) return;
  if(fl.dragging){
    const prev = fl.p;
    fl.p = damp(fl.p, fl.goal, 20, dt);
    fl.vel = damp(fl.vel, (fl.p - prev)/Math.max(dt, 1e-3), 14, dt);
  }else if(fl.settle){
    const s = fl.settle, done = glideStep(s, dt);
    fl.p = clamp(s.x, 0, 1); fl.vel = s.v;
    if(done){ fl.p = s.to; landFlight(s.to); return; }
  }else if(fl.anim){
    const a = fl.anim;
    a.t += dt*flightPace();
    const k = Math.min(1, a.t/a.dur);
    const prev = fl.p;
    fl.p = lerp(a.from, a.to, easeFlip(k));
    fl.vel = (fl.p - prev)/Math.max(dt, 1e-3);
    if(k >= 1){ landFlight(a.to); return; }
  }
  /* the hand leads with the corner it holds, and a turn by itself is lifted by an
     unseen one that lets go a third of the way over; free, the air holds the fore
     edge back the harder the faster the leaf swings. Both follow on a spring, so
     the bend builds and lets go the way paper does, never in a snap */
  const dir = Math.abs(fl.vel) > 0.05 ? Math.sign(fl.vel) : (fl.j < st.k ? -1 : 1);
  const prog = dir > 0 ? fl.p : 1 - fl.p;
  const lead = fl.dragging ? 0.55*Math.sin(Math.PI*fl.p)*dir
             : fl.anim ? 0.75*dir*(1 - smooth(clamp(prog/0.4, 0, 1))) : 0;
  const lag = fl.dragging ? 0 : -LAG_MAX*Math.tanh(AIR*Math.PI*fl.vel/LAG_MAX);
  sdamp(fl, 'lead', lead, 0.09, dt);
  sdamp(fl, 'lag', lag, 0.12, dt);
  sdamp(fl, 'sagK', fl.dragging ? 0.35 : 1, 0.2, dt);
}

export {
  coverAnim, coverEvent, coverLanded, fallCover, flip, setCoverAnim, setOpen,
  setResumeWriting, stepFall, stepFlight
};
