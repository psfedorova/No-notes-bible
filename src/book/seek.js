import { clamp } from '../lib/textures.js';
import { easeSine } from '../core/easing.js';
import { N, OPEN, PAGE_H, PAGE_W } from '../core/config.js';
import { pageCache, pageEntry, pages } from './pages.js';
import { land, leaves, pagePointWorld } from './leaves.js';
import { currentSigma, invalidateLayout, queue, st } from './state.js';
import { onePage, sideOf } from './view.js';
import { saveSoon } from '../ink/storage.js';
import { enterWriting, exitWriting, pageNoEl, writing } from '../ink/writing.js';
import { sfx } from '../audio/sound.js';
import { emitOpenBurst } from '../fx/magic.js';
import { g } from '../input/gestures.js';
import { coverAnim, flip, setOpen } from './turning.js';
import { seek, spreadOf, trail } from '../ink/spells.js';
import { seekIn } from '../ui/dialogs.js';
import { refreshUI, spreadLabel } from '../ui/controls.js';

function flightPace(){
  if(seek.goal === null) return queue.length ? 1.7 : 1;
  const left = Math.abs(seek.goal - st.k) - 1;
  return 1.25 + Math.min(left, 10)*0.9;
}
function seekSpread(k, opts = {}){
  k = clamp(k, 0, N);
  if(g && g.mode === 'turn') return;
  queue.length = 0;
  seek.goal = k;
  seek.resume = opts.resume || null;
  seek.keepQuill = !!opts.keepQuill;
  seek.flourish = opts.flourish !== false;
  if(!st.open){
    if(!coverAnim){ st.k = k; invalidateLayout(); }
    setOpen(true);
  }else if(Math.abs(k - st.k) > 1 && seek.flourish){
    st.auraTo = 0.8;
    sfx.shimmer();
  }
  if(seek.flourish && k !== st.k) pageNoEl.classList.add('seeking');
}
function stepSeek(){
  if(seek.goal === null) return;
  const rf = st.riffle;
  if(rf){
    for(let m=0;m<rf.d;m++){
      const p = rf.p[m];
      if(p <= 0.08 || p >= 0.92 || Math.random() > 0.35) continue;
      const { p: q, n: nrm } = pagePointWorld(2*riffleLeaf(rf, m), PAGE_W*0.98, PAGE_H*Math.random());
      trail.emit(q.x, q.y, q.z, nrm.x*0.16 + (Math.random() - 0.5)*0.16, 0.1 + Math.random()*0.08, nrm.z*0.16 + (Math.random() - 0.5)*0.16, 0.6 + Math.random()*0.5, 0.42);
    }
    return;
  }
  const fl = st.flight;
  if(fl){
    if(Math.abs(seek.goal - st.k) > 1 && Math.random() < 0.7){
      const { p, n: nrm } = pagePointWorld(2*fl.j, PAGE_W*0.98, PAGE_H*Math.random());
      trail.emit(p.x, p.y, p.z, nrm.x*0.2 + (Math.random() - 0.5)*0.2, 0.12 + Math.random()*0.1, nrm.z*0.2 + (Math.random() - 0.5)*0.2, 0.6 + Math.random()*0.5, 0.5);
    }
    return;
  }
  if(coverAnim || !st.open || st.theta < OPEN - 1e-3 || (g && g.mode === 'turn')) return;
  if(seek.goal === st.k){ arrive(); return; }
  if(Math.abs(seek.goal - st.k) > 1) startRiffle(seek.goal);
  else flip(Math.sign(seek.goal - st.k), true);
}
const RIFFLE_LEAF_T = 0.62;
const liftAt = x => 0.7*x + 0.3*x*x;
const riffleLeaf = (rf, m)=> rf.fwd ? rf.k0 + m : rf.k0 - 1 - m;
function startRiffle(k1){
  if(writing && !seek.keepQuill) exitWriting(true);
  const k0 = st.k, d = Math.abs(k1 - k0), dur = 0.9 + 0.42*Math.sqrt(d), span = dur - RIFFLE_LEAF_T;
  st.riffle = { k0, k1, d, fwd: k1 > k0, t: 0, dur, lift: Float32Array.from({ length: d }, (_, m)=> d > 1 ? span*liftAt(m/(d - 1)) : 0),
    tau: 0, p: new Float32Array(d).fill(k1 > k0 ? 0 : 1), lead: new Float32Array(d), lag: new Float32Array(d), lifted: 0, landed: 0, tick: 0, shown: k0,
    warm: [2*k1 - 1, 2*k1, 2*k1 - 2, 2*k1 + 1, 2*k1 - 3, 2*k1 - 4, 2*k1 + 2, 2*k1 + 3].filter(n => n >= 0 && n < 2*N && !pageCache.has(n)) };
  sfx.page();
}
function stepRiffle(dt){
  const rf = st.riffle;
  if(!rf) return;
  rf.t += dt; rf.tick -= dt;
  if(rf.warm.length) pageEntry(rf.warm.shift());
  rf.tau = rf.t;
  const dir = rf.fwd ? 1 : -1;
  for(let m=0;m<rf.d;m++){
    const u = clamp((rf.t - rf.lift[m])/RIFFLE_LEAF_T, 0, 1), q = easeSine(u);
    rf.p[m] = rf.fwd ? q : 1 - q;
    rf.lead[m] = 0.5*dir*Math.sin(Math.PI*clamp(q/0.35, 0, 1));
    rf.lag[m] = -0.6*dir*Math.pow(Math.sin(Math.PI*clamp((q - 0.1)/1.1, 0, 1)), 0.8);
    if(u > 0 && m >= rf.lifted){
      rf.lifted = m + 1;
      if(rf.tick <= 0){ m ? sfx.flick() : sfx.page(); rf.tick = 0.07; }
    }
    if(u >= 1 && m >= rf.landed){ rf.landed = m + 1; land(leaves[riffleLeaf(rf, m)], m === rf.d - 1 ? rf.lag[m] : 0, rf.fwd ? 1 : 0); }
  }
  const shown = Math.round(currentSigma());
  if(shown !== rf.shown && document.activeElement !== seekIn){ rf.shown = shown; seekIn.value = spreadLabel(shown); }
  if(rf.t >= rf.dur){
    st.k = rf.k1;
    st.riffle = null;
    invalidateLayout();
    sfx.settle();
    saveSoon(true);
    refreshUI();
  }
}
function arrive(){
  const r = seek.resume, flourish = seek.flourish;
  seek.goal = null; seek.resume = null; seek.keepQuill = false;
  st.auraTo = 0;
  pageNoEl.classList.remove('seeking');
  if(flourish){ emitOpenBurst(40); sfx.chime(); }
  if(r && r.n >= 1){
    if(!writing || writing.n !== r.n) enterWriting(r.n, r.idx);
    st.focusSide = r.n % 2 ? -1 : 1; st.focusTo = 1;
  }
}
function turnToPage(P){
  const n = clamp(Math.round(P) - 1, 0, 2*N - 1);
  const resume = writing && n >= 1 ? { n, idx: pages[n].t.length } : null;
  st.focusSide = sideOf(n);
  if(onePage()) st.focusTo = 1;
  if(writing && spreadOf(n) !== st.k) exitWriting(true);
  seekSpread(spreadOf(n), { resume });
  if(seek.goal === st.k && st.open && !coverAnim && !st.flight && !st.riffle) arrive();
}

export {
  flightPace, seekSpread, stepRiffle, stepSeek, turnToPage
};
