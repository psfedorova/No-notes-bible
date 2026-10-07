/* ============================================================================
   The opening film, shot from the live scene one frame at a time.

   src/main.js loads this under ?film. A capture script (tools/film/shoot.mjs)
   calls __film.shot(i) for every frame and screenshots the page, then encodes
   assets/intro/{wide,tall}.mp4 and writes the camera's first and last pose to
   assets/intro/poses.json, so the live book can take over from the last frame.

   The story: the book lies shut on its rock in the clearing. One of the forest's
   fireflies drifts in and settles on the sapphire, and its light sinks into the
   stone. The stone wakes with two slow beats and gold runs out from it through
   the lace of the cover. At each corner a spark leaps off and comes down in the
   air round the book, and from those four points the book's own magic circle
   grows, ring by ring, rune by rune, the seven-pointed star last. Whole, it
   flares once and lifts the book; the board swings over, the circle gathers
   itself up, narrows and comes down onto the title page, and as it touches the
   sheet its light runs out through the ornament and the lettering and settles.
   The view comes to rest where the reader sits, and the book is theirs.
   ==========================================================================*/
import { mulberry32 } from '../lib/textures.js';

const F = window.__book.film;
const { THREE, scene, st, orbit } = F;

const FPS = 30;
const ALIGHT = 1.7;                  // the firefly settles on the sapphire
const CORNERS = 2.9;                 // the gold has reached the cover's corners
const SEALED = 4.4;                  // the circle is whole
const OPEN_AT = 4.6;                 // the board starts to lift
const LAND = 7.8;                    // the circle touches the title page
const TALL = F.camera.aspect < 0.9;
/* a phone holds on the title page while its lettering comes up, then draws back */
const END = TALL ? 12.0 : 11.0;

const lerp = (a, b, t) => a + (b - a)*t;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = x => x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5*Math.cos(Math.PI*x);
const span = (t, a, b) => ease((t - a)/(b - a));
const lin = (t, a, b) => clamp((t - a)/(b - a), 0, 1);
const pxH = () => F.renderer.getDrawingBufferSize(new THREE.Vector2()).y;

const _gem = new THREE.Vector3(), _v = new THREE.Vector3();

/* ---------------- gold running through the cover's lace from the stone ---------------- */
const flowU = {
  uFlowC: { value: new THREE.Vector3() }, uFlowR: { value: 0 }, uFlowK: { value: 0 }, uFlowAfter: { value: 0 }
};
F.matGold.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, flowU);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFlowW;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvFlowW = (modelMatrix*vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFlowW;\nuniform vec3 uFlowC; uniform float uFlowR, uFlowK, uFlowAfter;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float fd = distance(vFlowW, uFlowC);
      float fBand = exp(-pow((fd - uFlowR)/0.32, 2.0));
      float fAfter = smoothstep(uFlowR + 0.05, uFlowR - 0.7, fd);
      totalEmissiveRadiance += vec3(1.0, 0.76, 0.4)*uFlowK*(fBand*1.1 + fAfter*uFlowAfter);`);
};
F.matGold.customProgramCacheKey = () => 'film-flow';
F.matGold.needsUpdate = true;
/* and on along the back, where the tooling is gold leaf in the leather (its metal map) */
F.matSpine.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, flowU);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFlowW;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvFlowW = (modelMatrix*vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFlowW;\nuniform vec3 uFlowC; uniform float uFlowR, uFlowK, uFlowAfter;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float sd = distance(vFlowW, uFlowC);
      float sBand = exp(-pow((sd - uFlowR)/0.4, 2.0));
      float sAfter = smoothstep(uFlowR + 0.05, uFlowR - 0.8, sd);
      totalEmissiveRadiance += vec3(1.0, 0.76, 0.4)*uFlowK*metalnessFactor*(sBand*1.2 + sAfter*uFlowAfter*0.8);`);
};
F.matSpine.customProgramCacheKey = () => 'film-flow-spine';
F.matSpine.needsUpdate = true;

