/* the book's state and its layout each frame */
import { lerp } from '../lib/textures.js';
import { N, PH, R, ZB } from '../core/config.js';
import { setShadowDirty } from '../scene/renderer.js';
import { EP_X0, JOINT_H } from './paper.js';
import { blankMat } from './print.js';
import { matLeafStack } from './materials.js';
import { pageCache, pageEntry, pages, trimCache } from './pages.js';
import { frontGrp } from './boards.js';
import { backGrp } from './sapphire.js';
import { HB_R, HB_SEG, headbands, jointB, jointF, lining, updateSpine } from './spine.js';
import { _A, _X, _Z, backDir, flightAngleFn, FLOAT_T, hingeOf, integrate, layoutCtx, leaves, restAngle, restParams, writeLeaf } from './leaves.js';

const st = {
  theta: 0,           // front board angle, 0 closed .. PI open
  k: 0,               // leaves lying on the left
  flight: null,       // { j, p, dragging, lead, lag, sagK, vel, gy, anim, settle }
  riffle: null,       // a long jump: several leaves in the air at once
  open: false,
  zoom: 1, camD: 14,
  bob: 1,
  lift: 0,
  focus: 0, focusTo: 0, focusSide: 1,  // the camera leaning in over the page being written
  thetaVel: 0,
  hover: 0, hoverTo: 0, aura: 0, auraTo: 0, glow: 0, glowTo: 0, gemFlare: 0,  // the opening's quiet magic
  jolt: 0, joltV: 0   // the whole tome giving on the moss as the board lands
};
const queue = [];
const _H = { x:0, z:0 };
let lastSig = '';
/* the layout is worked out afresh on the next frame even if nothing it reads has moved */
function invalidateLayout(){ lastSig = ''; }
function currentSigma(){
  const rf = st.riffle;
  if(rf){ let s = Math.min(rf.k0, rf.k1); for(let m=0;m<rf.d;m++) s += rf.p[m]; return s; }
  return st.flight ? st.flight.j + st.flight.p : st.k;
}

