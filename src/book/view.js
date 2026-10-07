/* the view: lying on the rock, lifting to be turned, the orbit and the framing */
import * as THREE from 'three';
import { clamp, lerp, smooth } from '../lib/textures.js';
import { easeSine } from '../core/easing.js';
import { CH, CW, N, OPEN, VH, VW, XJ_O } from '../core/config.js';
import { camera } from '../scene/renderer.js';
import { spinGrp } from '../scene/rig.js';
import { queue, st } from './state.js';
import { exitWriting, writing } from '../ink/writing.js';
import { flip } from './turning.js';
import { quillTo, seek, spreadOf } from '../ink/spells.js';
import { refreshUI } from '../ui/controls.js';

/* book +z (the cover / the spread) faces the sky; its head points away */
const qClosedHome = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI/2, -0.38, 0, 'YXZ'));
const qOpenHome   = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI/2, 0, 0, 'YXZ'));
spinGrp.quaternion.copy(qClosedHome);
/* the hand turns spinGoal; the book follows it, so no mouse step is ever seen raw */
const spinGoal = qClosedHome.clone();
let spinAnim = null;
function setSpinAnim(v){ spinAnim = v; }
const angVel = { x:0, y:0 };          // rad/s, kept on after a flick
let inertia = false;
function setInertia(v){ inertia = v; }
const camTarget = new THREE.Vector3();
/* the eye walks round the rock: az about the vertical, el raised or lowered from
   the framing's own elevation; dragging the forest moves the goals */
const orbit = { az:0, azTo:0, el:0, elTo:0, vx:0, vy:0, coast:false };
const ORBIT_EL = [0.06, 1.38];
/* how far the eye may stand from the boulder: beyond about 3 m the forest picture
   tears, and walking round the old oak would step into its trunk */
const CAM_REACH = 30;

function homeQuat(){ return st.open ? qOpenHome : qClosedHome; }
/* nearly straight down: square enough to read as a flat sheet, not so square
   that the eye's up direction is lost */
const WRITE_EL = 1.5;
/* how much of the screen the buttons and the pager take, top/bottom and sides */
let uiIn = null;
function uiInsets(){
  if(uiIn && uiIn.vw === VW && uiIn.vh === VH) return uiIn;
  const bar = document.querySelector('.ui.bar'), pg = document.getElementById('pager');
  const rb = bar ? bar.getBoundingClientRect() : null, rp = pg && !pg.hidden ? pg.getBoundingClientRect() : null;
  const top = rb && rb.height ? rb.bottom : 0, bot = rp && rp.height ? VH - rp.top : 0;
  const r = { vw: VW, vh: VH, v: clamp(Math.max(top, bot) + 10, 18, VH*0.2), s: clamp(VW*0.03, 8, 18), top, bot };
  if(rp && rp.height) uiIn = r;
  return r;
}
/* the part of the screen the keyboard leaves free, in canvas px */
function visibleBand(){
  const vv = window.visualViewport;
  if(!vv) return { top: 0, h: VH };
  const top = clamp(vv.offsetTop, 0, VH - 1);
  return { top, h: clamp(vv.height, 1, VH - top) };
}

/* ---------------- one page at a time ----------------
   A phone held upright reads the tome as a reader holds a big book close: the eye
   stays over one page, the pager counts pages, and the next page is either the
   other side of the spread (the eye moves over) or the back of the leaf (it turns) */
/* judged on the screen's full height for its width: the keyboard coming up must not
   change how the book is read */
let tallW = 0, tallH = 0;
function onePage(){
  if(VW !== tallW){ tallW = VW; tallH = VH; }
  tallH = Math.max(tallH, VH);
  return VW/tallH < 0.8;
}
const sideOf = n => n % 2 ? -1 : 1;
const pageMid = {};
/* how far the reader has slid the page being written, in page px, and page px per screen px */
let pageScroll = 0, pagePerPx = 1;
function setPageScroll(v){ pageScroll = v; }
function setPagePerPx(v){ pagePerPx = v; }
/* the spread the book will lie open at once the leaves in the air and the ones
   asked for after them are down */
