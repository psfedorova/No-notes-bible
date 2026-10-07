/* the leaves: real slabs of parchment, bent by integrating an angle along the arc */
import * as THREE from 'three';
import { clamp, lerp, smooth, mulberry32 } from '../lib/textures.js';
import { ALPHA, EPS, FAN, LH, LT, M, N, OPEN, PAGE_H, PAGE_W, PH, PW, R, RB, SWELL, T, XJ_C, XJ_O, ZB } from '../core/config.js';
import { bookRoot } from '../scene/rig.js';
import { matLeafEdge } from './materials.js';
import { blankMat } from './print.js';

const A_CNT = (M+1)*(R+1);
const V_CNT = 2*A_CNT + 4*(R+1) + 4*(M+1);
const leafIndex = (()=>{
  const top = [], bot = [], wall = [];
  const T_ = (m,r)=> r*(M+1)+m, B_ = (m,r)=> A_CNT + r*(M+1)+m;
  for(let r=0;r<R;r++) for(let m=0;m<M;m++){
    const a=T_(m,r), b=T_(m+1,r), c=T_(m+1,r+1), d=T_(m,r+1);
    top.push(a,b,c, a,c,d);
    const a2=B_(m,r), b2=B_(m+1,r), c2=B_(m+1,r+1), d2=B_(m,r+1);
    bot.push(a2,c2,b2, a2,d2,c2);
  }
  const fore = 2*A_CNT, spn = fore + 2*(R+1), head = spn + 2*(R+1), tail = head + 2*(M+1);
  for(let r=0;r<R;r++){
    const t0=fore+r*2, b0=t0+1, t1=t0+2, b1=t0+3;
    wall.push(t0,b0,t1, t1,b0,b1);
    const s0=spn+r*2, sb0=s0+1, s1=s0+2, sb1=s0+3;
    wall.push(s0,s1,sb0, s1,sb1,sb0);
  }
  for(let m=0;m<M;m++){
    const t0=head+m*2, b0=t0+1, t1=t0+2, b1=t0+3;
    wall.push(t0,t1,b0, t1,b1,b0);
    const u0=tail+m*2, ub0=u0+1, u1=u0+2, ub1=u0+3;
    wall.push(u0,ub0,u1, u1,ub0,ub1);
  }
  return { list:[...top, ...bot, ...wall], nTop: top.length, nBot: bot.length, nWall: wall.length, fore, spn, head, tail };
})();
const leaves = [];
for(let i=0;i<N;i++){
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(V_CNT*3), nrm = new Float32Array(V_CNT*3), uv = new Float32Array(V_CNT*2), col = new Float32Array(V_CNT*3);
  for(let r=0;r<=R;r++) for(let m=0;m<=M;m++){
    const k = r*(M+1)+m;
    uv[k*2] = m/M;               uv[k*2+1] = r/R;
    uv[(A_CNT+k)*2] = 1 - m/M;   uv[(A_CNT+k)*2+1] = r/R;
  }
  const rnd = mulberry32(900 + i*31);
  /* trimmed leaves: no two are quite the same size, but within a fraction of a leaf's
     thickness, so the edges read as one cut face of fine lines rather than a saw of
     corners, each leaf here being far thicker than paper */
  const len = PW*(1 - 0.0015*rnd());
  const yb = -PH/2 + 0.0015*(rnd()-0.35), yt = PH/2 - 0.0015*(rnd()-0.35);
  const tint = 0.84 + rnd()*0.2, warm = 0.92 + rnd()*0.1;
  /* the gutter: a page darkens as it runs down into the sewing, on both sides of
     every leaf, so the spread reads as bound into the spine and not laid beside it */
  const gutter = v => { const s = ((v % A_CNT) % (M+1))/M*len, f = 1 - smooth(clamp(s/0.42, 0, 1)); return 1 - 0.42*Math.pow(f, 1.6); };
  for(let v=0;v<V_CNT;v++){
    const wallV = v >= 2*A_CNT, gs = wallV ? 1 : gutter(v);
    col[v*3]   = wallV ? 0.84*tint : gs;
    col[v*3+1] = wallV ? 0.68*tint : gs;
    col[v*3+2] = wallV ? 0.42*tint*warm : gs;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm,3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv,2));
  g.setAttribute('color', new THREE.BufferAttribute(col,3));
  const across = new Float32Array(V_CNT);
  for(let v=2*A_CNT;v<V_CNT;v++) across[v] = (v - 2*A_CNT) % 2;
  g.setAttribute('aEdge', new THREE.BufferAttribute(across,1));
  g.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(V_CNT).fill(0.84 + (tint - 0.84)*1.1), 1));
  g.setIndex(leafIndex.list);
  g.addGroup(0, leafIndex.nTop, 0);
  g.addGroup(leafIndex.nTop, leafIndex.nBot, 1);
  g.addGroup(leafIndex.nTop + leafIndex.nBot, leafIndex.nWall, 2);
  const mesh = new THREE.Mesh(g, [blankMat[0], blankMat[1], matLeafEdge]);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.userData = { grab:'leaf', leaf:i };
  bookRoot.add(mesh);
  leaves.push({ i, mesh, geo:g, pos, nrm, sig:'', a0:0, len, ds: len/M, yb, yt, flt: 9, float: 0, floatLeft: false });
}