const _rfAir = { p:0, lead:0, lag:0, gy:-0.85, sagK:1 };
function layout(force){
  const fl = st.flight;
  const sigma = currentSigma();
  const fluttering = leaves.reduce((a, L)=> L.flt < FLOAT_T ? a + L.flt : a, 0);
  const rf = st.riffle;
  const sig = `${st.theta.toFixed(5)}|${sigma.toFixed(5)}|${fl ? fl.lead.toFixed(4)+','+fl.lag.toFixed(4)+','+fl.sagK.toFixed(3)+','+fl.gy.toFixed(3) : ''}|${rf ? rf.tau.toFixed(5) : ''}|${fluttering.toFixed(3)}`;
  if(!force && sig === lastSig) return;
  lastSig = sig;
  setShadowDirty(true);
  const C = layoutCtx(sigma, st.theta);

  backGrp.position.set(C.xb, 0, ZB);
  frontGrp.position.set(C.ex, 0, C.ez);
  frontGrp.rotation.y = -C.theta;

  for(let i=0;i<N;i++){
    const L = leaves[i];
    hingeOf(C, i, _H);
    let air = fl && i === fl.j ? fl : null, left = i < (fl ? fl.j : st.k);
    if(rf){
      const m = rf.fwd ? i - rf.k0 : rf.k0 - 1 - i;
      if(m >= 0 && m < rf.d){
        if(rf.p[m] > 0 && rf.p[m] < 1){ air = _rfAir; air.p = rf.p[m]; air.lead = rf.lead[m]; air.lag = rf.lag[m]; }
        else left = rf.p[m] >= 1;
      }else left = i < rf.k0;
    }
    if(air){
      const PR = restParams(C, i, false, _H), PL = restParams(C, i, true, _H);
      for(let r=0;r<=R;r++){
        const yN = -1 + 2*r/R;
        integrate(_H.x, _H.z, flightAngleFn(PR, PL, air, yN), _X[r], _Z[r], _A[r], L.ds);
      }
      writeLeaf(L, true);
      L.sig = '';
      L.a0 = _A[R>>1][0];
    }else{
      const P = restParams(C, i, left, _H);
      const s2 = `${_H.x.toFixed(5)},${_H.z.toFixed(5)},${P.phi0.toFixed(5)},${P.ell.toFixed(4)},${P.fan.toFixed(4)},${P.float.toFixed(4)},${left?C.theta.toFixed(5):'r'}`;
      if(force || s2 !== L.sig){
        integrate(_H.x, _H.z, s=>restAngle(P, s), _X[0], _Z[0], _A[0], L.ds);
        writeLeaf(L, false);
        L.sig = s2;
        L.a0 = _A[0][0];
      }
    }
  }
  updateBack(C);
  updateSpine(C);
  updateVisibility();
}
function updateBack(C){
  const pos = lining.geometry.attributes.position;
  const ptsX = new Float32Array(N), ptsZ = new Float32Array(N), oX = new Float32Array(N), oZ = new Float32Array(N);
  for(let i=0;i<N;i++){
    hingeOf(C, i, _H);
    const o = backDir(C, i);
    ptsX[i] = _H.x + o.x*0.006; ptsZ[i] = _H.z + o.z*0.006; oX[i] = o.x; oZ[i] = o.z;
    pos.setXYZ(i, ptsX[i], -PH/2 + 0.01, ptsZ[i]);
    pos.setXYZ(N+i, ptsX[i], PH/2 - 0.01, ptsZ[i]);
  }
  pos.needsUpdate = true;
  lining.geometry.computeVertexNormals();
  headbands.forEach(h=>{
    const side = h.userData.side, y0 = side*(PH/2 - HB_R*0.2);
    const P = h.geometry.attributes.position, Nn = h.geometry.attributes.normal;
    for(let i=0;i<N;i++){
      const a = Math.max(0,i-1), b = Math.min(N-1,i+1);
      let tx = ptsX[b]-ptsX[a], tz = ptsZ[b]-ptsZ[a];
      const l = Math.hypot(tx,tz)||1; tx/=l; tz/=l;
      const cx = ptsX[i] - oX[i]*HB_R*0.35, cz = ptsZ[i] - oZ[i]*HB_R*0.35;
      for(let k=0;k<=HB_SEG;k++){
        const ang = k/HB_SEG*Math.PI*2;
        const ny = Math.cos(ang), nn = Math.sin(ang);
        const nx = -tz*nn, nz = tx*nn;
        const q = i*(HB_SEG+1)+k;
        P.setXYZ(q, cx + nx*HB_R, y0 + ny*HB_R, cz + nz*HB_R);
        Nn.setXYZ(q, nx, ny, nz);
      }
    }
    P.needsUpdate = true; Nn.needsUpdate = true;
  });
  /* endpaper joints: board spine edge -> first / last leaf's sewing, as a real joint. The
     strip carries on the pastedown edge to edge, lying on the board at the pastedown's own
     height up to the board's edge, then crosses the gap straight to the leaf. Straight, so
     it always closes the gap and never swings out behind the spine (which then showed
     through from inside); flat on the board, so it never hangs there as a loose panel */
  const joint = (mesh, sx, sz, dx, dz, hx, hz)=>{
    const p = mesh.geometry.attributes.position;
    const ax = sx + dx*EP_X0, az = sz + dz*EP_X0;
    for(let c=0;c<10;c++){
      const x = c < 3 ? lerp(ax, sx, c/3) : lerp(sx, hx, (c - 3)/6);
      const z = c < 3 ? lerp(az, sz, c/3) : lerp(sz, hz, (c - 3)/6);
      p.setXYZ(c, x, -JOINT_H/2, z); p.setXYZ(10+c, x, JOINT_H/2, z);
    }
    p.needsUpdate = true; mesh.geometry.computeVertexNormals();
  };
  hingeOf(C, 0, _H);
  joint(jointF, C.ex + C.nx*0.002, C.ez + C.nz*0.002, C.dx, C.dz, _H.x, _H.z);
  hingeOf(C, N-1, _H);
  joint(jointB, C.xb, ZB + 0.002, 1, 0, _H.x, _H.z);
}

/* which page textures are live, and which leaves cast shadows */
function updateVisibility(){
  const rf = st.riffle;
  const c = rf ? Math.round(currentSigma()) : st.flight ? st.flight.j : st.k;
  const lo = rf ? 3 : 2, hi = rf ? 2 : 1;
  const keep = new Set();
  const open = st.theta > 0.02;
  for(let i=0;i<N;i++){
    const L = leaves[i];
    const near = open && i >= c-lo && i <= c+hi;
    const mats = L.mesh.material;
    /* in the thick of a riffle a leaf with nothing written on it goes by too
       fast to read, so it is not given a page of its own to paint */
    const blur = rf && !pages[2*i].t && !pages[2*i+1].t && !pageCache.has(2*i) && !pageCache.has(2*i+1);
    if(near && !blur){
      const er = pageEntry(2*i), ev = pageEntry(2*i+1);
      keep.add(2*i); keep.add(2*i+1);
      mats[0] = er.mat; mats[1] = ev.mat;
    }else if(open){
      mats[0] = matLeafStack; mats[1] = matLeafStack;
    }else{
      mats[0] = blankMat[0]; mats[1] = blankMat[1];
    }
    L.mesh.castShadow = near;
  }
  trimCache(keep);
}

export {
  _H, currentSigma, invalidateLayout, layout, queue, st
};
