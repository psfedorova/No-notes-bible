/* the spine: one hide of leather from board to board, the lining and headbands */
import * as THREE from 'three';
import { clamp, lerp, smooth, mulberry32, fbm, upsample, cv, tex } from '../lib/textures.js';
import { BACK_GAP, CH, CVR, HI_RES, N, OPEN, PH, ZB } from '../core/config.js';
import { bookRoot } from '../scene/rig.js';
import { matLining } from './materials.js';
import { HINGE_U, matEndpaper } from './paper.js';
import { runeStroke } from './print.js';
import { backDir, hingeOf } from './leaves.js';
import { _H } from './state.js';
import { shed } from '../assets/loaders.js';

/* ---------------- spine leather: one hide from board to board ---------------- */
const SP_U = 72, SP_V = 96, SP_LAP = 0.07, SP_BAND = 0.06;
const BANDS = [0.19, 0.40, 0.60, 0.81];
const spineGeo = new THREE.BufferGeometry();
{
  const cnt = (SP_U+1)*(SP_V+1);
  spineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cnt*3),3));
  const uv = new Float32Array(cnt*2), idx = [];
  for(let j=0;j<=SP_V;j++) for(let i=0;i<=SP_U;i++){ const k=j*(SP_U+1)+i; uv[k*2]=i/SP_U; uv[k*2+1]=j/SP_V; }
  for(let j=0;j<SP_V;j++) for(let i=0;i<SP_U;i++){
    const a=j*(SP_U+1)+i, b=a+1, c=a+SP_U+1, d=c+1;
    idx.push(a,b,c, b,d,c);
  }
  spineGeo.setAttribute('uv', new THREE.BufferAttribute(uv,2));
  spineGeo.setIndex(idx);
}
const matSpine = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0, side: THREE.DoubleSide, clearcoat: 0.2, clearcoatRoughness: 0.45 });
const spineMesh = new THREE.Mesh(spineGeo, matSpine);
spineMesh.castShadow = true; spineMesh.receiveShadow = true;
spineMesh.userData.grab = 'spine';
bookRoot.add(spineMesh);
/* the back is tooled like the boards: gold leaf pressed into the leather, and blind
   tooling (the same tools pressed without gold) for frames and runes. Both go into
   masks that become colour, relief, and metal where the gold lies */
