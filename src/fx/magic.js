/* the quiet magic round the book: motes, the aura, bursts of gold, dust and the inner glow */
import * as THREE from 'three';
import { clamp, lerp, smooth, mulberry32, makeSpriteCanvas } from '../lib/textures.js';
import { damp, sdamp } from '../core/easing.js';
import { CH, CVR, CW, N, OPEN, PAGE_H, PAGE_W, T, ZB } from '../core/config.js';
import { scene } from '../scene/renderer.js';
import { bookRoot, spinGrp } from '../scene/rig.js';
import { pagePointWorld } from '../book/leaves.js';
import { st } from '../book/state.js';
import { sparkMat } from './ink-fx.js';
import { stepLife } from '../scene/forest-life.js';
import { clock } from '../app/loop.js';

/* small magic, the forest's and the book's: cool blue-white wisps, some gold */
const flyMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uScale: { value: 1 } },
  vertexShader: `attribute float alpha, tint; varying float vA, vT; uniform float uScale;
    void main(){ vA = alpha; vT = tint; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = uScale*(0.9 + 1.4*alpha)/max(0.1, -mv.z); }`,
  fragmentShader: `varying float vA, vT;
    void main(){ float d = length(gl_PointCoord - 0.5); float core = smoothstep(0.09, 0.0, d), halo = smoothstep(0.5, 0.0, d);
      float a = (core + halo*halo*halo*0.6)*vA;
      gl_FragColor = vec4(mix(vec3(0.62, 0.88, 1.0), vec3(1.0, 0.86, 0.55), vT)*a*3.0, a); }`
});
/* motes of gold rising slowly off the open pages */
const MOTES = 90;
const moteGeo = new THREE.BufferGeometry();
const motePos = new Float32Array(MOTES*3), moteVel = new Float32Array(MOTES*3);
const moteAge = new Float32Array(MOTES), moteLife = new Float32Array(MOTES), moteAlpha = new Float32Array(MOTES);
moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
moteGeo.setAttribute('alpha', new THREE.BufferAttribute(moteAlpha, 1));
const moteMat = sparkMat.clone();
const motes = new THREE.Points(moteGeo, moteMat);
motes.frustumCulled = false;
scene.add(motes);
let moteNext = 0, moteAcc = 0;
function stepMotes(dt){
  const spread = st.open && st.theta > OPEN - 0.05;
  moteAcc += spread ? dt*7 : 0;
  while(moteAcc >= 1){
    moteAcc -= 1;
    const pagesOpen = [];
    if(st.k > 0) pagesOpen.push(2*st.k - 1);
    if(st.k < N) pagesOpen.push(2*st.k);
    if(!pagesOpen.length) break;
    const n = pagesOpen[(Math.random()*pagesOpen.length)|0];
    const { p, n: nrm } = pagePointWorld(n, PAGE_W*(0.1 + Math.random()*0.8), PAGE_H*(0.08 + Math.random()*0.84));
    const m = moteNext; moteNext = (moteNext + 1) % MOTES;
    motePos[m*3] = p.x + nrm.x*0.02; motePos[m*3+1] = p.y + nrm.y*0.02; motePos[m*3+2] = p.z + nrm.z*0.02;
    const sp = 0.06 + Math.random()*0.08;
    moteVel[m*3] = nrm.x*sp + (Math.random()-0.5)*0.04;
    moteVel[m*3+1] = nrm.y*sp + 0.05;
    moteVel[m*3+2] = nrm.z*sp + (Math.random()-0.5)*0.04;
    moteAge[m] = 0; moteLife[m] = 3 + Math.random()*2.5;
  }
  for(let m=0;m<MOTES;m++){
    if(moteAge[m] >= moteLife[m]){ moteAlpha[m] = 0; continue; }
    moteAge[m] += dt;
    const t = moteAge[m]/moteLife[m];
    motePos[m*3]   += moteVel[m*3]*dt + Math.sin(moteAge[m]*1.7 + m)*0.02*dt;
    motePos[m*3+1] += moteVel[m*3+1]*dt;
    motePos[m*3+2] += moteVel[m*3+2]*dt + Math.cos(moteAge[m]*1.3 + m)*0.02*dt;
    moteAlpha[m] = Math.sin(Math.PI*t)*0.35;
  }
  moteGeo.attributes.position.needsUpdate = true;
  moteGeo.attributes.alpha.needsUpdate = true;
}