/* ---------------- the magic circle, the same one pressed into every leaf ---------------- */
/* channels: R the rings, G the runes, B the star; a second, blurred copy is its glow */
const SIG = 2048, SR = 118;
function sigilCanvas(blur){
  const c = document.createElement('canvas');
  c.width = c.height = SIG;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, SIG, SIG);
  g.translate(SIG/2, SIG/2);
  const k = SIG/2/(SR*1.06);
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.globalCompositeOperation = 'lighter';
  if(blur) g.filter = `blur(${blur}px)`;
  const W = blur ? 2.2 : 1;
  const ring = (r, w)=>{ g.lineWidth = w*k*W; g.beginPath(); g.arc(0, 0, r*k, 0, Math.PI*2); g.stroke(); };
  g.strokeStyle = g.fillStyle = '#f00';
  ring(118, 1.5); ring(112, 0.8); ring(84, 1.1); ring(80, 0.6); ring(30, 0.9);
  for(let i=0;i<7;i++){ const a = -Math.PI/2 + i*Math.PI*2/7; g.beginPath(); g.arc(Math.cos(a)*118*k, Math.sin(a)*118*k, 3.2*k, 0, Math.PI*2); g.fill(); }
  g.strokeStyle = '#00f';
  g.lineWidth = 1.0*k*W; g.beginPath();
  for(let i=0;i<=7;i++){ const a = -Math.PI/2 + i*3*Math.PI*2/7; const x = Math.cos(a)*80*k, y = Math.sin(a)*80*k; i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  g.strokeStyle = '#0f0';
  const rnd = mulberry32(777), NR = 28;
  for(let i=0;i<NR;i++){
    g.save();
    g.rotate(i/NR*Math.PI*2);
    g.translate(0, -98*k);
    g.lineWidth = 1.0*k*W;
    const h = 7*k, w = 3.6*k;
    g.beginPath(); g.moveTo(0, -h); g.lineTo(0, h);
    const kind = Math.floor(rnd()*6);
    if(kind === 0){ g.moveTo(0, -h); g.lineTo(w, -h*0.3); }
    else if(kind === 1){ g.moveTo(0, -h*0.4); g.lineTo(w, -h); g.moveTo(0, h*0.2); g.lineTo(w, -h*0.4); }
    else if(kind === 2){ g.moveTo(-w, -h*0.5); g.lineTo(w, h*0.5); }
    else if(kind === 3){ g.moveTo(0, -h); g.lineTo(w, -h*0.5); g.lineTo(0, 0); }
    else if(kind === 4){ g.moveTo(-w, -h); g.lineTo(0, -h*0.3); g.lineTo(w, -h); }
    else { g.moveTo(0, -h*0.2); g.lineTo(-w, h*0.6); g.moveTo(0, -h*0.2); g.lineTo(w, h*0.6); }
    g.stroke();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  return t;
}
const circleMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: {
    uLines: { value: sigilCanvas(0) }, uGlow: { value: sigilCanvas(14) },
    uRing: { value: 0 }, uInner: { value: 0 }, uRunes: { value: 0 }, uStar: { value: 0 },
    uK: { value: 0 }, uTime: { value: 0 }, uHot: { value: 0 },
    uC: { value: new THREE.Vector4() }, uGap: { value: 0.25 }
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D uLines, uGlow; uniform float uRing, uInner, uRunes, uStar, uK, uTime, uHot, uGap; uniform vec4 uC; varying vec2 vUv;
    const float TAU = 6.2831853;
    /* every line grows both ways out of the four points where the sparks from the
       cover's corners came down (uC, in turns), until the pens meet: 1 drawn, with a hot head */
    float drawn(float ang, float p, out float head){
      float d = abs(fract(ang - uC.x + 0.5) - 0.5);
      d = min(d, abs(fract(ang - uC.y + 0.5) - 0.5));
      d = min(d, abs(fract(ang - uC.z + 0.5) - 0.5));
      d = min(d, abs(fract(ang - uC.w + 0.5) - 0.5));
      float e = p*uGap*1.04 - d;
      head = exp(-e*e*6000.0)*step(0.001, p)*step(p, 0.999);
      return smoothstep(0.0, 0.004, e);
    }
    void main(){
      vec2 q = vUv - 0.5;
      float r = length(q)*2.0*1.06*118.0;
      float ang = fract(atan(q.x, -q.y)/TAU + 1.0);
      vec3 L = texture2D(uLines, vUv).rgb, G = texture2D(uGlow, vUv).rgb;
      float hO, hI, hR, hS;
      float outer = r > 100.0 ? 1.0 : 0.0;
      float ringP = outer > 0.5 ? drawn(ang, uRing, hO) : drawn(ang, uInner, hI);
      if(outer > 0.5) hI = 0.0; else hO = 0.0;
      float runeP = drawn(ang, uRunes, hR);
      float starP = drawn(ang, uStar, hS);
      float line = L.r*ringP + L.g*runeP + L.b*starP;
      float glow = G.r*ringP + G.g*runeP + G.b*starP;
      float head = L.r*(hO + hI) + L.g*hR + L.b*hS + (G.r*(hO + hI) + G.g*hR + G.b*hS)*0.5;
      float flick = 0.9 + 0.1*sin(uTime*3.1 + r*0.21) * sin(uTime*1.7 - ang*19.0);
      vec3 gold = vec3(1.0, 0.66, 0.3), pale = vec3(1.0, 0.88, 0.66), cool = vec3(0.55, 0.72, 1.0);
      vec3 col = gold*line*0.95*flick + mix(cool, gold, 0.7)*glow*0.4 + pale*head*1.8 + pale*line*uHot*0.9;
      gl_FragColor = vec4(col*uK, 1.0);
    }`
});
const circle = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), circleMat);
circle.rotation.x = -Math.PI/2;
circle.frustumCulled = false;
circle.visible = false;
circle.renderOrder = 5;
scene.add(circle);
/* ---------------- motes rising off the lines as they are drawn ---------------- */
const MOTES = 1200;
const motePos = new Float32Array(MOTES*3), moteA = new Float32Array(MOTES);
const moteV = new Float32Array(MOTES*3), moteAge = new Float32Array(MOTES).fill(9), moteLife = new Float32Array(MOTES).fill(1);
const moteGeo = new THREE.BufferGeometry();
moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
moteGeo.setAttribute('alpha', new THREE.BufferAttribute(moteA, 1));
const moteMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uScale: { value: 1 } },
  vertexShader: `attribute float alpha; varying float vA; uniform float uScale;
    void main(){ vA = alpha; vec4 mv = modelViewMatrix*vec4(position, 1.0); gl_Position = projectionMatrix*mv;
      gl_PointSize = uScale*(0.5 + 0.8*alpha)/max(0.1, -mv.z); }`,
  fragmentShader: `varying float vA;
    void main(){ float d = length(gl_PointCoord - 0.5); float core = smoothstep(0.18, 0.0, d), halo = smoothstep(0.5, 0.0, d);
      halo *= halo; float a = (core*0.8 + halo*0.4)*vA;
      gl_FragColor = vec4(mix(vec3(1.0, 0.72, 0.36), vec3(1.0, 0.95, 0.85), core)*2.2*a, 1.0); }`
});
const motes = new THREE.Points(moteGeo, moteMat);
motes.frustumCulled = false;
scene.add(motes);
let moteNext = 0;
const rnd = mulberry32(31);
function emitMote(x, y, z, life){
  const k = moteNext; moteNext = (moteNext + 1) % MOTES;
  motePos[k*3] = x; motePos[k*3+1] = y; motePos[k*3+2] = z;
  moteV[k*3] = (rnd() - 0.5)*0.12; moteV[k*3+1] = 0.18 + rnd()*0.3; moteV[k*3+2] = (rnd() - 0.5)*0.12;
  moteAge[k] = 0; moteLife[k] = life;
}
function stepMotes(dt){
  for(let k=0;k<MOTES;k++){
    if(moteAge[k] >= moteLife[k]){ moteA[k] = 0; continue; }
    moteAge[k] += dt;
    const u = moteAge[k]/moteLife[k];
    motePos[k*3] += moteV[k*3]*dt; motePos[k*3+1] += moteV[k*3+1]*dt; motePos[k*3+2] += moteV[k*3+2]*dt;
    moteA[k] = Math.sin(Math.PI*Math.min(1, u*1.4 + 0.02))*(1 - u)*0.9*(0.6 + 0.4*Math.sin(k*1.7 + u*20));
  }
  moteGeo.attributes.position.needsUpdate = true;
  moteGeo.attributes.alpha.needsUpdate = true;
  moteMat.uniforms.uScale.value = pxH()*0.06;
}

/* ---------------- the firefly that wakes the book, and the sparks off its corners ---------------- */
/* 0: the firefly, 1-4: a spark leaping from each corner of the cover down to the circle */
const LIGHTS = 5;
const litPos = new Float32Array(LIGHTS*3), litA = new Float32Array(LIGHTS), litS = new Float32Array(LIGHTS), litC = new Float32Array(LIGHTS);
const litGeo = new THREE.BufferGeometry();
litGeo.setAttribute('position', new THREE.BufferAttribute(litPos, 3));
litGeo.setAttribute('alpha', new THREE.BufferAttribute(litA, 1));
litGeo.setAttribute('size', new THREE.BufferAttribute(litS, 1));
litGeo.setAttribute('cool', new THREE.BufferAttribute(litC, 1));
const litMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uScale: { value: 1 } },
  vertexShader: `attribute float alpha, size, cool; varying float vA, vC; uniform float uScale;
    void main(){ vA = alpha; vC = cool; vec4 mv = modelViewMatrix*vec4(position, 1.0); gl_Position = projectionMatrix*mv;
      gl_PointSize = uScale*size/max(0.1, -mv.z); }`,
  fragmentShader: `varying float vA, vC;
    void main(){ float d = length(gl_PointCoord - 0.5); float core = smoothstep(0.06, 0.0, d), halo = smoothstep(0.5, 0.0, d);
      halo = pow(halo, 4.0);
      vec3 hc = mix(vec3(1.0, 0.66, 0.28), vec3(0.85, 0.95, 0.55), vC);
      vec3 col = vec3(1.0, 0.97, 0.86)*core*2.6 + hc*halo*1.2;
      gl_FragColor = vec4(col*vA, 1.0); }`
});
const lights = new THREE.Points(litGeo, litMat);
lights.frustumCulled = false;
scene.add(lights);

/* a real little beetle: dark body, the pink shield behind its head, wing cases held up
   and the hind wings a blur while it flies, and the yellow-green lantern under its tail */
const fly = new THREE.Group();
const flyLamp = new THREE.MeshBasicMaterial({ color: 0xe8ff80 });
const flyLight = new THREE.PointLight(0xdcff70, 0, 1.6, 1.4);
const flyWings = [], flyCases = [];
/* the hind wings beat too fast to see: a soft fan of motion blur with a few veins */
const wingBlur = (()=>{
  const W = 256, H = 128, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(0, H/2, 0, 0, H/2, W);
  r.addColorStop(0, 'rgba(235,240,245,0.55)'); r.addColorStop(0.6, 'rgba(225,232,240,0.32)'); r.addColorStop(1, 'rgba(220,228,238,0)');
  g.fillStyle = r;
  g.beginPath(); g.moveTo(0, H/2); g.arc(0, H/2, W*0.98, -0.62, 0.62); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 1.2;
  for(const a of [-0.45, -0.2, 0.05, 0.3, 0.5]){ g.beginPath(); g.moveTo(4, H/2); g.lineTo(Math.cos(a)*W*0.9, H/2 + Math.sin(a)*W*0.9); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
{
  const dark = new THREE.MeshStandardMaterial({ color: 0x15100b, roughness: 0.4, metalness: 0.1 });
  const belly = new THREE.MeshStandardMaterial({ color: 0x3a2a19, roughness: 0.55 });
  const shield = new THREE.MeshStandardMaterial({ color: 0xe0956a, roughness: 0.5 });
  const caseM = new THREE.MeshStandardMaterial({ color: 0x2a1f15, roughness: 0.35, metalness: 0.12 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xc9b07a, roughness: 0.5 });
  const wingM = new THREE.MeshBasicMaterial({ map: wingBlur, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const ball = (r, m, sx, sy, sz, x, y, z) => { const o = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m); o.scale.set(sx, sy, sz); o.position.set(x, y, z); fly.add(o); return o; };
  ball(0.012, dark, 1, 0.9, 1, 0, 0.0, 0.088);                       // head
  ball(0.03, shield, 1.15, 0.36, 0.8, 0, 0.008, 0.062);               // the pink shield
  ball(0.012, dark, 0.9, 0.5, 0.9, 0, 0.016, 0.064);                  // its dark spot
  ball(0.022, belly, 1, 0.75, 1.1, 0, -0.002, 0.03);                  // thorax
  ball(0.02, belly, 1, 0.62, 0.9, 0, -0.004, 0.0);
  ball(0.019, belly, 1, 0.6, 0.9, 0, -0.005, -0.025);
  ball(0.018, flyLamp, 1, 0.62, 0.95, 0, -0.006, -0.05);              // the lantern: the last two rings
  ball(0.015, flyLamp, 1, 0.62, 1.0, 0, -0.006, -0.072);
  for(const sx of [-1, 1]){
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.0016, 0.001, 0.075, 4), dark);
    ant.position.set(sx*0.016, 0.004, 0.118); ant.rotation.set(Math.PI/2 - 0.35, 0, sx*0.55);
    fly.add(ant);
    for(const z of [0.045, 0.028, 0.01]){
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0016, 0.05, 4), dark);
      leg.position.set(sx*0.026, -0.016, z); leg.rotation.set((z - 0.028)*6, 0, sx*1.0);
      fly.add(leg);
    }
    const hinge = new THREE.Group();
    hinge.position.set(sx*0.006, 0.014, 0.046);
    const cs = new THREE.Mesh(new THREE.SphereGeometry(0.02, 14, 10), caseM);
    cs.scale.set(0.85, 0.28, 2.9); cs.position.set(sx*0.012, 0, -0.05);
    hinge.add(cs);
    const edge = new THREE.Mesh(new THREE.SphereGeometry(0.02, 14, 10), rim);
    edge.scale.set(0.2, 0.22, 2.8); edge.position.set(sx*0.027, -0.002, -0.05);
    hinge.add(edge);
    fly.add(hinge);
    flyCases.push({ g: hinge, sx });
    const wh = new THREE.Group();
    wh.position.set(sx*0.008, 0.016, 0.03);
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.06), wingM);
    w.rotation.x = -Math.PI/2; w.position.set(sx*0.06, 0, -0.008);
    if(sx < 0) w.rotation.y = Math.PI;
    wh.add(w);
    fly.add(wh);
    flyWings.push({ g: wh, w, sx });
  }
  fly.add(flyLight);
  flyLight.position.set(0, -0.02, -0.06);
}
fly.scale.setScalar(2.4);
scene.add(fly);

let flyPath = null;
const _up = new THREE.Vector3(0, 1, 0), _lamp = new THREE.Vector3();
let flyHeading = new THREE.Vector3(1, 0, 0), flyOff = null, offPath = null;
const flyFlat = new THREE.Vector3(1, 0, 0), flyAim = new THREE.Object3D();
const TAKE = ALIGHT + 0.95;          // the firefly takes off again
/* it drifts in across the clearing in loose loops and settles on the stone */
function makeFlyPath(){
  const k0 = rig.keys[0], B = k0.p.clone().sub(k0.l).normalize();
  const R = new THREE.Vector3().crossVectors(_up, B).normalize(), U = new THREE.Vector3().crossVectors(B, R);
  const k = TALL ? 0.55 : 1;
  const at = (r, u, b) => _gem.clone().addScaledVector(R, r*k).addScaledVector(U, u).addScaledVector(B, b);
  return new THREE.CatmullRomCurve3([
    at(-3.6, 1.0, 1.6), at(-2.6, 0.5, 1.9), at(-1.7, 0.95, 1.4), at(-0.95, 0.6, 0.8),
    at(-0.45, 0.42, 0.35), at(-0.15, 0.24, 0.1), at(0, 0.16, 0)
  ], false, 'centripetal');
}
function stepFirefly(t, dt){
  if(!flyPath) flyPath = makeFlyPath();
  const x = clamp(t/ALIGHT, 0, 1), u = 1 - Math.pow(1 - x, 1.6);
  const p = flyPath.getPoint(u);
  const w = (1 - x)*0.1;
  p.x += Math.sin(t*6.3)*w; p.y += Math.sin(t*4.1 + 1)*w*0.8; p.z += Math.cos(t*5.2)*w;
  if(t < ALIGHT) flyHeading.copy(flyPath.getTangent(u)).normalize();
  /* the way it faces on the level: kept from the last moment it was really going somewhere */
  const hz = Math.hypot(flyHeading.x, flyHeading.z);
  if(hz > 0.25 && (t < ALIGHT || t > TAKE + 0.15)) flyFlat.set(flyHeading.x, 0, flyHeading.z).normalize();
  const flat = flyFlat.clone();
  /* it sits a moment and gives its light to the stone, then opens its wings, hops up,
     hangs, turns and flies off in a slow widening curve into the trees, speeding up */
  const x2 = lin(t, TAKE, TAKE + 2.2);
  if(t >= ALIGHT){
    if(!flyOff) flyOff = _gem.clone().add(_v.set(0, 0.16, 0));
    p.copy(flyOff);
    if(x2 > 0){
      if(!offPath){
        rigAt(TAKE);
        const B = _rp.clone().sub(_rl).setY(0).normalize(), R = new THREE.Vector3().crossVectors(_up, B).normalize();
        const at = (r, u, b) => flyOff.clone().addScaledVector(R, r).add(_v.set(0, u, 0)).addScaledVector(B, b);
        offPath = new THREE.CatmullRomCurve3([at(0, 0, 0), at(0.05, 0.3, 0), at(0.35, 0.65, -0.15), at(1.4, 1.3, -0.8),
          at(3.4, 2.2, -2.2), at(6.5, 3.3, -4.6), at(10.5, 4.4, -8.0)], false, 'centripetal');
      }
      const u = Math.pow(x2, 1.7);
      p.copy(offPath.getPoint(u));
      p.y += Math.sin(t*5.3)*0.04*(1 - x2);
      flyHeading.copy(offPath.getTangent(Math.max(u, 0.12))).normalize();
    }
  }
  fly.position.copy(p);
  /* in flight it faces where it goes; sitting, it lies level on the stone */
  /* it faces where it flies, pitched only a little, and turns smoothly: never a snap,
     never up on its tail; on the stone it sits level, facing the way it came in */
  const lookDir = (t < ALIGHT || x2 > 0.12 ? flat.clone().setY(clamp(flyHeading.y, -0.5, 0.5)*0.35) : flat.clone()).normalize();
  flyAim.lookAt(_v.copy(flyAim.position).add(lookDir));
  if(!dt) fly.quaternion.copy(flyAim.quaternion);
  else fly.quaternion.slerp(flyAim.quaternion, 1 - Math.exp(-dt*7));
  const flying = t < ALIGHT - 0.12 || t > TAKE - 0.15;
  const off = x2;
  for(const W of flyWings){
    W.g.visible = flying;
    W.g.rotation.z = W.sx*(0.15 + 0.12*Math.sin(t*37 + W.sx));
    W.w.material.opacity = 0.75 + 0.25*Math.sin(t*53 + W.sx*2);
  }
  for(const C of flyCases) C.g.rotation.set(flying ? -0.25 : 0, 0, flying ? C.sx*0.7 : 0);
  fly.visible = off < 0.995;
  /* the lantern: slow firefly pulses in flight, a long bright glow as it settles, then
     its light goes down into the stone and it is left with an ember */
  const pulse = 0.45 + 0.55*Math.pow(0.5 + 0.5*Math.sin(t*4.2), 3);
  const settle = span(t, ALIGHT - 0.3, ALIGHT + 0.15)*(1 - span(t, ALIGHT + 0.2, ALIGHT + 0.8));
  const given = lerp(1.4, 0.3, span(t, ALIGHT + 0.2, ALIGHT + 0.8));
  const L = t < ALIGHT + 0.2 ? Math.max(pulse, settle*1.4) : lerp(given, 0.7 + 0.45*pulse, span(t, TAKE - 0.1, TAKE + 0.5))*(1 - span(off, 0.8, 1.0));
  flyLamp.color.setRGB(0.95*L*2.2, 1.0*L*2.2, 0.45*L*2.2);
  flyLight.intensity = L*0.45;
  _lamp.set(0, -0.012, -0.062).multiplyScalar(2.4).applyQuaternion(fly.quaternion).add(p);
  litPos.set([_lamp.x, _lamp.y, _lamp.z], 0);
  litA[0] = fly.visible ? Math.min(1, L)*0.85 : 0;
  litS[0] = 8.0*(0.6 + 0.4*Math.min(1.4, L));
  litC[0] = 1.0;
}
const sparkFrom = [], sparkTo = [];
const SPARK_T = 0.45;
function stepSparks(t){
  for(let k=0;k<4;k++){
    const i = k + 1;
    const u = lin(t, CORNERS + k*0.03, CORNERS + k*0.03 + SPARK_T);
    if(!sparkFrom.length || u <= 0 || u >= 1){ litA[i] = 0; continue; }
    const e = ease(u);
    _v.lerpVectors(sparkFrom[k], sparkTo[k], e);
    _v.y += Math.sin(Math.PI*e)*0.7;
    litPos.set([_v.x, _v.y, _v.z], i*3);
    litA[i] = Math.min(1, u*6)*(1 - span(u, 0.85, 1.0)*0.6);
    litS[i] = 11.0;
    litC[i] = 0;
    for(let j=0;j<3;j++) emitMote(_v.x, _v.y, _v.z, 0.5 + rnd()*0.7);
  }
}

/* ---------------- sparks from the circle to the letters ---------------- */
const sparks = (()=>{
  const MAX = 160, pos = new Float32Array(MAX*3), alpha = new Float32Array(MAX), list = [];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 1 } },
    vertexShader: `attribute float alpha; varying float vA; uniform float uScale;
      void main(){ vA = alpha; vec4 mv = modelViewMatrix*vec4(position, 1.0); gl_Position = projectionMatrix*mv; gl_PointSize = uScale*(0.6 + 0.6*alpha)/max(0.1, -mv.z); }`,
    fragmentShader: `varying float vA;
      void main(){ float d = length(gl_PointCoord - 0.5); float core = smoothstep(0.1, 0.0, d), halo = smoothstep(0.5, 0.0, d); halo *= halo*halo;
        gl_FragColor = vec4((vec3(1.0, 0.97, 0.88)*core*2.4 + vec3(1.0, 0.62, 0.22)*halo*1.1)*vA, 1.0); }`
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  scene.add(pts);
  const _p = new THREE.Vector3();
  return {
    add(from, to, t0, d){ list.push({ from, to, t0, d, i: list.length % MAX, side: rnd() - 0.5 }); return true; },
    step(t){
      alpha.fill(0);
      for(const q of list){
        const u = (t - q.t0)/q.d;
        if(u < 0 || u > 1) continue;
        const e = u*u*(3 - 2*u);
        _p.lerpVectors(q.from, q.to, e);
        _p.y += Math.sin(Math.PI*e)*0.32;
        pos.set([_p.x, _p.y, _p.z], q.i*3);
        alpha[q.i] = Math.min(1, u*5)*(u > 0.9 ? 1 - (u - 0.9)*6 : 1);
        if(rnd() < 0.6) emitMote(_p.x, _p.y, _p.z, 0.25 + rnd()*0.3);
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.alpha.needsUpdate = true;
      mat.uniforms.uScale.value = pxH()*0.05;
    }
  };
})();

/* ---------------- where the circle stands, and where it comes down ---------------- */
const R0 = 3.85;                      // round the shut book, in the air at its mid height
let C0 = null;
function restCentre(){
  const b = new THREE.Box3().setFromObject(F.bookRoot);
  return b.getCenter(new THREE.Vector3());
}
/* the title page: the circle comes down on (W/2, H*0.42), over the middle of its lettering */
function landing(){
  const { p, n } = F.pagePointWorld(0, F.PAGE_W/2, F.PAGE_H*0.42);
  const c = p.clone(), up = n.clone();
  const a = F.pagePointWorld(0, F.PAGE_W*0.2, F.PAGE_H*0.42).p.clone();
  const b = F.pagePointWorld(0, F.PAGE_W*0.8, F.PAGE_H*0.42).p.clone();
  const pxPerUnit = F.PAGE_W*0.6/a.distanceTo(b);
  return { c, up, pxPerUnit };
}
const LAND_R = 0.95;                  // its radius as it touches the sheet

/* world vectors on the title page to its pixels, and the circle as it lies there in
   page pixels: the transform the sigil is drawn with when it burns in */
let pageBasis = null;
function toPage(w){
  if(!pageBasis){
    const c = { x: F.PAGE_W/2, y: F.PAGE_H*0.42 }, P = (x, y) => F.pagePointWorld(0, x, y).p.clone();
    const p0 = P(c.x, c.y), U = P(c.x + 40, c.y).sub(p0).divideScalar(40), V = P(c.x, c.y + 40).sub(p0).divideScalar(40);
    const a = U.dot(U), b = U.dot(V), d = V.dot(V), det = a*d - b*b;
    pageBasis = { U, V, a, b, d, det };
  }
  const B = pageBasis, ru = w.dot(B.U), rv = w.dot(B.V);
  return [(ru*B.d - rv*B.b)/B.det, (rv*B.a - ru*B.b)/B.det];
}
function sigilOnPage(){
  const k = LAND_R/118;
  const ex = new THREE.Vector3(1, 0, 0).applyQuaternion(circle.quaternion).multiplyScalar(k);
  const ey = new THREE.Vector3(0, -1, 0).applyQuaternion(circle.quaternion).multiplyScalar(k);
  return [...toPage(ex), ...toPage(ey), F.PAGE_W/2, F.PAGE_H*0.42];
}

/* ---------------- the timeline ---------------- */
let opened = false, sparked = false, burnt = false, sigM = null, plan = null, clock = 0, spin = 0;

function at(t, dt){
  clock += dt;
  rig.t = t;
  rig.hand = span(t, END - (TALL ? 0.6 : 1.0), END - 0.1);
  /* the live camera keeps the reader's framing; the film's eye is the rig below */
  orbit.az = orbit.azTo = orbit.el = orbit.elTo = orbit.azV = orbit.elV = 0;
  orbit.coast = false;
  st.zoom = 1;

  /* the firefly comes down onto the sapphire; the stone wakes with two slow beats */
  F.frontGem.getWorldPosition(_gem);
  stepFirefly(t, dt);
  if(t < OPEN_AT + 0.4){
    const beat = x => Math.exp(-Math.pow((t - x)/0.22, 2));
    const glow = span(t, ALIGHT, ALIGHT + 0.5)*0.35*(1 - span(t, SEALED, OPEN_AT + 0.4));
    st.gemFlare = Math.max(glow, 0.9*beat(ALIGHT + 0.1) + 1.0*beat(ALIGHT + 0.55));
  }
  st.auraTo = 0.25 + 0.55*span(t, ALIGHT + 0.6, SEALED);

  /* from the stone the gold runs out through the lace to the corners, then glows on and cools */
  flowU.uFlowC.value.copy(_gem);
  flowU.uFlowR.value = lerp(0, 3.4, Math.pow(lin(t, ALIGHT + 0.3, CORNERS + 0.15), 0.85));
  flowU.uFlowK.value = span(t, ALIGHT + 0.25, ALIGHT + 0.45)*(1 - span(t, SEALED, SEALED + 0.9));
  flowU.uFlowAfter.value = lerp(0.42, 0.3, span(t, CORNERS - 0.6, CORNERS + 0.8));

  /* at each corner a spark leaps off and comes down where the circle will be */
  /* the circle lies in the air just over the shut cover, so nothing of it runs through the book */
  if(!C0){ const b = new THREE.Box3().setFromObject(F.bookRoot); C0 = b.getCenter(new THREE.Vector3()); C0.y = b.max.y + 0.05; }
  if(t >= CORNERS && !sparkFrom.length){
    const turns = [];
    for(const [x, y] of [[0, -1], [1, -1], [1, 1], [0, 1]]){
      const a = new THREE.Vector3(x*F.CW, y*F.CH/2, F.CVR + 0.01);
      F.frontGrp.localToWorld(a);
      const d = new THREE.Vector3(a.x - C0.x, 0, a.z - C0.z).normalize();
      const b = C0.clone().addScaledVector(d, R0);
      sparkFrom.push(a); sparkTo.push(b);
      turns.push((Math.atan2(d.x, d.z)/(Math.PI*2) + 1) % 1);
    }
    const so = turns.slice().sort((p, q) => p - q);
    let gap = 0;
    for(let i=0;i<4;i++) gap = Math.max(gap, ((so[(i + 1) % 4] - so[i]) + 1) % 1);
    circleMat.uniforms.uC.value.set(...turns);
    circleMat.uniforms.uGap.value = gap/2;
  }
  stepSparks(t);
  litGeo.attributes.position.needsUpdate = true;
  litGeo.attributes.alpha.needsUpdate = true;
  litGeo.attributes.size.needsUpdate = true;
  litGeo.attributes.cool.needsUpdate = true;
  litMat.uniforms.uScale.value = pxH()*0.09;

  /* the circle grows out of those four points, ring by ring, rune by rune, the star last */
  const DRAW = CORNERS + SPARK_T - 0.05;
  const lvl = span(t, DRAW - 0.1, DRAW + 0.05);
  circle.visible = lvl > 0.001 && t < LAND + 0.65;
  spin += dt*(0.22*span(t, SEALED, OPEN_AT + 0.8)*(1 - span(t, LAND - 0.9, LAND)));
  if(circle.visible){
    const U = circleMat.uniforms;
    U.uRing.value = lin(t, DRAW, DRAW + 0.65);
    U.uInner.value = lin(t, DRAW + 0.15, DRAW + 0.8);
    U.uRunes.value = lin(t, DRAW + 0.3, DRAW + 0.95);
    U.uStar.value = lin(t, DRAW + 0.45, SEALED);
    U.uTime.value = clock;
    /* whole, it flares once and lifts the book; it gathers itself up as the board opens,
       narrows over the open book and comes down onto the title page, where its light
       runs into the sheet */
    const L = landing();
    /* whole, it rises clear of the board's swing before the board lifts, hangs there
       while the book opens beneath it, glides over the title page and comes down */
    const up = span(t, SEALED + 0.05, OPEN_AT + 0.85);
    const to = span(t, OPEN_AT + 1.4, LAND - 1.2);
    /* it comes down slowly and settles the last finger's breadth, never a drop */
    const dx = clamp((t - (LAND - 1.7))/1.7, 0, 1), down = dx >= 1 ? 1 : 1 - Math.pow(1 - ease(dx), 2.2);
    const HIGH = 3.8;
    const hover = new THREE.Vector3(L.c.x, C0.y + HIGH, L.c.z);
    const rise = C0.clone().add(new THREE.Vector3(0, HIGH*up, 0));
    _v.lerpVectors(rise, hover, to);
    _v.lerp(L.c.clone().addScaledVector(L.up, 0.02), down);
    circle.position.copy(_v);
    const r = lerp(lerp(R0, 2.1, up), LAND_R, down);
    circle.scale.set(2*r*1.06, 2*r*1.06, 1);
    circle.rotation.set(-Math.PI/2, 0, 0);
    if(down > 0) circle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), L.up.clone().lerp(new THREE.Vector3(0, 1, 0), 1 - down).normalize());
    circle.rotateZ(spin);
    const pulse = x => Math.exp(-Math.pow((t - x)/0.18, 2));
    U.uHot.value = Math.max(pulse(SEALED + 0.12), 0.7*span(t, LAND - 0.6, LAND));
    /* as it touches, its gold goes over into the fire in the sheet */
    U.uK.value = lvl*(0.8 + 0.2*span(t, OPEN_AT, LAND - 0.5))*(1 - span(t, LAND, LAND + 0.6));
    /* motes off the drawn lines, more while it is moving */
    const n = t < LAND ? (t < OPEN_AT ? 8 : 6) : 0;
    for(let i=0;i<n;i++){
      const a = rnd()*Math.PI*2, rr = r*(rnd() < 0.6 ? 1 : 0.7 + rnd()*0.25);
      if(t < SEALED && rnd() > U.uRing.value) continue;
      _v.set(Math.cos(a)*rr, Math.sin(a)*rr, 0).applyQuaternion(circle.quaternion).add(circle.position);
      emitMote(_v.x, _v.y, _v.z, 1.2 + rnd()*1.4);
    }
  }
  stepMotes(dt);

  if(t >= OPEN_AT && !opened){ opened = true; F.setOpen(true); }
  if(t >= LAND && !sparked){ sparked = true; F.emitOpenBurst(30); }
  /* it lies on the title page as light, and from it a spark flies to each letter,
     which burns in as the book's own writing does */
  const START = LAND + 0.5, FLY = 0.42;
  if(t >= LAND && !burnt){
    if(!sigM){ sigM = sigilOnPage(); plan = F.titleBurnPlan(0.7); plan.forEach((q, i)=>{ q.flies = i % Math.max(1, Math.ceil(plan.length/70)) === 0; }); }
    const last = Math.max(...plan.map(q => q.s));
    F.titleBurn({ M: sigM, t, start: START,
      sig: span(t, LAND - 0.05, LAND + 0.35)*(1 - span(t, START + 0.2, START + last + 0.2)),
      done: t >= START + last + 1.15 });
    burnt = t >= START + last + 1.15;
    for(const q of plan){
      const t0 = START + q.s - FLY;
      if(q.flies && !q.spark && t >= t0){
        const a = rnd()*Math.PI*2, rr = LAND_R*(0.55 + 0.45*rnd());
        q.from = new THREE.Vector3(Math.cos(a)*rr, Math.sin(a)*rr, 0).applyQuaternion(circle.quaternion).add(circle.position);
        q.to = F.pagePointWorld(0, q.px, q.py).p.clone();
        q.spark = sparks.add(q.from, q.to, t0, FLY);
      }
      if(!q.lit && t >= START + q.s){
        q.lit = true;
        const to = q.to || F.pagePointWorld(0, q.px, q.py).p;
        emitMote(to.x, to.y + 0.01, to.z, 0.5 + rnd()*0.6);
        if(rnd() < 0.2) F.pagePuff(q.px, q.py);
      }
    }
  }
  sparks.step(t);
  /* no leaf comes down across the open book at the end, where the live one takes over */
  if(t >= OPEN_AT){
    for(const m of F.fallers){
      const u = m.userData;
      if(Math.hypot(u.x, u.z) < 10 && u.y > F.camera.position.y + 0.5) u.y = Math.max(u.y, 60);
    }
  }
}

/* ---------------- the camera: one unbroken flight ---------------- */
/* close by the shut book as the firefly comes in, down to the stone as it lands, back
   and up as the gold runs out and the circle grows, round to the reader's side as the
   board opens, and down onto the title page; keyed in time and joined by a spline that
   is smooth in speed as well as in place (Catmull-Rom with the keys' own times), so
   there are no cuts and no jolts. The eye sets off from rest, so the film rises out of
   its own still frame. The last key is the reader's own view, and over the
   last second the eye is handed to the live camera exactly */
const rig = { t: 0, hand: 0, keys: null };
function sph(l, az, el, d){
  return { l, p: l.clone().add(new THREE.Vector3(Math.sin(az)*Math.cos(el), Math.sin(el), Math.cos(az)*Math.cos(el)).multiplyScalar(d)) };
}
function buildRig(end){
  F.frontGem.getWorldPosition(_gem);
  const c0 = restCentre();
  const E = { p: new THREE.Vector3().fromArray(end.pos), l: null };
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().fromArray(end.quat));
  /* where the reader's eye meets the open book, not a point in the air before it */
  E.l = E.p.clone().addScaledVector(fwd, (E.p.y - (c0.y + 0.25))/Math.max(0.2, -fwd.y));
  const m = TALL ? [1.25, 1.25, 1.7, 1.95, 1.7, 1.35] : [1, 1, 1, 1, 1, 1];
  const keys = [
    { t: 0.0, ...sph(_gem.clone().add(new THREE.Vector3(-0.3, 0.15, 0)), -1.15, 0.36, 5.2*m[0]) },
    { t: ALIGHT, ...sph(_gem.clone(), -0.95, 0.62, 3.2*m[1]) },
    { t: CORNERS + 0.1, ...sph(c0.clone().add(new THREE.Vector3(0, 0.2, 0)), -0.75, 0.7, 7.0*m[2]) },
    { t: SEALED, ...sph(c0.clone().add(new THREE.Vector3(0, 0.3, 0)), -0.5, 0.68, 11.0*m[3]) },
    { t: OPEN_AT + 1.5, ...sph(c0.clone().lerp(E.l, 0.5).add(new THREE.Vector3(0, 1.8, 0)), -0.24, 0.62, 11.0*m[4]) },
    ...(TALL ? [
      { t: LAND, ...sph(E.l.clone().add(new THREE.Vector3(1.6, 0, 0.1)), -0.04, 1.0, 7.6) },
      { t: LAND + 2.3, ...sph(E.l.clone().add(new THREE.Vector3(1.6, 0, 0.1)), 0, 1.03, 7.0) },
      { t: END - 0.4, p: E.p, l: E.l }
    ] : [
      { t: LAND, ...sph(E.l.clone().add(new THREE.Vector3(0.7, 0, 0)), -0.07, 0.88, 7.6) },
      { t: END - 1.0, p: E.p, l: E.l }
    ])
  ];
  const n = keys.length;
  for(let i=0;i<n;i++){
    const k = keys[i];
    if(i === 0 || i === n - 1){ k.vp = new THREE.Vector3(); k.vl = new THREE.Vector3(); }
    else {
      const a = keys[i - 1], b = keys[i + 1], dt = b.t - a.t;
      k.vp = b.p.clone().sub(a.p).divideScalar(dt);
      k.vl = b.l.clone().sub(a.l).divideScalar(dt);
    }
  }
  rig.keys = keys;
}
function hermite(a, va, b, vb, d, u, out){
  const u2 = u*u, u3 = u2*u;
  const h00 = 2*u3 - 3*u2 + 1, h10 = u3 - 2*u2 + u, h01 = -2*u3 + 3*u2, h11 = u3 - u2;
  return out.set(0, 0, 0).addScaledVector(a, h00).addScaledVector(va, h10*d).addScaledVector(b, h01).addScaledVector(vb, h11*d);
}
const _rp = new THREE.Vector3(), _rl = new THREE.Vector3(), _f = new THREE.Vector3(), _a = new THREE.Vector3();
function rigAt(t){
  const K = rig.keys;
  let i = 0;
  while(i < K.length - 2 && t > K[i + 1].t) i++;
  const a = K[i], b = K[i + 1], d = b.t - a.t, u = clamp((t - a.t)/d, 0, 1);
  hermite(a.p, a.vp, b.p, b.vp, d, u, _rp);
  hermite(a.l, a.vl, b.l, b.vl, d, u, _rl);
}
window.__filmCam = () => {
  if(!rig.keys) return;
  const c = F.camera;
  _f.set(0, 0, -1).applyQuaternion(c.quaternion);
  rigAt(rig.t);
  const k = rig.hand;
  c.position.lerpVectors(_rp, c.position, k);
  _f.lerpVectors(_a.subVectors(_rl, _rp).normalize(), _f, k).normalize();
  c.lookAt(_a.copy(c.position).add(_f));
};

const pose = () => ({
  pos: F.camera.position.toArray().map(v => +v.toFixed(5)),
  quat: F.camera.quaternion.toArray().map(v => +v.toFixed(6)),
  fov: +F.camera.fov.toFixed(4), aspect: +F.camera.aspect.toFixed(5)
});

/* the view settles on the first frame before the film starts; the title page is bare
   until the circle brings its lettering */
F.titleReveal(0);
const ends = await fetch('assets/intro/poses.json?v=' + Date.now()).then(r => r.json());
buildRig(ends[TALL ? 'tall' : 'wide'].end);
at(0, 0);
for(let i=0;i<240;i++) F.update(1/FPS);
F.frame(1/FPS);

window.__film = {
  fps: FPS, frames: Math.round(END*FPS),
  shot(i){ at(i/FPS, 1/FPS); F.frame(1/FPS); return i; },
  /* steps the story without drawing, for stills */
  run(i){ at(i/FPS, 1/FPS); F.update(1/FPS); return i; },
  pose
};