/* rest shape: angle phi0*g(s/ell), g = 1 - smoothstep, so the leaf leaves its
   sewing straight and lands tangentially on the leaf below. The height it gains
   is ell*I(phi0); I is tabulated once and inverted by bisection. */
const gFn = u => u >= 1 ? 0 : 1 - u*u*(3-2*u);
const PHI_MAX = 1.45, I_TAB = 600;
const iTab = new Float32Array(I_TAB+1);
for(let k=0;k<=I_TAB;k++){
  const ph = -PHI_MAX + 2*PHI_MAX*k/I_TAB;
  let s = 0; const NS = 32;
  for(let q=0;q<NS;q++) s += Math.sin(ph*gFn((q+0.5)/NS));
  iTab[k] = s/NS;
}
function solvePhi(ratio){
  if(ratio <= iTab[0]) return -PHI_MAX;
  if(ratio >= iTab[I_TAB]) return PHI_MAX;
  let lo = 0, hi = I_TAB;
  while(hi-lo > 1){ const mid = (lo+hi)>>1; if(iTab[mid] < ratio) lo = mid; else hi = mid; }
  const f = (ratio - iTab[lo])/((iTab[hi]-iTab[lo]) || 1);
  return -PHI_MAX + 2*PHI_MAX*(lo+f)/I_TAB;
}

/* The sewn backs sit on a fixed arc of the block: the split between the two
   stacks slides along it as pages turn, so a book open at its first leaves has
   a low gutter beside the thin stack and the spine only arches up when the
   book is opened near its middle. sigma (leaves on the left, fractional while
   one is in flight) only decides how the fore edges fan. */