/* ---------------- quiet magic around the opening and closing ---------------- */
/* gold sparks circling the book slowly while it opens or closes */
const AURA = 120;
const auraGeo = new THREE.BufferGeometry();
const auraPos = new Float32Array(AURA*3), auraAlpha = new Float32Array(AURA);
const auraSeed = Array.from({length:AURA}, (_, i)=>{ const r = mulberry32(700 + i); return { a: r()*Math.PI*2, r: 0.85 + r()*0.4, h: r(), w: 0.22 + r()*0.32, ph: r()*6.28, tw: 1.5 + r()*3 }; });
auraGeo.setAttribute('position', new THREE.BufferAttribute(auraPos, 3));
auraGeo.setAttribute('alpha', new THREE.BufferAttribute(auraAlpha, 1));
auraGeo.setAttribute('tint', new THREE.BufferAttribute(Float32Array.from({length: AURA}, (_, i)=>i % 2), 1));
const auraMat = flyMat.clone();
const aura = new THREE.Points(auraGeo, auraMat);
aura.frustumCulled = false;
scene.add(aura);
const _ac = new THREE.Vector3();
function stepAura(dt){
  const lvl = Math.max(st.aura, 0.32);
  aura.visible = lvl > 0.002;
  if(!aura.visible) return;
  spinGrp.getWorldPosition(_ac);
  const b = smooth(clamp(st.theta/OPEN, 0, 1));
  const rx = lerp(3.0, 4.6, b), rz = lerp(3.3, 3.4, b);
  for(let i=0;i<AURA;i++){
    const q = auraSeed[i];
    q.a += q.w*dt*(0.6 + st.aura*0.8);
    q.h = (q.h + dt*0.07) % 1;
    auraPos[i*3]   = _ac.x + Math.cos(q.a)*rx*q.r;
    auraPos[i*3+1] = _ac.y - 0.25 + q.h*1.6;
    auraPos[i*3+2] = _ac.z + Math.sin(q.a)*rz*q.r;
    auraAlpha[i] = lvl*Math.sin(Math.PI*q.h)*(0.5 + 0.4*Math.sin(clock*q.tw + q.ph));
  }
  auraGeo.attributes.position.needsUpdate = true;
  auraGeo.attributes.alpha.needsUpdate = true;
}

/* free particles: gold breathed off the pages as they open, dust knocked out
   from under the boards when they shut */
function particlePool(count, mat){
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count*3), vel = new Float32Array(count*3), alpha = new Float32Array(count);
  const age = new Float32Array(count), life = new Float32Array(count), gain = new Float32Array(count);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  let next = 0, live = 0;
  return {
    emit(x, y, z, vx, vy, vz, lf, g){
      const k = next; next = (next + 1) % count;
      pos[k*3] = x; pos[k*3+1] = y; pos[k*3+2] = z;
      vel[k*3] = vx; vel[k*3+1] = vy; vel[k*3+2] = vz;
      age[k] = 0; life[k] = lf; gain[k] = g; live = count;
    },
    step(dt, drag, rise){
      if(!live) return;
      let any = 0;
      const f = Math.exp(-drag*dt);
      for(let k=0;k<count;k++){
        if(age[k] >= life[k]){ alpha[k] = 0; continue; }
        any = 1;
        age[k] += dt;
        vel[k*3] *= f; vel[k*3+1] = vel[k*3+1]*f + rise*dt; vel[k*3+2] *= f;
        pos[k*3] += vel[k*3]*dt; pos[k*3+1] += vel[k*3+1]*dt; pos[k*3+2] += vel[k*3+2]*dt;
        const t = age[k]/life[k];
        alpha[k] = gain[k]*Math.min(1, t*8)*(1 - t)*(1 - t);
      }
      live = any;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.alpha.needsUpdate = true;
    }
  };
}
const burstMat = sparkMat.clone();
const burst = particlePool(160, burstMat);
const dustMat = sparkMat.clone();
dustMat.fragmentShader = `varying float vA;
  void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d)*vA; gl_FragColor = vec4(vec3(1.0, 0.84, 0.62)*a, 1.0); }`;