function landingSpread(){
  let k = st.riffle ? st.riffle.k1 : st.k;
  const fl = st.flight;
  if(fl && !fl.dragging){
    const to = fl.anim ? fl.anim.to : fl.settle ? fl.settle.to : null;
    if(to !== null) k = to === 1 ? fl.j + 1 : fl.j;
  }
  if(seek.goal !== null) k = seek.goal;
  for(const d of queue) k = clamp(k + d, 0, N);
  return k;
}
function shownPage(){
  const k = landingSpread();
  if(k <= 0) return 0;
  if(k >= N) return 2*N - 1;
  return st.focusSide > 0 ? 2*k : 2*k - 1;
}
function stepPage(d){
  if(st.riffle || !st.open) return;
  const n = shownPage(), m = clamp(n + d, 0, 2*N - 1);
  if(m === n) return;
  if(writing && m >= 1){ quillTo(m); refreshUI(); return; }
  if(writing) exitWriting();
  st.focusSide = sideOf(m); st.focusTo = 1;
  if(spreadOf(m) !== landingSpread()) flip(d);
  refreshUI();
}
const pageStep = d => onePage() ? stepPage(d) : flip(d);
/* what the camera frames: it follows the board while the book opens, but a
   book being shut is watched from where the reader sits, as a person would;
   only once the board is down and still do the view and the tome ease back */
const shut = { th: null, hold: false, ease: null, spin: null };
const frameTheta = () => shut.th === null ? st.theta : shut.th;
function holdFrame(spinTo, settle){
  shut.th = frameTheta(); shut.hold = true; shut.ease = null;
  shut.spin = spinTo ? { to: spinTo, settle } : null;
}
function releaseFrame(){
  if(!shut.hold) return;
  shut.hold = false;
  shut.ease = { t: -0.45, d: 2.2, from: shut.th };
}
function freeFrame(){ shut.th = null; shut.hold = false; shut.ease = null; shut.spin = null; }
function stepFrame(dt){
  const E = shut.ease;
  if(!E) return;
  E.t += dt;
  if(E.t >= 0 && shut.spin){ glideSpin(shut.spin.to, 2.4, shut.spin.settle); shut.spin = null; }
  const k = clamp(E.t/E.d, 0, 1);
  shut.th = lerp(E.from, 0, easeSine(k));
  if(k >= 1) freeFrame();
}
function camElevation(){ return lerp(0.26, 0.9, smooth(clamp(frameTheta()/OPEN,0,1))); }
function fitDistance(){
  const b = smooth(clamp(frameTheta()/OPEN,0,1));
  const fov = camera.fov*Math.PI/180, aspect = VW/VH;
  const w = lerp(CW + 8.5, 2*(CW + XJ_O) + 2.0, b);
  const el = camElevation();
  const h = lerp(CH*Math.sin(el) + 6.5, CH*Math.sin(el) + 1.6, b);
  /* closed, the whole boulder is in the frame, the book small upon it, as in the reference */
  return Math.max(h/(2*Math.tan(fov/2)), w/(2*Math.tan(fov/2)*aspect), 6)*lerp(1.55, 1, b);
}
function rotateBy(dx, dy){
  const qa = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), dx);
  const camRight = new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion);
  const qb = new THREE.Quaternion().setFromAxisAngle(camRight, dy);
  spinGoal.premultiply(qb).premultiply(qa).normalize();
}
/* settle: the glide turns the book where it lies on the rock instead of lifting it */
function glideSpin(to, dur, settle){
  spinAnim = { q0: spinGrp.quaternion.clone(), q1: to.clone(), t:0, dur, settle: !!settle };
  inertia = false;
}
function atHome(){ return (spinAnim && spinAnim.settle) || (shut.spin && shut.spin.settle) || spinGoal.angleTo(homeQuat()) < 0.05; }

export {
  angVel, atHome, CAM_REACH, camElevation, camTarget, fitDistance, frameTheta, freeFrame,
  glideSpin, holdFrame, homeQuat, inertia, onePage, orbit, ORBIT_EL, pageMid, pagePerPx,
  pageScroll, pageStep, qClosedHome, qOpenHome, releaseFrame, rotateBy, setInertia,
  setPagePerPx, setPageScroll, setSpinAnim, shownPage, sideOf, spinAnim, spinGoal,
  stepFrame, stepPage, uiInsets, visibleBand, WRITE_EL
};