const GZ = ZB + EPS + RB*(1 - Math.cos(N/2*ALPHA)) + 0.003;
function layoutCtx(sigma, theta){
  const b = smooth(clamp(theta/OPEN, 0, 1));
  const c = Math.cos(theta), s = Math.sin(theta);
  const pcx = (XJ_C - XJ_O)/2;
  const e0x = XJ_C - pcx, e0z = T/2 + EPS;
  return {
    sigma, theta, b,
    ex: pcx + e0x*c - e0z*s, ez: e0x*s + e0z*c,
    dx: c, dz: s, nx: s, nz: -c,
    xb: lerp(XJ_C, XJ_O, b)
  };
}
function hingeOf(C, i, out){
  const hzc = ZB + EPS + (N-1-i+0.5)*LT, hxc = -SWELL*Math.sin(Math.PI*(i+0.5)/N);
  const psi = (i + 0.5 - N/2)*ALPHA;
  out.x = lerp(hxc, RB*Math.sin(psi), C.b);
  out.z = lerp(hzc, GZ - RB + RB*Math.cos(psi), C.b);
  return out;
}
/* the side of the sewing away from the leaves: -x closed, towards the arc's centre open */
const _bd = { x:0, z:0 };
function backDir(C, i){
  const psi = (i + 0.5 - N/2)*ALPHA;
  let x = lerp(-1, -Math.sin(psi), C.b), z = lerp(0, -Math.cos(psi), C.b);
  const l = Math.hypot(x, z) || 1;
  _bd.x = x/l; _bd.z = z/l;
  return _bd;
}
const RAMP = 3.0;                  // run of a leaf's rise out of the sewing, per unit of stack thickness
function restParams(C, i, left, H){
  let rise, q;
  if(!left){
    rise = (EPS + (N-1-i+0.5)*LT) - (H.z - ZB);
    q = (N - C.sigma) > 0.5 ? (N-1-i)/(N - C.sigma) : 0;
  }else{
    rise = (EPS + (i+0.5)*LT) - ((H.x-C.ex)*C.nx + (H.z-C.ez)*C.nz);
    q = C.sigma > 0.5 ? i/C.sigma : 0;
  }
  /* every leaf of a stack rises out of the sewing over the same run, set by how thick
     the stack is: a leaf higher up then climbs more steeply all along and stays above
     the one below it, instead of their ramps crossing and flickering through each other */
  const thick = (left ? C.sigma : N - C.sigma)*LT;
  const ell = clamp(0.45 + RAMP*Math.max(thick, Math.abs(rise)), 0.45, 0.8*PW);
  /* a leaf that has just landed comes down last at its fore edge, on the air caught
     under it, and gives a small shiver as that air goes */
  const L = leaves[i], t = L.flt, live = t < FLOAT_T;
  const flutter = live ? 0.03*Math.exp(-t*7)*Math.abs(Math.sin(t*16)) : 0;
  const float = live && left === L.floatLeft ? L.float*Math.pow(1 - t/FLOAT_T, 2.2) : 0;
  return { phi0: solvePhi(rise/ell), ell, fan: FAN*clamp(q,0,1)*C.b*C.b + flutter, float, left, theta: C.theta };
}
const FLOAT_T = 0.75;
/* a leaf touching down: whatever its fore edge still trails by is the air under it */
function land(L, lag, to){
  L.flt = 0;
  L.floatLeft = to === 1;
  L.float = Math.max(0, to === 1 ? -lag : lag);
}
function restAngle(P, s){
  const fanW = smooth(clamp((s/PW - 0.62)/0.38, 0, 1));
  const beta = P.phi0*gFn(s/P.ell) + P.fan*fanW + P.float*bendLag(s/PW);
  return P.left ? P.theta - beta : beta;
}
/* a leaf in flight: blend of its two rest shapes, bent the way paper bends. A hand
   at the corner lifts it there first (lead: flat by the spine, curling up to the
   hand); flying free, the air holds the fore edge back (lag: bent mostly near
   the sewing, as a cantilever is); and wherever it is not upright it droops
   under its own weight (sag). Held between the two rests so it can never cut
   into either stack */