const dust2 = particlePool(140, dustMat);
function emitOpenBurst(count = 110){
  const pg = [];
  if(st.k > 0) pg.push(2*st.k - 1);
  if(st.k < N) pg.push(2*st.k);
  for(let i=0;i<count && pg.length;i++){
    const n = pg[i % pg.length];
    const { p, n: nrm } = pagePointWorld(n, PAGE_W*(0.12 + Math.random()*0.76), PAGE_H*(0.1 + Math.random()*0.8));
    const sp = 0.25 + Math.random()*0.5;
    burst.emit(p.x + nrm.x*0.02, p.y + nrm.y*0.02, p.z + nrm.z*0.02,
      nrm.x*sp + (Math.random()-0.5)*0.3, nrm.y*sp + 0.15, nrm.z*sp + (Math.random()-0.5)*0.3,
      1.4 + Math.random()*1.6, 0.45 + Math.random()*0.4);
  }
}
/* the closed book in world space: corners of its footprint on the rock */
const _dc = new THREE.Vector3();
function emitDustPuff(){
  for(let i=0;i<110;i++){
    const side = i % 4, t = Math.random();
    const lx = side < 2 ? lerp(0, CW, t) : (side === 2 ? 0 : CW);
    const ly = side < 2 ? (side ? CH/2 : -CH/2) : lerp(-CH/2, CH/2, t);
    _dc.set(lx, ly, ZB - CVR*0.5);
    bookRoot.localToWorld(_dc);
    const out = new THREE.Vector3(lx - CW/2, ly, 0).normalize();
    const v = new THREE.Vector3(out.x, out.y, 0).transformDirection(bookRoot.matrixWorld);
    const sp = 0.35 + Math.random()*0.6;
    dust2.emit(_dc.x, _dc.y + 0.05, _dc.z, v.x*sp, 0.12 + Math.random()*0.25, v.z*sp, 1.4 + Math.random()*1.4, 0.07 + Math.random()*0.07);
  }
}
/* warm light spilling out of the gap as the board lifts: a breath of it, the colour
   of the sun on the page, not an orange lamp inside the book */
const innerGlow = new THREE.PointLight(0xffdcb0, 0, 6, 1.6);
scene.add(innerGlow);
const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: (()=>{ const t = new THREE.CanvasTexture(makeSpriteCanvas(128)); t.colorSpace = THREE.SRGBColorSpace; return t; })(),
  color: 0xffe2bc, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true }));
glowSprite.scale.set(5, 5, 1);
scene.add(glowSprite);
const _gp = new THREE.Vector3();

function stepMagic(dt){
  stepLife(dt);
  sdamp(st, 'hover', st.hoverTo, 0.45, dt);
  st.aura = damp(st.aura, st.auraTo, st.auraTo > st.aura ? 3 : 1.4, dt);
  st.glow = damp(st.glow, st.glowTo, st.glowTo > st.glow ? 4 : 1.2, dt);
  st.gemFlare *= Math.exp(-dt*2.2);
  stepAura(dt);
  burst.step(dt, 1.2, 0.08);
  dust2.step(dt, 2.2, 0.05);
  const gap = Math.pow(Math.sin(clamp(st.theta, 0, OPEN)), 0.8);
  const gl = st.glow*(0.25 + 0.75*gap);
  _gp.set(lerp(CW*0.5, 0, smooth(clamp(st.theta/OPEN, 0, 1))), 0, T/2 + 0.8);
  bookRoot.localToWorld(_gp);
  innerGlow.position.copy(_gp);
  innerGlow.intensity = gl*1.8;
  glowSprite.position.copy(_gp);
  glowSprite.material.opacity = gl*0.06;
  glowSprite.visible = gl > 0.003;
}

export {
  auraMat, burstMat, dustMat, emitDustPuff, emitOpenBurst, flyMat, moteMat, particlePool,
  stepMagic, stepMotes
};
