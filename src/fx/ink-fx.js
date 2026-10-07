/* embers and smoke off the letters as they burn in */
import * as THREE from 'three';
import { clamp, smooth } from '../lib/textures.js';
import { scene } from '../scene/renderer.js';
import { glyphBox } from '../ink/layout.js';
import { BURN_CAP, BURN_T } from '../ink/paint.js';
import { pagePointWorld } from '../book/leaves.js';

/* a few embers lifting off a freshly burned letter: slow, drifting,
   breathing in and out rather than spitting out */
const SPARKS = 240;
const sparkGeo = new THREE.BufferGeometry();
const sparkPos = new Float32Array(SPARKS*3), sparkVel = new Float32Array(SPARKS*3), sparkLife = new Float32Array(SPARKS);
const sparkAlpha = new Float32Array(SPARKS), sparkMax = new Float32Array(SPARKS).fill(1), sparkSeed = new Float32Array(SPARKS);
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
sparkGeo.setAttribute('alpha', new THREE.BufferAttribute(sparkAlpha, 1));
const sparkMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uScale: { value: 1 } },
  vertexShader: `attribute float alpha; varying float vA; uniform float uScale;
    void main(){ vA = alpha; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = uScale*(0.9 + 1.4*alpha)/max(0.1, -mv.z); }`,
  fragmentShader: `varying float vA;
    void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d)*vA; gl_FragColor = vec4(vec3(1.0, 0.82, 0.5)*1.6*a, a); }`
});
/* the burn's own motes: a white-gold ember in a soft orange halo */
const inkSparkMat = sparkMat.clone();
inkSparkMat.vertexShader = `attribute float alpha; varying float vA; uniform float uScale;
    void main(){ vA = alpha; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = uScale*(0.8 + 1.1*alpha)/max(0.1, -mv.z); }`;
inkSparkMat.fragmentShader = `varying float vA;
    void main(){ float d = length(gl_PointCoord - 0.5); float core = smoothstep(0.16, 0.0, d); float halo = smoothstep(0.5, 0.05, d); halo *= halo;
      float a = (core*0.9 + halo*0.4)*vA; gl_FragColor = vec4(mix(vec3(1.0, 0.52, 0.18), vec3(1.0, 0.9, 0.7), core)*1.5*a, a); }`;
const sparks = new THREE.Points(sparkGeo, inkSparkMat);
sparks.frustumCulled = false;
scene.add(sparks);
let sparkNext = 0;
/* lift: the ink leaving the sheet when a page is wiped, a little livelier */
function emitSparks(n, lay, text, at, count, lift){
  for(let i=at; i<at+count; i++){
    const gb = glyphBox(lay, text, i);
    if(!gb) continue;
    if(!lift && Math.random() > 0.55) continue;
    const { p, n: nrm } = pagePointWorld(n, gb.x + gb.w*Math.random(), gb.y - lay.size*(0.15 + Math.random()*0.6));
    const s = sparkNext; sparkNext = (sparkNext+1) % SPARKS;
    sparkPos[s*3] = p.x; sparkPos[s*3+1] = p.y; sparkPos[s*3+2] = p.z;
    const sp = lift ? 0.14 + Math.random()*0.16 : 0.05 + Math.random()*0.06, j = lift ? 0.16 : 0.06;
    sparkVel[s*3]   = nrm.x*sp + (Math.random()-0.5)*j;
    sparkVel[s*3+1] = nrm.y*sp + (Math.random()-0.5)*j + 0.04;
    sparkVel[s*3+2] = nrm.z*sp + (Math.random()-0.5)*j;
    sparkMax[s] = sparkLife[s] = (lift ? 1.0 : 1.3) + Math.random()*0.9;
    sparkSeed[s] = Math.random()*6.283;
  }
}
/* a thread of smoke off each burning letter: a few soft puffs that rise,
   curl and widen, lit amber by the ember at first, then a cool grey veil
   over the sheet, gone within two seconds */