const TWIST = 0.55;                // how far the lifted corner runs ahead of the other
const SAG = 0.30;                  // fore-edge droop of a leaf held level, free in the air
const AIR = 0.20;                  // how far the air holds the fore edge back, per rad/s of swing
const LAG_MAX = 1.0;
const bendLead = u => Math.pow(u, 1.6);
const bendLag = u => 0.35*(8*u/3 - 2*u*u + u*u*u*u/3) + 0.65*u;
const bendSag = u => 1 - (1-u)*(1-u)*(1-u);
function flightAngleFn(PR, PL, air, yN){
  const p = air.p;
  const tw = air.gy*yN;
  const lead = air.lead*(1 + TWIST*tw), lag = air.lag*(1 - 0.3*TWIST*tw);
  const aMid = lerp(restAngle(PR, PW*0.5), restAngle(PL, PW*0.5), p);
  /* by the stacks the leaf is borne on the air pressed out from under it */
  const sag = -SAG*air.sagK*Math.cos(aMid)*Math.sqrt(Math.sin(Math.PI*clamp(p, 0, 1)));
  return s=>{
    const aR = restAngle(PR, s), aL = restAngle(PL, s), u = s/PW;
    const a = lerp(aR, aL, p) + lead*bendLead(u) + lag*bendLag(u) + sag*bendSag(u);
    return clamp(a, Math.min(aR,aL), Math.max(aR,aL));
  };
}
const _X = Array.from({length:R+1}, ()=>new Float32Array(M+1));
const _Z = Array.from({length:R+1}, ()=>new Float32Array(M+1));
const _A = Array.from({length:R+1}, ()=>new Float32Array(M+1));
function integrate(hx, hz, angleAt, X, Z, A, ds){
  X[0] = hx; Z[0] = hz;
  for(let m=0;m<=M;m++) A[m] = angleAt(m*ds);
  for(let m=0;m<M;m++){
    const a = angleAt((m+0.5)*ds);
    X[m+1] = X[m] + Math.cos(a)*ds;
    Z[m+1] = Z[m] + Math.sin(a)*ds;
  }
}
function writeLeaf(L, vary){
  const pos = L.pos, nrm = L.nrm;
  const set = (arr, v, x, y, z)=>{ arr[v*3]=x; arr[v*3+1]=y; arr[v*3+2]=z; };
  for(let r=0;r<=R;r++){
    const rr = vary ? r : 0, X = _X[rr], Z = _Z[rr], A = _A[rr];
    const y = L.yb + r/R*(L.yt - L.yb);
    for(let m=0;m<=M;m++){
      const nx = -Math.sin(A[m]), nz = Math.cos(A[m]);
      const k = r*(M+1)+m;
      set(pos, k, X[m]+nx*LH, y, Z[m]+nz*LH);         set(nrm, k, nx, 0, nz);
      set(pos, A_CNT+k, X[m]-nx*LH, y, Z[m]-nz*LH);   set(nrm, A_CNT+k, -nx, 0, -nz);
    }
    const ex = Math.cos(A[M]), ez = Math.sin(A[M]);
    const nxE = -Math.sin(A[M]), nzE = Math.cos(A[M]);
    let v = leafIndex.fore + r*2;
    set(pos, v,   X[M]+nxE*LH, y, Z[M]+nzE*LH); set(nrm, v,   ex, 0, ez);
    set(pos, v+1, X[M]-nxE*LH, y, Z[M]-nzE*LH); set(nrm, v+1, ex, 0, ez);
    const sx = Math.cos(A[0]), sz = Math.sin(A[0]);
    const nx0 = -Math.sin(A[0]), nz0 = Math.cos(A[0]);
    v = leafIndex.spn + r*2;
    set(pos, v,   X[0]+nx0*LH, y, Z[0]+nz0*LH); set(nrm, v,   -sx, 0, -sz);
    set(pos, v+1, X[0]-nx0*LH, y, Z[0]-nz0*LH); set(nrm, v+1, -sx, 0, -sz);
  }
  for(let m=0;m<=M;m++){
    const kH = R*(M+1)+m, kT = m;
    let v = leafIndex.head + m*2;
    pos.copyWithin(v*3, kH*3, kH*3+3);             set(nrm, v, 0, 1, 0);
    pos.copyWithin((v+1)*3, (A_CNT+kH)*3, (A_CNT+kH)*3+3); set(nrm, v+1, 0, 1, 0);
    v = leafIndex.tail + m*2;
    pos.copyWithin(v*3, kT*3, kT*3+3);             set(nrm, v, 0, -1, 0);
    pos.copyWithin((v+1)*3, (A_CNT+kT)*3, (A_CNT+kT)*3+3); set(nrm, v+1, 0, -1, 0);
  }
  L.geo.attributes.position.needsUpdate = true;
  L.geo.attributes.normal.needsUpdate = true;
  L.bsDirty = true;
}
/* a point of page n given in canvas px, in world space, with the page's normal */
const _pp = new THREE.Vector3(), _pn = new THREE.Vector3();
function pagePointWorld(n, px, py){
  const L = leaves[n>>1], recto = n%2 === 0;
  const u = clamp(px/PAGE_W, 0, 1), v = clamp(1 - py/PAGE_H, 0, 1);
  const fm = (recto ? u : 1-u)*M, fr = v*R;
  const m0 = Math.min(M-1, Math.floor(fm)), r0 = Math.min(R-1, Math.floor(fr));
  const tm = fm - m0, tr = fr - r0;
  const base = recto ? 0 : A_CNT;
  const P = L.pos, Nn = L.nrm;
  const at = (arr, m, r, c)=> arr[(base + r*(M+1) + m)*3 + c];
  for(let c=0;c<3;c++){
    const a = lerp(at(P,m0,r0,c), at(P,m0+1,r0,c), tm), b = lerp(at(P,m0,r0+1,c), at(P,m0+1,r0+1,c), tm);
    _pp.setComponent(c, lerp(a, b, tr));
    _pn.setComponent(c, at(Nn, m0, r0, c));
  }
  L.mesh.localToWorld(_pp);
  _pn.transformDirection(L.mesh.matrixWorld);
  return { p: _pp, n: _pn };
}

export {
  _A, _X, _Z, AIR, backDir, flightAngleFn, FLOAT_T, hingeOf, integrate, LAG_MAX, land,
  layoutCtx, leaves, pagePointWorld, restAngle, restParams, writeLeaf
};