function paintSpine(tile, norImg, roughImg){
  const SW = HI_RES ? 1024 : 512, SH = SW*3, K = SW/512;
  const col = cv(SW, SH), x = col.getContext('2d');
  for(let y=0;y<SH;y+=SW) x.drawImage(tile, 0, y, SW, SW);
  const tiledRep = (src, rx, ry)=>{
    const c = cv(SW, SH), t = c.getContext('2d'), tw = SW/rx, th = SH/ry;
    for(let y=0;y<SH;y+=th) for(let xx=0;xx<SW;xx+=tw) t.drawImage(src, xx, y, tw, th);
    return c;
  };
  const nor = tiledRep(norImg, 1.4, 4), rgh = tiledRep(roughImg, 1.4, 4);
  const goldC = cv(SW, SH), g = goldC.getContext('2d');
  const blindC = cv(SW, SH), b = blindC.getContext('2d');
  [g, b].forEach(c=>{ c.fillStyle = c.strokeStyle = '#fff'; c.lineCap = 'round'; c.lineJoin = 'round'; });

  BANDS.forEach(v=>{
    const y = (1-v)*SH, bh = SH*0.026;
    x.fillStyle = 'rgba(0,0,0,.18)'; x.fillRect(0, y-bh/2, SW, bh);
    [-bh/2-5*K, bh/2+5*K].forEach(dy=>g.fillRect(SW*0.06, y+dy-1.6*K, SW*0.88, 3.2*K));
    for(let px=SW*0.1; px<SW*0.9; px+=14*K){ g.beginPath(); g.arc(px, y, 2.2*K, 0, 7); g.fill(); }
  });

  /* a canvas pixel across the round covers less leather than one along the spine:
     each panel is drawn wide by that ratio so its tooling lands undistorted */
  const stretch = (SW*(1 - 2*SP_UV_EDGE)/spineArc)/(SH/CH);
  const across = SW*(1 - 2*SP_UV_EDGE);
  const panel = (v0, v1, draw)=>{
    [g, b].forEach(c=>{ c.save(); c.translate(SW/2, (1-(v0+v1)/2)*SH); c.scale(stretch, 1); });
    draw(across/stretch, (v1 - v0)*SH);
    [g, b].forEach(c=>c.restore());
  };
  const starPath = (c, cx, cy, ro, ri, n, a0 = -Math.PI/2)=>{
    c.beginPath();
    for(let i=0;i<n*2;i++){ const r = i%2 ? ri : ro, a = a0 + i*Math.PI/n; i ? c.lineTo(cx + Math.cos(a)*r, cy + Math.sin(a)*r) : c.moveTo(cx + Math.cos(a)*r, cy + Math.sin(a)*r); }
    c.closePath();
  };
  const sparkle = (cx, cy, r)=>{ starPath(g, cx, cy, r, r*0.28, 4); g.fill(); };
  /* every panel sits in a blind double fillet with a gilt sparkle at each corner */
  const frame = (w, h)=>{
    const fx = w*0.40, fy = h/2 - SH*0.038, d = 7*K;
    b.lineWidth = 2.4*K; b.strokeRect(-fx, -fy, fx*2, fy*2);
    b.lineWidth = 1.1*K; b.strokeRect(-fx + d, -fy + d, (fx - d)*2, (fy - d)*2);
    [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx, sy])=>sparkle(sx*(fx - d), sy*(fy - d), 7*K));
    return { fx: fx - d, fy: fy - d };
  };
  const word = (text, cy, maxW, maxH, weight = 700)=>{
    g.font = `${weight} 100px "Cormorant SC", serif`;
    const s = Math.floor(100*Math.min(maxW/g.measureText(text).width, maxH/100));
    g.font = `${weight} ${s}px "Cormorant SC", serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 0, cy);
  };

  /* head: the magic circle of the pages' watermark, in gold, runes pressed blind round it */
  panel(BANDS[3], 0.985, (w, h)=>{
    frame(w, h);
    const R = Math.min(w*0.27, h*0.27), rnd = mulberry32(777);
    g.lineWidth = 2.2*K; g.beginPath(); g.arc(0, 0, R, 0, 7); g.stroke();
    b.lineWidth = 1.2*K; b.beginPath(); b.arc(0, 0, R*0.74, 0, 7); b.stroke();
    b.beginPath(); b.arc(0, 0, R*0.2, 0, 7); b.stroke();
    b.lineWidth = 1.3*K;
    for(let i=0;i<14;i++){
      b.save(); b.rotate(i/14*Math.PI*2); b.translate(0, -R*0.87);
      runeStroke(b, Math.floor(rnd()*6), R*0.075, R*0.04);
      b.restore();
    }
    g.lineWidth = 1.6*K; g.beginPath();
    for(let i=0;i<=7;i++){ const a = -Math.PI/2 + i*3*Math.PI*2/7; i ? g.lineTo(Math.cos(a)*R*0.72, Math.sin(a)*R*0.72) : g.moveTo(Math.cos(a)*R*0.72, Math.sin(a)*R*0.72); }
    g.stroke();
    for(let i=0;i<7;i++){ const a = -Math.PI/2 + i*Math.PI*2/7; g.beginPath(); g.arc(Math.cos(a)*R, Math.sin(a)*R, 3.6*K, 0, 7); g.fill(); }
    g.beginPath(); g.arc(0, 0, 4*K, 0, 7); g.fill();
  });
  panel(BANDS[2], BANDS[3], (w, h)=>{ const f = frame(w, h); word('LIBER', 0, f.fx*1.5, f.fy*0.8); });
  panel(BANDS[1], BANDS[2], (w, h)=>{ const f = frame(w, h); word('ARCANUM', 0, f.fx*1.6, f.fy*0.8); });
  /* the moon waxing, full and waning, under a little constellation */
  panel(BANDS[0], BANDS[1], (w, h)=>{
    const f = frame(w, h), r = f.fx*0.27, cy = f.fy*0.18;
    b.beginPath(); b.arc(0, cy, r*0.86, 0, 7); b.fill();
    g.lineWidth = 2.6*K; g.beginPath(); g.arc(0, cy, r, 0, 7); g.stroke();
    starPath(g, 0, cy, r*0.5, r*0.2, 7); g.fill();
    [-1, 1].forEach(d=>{
      const cx = d*r*1.95, rc = r*0.8;
      g.save();
      g.beginPath(); g.rect(-w, -h, w*2, h*2); g.arc(cx - d*rc*0.42, cy, rc*0.86, 0, 7); g.clip('evenodd');
      g.beginPath(); g.arc(cx, cy, rc, 0, 7); g.fill();
      g.restore();
    });
    const pts = [[-f.fx*0.62, -f.fy*0.62], [-f.fx*0.18, -f.fy*0.8], [f.fx*0.34, -f.fy*0.56], [f.fx*0.7, -f.fy*0.74]];
    b.lineWidth = 1*K; b.setLineDash([2*K, 5*K]);
    b.beginPath(); pts.forEach(([px, py], i)=> i ? b.lineTo(px, py) : b.moveTo(px, py)); b.stroke();
    b.setLineDash([]);
    pts.forEach(([px, py], i)=>sparkle(px, py, (i%2 ? 7 : 10)*K));
  });
  /* tail: the book's motto, "what is written remains" */
  panel(0.015, BANDS[0], (w, h)=>{
    const f = frame(w, h);
    word('SCRIPTA', -f.fy*0.3, f.fx*1.45, f.fy*0.42, 600);
    word('MANENT', f.fy*0.3, f.fx*1.45, f.fy*0.42, 600);
  });

  const mk = (blur, ...srcs)=>{
    const c = cv(SW, SH), t = c.getContext('2d');
    t.fillStyle = '#000'; t.fillRect(0, 0, SW, SH);
    if(blur) t.filter = `blur(${blur}px)`;
    t.globalCompositeOperation = 'lighter';
    srcs.forEach(s=>t.drawImage(s, 0, 0));
    return t.getImageData(0, 0, SW, SH).data;
  };
  const gS = mk(0, goldC), bS = mk(0, blindC), tight = mk(1.2*K, goldC, blindC), wide = mk(4*K, goldC, blindC);
  const wear = upsample(fbm(SW>>3, SH>>3, 3, 9, 3, 515), SW>>3, SH>>3, SW, SH);
  const cd = x.getImageData(0, 0, SW, SH), cp = cd.data;
  const nc = nor.getContext('2d'), nd = nc.getImageData(0, 0, SW, SH), np = nd.data;
  const pbr = cv(SW, SH), pc = pbr.getContext('2d'), rp = rgh.getContext('2d').getImageData(0, 0, SW, SH).data;
  const pd = pc.createImageData(SW, SH), pp = pd.data;
  for(let y=0;y<SH;y++) for(let xx=0;xx<SW;xx++){
    const i = y*SW + xx, p = i*4;
    const rub = clamp((wear[i] - 0.5)*2.4, 0, 1);
    const gm = gS[p]/255*(1 - rub*0.45), bm = bS[p]/255, halo = wide[p]/255;
    const lum = 0.84 + (wear[i] - 0.5)*0.35;
    for(let k=0;k<3;k++){
      const leather = cp[p+k]*(1 - halo*0.3)*(1 - bm*0.45);
      cp[p+k] = clamp(lerp(leather, [228, 182, 96][k]*lum, gm), 0, 255);
    }
    const xm = Math.max(0, xx-1), xp = Math.min(SW-1, xx+1), ym = Math.max(0, y-1), yp = Math.min(SH-1, y+1);
    const dx = (tight[(y*SW+xp)*4] - tight[(y*SW+xm)*4])/255, dy = (tight[(yp*SW+xx)*4] - tight[(ym*SW+xx)*4])/255;
    let nx = (np[p]/255*2-1)*(1 - gm*0.4) + dx*1.5, ny = (np[p+1]/255*2-1)*(1 - gm*0.4) - dy*1.5, nz = np[p+2]/255*2-1;
    const l = Math.hypot(nx, ny, nz) || 1;
    np[p] = (nx/l*0.5+0.5)*255; np[p+1] = (ny/l*0.5+0.5)*255; np[p+2] = (nz/l*0.5+0.5)*255;
    pp[p] = 0; pp[p+1] = lerp(clamp(90 + rp[p]*0.55 - bm*35, 50, 230), 100 + rub*40, gm); pp[p+2] = gm*255; pp[p+3] = 255;
  }
  x.putImageData(cd, 0, 0);
  nc.putImageData(nd, 0, 0);
  pc.putImageData(pd, 0, 0);
  const vig = x.createLinearGradient(0,0,SW,0);
  vig.addColorStop(0,'rgba(3,5,10,.55)'); vig.addColorStop(SP_UV_EDGE + 0.03,'rgba(3,5,10,0)');
  vig.addColorStop(1 - SP_UV_EDGE - 0.03,'rgba(3,5,10,0)'); vig.addColorStop(1,'rgba(3,5,10,.55)');
  x.fillStyle = vig; x.fillRect(0,0,SW,SH);
  const pbrTex = shed(tex(pbr, {wrap:false}));
  matSpine.map = shed(tex(col, {srgb:true, wrap:false}));
  matSpine.normalMap = shed(tex(nor, {wrap:false}));
  matSpine.roughnessMap = pbrTex; matSpine.metalnessMap = pbrTex;
  matSpine.roughness = 1; matSpine.metalness = 1; matSpine.envMapIntensity = 1.35;
  matSpine.needsUpdate = true;
}
function bandBump(v){
  let b = 0;
  BANDS.forEach(c=>{ const d = Math.abs(v-c)/0.03; if(d<1) b = Math.max(b, Math.pow(Math.cos(d*Math.PI/2), 0.7)); });
  return b;
}
const _sp = { px:new Float32Array(SP_U+1), pz:new Float32Array(SP_U+1), nx:new Float32Array(SP_U+1), nz:new Float32Array(SP_U+1), w:new Float32Array(SP_U+1), u:new Float32Array(SP_U+1) };
const SP_UV_EDGE = 0.06;            // canvas margin each side for the laps onto the boards
let spineArc = 0.81;                // the round of the back, board edge to board edge, as last laid out
const SP_LAPN = 5;                  // columns of the hide lapped onto each board
/* head and tail: the hide is turned in at either end, so its edge shows the leather's
   thickness, and once the back has gone hollow the tube between the leather and the
   sewn backs opens under the headband, its paper lining fading into the dark */
const SP_TH = 0.011, SP_TURN = 0.035;   // leather thickness at the turn-in, and its depth inside
const SP_SAG = 0.032;                   // the round the hollow back keeps when the book lies open, down to the boards' outer faces
const SP_JOINT = 1.1;                   // reach of the leather's turn onto the round, per unit of its span
const SP_EDGE = 1.2*CVR;                // reach of its turn round a board's edge
const matHollow = new THREE.MeshStandardMaterial({ color: 0x4a3622, roughness: 1, metalness: 0, side: THREE.DoubleSide, vertexColors: true });
const spineCaps = [-1, 1].map(side=>{
  const lip = ribbon(SP_U - 2*SP_LAPN + 1, 3, matSpine);
  lip.castShadow = true;
  lip.userData.grab = 'spine';
  const hollow = ribbon(SP_U - 2*SP_LAPN + 1, 3, matHollow);
  hollow.userData.grab = 'spine';
  const n = SP_U - 2*SP_LAPN + 1, col = new Float32Array(n*3*3);
  for(let k=0;k<n*3;k++) col.fill(k < n ? 0.75 : 0.18, k*3, k*3 + 3);
  hollow.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return { side, lip, hollow };
});
const _spTight = Array.from({length:SP_U+1}, ()=>[0, 0]);
/* the hide runs from the back board, round the sewn backs of the leaves (offset
   outwards by BACK_GAP), to the front board. Closed it is the rounded spine; open
   it rounds under the block from joint to joint and rests on what the boards rest on. */
function updateSpine(C){
  const ax = C.xb, az = ZB - CVR;
  const bx = C.ex - C.nx*CVR, bz = C.ez - C.nz*CVR;
  const back = [];
  for(let i=N-1;i>=0;i-=1){
    const o = backDir(C, i);
    hingeOf(C, i, _H);
    back.push([_H.x + o.x*BACK_GAP, _H.z + o.z*BACK_GAP]);
  }
  const P = [];
  const LAPN = SP_LAPN, TR = 8, NB = SP_U + 1 - 2*LAPN - 2*TR;
  for(let i=0;i<LAPN;i++){ const t=i/LAPN; P.push([ax + SP_LAP*(1-t), az, 0]); }
  /* the round of the back, first and last sewn back included. Hollow back: as the
     boards go down flat the hide lets go of the sewn backs and rounds under them,
     a narrow tube between, instead of arching up with them */
  const hol = smooth(clamp((C.theta/OPEN - 0.45)/0.55, 0, 1));
  const L0 = back[0], L1 = back[back.length-1];
  const cl = Math.hypot(L1[0] - L0[0], L1[1] - L0[1]) || 1;
  const sgx = (L0[1] - L1[1])/cl*SP_SAG, sgz = (L1[0] - L0[0])/cl*SP_SAG;
  /* drawn tight from board to board the leather spans the backs it cannot reach:
     only the sewn backs on the outside of the band carry it */
  const band = [[ax, az]];
  for(const p of back.concat([[bx, bz]])){
    while(band.length > 1){
      const a = band[band.length-2], b = band[band.length-1];
      if((b[0]-a[0])*(p[1]-b[1]) - (b[1]-a[1])*(p[0]-b[0]) <= 0) break;
      band.pop();
    }
    band.push(p);
  }
  const held = band.length > 3 ? band.slice(1, -1) : [L0, L1];
  const cum = [0];
  for(let i=1;i<held.length;i++) cum.push(cum[i-1] + Math.hypot(held[i][0]-held[i-1][0], held[i][1]-held[i-1][1]));
  const mid = [];
  for(let i=0, h=0;i<NB;i++){
    const s = i/(NB-1), at = s*cum[cum.length-1];
    while(h < held.length - 2 && cum[h+1] < at) h++;
    const f = clamp((at - cum[h])/((cum[h+1] - cum[h]) || 1), 0, 1);
    const tx = lerp(held[h][0], held[h+1][0], f), tz = lerp(held[h][1], held[h+1][1], f);
    const g = s*(back.length-1), a = back[Math.floor(g)], b = back[Math.min(back.length-1, Math.floor(g)+1)];
    _spTight[LAPN + TR + i][0] = lerp(a[0], b[0], g - Math.floor(g)); _spTight[LAPN + TR + i][1] = lerp(a[1], b[1], g - Math.floor(g));
    const bow = 4*s*(1 - s);
    const hx = lerp(L0[0], L1[0], s) + sgx*bow, hz = lerp(L0[1], L1[1], s) + sgz*bow;
    mid.push([lerp(tx, hx, hol), lerp(tz, hz, hol)]);
  }
  /* each board edge turns onto the round as a cubic that leaves the board along its
     face and meets the round along the round's own direction, so the leather has no
     crease at the joint at any angle of the board */
  const joint = (px, pz, mx, mz, qx, qz, nx2, nz2, i, from)=>{
    const t = i/TR, t2 = t*t, t3 = t2*t;
    const h00 = 2*t3 - 3*t2 + 1, h10 = t3 - 2*t2 + t, h01 = 3*t2 - 2*t3, h11 = t3 - t2;
    return [h00*px + h10*mx + h01*qx + h11*nx2, h00*pz + h10*mz + h01*qz + h11*nz2, from ? t : 1 - t];
  };
  const dir = (a, b)=>{ const l = Math.hypot(b[0]-a[0], b[1]-a[1]) || 1; return [(b[0]-a[0])/l, (b[1]-a[1])/l]; };
  const M0 = mid[0], M1 = mid[NB-1], d0 = dir(mid[0], mid[1]), d1 = dir(mid[NB-2], mid[NB-1]);
  const kA = Math.hypot(M0[0] - ax, M0[1] - az)*SP_JOINT, kB = Math.hypot(bx - M1[0], bz - M1[1])*SP_JOINT;
  const eA = Math.min(kA, SP_EDGE), eB = Math.min(kB, SP_EDGE);
  for(let i=0;i<TR;i++) P.push(joint(ax, az, -eA, 0, M0[0], M0[1], d0[0]*kA, d0[1]*kA, i, true));
  for(let i=0;i<NB;i++) P.push([mid[i][0], mid[i][1], 1]);
  for(let i=1;i<=TR;i++) P.push(joint(M1[0], M1[1], d1[0]*kB, d1[1]*kB, bx, bz, C.dx*eB, C.dz*eB, i, false));
  for(let i=1;i<=LAPN;i++){ const t=i/LAPN; P.push([bx + C.dx*SP_LAP*t, bz + C.dz*SP_LAP*t, 0]); }
  for(let i=LAPN;i<LAPN+TR;i++){ _spTight[i][0] = P[i][0]; _spTight[i][1] = P[i][1]; }
  for(let i=SP_U-LAPN-TR+1;i<=SP_U-LAPN;i++){ _spTight[i][0] = P[i][0]; _spTight[i][1] = P[i][1]; }
  /* the leather's artwork is laid by arc length: the round of the back (board edge to
     board edge) takes the middle of the canvas, the laps onto the boards its margins,
     so lettering keeps its shape and never wraps under the boards */
  const r0 = LAPN, r1 = SP_U - LAPN;
  let arc = 0;
  _sp.u[r0] = 0;
  for(let i=r0+1;i<=r1;i++){ arc += Math.hypot(P[i][0]-P[i-1][0], P[i][1]-P[i-1][1]); _sp.u[i] = arc; }
  for(let i=0;i<=SP_U;i++){
    const a = P[Math.max(0,i-1)], b = P[Math.min(SP_U,i+1)];
    let tx = b[0]-a[0], tz = b[1]-a[1];
    const l = Math.hypot(tx,tz) || 1; tx/=l; tz/=l;
    _sp.px[i]=P[i][0]; _sp.pz[i]=P[i][1]; _sp.nx[i]=-tz; _sp.nz[i]=tx; _sp.w[i]=smooth(clamp(P[i][2],0,1));
  }
  for(let i=0;i<=SP_U;i++){
    _sp.u[i] = i < r0 ? SP_UV_EDGE*i/r0 : i > r1 ? 1 - SP_UV_EDGE*(SP_U - i)/LAPN : SP_UV_EDGE + (1 - 2*SP_UV_EDGE)*_sp.u[i]/arc;
  }
  spineArc = arc;
  const uvA = spineGeo.attributes.uv;
  for(let j=0;j<=SP_V;j++) for(let i=0;i<=SP_U;i++) uvA.setX(j*(SP_U+1)+i, _sp.u[i]);
  uvA.needsUpdate = true;
  const pos = spineGeo.attributes.position;
  for(let j=0;j<=SP_V;j++){
    const v = j/SP_V, y = (v-0.5)*CH, bump = bandBump(v)*SP_BAND;
    for(let i=0;i<=SP_U;i++){
      const lap = i < r0 ? i/r0 : i > r1 ? (SP_U - i)/LAPN : 1;
      const off = lerp(-0.0006, 0.0035, lap) + bump*_sp.w[i];
      pos.setXYZ(j*(SP_U+1)+i, _sp.px[i] + _sp.nx[i]*off, y, _sp.pz[i] + _sp.nz[i]*off);
    }
  }
  pos.needsUpdate = true;
  spineGeo.computeVertexNormals();
  spineGeo.computeBoundingSphere();
  spineCaps.forEach(({side, lip, hollow})=>{
    const yE = side*CH/2, yT = side*(CH/2 - SP_TURN), yH = side*(PH/2 - 0.3), cols = r1 - r0 + 1;
    const p = lip.geometry.attributes.position, uv = lip.geometry.attributes.uv;
    const q = hollow.geometry.attributes.position;
    for(let c=0;c<cols;c++){
      const i = r0 + c, nx = _sp.nx[i], nz = _sp.nz[i];
      const ox = _sp.px[i] + nx*0.0035, oz = _sp.pz[i] + nz*0.0035;
      const ix = _sp.px[i] - nx*SP_TH, iz = _sp.pz[i] - nz*SP_TH;
      p.setXYZ(c, ox, yE, oz);
      p.setXYZ(cols + c, ix, yE, iz);
      p.setXYZ(2*cols + c, ix, yT, iz);
      uv.setXY(c, _sp.u[i], side > 0 ? 1 : 0);
      uv.setXY(cols + c, _sp.u[i], side > 0 ? 0.99 : 0.01);
      uv.setXY(2*cols + c, _sp.u[i], side > 0 ? 0.985 : 0.015);
      const a = _spTight[Math.max(r0, i-1)], b = _spTight[Math.min(r1, i+1)];
      const tl = Math.hypot(b[0]-a[0], b[1]-a[1]) || 1, inset = (BACK_GAP - 0.004)*_sp.w[i];
      q.setXYZ(c, ix, yT, iz);
      q.setXYZ(cols + c, ix, yH, iz);
      q.setXYZ(2*cols + c, _spTight[i][0] + (b[1]-a[1])/tl*inset, yH, _spTight[i][1] - (b[0]-a[0])/tl*inset);
    }
    p.needsUpdate = true; uv.needsUpdate = true; q.needsUpdate = true;
    lip.geometry.computeVertexNormals();
    hollow.geometry.computeVertexNormals();
    hollow.visible = C.theta > 0.02;
  });
}

/* ---------------- block back: lining, headbands, endpaper joints ---------------- */
function ribbon(cols, rows, mat){
  const g = new THREE.BufferGeometry();
  const cnt = cols*rows;
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cnt*3),3));
  const uv = new Float32Array(cnt*2), idx = [];
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){ const k=r*cols+c; uv[k*2]=c/(cols-1); uv[k*2+1]=r/(rows-1); }
  for(let r=0;r<rows-1;r++) for(let c=0;c<cols-1;c++){ const a=r*cols+c; idx.push(a,a+1,a+cols, a+1,a+cols+1,a+cols); }
  g.setAttribute('uv', new THREE.BufferAttribute(uv,2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true; m.frustumCulled = false;
  bookRoot.add(m);
  return m;
}
const lining = ribbon(N, 2, matLining);
/* the hinge strips carry on the doublure's leather: u runs from its spine edge
   (HINGE_U) down to the gutter (0) */
const jointF = ribbon(10, 2, matEndpaper);
const jointB = ribbon(10, 2, matEndpaper);
[jointF, jointB].forEach(j=>{
  const uv = j.geometry.attributes.uv;
  for(let i=0;i<uv.count;i++) uv.setX(i, HINGE_U*(1 - uv.getX(i)));
});
/* headbands: silk wound round a core, cream and madder, sitting on the backs */
const HB_SEG = 10, HB_R = 0.017;
const headbandTex = (()=>{
  const c = cv(64, 32), x = c.getContext('2d');
  for(let i=0;i<8;i++){
    x.fillStyle = i%2 ? '#e9dcc0' : '#7d1d16';
    x.beginPath(); x.moveTo(i*8, 0); x.lineTo(i*8+8, 0); x.lineTo(i*8+2, 32); x.lineTo(i*8-6, 32); x.closePath(); x.fill();
    x.beginPath(); x.moveTo(i*8+64, 0); x.lineTo(i*8+72, 0); x.lineTo(i*8+66, 32); x.lineTo(i*8+58, 32); x.closePath(); x.fill();
  }
  const g = x.createLinearGradient(0,0,0,32);
  g.addColorStop(0,'rgba(0,0,0,.35)'); g.addColorStop(.5,'rgba(255,255,255,.08)'); g.addColorStop(1,'rgba(0,0,0,.35)');
  x.fillStyle = g; x.fillRect(0,0,64,32);
  return tex(c, {srgb:true, rx:N/2.2, ry:1});
})();
const headbands = [1,-1].map(side=>{
  const g = new THREE.BufferGeometry();
  const cnt = N*(HB_SEG+1);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cnt*3),3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(cnt*3),3));
  const uv = new Float32Array(cnt*2), idx = [];
  for(let i=0;i<N;i++) for(let k=0;k<=HB_SEG;k++){ const q=i*(HB_SEG+1)+k; uv[q*2]=i/(N-1); uv[q*2+1]=k/HB_SEG; }
  for(let i=0;i<N-1;i++) for(let k=0;k<HB_SEG;k++){
    const a=i*(HB_SEG+1)+k, b=a+1, c2=a+HB_SEG+1, d=c2+1;
    idx.push(a,c2,b, b,c2,d);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv,2));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map:headbandTex, roughness:0.55, metalness:0.05, side:THREE.DoubleSide }));
  m.frustumCulled = false;
  m.userData.side = side;
  bookRoot.add(m);
  return m;
});

export {
  HB_R, HB_SEG, headbands, jointB, jointF, lining, matSpine, paintSpine, spineMesh,
  updateSpine
};