const SMOKE = 160;
const smokeGeo = new THREE.BufferGeometry();
const smokePos = new Float32Array(SMOKE*3), smokeVel = new Float32Array(SMOKE*3);
const smokeAge = new Float32Array(SMOKE).fill(1), smokeLife = new Float32Array(SMOKE).fill(1), smokeWait = new Float32Array(SMOKE);
const smokeAlpha = new Float32Array(SMOKE), smokeT = new Float32Array(SMOKE), smokeSeed = new Float32Array(SMOKE), smokeSize = new Float32Array(SMOKE);
const smokeKind = new Float32Array(SMOKE);
smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePos, 3));
smokeGeo.setAttribute('alpha', new THREE.BufferAttribute(smokeAlpha, 1));
smokeGeo.setAttribute('age', new THREE.BufferAttribute(smokeT, 1));
smokeGeo.setAttribute('seed', new THREE.BufferAttribute(smokeSeed, 1));
smokeGeo.setAttribute('size', new THREE.BufferAttribute(smokeSize, 1));
smokeGeo.setAttribute('kind', new THREE.BufferAttribute(smokeKind, 1));
const smokeMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false,
  uniforms: { uScale: { value: 1 } },
  vertexShader: `attribute float alpha, age, seed, size, kind; varying float vA, vT, vS, vK; uniform float uScale;
    void main(){ vA = alpha; vT = age; vS = seed; vK = kind; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv;
      gl_PointSize = alpha > 0.0 ? uScale*size/max(0.1, -mv.z) : 0.0; }`,
  fragmentShader: `varying float vA, vT, vS, vK;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453); }
    float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
    void main(){
      vec2 p = gl_PointCoord - 0.5;
      p.x += 0.13*sin(p.y*7.0 + vS*6.283 + vT*3.0);
      float r = length(p*vec2(1.8, 1.0));
      float n = vnoise(p*4.5 + vec2(vS*17.0, -vT*2.2))*0.65 + vnoise(p*10.0 + vec2(-vT*3.0, vS*9.0))*0.35;
      float d = smoothstep(0.5, 0.08, r)*smoothstep(0.28, 0.78, n);
      float warm = 1.0 - smoothstep(0.0, 0.3, vT);
      vec3 col = mix(vec3(0.4, 0.4, 0.44), vec3(1.0, 0.64, 0.34), warm);
      col = mix(col, mix(vec3(0.86, 0.84, 0.78), vec3(1.0, 0.86, 0.6), warm), vK);
      gl_FragColor = vec4(col, d*vA*(0.75 + 0.25*warm));
    }`
});
const smoke = new THREE.Points(smokeGeo, smokeMat);
smoke.frustumCulled = false;
scene.add(smoke);
let smokeNext = 0;
function nextSmoke(){ const s = smokeNext; smokeNext = (smokeNext + 1) % SMOKE; return s; }
/* the forest breeze the smoke leans into */
const SMOKE_WIND = [0.16, 0, -0.08];
function emitSmoke(n, lay, text, at, count, vapor){
  for(let i=at; i<at+count; i++){
    const ch = text[i];
    if(!ch || /\s/.test(ch)) continue;
    const gb = glyphBox(lay, text, i);
    if(!gb) continue;
    const puffs = vapor ? (gb.cap ? 4 : 1 + (Math.random() < 0.5 ? 1 : 0)) : gb.cap ? 7 : 2 + (Math.random() < 0.4 ? 1 : 0), T = gb.cap ? BURN_CAP : BURN_T;
    const x0 = gb.cap ? lay.cap.x : gb.x, w = gb.cap ? lay.cap.w : gb.w, yy = gb.cap ? lay.cap.y - lay.cap.size*0.35 : gb.y - lay.size*0.35;
    for(let k=0;k<puffs;k++){
      const f = (k + 0.5)/puffs;
      const { p, n: nrm } = pagePointWorld(n, x0 + w*(gb.cap ? f : 0.25 + Math.random()*0.5), yy + (Math.random() - 0.5)*lay.size*0.3);
      const s = nextSmoke();
      smokePos[s*3] = p.x + nrm.x*0.01; smokePos[s*3+1] = p.y + nrm.y*0.01; smokePos[s*3+2] = p.z + nrm.z*0.01;
      smokeVel[s*3] = nrm.x*0.05 + (Math.random() - 0.5)*0.03;
      smokeVel[s*3+1] = nrm.y*0.05 + 0.14 + Math.random()*0.06;
      smokeVel[s*3+2] = nrm.z*0.05 + (Math.random() - 0.5)*0.03;
      smokeWait[s] = vapor ? 0.12 + Math.random()*0.35 : T*(gb.cap ? f*0.9 : 0.25 + k*0.12);
      smokeKind[s] = vapor ? 1 : 0;
      smokeAge[s] = 0;
      smokeLife[s] = 1.4 + Math.random()*0.7;
      smokeSeed[s] = Math.random();
    }
  }
}
function stepSmoke(dt){
  const drag = Math.exp(-dt*0.6);
  for(let s=0;s<SMOKE;s++){
    if(smokeWait[s] > 0){ smokeWait[s] -= dt; smokeAlpha[s] = 0; continue; }
    if(smokeAge[s] >= smokeLife[s]){ smokeAlpha[s] = 0; continue; }
    smokeAge[s] += dt;
    const q = s*3, t = Math.min(smokeAge[s]/smokeLife[s], 1), ph = smokeSeed[s]*6.283;
    smokeVel[q] *= drag; smokeVel[q+2] *= drag;
    const gust = smokeAge[s]*0.5;
    smokePos[q]   += (smokeVel[q] + SMOKE_WIND[0]*gust + Math.sin(smokeAge[s]*1.6 + ph)*0.04)*dt;
    smokePos[q+1] += smokeVel[q+1]*dt;
    smokePos[q+2] += (smokeVel[q+2] + SMOKE_WIND[2]*gust + Math.cos(smokeAge[s]*1.3 + ph)*0.04)*dt;
    smokeT[s] = t;
    smokeSize[s] = 22 + 46*Math.pow(t, 0.6);
    smokeAlpha[s] = smooth(clamp(t/0.1, 0, 1))*Math.pow(1 - t, 1.4)*0.42;
  }
  smokeGeo.attributes.position.needsUpdate = true;
  smokeGeo.attributes.alpha.needsUpdate = true;
  smokeGeo.attributes.age.needsUpdate = true;
  smokeGeo.attributes.size.needsUpdate = true;
  smokeGeo.attributes.kind.needsUpdate = true;
}
function stepSparks(dt){
  const drag = Math.exp(-dt*0.9);
  for(let s=0;s<SPARKS;s++){
    if(sparkLife[s] <= 0){ sparkAlpha[s] = 0; continue; }
    sparkLife[s] -= dt;
    const age = sparkMax[s] - sparkLife[s], q = s*3, ph = sparkSeed[s];
    sparkVel[q] *= drag; sparkVel[q+1] = sparkVel[q+1]*drag + 0.07*dt; sparkVel[q+2] *= drag;
    sparkPos[q]   += (sparkVel[q] + Math.sin(age*1.7 + ph)*0.018)*dt;
    sparkPos[q+1] += sparkVel[q+1]*dt;
    sparkPos[q+2] += (sparkVel[q+2] + Math.cos(age*1.3 + ph)*0.018)*dt;
    const life = clamp(sparkLife[s]/sparkMax[s], 0, 1);
    sparkAlpha[s] = smooth(clamp(age/0.22, 0, 1))*Math.pow(life, 1.3)*(0.78 + 0.22*Math.sin(age*9 + ph))*0.85;
  }
  sparkGeo.attributes.position.needsUpdate = true;
  sparkGeo.attributes.alpha.needsUpdate = true;
}

export {
  emitSmoke, emitSparks, inkSparkMat, nextSmoke, smokeAge, smokeKind, smokeLife,
  smokeMat, smokePos, smokeSeed, smokeVel, smokeWait, sparkMat, stepSmoke, stepSparks
};
