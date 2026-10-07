/* ============================================================================
   Liber Arcanum: a WebGL grimoire you can turn in your hands and write in.

   Hybrid build. Blender (blender/build_assets.py) makes the static pieces: the
   gilt filigree of both boards as raised geometry, the tooling masks and the
   boulder. Poly Haven scans supply the forest light, the moss and the leather
   grain. Everything that moves is built here.

   Every leaf is a real slab of parchment with its own thickness, sewn to its own
   station on the spine. Leaves are inextensible: their cross-section is built
   by integrating an angle along the arc, so a page never stretches, the fore
   edge of an open stack slants the way a real one does, and thickness moves
   from one side to the other as pages turn.

   Ink is painted straight into the page texture. A hidden <textarea> takes the
   keyboard (any layout, IME, undo), and the caret and selection are drawn on
   the parchment, so the book can be written in at any angle. Fresh letters
   burn in with a glow before they settle into the vellum as ink.
   ==========================================================================*/
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import {
  clamp, lerp, smooth, mulberry32, fbm, upsample, cv, normalFromHeight, tex,
  setMaxAniso, makeSpriteCanvas, makeRayAlpha, crackCanvas, fieldFromCanvas
} from './textures.js?v=4';
import { createShelf, sharingOn } from './shared.js?v=29';

const T0 = performance.now();
/* ?film: the opening film is shot from this very scene, one frame at a time (film.js).
   Otherwise the film plays over the page while the forest loads (index.html, __intro),
   and the live book takes over from its last frame */
const FILM = new URLSearchParams(location.search).has('film');
const intro = !FILM && window.__intro || null;
if(intro) document.documentElement.classList.add('settling');
const easeIO = t => t<.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
const easeSine = t => 0.5 - 0.5*Math.cos(Math.PI*t);
/* a leaf is lifted gently by its corner and still falling when its back reaches the
   stack: the fore edge then comes down last, on its cushion of air */
const easeFlip = t => t*t*(3 - 2*t) + 0.55*t*t*(t - 1);
const easeIn2 = t => t*t;
const easeOut2 = t => 1 - (1 - t)*(1 - t);
/* frame-rate independent smoothing toward a goal */
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate*dt));
/* second-order smoothing: o[k] eases toward the goal with velocity o[k+'V'],
   so motion starts and stops without a kick when the goal jumps */
function sdamp(o, k, goal, time, dt){
  const w = 2/time, x = w*dt, e = 1/(1 + x + 0.48*x*x + 0.235*x*x*x);
  const v = o[k + 'V'] || 0, d = o[k] - goal, t = (v + w*d)*dt;
  o[k + 'V'] = (v - w*t)*e;
  o[k] = goal + (d + t)*e;
  return o[k];
}
/* a released hand's motion carried on to rest: a cubic that starts at the hand's
   speed and arrives at zero speed, never past the stop; at rest it is a smoothstep
   over the usual duration, a throw only shortens it */
function glideFrom(x, v, to, base){
  const d = to - x, ad = Math.abs(d);
  let T = base;
  if(v*d > 0) T = clamp(2*ad/Math.abs(v), 0.22, base);
  const m0 = v*d > 0 ? Math.sign(d)*Math.min(Math.abs(v)*T, 2.5*ad) : clamp(v*T, -0.4*ad, 0.4*ad);
  return { x0: x, m0, to, T: Math.max(T, 1e-3), t: 0 };
}
function glideStep(gl, dt){
  gl.t = Math.min(gl.T, gl.t + dt);
  const s = gl.t/gl.T, s2 = s*s, s3 = s2*s;
  gl.x = (2*s3 - 3*s2 + 1)*gl.x0 + (s3 - 2*s2 + s)*gl.m0 + (3*s2 - 2*s3)*gl.to;
  gl.v = ((6*s2 - 6*s)*gl.x0 + (3*s2 - 4*s + 1)*gl.m0 + (6*s - 6*s2)*gl.to)/gl.T;
  return gl.t >= gl.T;
}

/* ============================== dimensions ==============================
   1 unit is about a decimetre.                                            */
const PW = 3.40, PH = 4.70;        // leaf width (spine to fore edge) and height
const N = 50;                      // leaves -> 100 pages
const T = 0.56;                    // text block thickness
const LT = T/N;                    // leaf pitch
const LH = LT*0.42;                // half thickness of one leaf slab
const EPS = 0.004;                 // air between the block and a board
const CVR = 0.055;                 // board thickness
const OV = 0.09, OVH = 0.09;       // board overhang at fore edge, head and tail
const CH = PH + OVH*2;
const XJ_C = 0.06, XJ_O = 0.27;    // board spine edge: closed / open
const CW = PW + OV - XJ_C;         // board width (matches blender/build_assets.py)
const ZB = -(T/2 + EPS);           // inner face of the back board
const RB = T/0.45;                 // radius of the spine back when open
const ALPHA = LT/RB;               // arc taken by one leaf on that back
const SWELL = 0.05;                // rounding of the closed spine
const FAN = 0.07;                  // fore-corner lift of the top resting leaf
const M = 48, R = 10;              // leaf grid: along the arc, along the height
const OPEN = Math.PI;
const BACK_GAP = 0.022;            // spine leather to the sewn backs

/* sharper pages where there is memory to spare; phones keep the lighter sheet */
const HI_RES = !(matchMedia && matchMedia('(pointer: coarse)').matches);
const PAGE_W = HI_RES ? 1536 : 1024, PAGE_H = Math.round(PAGE_W*1416/1024);
const SC = PAGE_W/340;             // page artwork is drawn in a 340 x 470 space
const FS = PAGE_W/880;             // font sizes below were tuned on an 880 px page
const INK = '#2e1c0e';
const LS_KEY = 'liber-arcanum.v2';

const ROCK_TOP = 0;                // the boulder's resting dome peaks here
const LIFT_H = 3.0;                // how high the book floats while it is turned
const GROUND_Y = -3.4;             // the forest floor the boulder is sunk in

/* one hand for the whole book, the title page's own: Cormorant Garamond italic,
   the face of its motto. It cuts Latin and Cyrillic as one design, so Russian
   and English share every metric and burn in exactly alike. Initials are the
   upright capitals of the same face. lead keeps the old line pitch, so pages
   written before keep their line count */
const FONTS = [
  { id:'chronicle', name:'Chronicle', css:'"Cormorant Garamond"', capCss:'"Cormorant Garamond"',
    weight:500, style:'italic', size:44, lead:1.315, capWeight:600 }
];
const fontById = id => FONTS.find(f=>f.id===id) || FONTS[0];
const capFont = (f, size) => `${f.capWeight || 400} ${Math.round(size)}px ${f.capCss || f.css}, ${f.css}, serif`;
const fontCss = (f, size, weight) => `${f.style==='italic'?'italic ':''}${weight||f.weight} ${Math.round(size)}px ${f.css}, "Cormorant Garamond", serif`;

/* a phone gets the 4k forest with its depth at the same size (6144 is past the texture
   limit of many phones), the light and the leather at 1k: the leather is dyed down to
   1024 anyway, and the light only feeds the blurred reflections */
const LEA = HI_RES ? '2k' : '1k';
const ASSETS = {
  forest: HI_RES ? 'assets/forest/forest.jpg' : 'assets/forest/forest_4k.jpg',
  forestDepth: HI_RES ? 'assets/forest/depth.png' : 'assets/forest/depth_4k.png', forestWater: 'assets/forest/water.png',
  forestLight: HI_RES ? 'assets/forest/light.hdr' : 'assets/forest/light_1k.hdr',
  forestBack: 'assets/forest/back.jpg', forestBackDepth: 'assets/forest/back_depth.png', forestNear: 'assets/forest/near.json',
  brook: 'assets/audio/forest_brook.wav', magicBed: 'assets/audio/magic_forest.wav',
  twinkles: ['assets/audio/twinkle_a.mp3', 'assets/audio/twinkle_b.mp3', 'assets/audio/twinkle_c.mp3'],
  leaAlbedo: `assets/leather/brown_leather_albedo_${LEA}.jpg`, leaNor: `assets/leather/brown_leather_nor_gl_${LEA}.jpg`,
  leaRough: `assets/leather/brown_leather_rough_${LEA}.jpg`,
  goldFront: 'models/gold_front.glb?v=2', goldBack: 'models/gold_back.glb?v=2',
  maskFront: 'models/gold_front_mask.png?v=2', maskBack: 'models/gold_back_mask.png?v=2',
  rock: 'models/rock.glb?v=3',
  granite: 'assets/rock/granite.jpg', moss: 'assets/rock/moss.jpg',
  stone: HI_RES ? 'assets/rock/stone_2k.jpg' : 'assets/rock/stone_1k.jpg', stoneNor: 'assets/rock/stone_nor.jpg'
};

/* A backgrounded pane can report a 0x0 viewport; keep the last good size. */
let VW = 1280, VH = 720;
function measureViewport(){
  const w = innerWidth || document.documentElement.clientWidth || 0;
  const h = innerHeight || document.documentElement.clientHeight || 0;
  if(w >= 2 && h >= 2){ VW = w; VH = h; return true; }
  return false;
}
measureViewport();

/* ============================================================================
   1.  renderer, the forest, light, post
   ==========================================================================*/
const canvasEl = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: false, alpha: false, powerPreference: 'high-performance' });
/* a phone starts at 1.5 device pixels to a CSS pixel and steps down while its frames run
   slow (adaptPixels, 15. loop); the post passes and the forest are what fill its GPU */
const DPR_MAX = Math.min(devicePixelRatio, HI_RES ? 2 : 1.5);
let DPR = DPR_MAX;
renderer.setPixelRatio(DPR);
renderer.setSize(VW, VH, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
/* the shadow maps are drawn again only when something casting one has moved: the book
   (bookRoot's place) or its leaves and boards (layout); the boulder never moves */
renderer.shadowMap.autoUpdate = false;
/* a phone keeps no copy of its pictures once they are on the GPU (shed), so a GPU that
   comes back after iOS took it away has nothing to load them from: start the page again */
canvasEl.addEventListener('webglcontextrestored', ()=>{ if(!HI_RES) location.reload(); });
let shadowDirty = true;
const shadowKey = new Float32Array(16);
setMaxAniso(renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f08);
const camera = new THREE.PerspectiveCamera(40, VW/VH, 0.1, 400);
camera.position.set(0, 8, 9);

/* the low sun of the forest render (blender/build_forest.py SUN_TOWARD), behind the book on the right */
/* the whole forest (and the boulder in it) is turned about the book this much, so the
   reader faces the sun through the trees, the way the reference is lit */
const FOREST_YAW = 0.5;
const SUN_DIR = new THREE.Vector3(0.45, 0.55, -0.70).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), FOREST_YAW);
const sun = new THREE.DirectionalLight(0xfff2e2, 1.6);
sun.position.copy(SUN_DIR).multiplyScalar(22);
sun.castShadow = true;
sun.shadow.mapSize.set(HI_RES ? 4096 : 2048, HI_RES ? 4096 : 2048);
sun.shadow.camera.near = 4; sun.shadow.camera.far = 50;
sun.shadow.camera.left = -15; sun.shadow.camera.right = 15;
sun.shadow.camera.top = 15; sun.shadow.camera.bottom = -15;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 3;
scene.add(sun, sun.target);
const gemLight = new THREE.PointLight(0x5aa0ff, 0.5, 2.2, 2);
scene.add(gemLight);
/* a shaft of sun through a gap in the canopy, landing on the book: the book and the
   crown of the boulder stand in a pool of light brighter than the wood round them */
const BEAM_AT = new THREE.Vector3(0, 0.3, 0);
const BEAM_R = 4.6;                      // its radius where it lands
const BEAM_FROM = 34;                    // how far up the gap in the leaves is
/* it is the forest's own sun, so the shaft runs the way every other ray in the wood
   runs, up toward the bright gap behind the book */
const BEAM_DIR = SUN_DIR;
/* the gap is not round and clean: light comes through between leaves, so the shaft is
   made of many soft rays. The pool on the book stays whole: flecks of it on the pages
   read as stains on the parchment */
const goboTex = (()=>{
  const S = 256, c = cv(S, S), x = c.getContext('2d'), rnd = mulberry32(4711);
  x.fillStyle = '#262626'; x.fillRect(0, 0, S, S);
  for(let i=0;i<70;i++){
    const px = rnd()*S, py = rnd()*S, r = 6 + Math.pow(rnd(), 2)*34, a = 0.25 + rnd()*0.55;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.55, `rgba(255,255,255,${a*0.6})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.ellipse(px, py, r, r*(0.7 + rnd()*0.3), rnd()*3, 0, 7); x.fill();
  }
  const b = cv(S, S), y = b.getContext('2d');
  y.filter = 'blur(3px)'; y.drawImage(c, 0, 0);
  const t = new THREE.CanvasTexture(b);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const beam = new THREE.SpotLight(0xffeedd, 2.5, 0, Math.atan(BEAM_R*1.25/BEAM_FROM), 0.9, 0);
beam.position.copy(BEAM_DIR).multiplyScalar(BEAM_FROM).add(BEAM_AT);
beam.target.position.copy(BEAM_AT);
beam.castShadow = true;
beam.shadow.mapSize.set(HI_RES ? 2048 : 1024, HI_RES ? 2048 : 1024);
beam.shadow.camera.near = BEAM_FROM - 12; beam.shadow.camera.far = BEAM_FROM + 12;
beam.shadow.bias = -0.0004; beam.shadow.normalBias = 0.02; beam.shadow.radius = 4;
scene.add(beam, beam.target);

/* shafts of light falling through the canopy, all parallel to the sun */
/* the forest render carries its own shafts of light now; these stay hidden */
const rayGroup = new THREE.Group();
rayGroup.visible = false;
scene.add(rayGroup);
{
  const alpha = new THREE.CanvasTexture(makeRayAlpha());
  const rnd = mulberry32(51);
  const up = new THREE.Vector3(0,1,0);
  for(let i=0;i<7;i++){
    const h = 26 + rnd()*8, r = 0.5 + rnd()*1.3;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r*1.6, r, h, 24, 1, true),
      new THREE.MeshBasicMaterial({ color:0xfff1d6, transparent:true, opacity:0.015 + rnd()*0.02, alphaMap:alpha,
        blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide, fog:false }));
    const foot = new THREE.Vector3(-10 + rnd()*20, -1.5, -24 + rnd()*12);
    m.quaternion.setFromUnitVectors(up, SUN_DIR);
    m.position.copy(foot).addScaledVector(SUN_DIR, h*0.5);
    m.userData.base = m.material.opacity; m.userData.ph = rnd()*6;
    rayGroup.add(m);
  }
}

{
  const alpha = new THREE.CanvasTexture(makeRayAlpha());
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 0.9, 30, 32, 1, true),
    new THREE.MeshBasicMaterial({ color:0xffc070, transparent:true, opacity:0.035, alphaMap:alpha,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide }));
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), SUN_DIR);
  shaft.position.set(1.6, 0, -0.3).addScaledVector(SUN_DIR, 15.5);
  shaft.userData.base = 0.035; shaft.userData.ph = 1.3;
  rayGroup.add(shaft);
}

/* warm motes drifting in the light */
let dust;
{
  const NP = 170;
  const pos = new Float32Array(NP*3), seed = new Float32Array(NP);
  for(let i=0;i<NP;i++){
    pos[i*3] = (Math.random()-0.5)*18; pos[i*3+1] = Math.random()*8 - 0.5; pos[i*3+2] = (Math.random()-0.6)*12;
    seed[i] = Math.random()*100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  const sprite = new THREE.CanvasTexture(makeSpriteCanvas(64));
  sprite.colorSpace = THREE.SRGBColorSpace;
  dust = new THREE.Points(g, new THREE.PointsMaterial({
    map: sprite, size: 0.06, sizeAttenuation: true, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffc070 }));
  dust.userData.seed = seed; dust.frustumCulled = false;
  scene.add(dust);
}

/* the shaft itself, seen in the forest's haze. It is a pass over the finished picture:
   each eye ray is marched through the beam up to the first thing it meets (the depth
   the scene left behind), so the light falls on the book, the stone and the ground and
   passes behind them, with no surface of its own to show an edge. The haze is thin and
   drifts, the rays are the gaps in the leaves, and it scatters forward, so it glows
   most when one looks up it toward the sun and almost vanishes from behind */
const beamU = {
  uA: { value: BEAM_AT }, uD: { value: BEAM_DIR }, uSig: { value: BEAM_R*0.5 }, uLen: { value: BEAM_FROM*1.1 },
  uTime: { value: 0 }, uK: { value: 1 }, uGobo: { value: BEAM_R*2.5 },
  uX: { value: new THREE.Vector3() }, uY: { value: new THREE.Vector3() },
  uCol: { value: new THREE.Color(0xfff0dc).multiplyScalar(0.05) }
};
beamU.uX.value.crossVectors(new THREE.Vector3(0, 1, 0), BEAM_DIR).normalize();
beamU.uY.value.crossVectors(BEAM_DIR, beamU.uX.value).normalize();
class BeamPass extends Pass {
  constructor(){
    super();
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...beamU, tColor: { value: null }, tDepth: { value: null }, tGobo: { value: goboTex },
        uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D tColor, tDepth, tGobo; uniform mat4 uInvProj, uCamWorld;
        uniform vec3 uA, uD, uX, uY, uCol; uniform float uSig, uLen, uTime, uK, uGobo; varying vec2 vUv;
        float h31(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x + p.y + p.z)); }
        float vn3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0 - 2.0*f);
          return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }
        void main(){
          vec4 base = texture2D(tColor, vUv);
          gl_FragColor = base;
          if(uK < 0.001) return;
          float z = texture2D(tDepth, vUv).x;
          vec4 v = uInvProj*vec4(vUv*2.0 - 1.0, z*2.0 - 1.0, 1.0); v /= v.w;
          float tEnd = z > 0.99999 ? 800.0 : length(v.xyz);
          vec3 ro = (uCamWorld*vec4(0.0, 0.0, 0.0, 1.0)).xyz, rd = normalize((uCamWorld*vec4(v.xyz, 0.0)).xyz);
          vec3 w0 = ro - uA, dp = rd - uD*dot(rd, uD), wp = w0 - uD*dot(w0, uD);
          float R = uSig*(1.0 + uLen*0.012)*3.0;
          float a = dot(dp, dp), b = dot(dp, wp), c = dot(wp, wp) - R*R, disc = b*b - a*c;
          if(disc <= 0.0 || a < 1e-6) return;
          float sq = sqrt(disc), t0 = max((-b - sq)/a, 0.0), t1 = min((-b + sq)/a, tEnd);
          if(t1 <= t0) return;
          const int N = ${HI_RES ? 32 : 14};
          float dt = (t1 - t0)/float(N);
          float jit = fract(52.9829189*fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          vec2 sway = vec2(sin(uTime*0.13), cos(uTime*0.11))*0.006;
          float acc = 0.0;
          for(int i=0;i<N;i++){
            vec3 p = ro + rd*(t0 + (float(i) + jit)*dt);
            vec3 q = p - uA; float s = dot(q, uD); vec3 x = q - uD*s;
            float sig = uSig*(1.0 + max(s, 0.0)*0.012);
            float prof = exp(-dot(x, x)/(sig*sig));
            float leaf = 0.25 + 1.5*texture2D(tGobo, vec2(dot(x, uX), dot(x, uY))/uGobo + 0.5 + sway).r;
            float ax = smoothstep(-8.0, -3.0, s)*(1.0 - smoothstep(uLen*0.35, uLen, s));
            float mist = 0.45 + vn3(p*0.08 + vec3(uTime*0.03, -uTime*0.04, 0.0));
            acc += prof*leaf*ax*mist;
          }
          float cs = dot(rd, uD);
          float hg = 0.3 + 0.64/pow(1.36 - 1.2*cs, 1.5)*0.2;
          gl_FragColor = vec4(base.rgb + uCol*acc*dt*hg*uK, base.a);
        }`
    });
    this.quad = new FullScreenQuad(this.material);
  }
  render(renderer, writeBuffer, readBuffer){
    const u = this.material.uniforms;
    u.tColor.value = readBuffer.texture; u.tDepth.value = readBuffer.depthTexture;
    u.uInvProj.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

/* motes drifting in the shaft, catching the sun and going dark as they leave it */
const BEAM_MOTES = HI_RES ? 320 : 180;
const beamMotes = (()=>{
  const g = new THREE.BufferGeometry(), seed = new Float32Array(BEAM_MOTES*4), rnd = mulberry32(913);
  for(let i=0;i<BEAM_MOTES;i++){
    seed[i*4] = Math.pow(rnd(), 1.6)*BEAM_FROM*0.55;
    seed[i*4+1] = rnd()*Math.PI*2;
    seed[i*4+2] = Math.sqrt(rnd())*BEAM_R*1.15;
    seed[i*4+3] = rnd();
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BEAM_MOTES*3), 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uA: beamU.uA, uD: beamU.uD, uSig: beamU.uSig, uTime: beamU.uTime, uK: { value: 1 }, uScale: { value: 1 } },
    vertexShader: `attribute vec4 seed; uniform vec3 uA, uD; uniform float uSig, uTime, uScale; varying float vA;
      void main(){
        vec3 n1 = normalize(cross(uD, vec3(0.0, 1.0, 0.0))), n2 = cross(n1, uD);
        float ph = seed.w*40.0, t = uTime*(0.05 + 0.08*seed.w);
        float s = seed.x + sin(t*1.3 + ph)*0.8;
        float a = seed.y + t*0.4, r = seed.z*(1.0 + 0.12*sin(t*0.9 + ph));
        vec3 p = uA + uD*s + (n1*cos(a) + n2*sin(a))*r + vec3(sin(t*2.1 + ph), cos(t*1.7 + ph*1.3), sin(t*1.9 + ph*0.7))*0.35;
        float lit = exp(-r*r/(uSig*uSig*1.3))*smoothstep(-0.2, 1.5, s);
        float glint = pow(0.5 + 0.5*sin(uTime*(0.7 + 1.6*seed.w) + ph), 6.0);
        vA = lit*(0.25 + 0.75*glint);
        vec4 mv = modelViewMatrix*vec4(p, 1.0);
        gl_Position = projectionMatrix*mv;
        gl_PointSize = uScale*(0.55 + 0.6*seed.w)/max(0.1, -mv.z);
      }`,
    fragmentShader: `varying float vA; uniform float uK;
      void main(){ float d = length(gl_PointCoord - 0.5); float a = (smoothstep(0.5, 0.0, d)*0.5 + smoothstep(0.16, 0.0, d))*vA*uK;
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.8)*a*1.5, a); }`
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  scene.add(pts);
  return pts;
})();

/* post: bloom for the gilt and the magic, then a warm grade */
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(VW*DPR, VH*DPR, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(VW*DPR, VH*DPR) }));
/* the second target's clone shares the first's depth source, so the beam would read the
   depth the pass is drawing into; without MSAA in between, Safari draws nothing then */
composer.renderTarget2.depthTexture = new THREE.DepthTexture(VW*DPR, VH*DPR);
composer.setPixelRatio(DPR);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new BeamPass());
const bloom = new UnrealBloomPass(new THREE.Vector2(VW, VH), 0.34, 0.6, 0.9);
/* the glow is soft anyway: a phone blurs it from a sixteenth of the pixels */
if(!HI_RES){ const setSize = bloom.setSize.bind(bloom); bloom.setSize = (w, h)=>setSize(w/4, h/4); }
composer.addPass(bloom);
composer.addPass(new OutputPass());
const gradePass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.55 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      /* one grade over the forest, the stone and the book alike: cool blue-green
         dusk in the shade, the sun's warmth kept only where it really falls */
      float l = dot(c, vec3(0.299,0.587,0.114));
      float yel = clamp((min(c.r, c.g) - c.b)*2.2, 0.0, 1.0)*(1.0 - 0.75*smoothstep(0.4, 0.75, l));
      c = mix(c, vec3(l), 0.32*yel + 0.06);
      vec3 shade = vec3(0.9, 0.98, 1.05), light = vec3(1.03, 1.0, 0.94);
      c *= mix(shade, light, smoothstep(0.25, 0.85, l));
      c += vec3(0.0, 0.006, 0.015)*(1.0 - smoothstep(0.0, 0.35, l));
      c = mix(c, smoothstep(0.0, 1.0, c), 0.25);
      float d = distance(vUv, vec2(0.5, 0.46));
      c *= mix(1.0, smoothstep(0.92, 0.28, d), uVig);
      gl_FragColor = vec4(c, 1.0);
    }`
});
composer.addPass(gradePass);

/* ============================================================================
   2.  hierarchy: float -> spin (free trackball) -> centre -> book
   ==========================================================================*/
const floatGrp = new THREE.Group();
const spinGrp  = new THREE.Group();
const bookRoot = new THREE.Group();
scene.add(floatGrp); floatGrp.add(spinGrp); spinGrp.add(bookRoot);

/* ============================================================================
   3.  materials (leather maps arrive with the scans, see applyLeather)
   ==========================================================================*/
const boardArt = side => new THREE.MeshPhysicalMaterial({
  color: 0x18233f, metalness: 0, roughness: 0.62, clearcoat: 0.1, clearcoatRoughness: 0.6,
  normalScale: new THREE.Vector2(1.0, 1.0), name: 'board-' + side
});
const matCoverFront = boardArt('front');
const matCoverBack  = boardArt('back');
/* the bright gap in the canopy behind the book would wash the matte leather out */
matCoverFront.envMapIntensity = matCoverBack.envMapIntensity = 0.55;
const matLeatherEdge = new THREE.MeshPhysicalMaterial({ color: 0x18233f, roughness: 0.65, metalness: 0, clearcoat: 0.15 });
const matGold = new THREE.MeshPhysicalMaterial({
  color: 0xc99b4a, metalness: 1, roughness: 0.33, envMapIntensity: 1.3, clearcoat: 0.12, clearcoatRoughness: 0.5,
  emissive: 0xffc56e, emissiveIntensity: 0
});
/* the fore edge of aged leaves, slightly uneven from leaf to leaf (vertex colours) */
const matLeafEdge = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.82, metalness:0.05, envMapIntensity:0.8 });
/* each leaf here is as thick as a few sheets of paper, so its cut face shows them: fine
   seams across it, each sheet a shade of its own. Where a pixel spans several sheets the
   seams melt into their mean tone instead of shimmering */
matLeafEdge.onBeforeCompile = sh=>{
  sh.vertexShader = 'attribute float aEdge; varying float vEdge;\n' + sh.vertexShader
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEdge = aEdge;');
  sh.fragmentShader = 'varying float vEdge;\n' + sh.fragmentShader
    .replace('#include <color_fragment>', `#include <color_fragment>
      { float a = vEdge*5.0, w = fwidth(a), f = fract(a), d = min(f, 1.0 - f);
        float seam = 1.0 - smoothstep(0.0, 0.08 + 1.5*w, d);
        float tone = fract(sin(floor(a)*91.7 + vColor.r*613.0)*43758.5);
        float fade = 1.0 - smoothstep(0.25, 0.6, w);
        diffuseColor.rgb *= mix(0.94, 1.0 + 0.06*(tone - 0.5) - 0.2*seam, fade); }`);
};
const matLining = new THREE.MeshStandardMaterial({ color:0x3a2a18, roughness:1, metalness:0, side:THREE.DoubleSide });

/* ============================================================================
   4.  page artwork
   ==========================================================================*/
/* vellum: mottled, crinkled, fibrous, with foxing, like a hand-made sheet */
function makeVellum(S){
  const mot = upsample(fbm(S>>2,S>>2, 3,3, 5, 404), S>>2,S>>2, S,S);
  const stain = upsample(fbm(S>>3,S>>3, 2,2, 3, 91), S>>3,S>>3, S,S);
  const crin = fbm(S, S, 64, 64, 3, 515);
  const fib = fbm(S, S, 8, 220, 2, 77);
  const c = cv(S,S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S,S), d = img.data;
  const rnd = mulberry32(1234);
  const hf = new Float32Array(S*S);
  for(let i=0,p=0;i<S*S;i++,p+=4){
    const ridged = 1 - Math.abs(crin[i]*2 - 1);
    let r=0.82, g=0.70, b=0.51;
    const lift = (mot[i]-0.5)*0.22 + (ridged-0.62)*0.12 + (fib[i]-0.5)*0.045 + (rnd()-0.5)*0.05;
    r += lift*0.8; g += lift*0.85; b += lift*1.0;
    const bl = Math.pow(clamp((stain[i]-0.48)/0.52,0,1), 1.4);
    r = lerp(r, 0.70, bl*0.65); g = lerp(g, 0.56, bl*0.7); b = lerp(b, 0.37, bl*0.75);
    d[p]=clamp(r,0,1)*255; d[p+1]=clamp(g,0,1)*255; d[p+2]=clamp(b,0,1)*255; d[p+3]=255;
    hf[i] = 0.5 + (ridged-0.6)*0.55 + (fib[i]-0.5)*0.15 + (mot[i]-0.5)*0.2 + (rnd()-0.5)*0.12;
  }
  ctx.putImageData(img,0,0);
  /* long fibres laid into the sheet */
  for(let i=0;i<2600;i++){
    const x = rnd()*S, y = rnd()*S, a = (rnd()-0.5)*0.7, L = 6 + rnd()*22;
    ctx.strokeStyle = rnd() < 0.5 ? `rgba(255,240,205,${0.05+rnd()*0.07})` : `rgba(90,60,25,${0.04+rnd()*0.06})`;
    ctx.lineWidth = 0.5 + rnd()*0.9;
    ctx.beginPath(); ctx.moveTo(x,y);
    ctx.quadraticCurveTo(x + Math.cos(a)*L*0.5, y + Math.sin(a)*L*0.5 + (rnd()-0.5)*4, x + Math.cos(a)*L, y + Math.sin(a)*L);
    ctx.stroke();
  }
  /* the tooth of a rag sheet: flecks of bark and dark fibre caught in the pulp */
  for(let i=0;i<9000;i++){
    const x = rnd()*S, y = rnd()*S, r = 0.4 + rnd()*0.9;
    ctx.fillStyle = rnd() < 0.8 ? `rgba(90,70,45,${0.05+rnd()*0.12})` : `rgba(255,246,225,${0.06+rnd()*0.1})`;
    ctx.fillRect(x, y, r, r*(0.6+rnd()*0.9));
  }
  /* foxing */
  for(let i=0;i<110;i++){
    const x = rnd()*S, y = rnd()*S, r = 1 + rnd()*5;
    const gr = ctx.createRadialGradient(x,y,0,x,y,r);
    gr.addColorStop(0, `rgba(130,92,50,${0.06+rnd()*0.12})`); gr.addColorStop(1,'rgba(130,92,50,0)');
    ctx.fillStyle = gr; ctx.fillRect(x-r,y-r,r*2,r*2);
  }
  return { base: c, normalTex: shed(tex(normalFromHeight(hf,S,S,3.0), {rx:2.5, ry:2.5})) };
}
const parch = makeVellum(1024);
/* the edges of an old leaf brown first, unevenly, worst at the corners */
const edgeTone = (()=>{
  const W = PAGE_W >> 1, H = PAGE_H >> 1;
  const n1 = upsample(fbm(W>>3, H>>3, 4, 5, 4, 808), W>>3, H>>3, W, H);
  const n2 = fbm(W, H, 40, 52, 2, 909);
  const c = cv(W, H), ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H), d = img.data;
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const i = y*W + x, u = x/W, v = y/H;
    const e = Math.min(u, 1-u, v*0.72, (1-v)*0.72);
    const corner = Math.max(0, 0.16 - Math.hypot(Math.min(u,1-u), Math.min(v,1-v)*0.72))/0.16;
    let a = Math.exp(-e/0.035)*0.75 + Math.exp(-e/0.12)*0.28 + corner*0.35;
    a *= 0.55 + 0.9*n1[i] + (n2[i]-0.5)*0.3;
    d[i*4] = 112; d[i*4+1] = 84; d[i*4+2] = 52; d[i*4+3] = clamp(a*0.8, 0, 0.6)*255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
})();
/* doublure: the inside of each board is lined with dark chocolate leather, tooled
   in gold (fillets, a beaded roll, filigree corner pieces), carried round the
   hinge into the gutter. One map: u 0..HINGE_U is the hinge, HINGE_U..1 the panel */
const EP_X0 = 0.14, EP_X1 = CW - 0.07, EP_H = CH - 0.14, EP_HINGE = 0.45, JOINT_H = PH - 0.02;
const HINGE_U = EP_HINGE/(EP_X1 - EP_X0 + EP_HINGE);
/* the pastedown and its joints lie a hair above the board: pulled toward the eye in depth,
   so the board's own face never shows through them at a grazing angle */
const matEndpaper = new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.7, metalness: 0, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });

const PINK = a => `rgba(64,38,14,${a})`;
function spiralPath(ctx, cx, cy, r0, r1, a0, turns, cw){
  const n = Math.max(10, Math.round(turns*28));
  for(let i=0;i<=n;i++){
    const t = i/n, a = a0 + cw*turns*Math.PI*2*t, r = r0 + (r1-r0)*t;
    const x = cx + Math.cos(a)*r, y = cy + Math.sin(a)*r;
    i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
  }
}
function inkLeaf(ctx, x, y, ang, L, W){
  ctx.save(); ctx.translate(x,y); ctx.rotate(ang);
  ctx.beginPath(); ctx.moveTo(0,0);
  ctx.bezierCurveTo(W, -L*0.3, W*0.7, -L*0.75, 0, -L);
  ctx.bezierCurveTo(-W*0.7, -L*0.75, -W, -L*0.3, 0, 0);
  ctx.fill(); ctx.stroke();
  ctx.restore();
}
/* engraved border after the reference: double rules, a chain band, corner
   scrollwork and lozenge medallions at the middle of each side */
function drawOrnateBorder(ctx){
  ctx.save();
  ctx.scale(SC,SC);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const X0 = 15, Y0 = 15, X1 = 325, Y1 = 443;
  const rule = (i, w, a)=>{ ctx.strokeStyle = PINK(a); ctx.lineWidth = w; ctx.strokeRect(X0+i, Y0+i, X1-X0-2*i, Y1-Y0-2*i); };
  rule(0, 1.25, .82); rule(2.6, .45, .7);
  rule(9.8, .45, .7); rule(12.2, .95, .8);
  /* chain band: alternating lozenges and pearls */
  const band = (ax, ay, bx, by)=>{
    const L = Math.hypot(bx-ax, by-ay), n = Math.floor(L/6.2);
    for(let k=1;k<n;k++){
      const t = k/n; if(Math.abs(t-0.5) < 2.2/n) continue;
      const x = ax + (bx-ax)*t, y = ay + (by-ay)*t;
      if(k%2){
        ctx.fillStyle = PINK(.75);
        ctx.beginPath(); ctx.moveTo(x, y-2.0); ctx.lineTo(x+1.5, y); ctx.lineTo(x, y+2.0); ctx.lineTo(x-1.5, y); ctx.closePath(); ctx.fill();
      }else{
        ctx.fillStyle = PINK(.6); ctx.beginPath(); ctx.arc(x, y, 0.75, 0, 7); ctx.fill();
      }
    }
  };
  const m = 6.2;
  band(X0+m, Y0+m, X1-m, Y0+m); band(X0+m, Y1-m, X1-m, Y1-m);
  band(X0+m, Y0+m, X0+m, Y1-m); band(X1-m, Y0+m, X1-m, Y1-m);
  /* medallions on the band at mid-sides */
  const medal = (x, y, rotA)=>{
    ctx.save(); ctx.translate(x,y); ctx.rotate(rotA);
    ctx.clearRect(-9,-5,18,10);
    ctx.strokeStyle = PINK(.85); ctx.lineWidth = .8; ctx.fillStyle = PINK(.18);
    ctx.beginPath(); ctx.moveTo(0,-5.4); ctx.lineTo(5,0); ctx.lineTo(0,5.4); ctx.lineTo(-5,0); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = PINK(.85); ctx.beginPath(); ctx.arc(0,0,1.3,0,7); ctx.fill();
    ctx.lineWidth = .6;
    [-1,1].forEach(s=>{ ctx.beginPath(); spiralPath(ctx, s*8.3, 0, 2.8, 0.5, s>0?Math.PI:0, 1.2, s); ctx.stroke(); });
    ctx.restore();
  };
  medal((X0+X1)/2, Y0+m, 0); medal((X0+X1)/2, Y1-m, 0);
  medal(X0+m, (Y0+Y1)/2, Math.PI/2); medal(X1-m, (Y0+Y1)/2, Math.PI/2);
  /* corner scrollwork inside the inner rule */
  const corner = (x, y, sx, sy)=>{
    ctx.save(); ctx.translate(x,y); ctx.scale(sx,sy);
    ctx.strokeStyle = PINK(.82); ctx.fillStyle = PINK(.55); ctx.lineWidth = .7;
    ctx.clearRect(-m-2.2,-m-2.2,4.4,4.4);
    ctx.fillStyle = PINK(.7);
    ctx.beginPath(); ctx.moveTo(-m,-m-2.4); ctx.lineTo(-m+2.4,-m); ctx.lineTo(-m,-m+2.4); ctx.lineTo(-m-2.4,-m); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(1.5, 30); ctx.bezierCurveTo(2, 16, 8, 8, 18, 6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(30, 1.5); ctx.bezierCurveTo(16, 2, 8, 8, 6, 18); ctx.stroke();
    ctx.beginPath(); spiralPath(ctx, 21, 9, 4.2, 0.6, Math.PI*1.1, 1.3, 1); ctx.stroke();
    ctx.beginPath(); spiralPath(ctx, 9, 21, 4.2, 0.6, Math.PI*0.4, 1.3, -1); ctx.stroke();
    ctx.lineWidth = .5; ctx.fillStyle = PINK(.45);
    inkLeaf(ctx, 7, 7, Math.PI*0.75, 11, 3.2);
    inkLeaf(ctx, 7, 7, Math.PI*0.55, 7.5, 2.2);
    inkLeaf(ctx, 7, 7, Math.PI*0.95, 7.5, 2.2);
    ctx.fillStyle = PINK(.8); ctx.beginPath(); ctx.arc(4.2, 4.2, 1.6, 0, 7); ctx.fill();
    [[26,4],[4,26],[14,15]].forEach(([px,py])=>{ ctx.beginPath(); ctx.arc(px,py,.7,0,7); ctx.fill(); });
    ctx.restore();
  };
  const ci = 13.6;
  corner(X0+ci, Y0+ci, 1, 1); corner(X1-ci, Y0+ci, -1, 1); corner(X0+ci, Y1-ci, 1, -1); corner(X1-ci, Y1-ci, -1, -1);
  ctx.restore();
}
/* the border is printed once into its own sheet and worn there: the ink is
   thinned and broken where an old impression lost it, then laid on by multiply */
let borderCanvas = null;
function borderArt(){
  if(borderCanvas) return borderCanvas;
  const c = cv(PAGE_W, PAGE_H), ctx = c.getContext('2d');
  ctx.filter = `blur(${(0.35*SC).toFixed(2)}px)`;
  drawOrnateBorder(ctx);
  ctx.filter = 'none';
  const W = PAGE_W >> 2, H = PAGE_H >> 2;
  const wear = upsample(fbm(W>>2, H>>2, 6, 8, 4, 616), W>>2, H>>2, W, H);
  const m = cv(W, H), mx = m.getContext('2d'), img = mx.createImageData(W, H), d = img.data;
  const rnd = mulberry32(4242);
  for(let i=0;i<W*H;i++){ d[i*4+3] = clamp((wear[i]-0.45)*2.2 + (rnd()-0.5)*0.5, 0, 0.9)*255; }
  mx.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(m, 0, 0, PAGE_W, PAGE_H);
  borderCanvas = c;
  return c;
}
/* gold leaf laid over the printed ornament (the inner rule, the corner fleurons,
   the lozenges at mid-side), rubbed thin in places; drawn once for every page.
   gilt().color goes on the page art, gilt().pbr is the shared roughness (G) and
   metalness (B) map that makes it shine as metal while the paper stays matte */
let giltCanvases = null;
function gilt(){
  if(giltCanvases) return giltCanvases;
  const mask = cv(PAGE_W, PAGE_H), ctx = mask.getContext('2d');
  ctx.save(); ctx.scale(SC, SC);
  ctx.fillStyle = ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const X0 = 15, Y0 = 15, X1 = 325, Y1 = 443, m = 6.2, ci = 13.6;
  ctx.lineWidth = 1.05; ctx.strokeRect(X0+12.2, Y0+12.2, X1-X0-24.4, Y1-Y0-24.4);
  const lozenge = (x, y, rx, ry)=>{ ctx.beginPath(); ctx.moveTo(x, y-ry); ctx.lineTo(x+rx, y); ctx.lineTo(x, y+ry); ctx.lineTo(x-rx, y); ctx.closePath(); ctx.fill(); };
  [[(X0+X1)/2, Y0+m, 0], [(X0+X1)/2, Y1-m, 0], [X0+m, (Y0+Y1)/2, 1], [X1-m, (Y0+Y1)/2, 1]].forEach(([x, y, v])=>{
    v ? lozenge(x, y, 5.4, 5) : lozenge(x, y, 5, 5.4);
  });
  [[X0+ci, Y0+ci, 1, 1], [X1-ci, Y0+ci, -1, 1], [X0+ci, Y1-ci, 1, -1], [X1-ci, Y1-ci, -1, -1]].forEach(([x, y, sx, sy])=>{
    ctx.save(); ctx.translate(x, y); ctx.scale(sx, sy);
    lozenge(-m, -m, 2.4, 2.4);
    ctx.lineWidth = 0.2;
    inkLeaf(ctx, 7, 7, Math.PI*0.75, 11, 3.2);
    inkLeaf(ctx, 7, 7, Math.PI*0.55, 7.5, 2.2);
    inkLeaf(ctx, 7, 7, Math.PI*0.95, 7.5, 2.2);
    ctx.beginPath(); ctx.arc(4.2, 4.2, 1.6, 0, 7); ctx.fill();
    ctx.restore();
  });
  ctx.restore();
  /* worn leaf: rubbed off in small flecks, never wholly gone */
  const W = PAGE_W >> 2, H = PAGE_H >> 2;
  const wear = fbm(W, H, 30, 40, 3, 2323);
  const wm = cv(W, H), wx = wm.getContext('2d'), wi = wx.createImageData(W, H);
  for(let i=0;i<W*H;i++) wi.data[i*4+3] = clamp((wear[i]-0.58)*2.4, 0, 0.7)*255;
  wx.putImageData(wi, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(wm, 0, 0, PAGE_W, PAGE_H);
  const tint = (fill)=>{
    const c = cv(PAGE_W, PAGE_H), x = c.getContext('2d');
    x.drawImage(mask, 0, 0); x.globalCompositeOperation = 'source-in';
    x.fillStyle = fill; x.fillRect(0, 0, PAGE_W, PAGE_H);
    return c;
  };
  const color = tint('rgb(214,172,92)');
  const pbr = cv(PAGE_W, PAGE_H), px = pbr.getContext('2d');
  px.fillStyle = 'rgb(0,235,0)'; px.fillRect(0, 0, PAGE_W, PAGE_H);
  px.drawImage(tint('rgb(0,82,255)'), 0, 0);
  giltCanvases = { color, pbr: tex(pbr, { wrap:false }) };
  return giltCanvases;
}
/* one rune from straight staves like old futhark, centred on the origin */
function runeStroke(ctx, kind, h, w){
  ctx.beginPath(); ctx.moveTo(0, -h); ctx.lineTo(0, h);
  if(kind === 0){ ctx.moveTo(0, -h); ctx.lineTo(w, -h*0.3); }
  else if(kind === 1){ ctx.moveTo(0, -h*0.4); ctx.lineTo(w, -h); ctx.moveTo(0, h*0.2); ctx.lineTo(w, -h*0.4); }
  else if(kind === 2){ ctx.moveTo(-w, -h*0.5); ctx.lineTo(w, h*0.5); }
  else if(kind === 3){ ctx.moveTo(0, -h); ctx.lineTo(w, -h*0.5); ctx.lineTo(0, 0); }
  else if(kind === 4){ ctx.moveTo(-w, -h); ctx.lineTo(0, -h*0.3); ctx.lineTo(w, -h); }
  else { ctx.moveTo(0, -h*0.2); ctx.lineTo(-w, h*0.6); ctx.moveTo(0, -h*0.2); ctx.lineTo(w, h*0.6); }
  ctx.stroke();
}
/* a magic circle pressed into the sheet like a watermark, so every leaf reads as
   part of a book of spells and the writing still sits clearly over it */
let sigilCanvas = null;
function sigilArt(){
  if(sigilCanvas) return sigilCanvas;
  const R = 118*SC, c = cv(Math.ceil(R*2.2), Math.ceil(R*2.2)), ctx = c.getContext('2d');
  ctx.translate(c.width/2, c.height/2);
  ctx.strokeStyle = PINK(1); ctx.fillStyle = PINK(1); ctx.lineCap = 'round';
  const ring = (r, w)=>{ ctx.lineWidth = w*SC; ctx.beginPath(); ctx.arc(0, 0, r*SC, 0, Math.PI*2); ctx.stroke(); };
  ring(118, 1.1); ring(112, 0.5); ring(84, 0.8); ring(80, 0.4); ring(30, 0.7);
  /* a seven-pointed star joining the inner ring */
  ctx.lineWidth = 0.7*SC; ctx.beginPath();
  for(let i=0;i<=7;i++){ const a = -Math.PI/2 + i*3*Math.PI*2/7; const x = Math.cos(a)*80*SC, y = Math.sin(a)*80*SC; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke();
  /* runes in the band between the rings, drawn from straight staves like old futhark */
  const rnd = mulberry32(777);
  const NR = 28;
  for(let i=0;i<NR;i++){
    ctx.save();
    ctx.rotate(i/NR*Math.PI*2);
    ctx.translate(0, -98*SC);
    ctx.lineWidth = 0.75*SC;
    runeStroke(ctx, Math.floor(rnd()*6), 7*SC, 3.6*SC);
    ctx.restore();
  }
  for(let i=0;i<7;i++){ const a = -Math.PI/2 + i*Math.PI*2/7; ctx.beginPath(); ctx.arc(Math.cos(a)*118*SC, Math.sin(a)*118*SC, 2.6*SC, 0, Math.PI*2); ctx.fill(); }
  ctx.beginPath(); ctx.arc(0, 0, 3*SC, 0, Math.PI*2); ctx.fill();
  /* faint, and broken like an old impression */
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = 'rgba(0,0,0,0.13)'; ctx.fillRect(0, 0, c.width, c.height);
  sigilCanvas = c;
  return c;
}
function divider(ctx, cx, y, w, s){
  ctx.save(); ctx.translate(cx, y); ctx.scale(s, s);
  ctx.strokeStyle = PINK(.85); ctx.fillStyle = PINK(.8); ctx.lineWidth = .8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-w,0); ctx.lineTo(-14,0); ctx.moveTo(14,0); ctx.lineTo(w,0); ctx.stroke();
  [-1,1].forEach(d=>{
    ctx.beginPath(); spiralPath(ctx, d*9, -2.5, 3.6, 0.6, d>0?Math.PI*0.9:Math.PI*0.1, 1.25, d); ctx.stroke();
    ctx.beginPath(); spiralPath(ctx, d*9, 2.5, 3.6, 0.6, d>0?-Math.PI*0.9:-Math.PI*0.1, 1.25, -d); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(d*w, 0); ctx.lineTo(d*(w-5), -1.4); ctx.lineTo(d*(w-5), 1.4); ctx.closePath(); ctx.fill();
  });
  ctx.beginPath(); ctx.moveTo(0,-10); ctx.lineTo(2.4,0); ctx.lineTo(0,10); ctx.lineTo(-2.4,0); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(0,0,1.8,0,7); ctx.fillStyle = 'rgba(222,202,162,1)'; ctx.fill();
  ctx.restore();
}
/* recto: the spine is on the left of the canvas; verso: on the right */
let titleHidden = false;
function pageBackground(n){
  const recto = ((n%2)+2)%2 === 0;
  const c = cv(PAGE_W, PAGE_H), ctx = c.getContext('2d');
  const rnd = mulberry32(300 + n*17);
  const S = parch.base.width;
  const sx = Math.floor(rnd()*S*0.3), sy = Math.floor(rnd()*S*0.25);
  ctx.drawImage(parch.base, sx, sy, S-sx, S-sy, 0, 0, PAGE_W, PAGE_H);
  const gut = ctx.createLinearGradient(0,0,PAGE_W,0);
  [[0,'rgba(80,60,36,.30)'],[0.05,'rgba(90,68,40,.10)'],[0.15,'rgba(90,68,40,0)'],[0.93,'rgba(90,68,40,0)'],[1,'rgba(90,68,40,.14)']]
    .forEach(([o,cl])=>gut.addColorStop(recto?o:1-o, cl));
  ctx.fillStyle = gut; ctx.fillRect(0,0,PAGE_W,PAGE_H);
  ctx.save();
  if(rnd() < 0.5){ ctx.translate(PAGE_W, 0); ctx.scale(-1, 1); }
  if(rnd() < 0.5){ ctx.translate(0, PAGE_H); ctx.scale(1, -1); }
  ctx.drawImage(edgeTone, 0, 0, PAGE_W, PAGE_H);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(borderArt(), 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(gilt().color, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  if(n !== 0){
    ctx.translate(PAGE_W/2, PAGE_H*0.48);
    ctx.rotate((rnd() - 0.5)*0.5);
    ctx.drawImage(sigilArt(), -sigilArt().width/2, -sigilArt().height/2);
  }
  ctx.restore();
  if(n > 0){
    ctx.fillStyle = PINK(.8);
    ctx.font = `italic 500 ${13*SC}px "Cormorant Garamond", serif`;
    ctx.textAlign = 'center';
    ctx.fillText(String(n+1), PAGE_W/2, 458*SC);
    ctx.textAlign = 'left';
  }
  if(n === 0 && !titleHidden) drawTitle(ctx);
  return c;
}
/* the invitation is written on a leaf of the book itself: the same vellum,
   worn border, gold leaf and watermark circle, without the gutter shadow */
let invitePaperUrl = null;
function invitePaper(){
  if(invitePaperUrl) return invitePaperUrl;
  const c = cv(PAGE_W, PAGE_H), ctx = c.getContext('2d');
  const S = parch.base.width;
  ctx.drawImage(parch.base, S*0.12, S*0.08, S*0.8, S*0.84, 0, 0, PAGE_W, PAGE_H);
  ctx.drawImage(edgeTone, 0, 0, PAGE_W, PAGE_H);
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(borderArt(), 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(gilt().color, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.55;
  ctx.drawImage(sigilArt(), (PAGE_W - sigilArt().width)/2, PAGE_H*0.5 - sigilArt().height/2);
  const out = cv(720, Math.round(720*PAGE_H/PAGE_W));
  out.getContext('2d').drawImage(c, 0, 0, out.width, out.height);
  invitePaperUrl = out.toDataURL('image/jpeg', 0.86);
  return invitePaperUrl;
}
/* engraved headpiece of the title page: tapered rules, a lance through the
   middle and scrolls curling away from the title (dir -1 turns them below) */
function titleFlourish(ctx, cx, y, w, dir){
  ctx.save(); ctx.translate(cx, y); ctx.scale(SC, SC*dir);
  ctx.strokeStyle = PINK(.9); ctx.fillStyle = PINK(.88);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  [-1,1].forEach(s=>{
    ctx.beginPath();
    ctx.moveTo(s*3, -0.8); ctx.quadraticCurveTo(s*w*0.45, -0.5, s*w, 0);
    ctx.quadraticCurveTo(s*w*0.45, 0.5, s*3, 0.8); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 0.75;
    ctx.beginPath(); ctx.moveTo(s*2.2, -1.2);
    ctx.bezierCurveTo(s*8, -1.4, s*13, -3.2, s*17.5, -3.2);
    spiralPath(ctx, s*17.5, -7.6, 4.4, 0.6, Math.PI/2, 1.2, -s); ctx.stroke();
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(s*2.4, -3.4);
    ctx.bezierCurveTo(s*3.5, -10, s*8, -13.5, s*12.6, -12.4);
    spiralPath(ctx, s*11.4, -9.9, 2.75, 0.4, -Math.PI*0.36, 1.1, -s); ctx.stroke();
    ctx.lineWidth = 0.55;
    ctx.beginPath(); ctx.moveTo(s*21.5, -1);
    ctx.bezierCurveTo(s*24, -1.4, s*26, -2.6, s*27.4, -1.6);
    spiralPath(ctx, s*27.4, -3.8, 2.2, 0.35, Math.PI/2, 1.1, -s); ctx.stroke();
    ctx.lineWidth = 0.35;
    inkLeaf(ctx, s*5.2, -1.6, s*0.55, 6.8, 1.8);
    inkLeaf(ctx, s*20.5, -11.6, s*0.9, 5.2, 1.5);
    inkLeaf(ctx, s*23.5, -1.2, s*1.15, 5.6, 1.6);
    inkLeaf(ctx, s*32, -0.6, s*1.3, 4.2, 1.2);
    [[s*15.2, -14.6, 0.75], [s*25.6, -8.2, 0.6], [s*35.4, -2.6, 0.55], [s*7, -7.4, 0.55]].forEach(([x, yy, r])=>{
      ctx.beginPath(); ctx.arc(x, yy, r, 0, 7); ctx.fill();
    });
    ctx.beginPath(); ctx.moveTo(s*w, 0); ctx.lineTo(s*(w-4.5), -1.1); ctx.lineTo(s*(w-4.5), 1.1); ctx.closePath(); ctx.fill();
  });
  ctx.beginPath();
  ctx.moveTo(0, -24); ctx.lineTo(1.5, -13); ctx.lineTo(0.55, -5); ctx.lineTo(0, -3);
  ctx.lineTo(-0.55, -5); ctx.lineTo(-1.5, -13); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 23); ctx.lineTo(2.1, 11); ctx.lineTo(0.7, 5); ctx.lineTo(0, 3);
  ctx.lineTo(-0.7, 5); ctx.lineTo(-2.1, 11); ctx.closePath(); ctx.fill();
  ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(-2.6, -15.5); ctx.lineTo(2.6, -15.5); ctx.moveTo(-3, 13.5); ctx.lineTo(3, 13.5); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 2.3, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(222,196,150,.9)'; ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, 7); ctx.fill();
  ctx.restore();
}
function titleTailpiece(ctx, cx, y){
  ctx.save(); ctx.translate(cx, y); ctx.scale(SC, SC);
  ctx.strokeStyle = PINK(.88); ctx.fillStyle = PINK(.85);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  [-1,1].forEach(s=>{
    ctx.beginPath();
    ctx.moveTo(s*3, -0.6); ctx.quadraticCurveTo(s*20, -0.35, s*40, 0);
    ctx.quadraticCurveTo(s*20, 0.35, s*3, 0.6); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(s*1.8, -1);
    ctx.bezierCurveTo(s*4, -1.4, s*6, -2.2, s*7.2, -1.6);
    spiralPath(ctx, s*7.2, -3.6, 2, 0.35, Math.PI/2, 1.05, -s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s*1.8, 1);
    ctx.bezierCurveTo(s*4, 1.4, s*6, 2.2, s*7.2, 1.6);
    spiralPath(ctx, s*7.2, 3.6, 2, 0.35, -Math.PI/2, 1.05, s); ctx.stroke();
  });
  ctx.lineWidth = 0.35;
  inkLeaf(ctx, 0, -2.4, 0, 5.4, 1.9);
  inkLeaf(ctx, -0.6, -2.6, -0.8, 4.2, 1.3);
  inkLeaf(ctx, 0.6, -2.6, 0.8, 4.2, 1.3);
  ctx.beginPath();
  ctx.moveTo(0, 13); ctx.lineTo(1.6, 6.5); ctx.lineTo(0.5, 3.2); ctx.lineTo(0, 2);
  ctx.lineTo(-0.5, 3.2); ctx.lineTo(-1.6, 6.5); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 1.9, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(222,196,150,.9)'; ctx.beginPath(); ctx.arc(0, 0, 0.7, 0, 7); ctx.fill();
  ctx.restore();
}
/* the blackletter is cut like an engraving: dark ink with fine light hatching */
function engravedTitle(ctx, text, cx, baseline, maxW){
  let size = 44*SC;
  const font = z => `${z}px "UnifrakturMaguntia", "Cormorant SC", serif`;
  ctx.save(); ctx.font = font(size);
  const tw = ctx.measureText(text).width;
  if(tw > maxW*SC) size *= maxW*SC/tw;
  ctx.font = font(size);
  const w = Math.ceil(ctx.measureText(text).width + size*0.4), h = Math.ceil(size*1.5);
  ctx.restore();
  const c = cv(w, h), x = c.getContext('2d');
  x.font = font(size); x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  const by = Math.round(h*0.72);
  const g = x.createLinearGradient(0, by - size*0.8, 0, by + size*0.2);
  g.addColorStop(0, 'rgba(52,30,11,.96)'); g.addColorStop(0.55, 'rgba(36,20,7,.97)'); g.addColorStop(1, 'rgba(58,34,13,.95)');
  x.fillStyle = g; x.fillText(text, w/2, by);
  x.globalCompositeOperation = 'source-atop';
  x.strokeStyle = 'rgba(214,170,104,.32)'; x.lineWidth = Math.max(1, 0.32*SC);
  const step = 1.25*SC;
  x.beginPath();
  for(let k = -h; k < w; k += step){ x.moveTo(k, h); x.lineTo(k + h*0.7, 0); }
  x.stroke();
  ctx.save();
  ctx.shadowColor = 'rgba(40,22,8,.4)'; ctx.shadowBlur = 1.5*SC; ctx.shadowOffsetY = 0.3*SC;
  ctx.drawImage(c, cx - w/2, baseline - by);
  ctx.restore();
}
const TITLE = 'No Notes Bible';
const MOTTO = ['P.S. Read mindfully.', 'The why is on you.'];
function drawTitle(ctx){
  const cx = PAGE_W/2;
  titleFlourish(ctx, cx, 162*SC, 76, 1);
  engravedTitle(ctx, TITLE, cx, 202*SC, 176);
  titleFlourish(ctx, cx, 228*SC, 76, -1);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(48,28,10,.9)';
  ctx.font = `italic 500 ${15.5*SC}px "Cormorant Garamond", serif`;
  MOTTO.forEach((line, i)=>ctx.fillText(line, cx, (270 + i*18)*SC));
  ctx.restore();
  titleTailpiece(ctx, cx, 314*SC);
}
function textBox(n){
  const recto = n%2===0;
  const x = (recto ? 50 : 40)*SC, w = (340-50-40)*SC;
  const y = (n===0 ? 236 : 46)*SC;
  return { x, y, w, bottom: 414*SC, flow: !!(pages[n] && pages[n].c) };
}

/* ---------------- text layout: the one geometry the ink and caret share ---------------- */
const measCtx = cv(8,8).getContext('2d');
function layoutText(text, f, box){
  const size = f.size*FS, lh = Math.round(size*(f.lead || 1.38));
  measCtx.font = fontCss(f, size);
  const lines = [];
  let cap = null;
  const first = text.charAt(0);
  if(first && !box.flow && /\p{L}/u.test(first)){
    /* a raised initial: a big figured capital standing on the first line's
       baseline, the rest of the word running on from it */
    const capSize = size*2.45;
    measCtx.font = capFont(f, capSize);
    const cm = measCtx.measureText(first);
    const cw = Math.max(cm.width, cm.actualBoundingBoxRight);
    cap = { ch:first, size:capSize, w: cw + size*0.06, l: Math.max(0, cm.actualBoundingBoxLeft), lines:1, x: box.x };
    measCtx.font = fontCss(f, size);
  }
  const W = box.w;
  const avail = li => W - (cap && li < cap.lines ? cap.w : 0);
  const xStart = li => box.x + (cap && li < cap.lines ? cap.w : 0);
  const meas = s => measCtx.measureText(s).width;
  let i = 0;
  const L = text.length;
  while(true){
    const nl = text.indexOf('\n', i);
    const pe = nl < 0 ? L : nl;
    let ls = i;
    if(ls === pe) lines.push({ start:ls, end:pe });
    while(ls < pe){
      const li = lines.length;
      const skip = (cap && ls === 0) ? 1 : 0;
      const maxW = avail(li);
      let end = ls + skip, lastBreak = -1;
      while(end < pe){
        const ch = text[end];
        const w = meas(text.slice(ls+skip, end+1));
        if(w > maxW && ch !== ' '){ break; }
        end++;
        if(ch === ' ') lastBreak = end;
      }
      if(end < pe){
        if(lastBreak > ls+skip) end = lastBreak;
        else if(end === ls+skip) end = ls+skip+1;
      }
      lines.push({ start:ls, end, skip });
      ls = end;
    }
    if(nl < 0) break;
    i = nl + 1;
    if(i > L) break;
  }
  if(!lines.length) lines.push({ start:0, end:0 });
  let ok = true;
  const y0 = box.y + (cap ? Math.max(size*0.98, cap.size*0.74) : size*0.98);
  lines.forEach((ln, li)=>{
    ln.x0 = xStart(li);
    ln.y = y0 + li*lh;
    const skip = ln.skip || 0;
    ln.xs = [];
    for(let j=0;j<=ln.end-ln.start;j++){
      if(skip && j===0) ln.xs.push(box.x);
      else ln.xs.push(ln.x0 + meas(text.slice(ln.start+skip, ln.start+j)));
    }
    if(ln.y + size*0.3 > box.bottom) ok = false;
  });
  if(cap) cap.y = y0;
  return { lines, cap, ok, size, lh, f, box };
}
/* the band a line's ink can reach, in font sizes above and below its baseline:
   the burn and the evaporation clip to it, so descenders burn with their letter */
const INK_UP = 1.05, INK_DN = 0.42;
function lineOf(lay, idx){
  let best = 0;
  for(let i=0;i<lay.lines.length;i++) if(lay.lines[i].start <= idx) best = i;
  return best;
}
function caretXY(lay, idx){
  const li = lineOf(lay, idx), ln = lay.lines[li];
  const j = clamp(idx - ln.start, 0, ln.xs.length-1);
  return { x: ln.xs[j], y: ln.y, li };
}
function indexAt(lay, px, py){
  let li = 0, bd = Infinity;
  lay.lines.forEach((ln, i)=>{ const d = Math.abs(py - (ln.y - lay.size*0.35)); if(d < bd){ bd = d; li = i; } });
  return indexOnLine(lay, li, px);
}
function indexOnLine(lay, li, px){
  const ln = lay.lines[li];
  let best = 0, bd = Infinity;
  for(let j=0;j<ln.xs.length;j++){
    const d = Math.abs(ln.xs[j]-px);
    if(d < bd){ bd = d; best = j; }
  }
  /* the trailing space of a wrapped line belongs to the next line's caret */
  let idx = ln.start + best;
  const nxt = lay.lines[li+1];
  if(nxt && idx === ln.end && nxt.start === ln.end && ln.end > ln.start) idx = ln.end - 1;
  return idx;
}
/* where character idx sits: its line, pen position and advance, in canvas px */
function glyphBox(lay, text, idx){
  if(lay.cap && idx === 0) return { x: lay.cap.x, y: lay.cap.y, w: lay.cap.w, cap: true, ln: null };
  const li = lineOf(lay, idx), ln = lay.lines[li];
  const j = idx - ln.start;
  if(j < 0 || j+1 >= ln.xs.length) return null;
  return { x: ln.xs[j], y: ln.y, w: ln.xs[j+1] - ln.xs[j], ln };
}
/* how long a page keeps repainting after its last letter: the raised initial cools longest */
const GLOW_T = 3.6;
/* the spell burns a letter through in BURN_T, then the stroke cools in COOL_T */
const BURN_T = 0.42, BURN_CAP = 1.2, COOL_T = 0.42, COOL_CAP = 0.65;
/* how far ahead of the glowing rim the char line runs, in seconds of the front */
const CHAR = 0.04;
const lineText = (text, ln)=> text.slice(ln.start + (ln.skip||0), ln.end);
/* every letter still burning, with its index and its age in seconds */
function eachBurning(lay, text, born, now, fn){
  if(!born) return;
  for(let i=0;i<text.length;i++){
    const age = (now - (born[i]||0))/1000;
    if(age >= GLOW_T || age < 0) continue;
    const ch = text[i]; if(ch === ' ' || ch === '\n') continue;
    const gb = glyphBox(lay, text, i); if(!gb) continue;
    if(age > (gb.cap ? BURN_CAP + 5*COOL_CAP : BURN_T + 5*COOL_T)) continue;
    fn(gb, i, age);
  }
}
/* paints one burning letter exactly as the ink has it: the whole line is
   redrawn through a clip around that letter, so kerning and ligatures match */
function paintThroughClip(ctx, lay, text, gb){
  ctx.save();
  ctx.beginPath();
  if(gb.cap){
    const c = lay.cap;
    const l = Math.max(lay.size*0.2, c.l + lay.size*0.1);
    ctx.rect(c.x - l, c.y - c.size*0.95, c.w + l, c.size*1.2);
    ctx.clip();
    ctx.font = capFont(lay.f, c.size);
    ctx.fillText(c.ch, c.x, c.y);
  }else{
    ctx.rect(gb.x - 0.5, gb.y - lay.size*INK_UP, gb.w + 1, lay.size*(INK_UP + INK_DN));
    ctx.clip();
    ctx.font = fontCss(lay.f, lay.size);
    ctx.fillText(lineText(text, gb.ln), gb.ln.x0, gb.ln.y);
  }
  ctx.restore();
}
function burnDone(born, now, i){
  const b = born[i];
  return !b || (now - b)/1000 >= BURN_T;
}
/* the patch of sheet a letter's burn may touch */
function burnRegion(lay, text, born, now, gb, i){
  const s = lay.size;
  if(gb.cap){
    const c = lay.cap, top = c.y - c.size - s*0.1, bot = c.y + c.size*0.3, l = Math.max(s*0.3, c.l + s*0.1);
    return { x0: c.x - l, y0: top, x1: c.x + c.w + s*0.1, y1: bot, rects: [[c.x - l, top, c.w + l + s*0.1, bot - top]] };
  }
  const ln = gb.ln, a0 = ln.start + (ln.skip||0);
  const open = j => j < a0 || j >= ln.end || /\s/.test(text[j]);
  const x0 = gb.x - (open(i-1) ? s*0.14 : 0.5);
  const x1 = gb.x + gb.w + (open(i+1) || !burnDone(born, now, i+1) ? s*0.32 : 1);
  const y0 = gb.y - s*INK_UP, bh = s*(INK_UP + INK_DN);
  return { x0, y0, x1, y1: y0 + bh, rects: [[x0, y0, x1 - x0, bh]] };
}
function clipRects(ctx, R){
  ctx.beginPath();
  R.rects.forEach(q => ctx.rect(q[0], q[1], q[2], q[3]));
  ctx.clip();
}
const burnCv = {};
function burnScratch(k, w, h){
  let c = burnCv[k];
  if(!c){ c = burnCv[k] = document.createElement('canvas'); c.width = c.height = 64; }
  if(c.width < w || c.height < h){ c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
  const x = c.getContext('2d', { willReadFrequently: true });
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.shadowBlur = 0; x.filter = 'none';
  x.clearRect(0, 0, w, h);
  return x;
}
let burnNoise = null;
/* the burn noise read smoothly between its texels, so fine detail has no grain */
function noiseAt(x, y){
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const r0 = (y0 & 255) << 8, r1 = ((y0 + 1) & 255) << 8, c0 = x0 & 255, c1 = (x0 + 1) & 255;
  const a = burnNoise[r0 | c0], b = burnNoise[r0 | c1], c = burnNoise[r1 | c0], d = burnNoise[r1 | c1];
  return (a + (b - a)*fx)*(1 - fy) + (c + (d - c)*fx)*fy;
}
const NIB_DX = 0.972, NIB_DY = 0.235;
const ramp = (h, K)=>{
  let k = 0;
  while(k < K.length - 2 && h > K[k+1][0]) k++;
  const a = K[k], b = K[k+1], t = clamp((h - a[0])/(b[0] - a[0]), 0, 1);
  return [lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
};
const SINGE = [[0, 46, 22, 10], [0.35, 120, 46, 16], [0.7, 214, 110, 40], [1, 255, 214, 150]];
const EMBER = [[0, 0, 0, 0], [0.2, 190, 62, 14], [0.5, 255, 132, 40], [1, 255, 228, 180]];
/* a fresh letter is burned into the sheet by the spell: the paper browns in the
   letter's shape, a ragged white-gold front eats through it along the pen's
   slant, and the stroke behind it glows ember, flickers and cools into char.
   Returns the region and three images: the parchment still unburnt, the
   letter's colour on the sheet, and its light for the glow layer */
function burnLetter(lay, text, born, now, gb, i, ageS){
  const T = gb.cap ? BURN_CAP : BURN_T, C = gb.cap ? COOL_CAP : COOL_T, PRE = T*(gb.cap ? 0.2 : 0.4);
  /* the bands round the front, kept to the same width in pixels on the big initial */
  const RIM = gb.cap ? 0.045 : 0.08, CH = gb.cap ? 0.022 : CHAR, HOT = gb.cap ? 0.035 : 0.06;
  const R = burnRegion(lay, text, born, now, gb, i);
  const X0 = Math.floor(R.x0), Y0 = Math.floor(R.y0);
  const w = Math.ceil(R.x1) - X0, h = Math.ceil(R.y1) - Y0;
  if(w < 1 || h < 1) return null;
  if(!burnNoise) burnNoise = fbm(256, 256, 12, 12, 3, 4242);
  const mx = burnScratch('m', w, h);
  mx.translate(-X0, -Y0);
  mx.fillStyle = '#fff';
  paintThroughClip(mx, lay, text, gb);
  const ink = mx.getImageData(0, 0, w, h).data;
  const soft = softMask(ink, w, h, Math.max(1, Math.round(2.4*FS)));
  const s = lay.size;
  const gx0 = gb.cap ? lay.cap.x : gb.x, gx1 = gb.cap ? lay.cap.x + lay.cap.w : gb.x + gb.w;
  const gy0 = gb.cap ? lay.cap.y - lay.cap.size*0.75 : gb.y - s*0.9, gy1 = gb.cap ? lay.cap.y + lay.cap.size*0.1 : gb.y + s*0.2;
  const sMin = gx0*NIB_DX + gy0*NIB_DY, sSpan = Math.max(1, gx1*NIB_DX + gy1*NIB_DY - sMin);
  const cover = mx.createImageData(w, h), paint = mx.createImageData(w, h), glow = mx.createImageData(w, h);
  const cd = cover.data, pd = paint.data, ld = glow.data;
  const nk = 1/FS, rise = ageS*70;
  const spread = gb.cap ? capSpread(ink, w, h, X0, Y0, lay.cap.ch) : null;
  let lit = false;
  for(let y=0, p=0; y<h; y++){
    const Y = Y0 + y, ny = ((Y*nk) & 255) << 8, fy = (((Y*nk*1.7 + rise) | 0) & 255) << 8;
    for(let x=0; x<w; x++, p+=4){
      const a = ink[p+3]/255, sa = soft[p>>2];
      if(sa < 0.004) continue;
      const X = X0 + x;
      const F = spread ? spread[p>>2] :
        clamp((X*NIB_DX + Y*NIB_DY - sMin)/sSpan, -0.2, 1.2)*0.74 + burnNoise[ny | ((X*nk) & 255)]*0.42 - 0.08;
      const la = ageS - T*F;
      if(la < 0){
        cd[p+3] = Math.min(255, sa*640);
        if(la > -PRE){
          const k = 1 + la/PRE, q = k*k, c = la > -CH ? 1 + la/CH : 0;
          pd[p] = lerp(120, 30, c); pd[p+1] = lerp(66, 14, c); pd[p+2] = lerp(28, 6, c);
          pd[p+3] = Math.min(1, (a*0.55 + sa*0.1)*q + (a*0.9 + sa*0.25)*c)*255;
          if(la > -HOT){
            const e = a*(1 + la/HOT)*0.3;
            ld[p] = 210; ld[p+1] = 90; ld[p+2] = 30; ld[p+3] = e*255;
            lit = true;
          }
        }
        continue;
      }
      if(la < HOT) cd[p+3] = Math.min(255, sa*640)*(1 - la/HOT);
      const fl = burnNoise[fy | (((X*nk*1.7) | 0) & 255)];
      const edge = clamp((1 - sa)*2.5, 0, 1);
      const heat = Math.min(1, Math.exp(-la/(C*(0.55 + 1.1*edge)))*(0.72 + 0.56*fl));
      const rim = la < RIM ? 1 - la/RIM : 0;
      if(heat < 0.01 && rim === 0) continue;
      lit = true;
      if(a > 0.004){
        const c = ramp(heat, SINGE), r = rim*0.8;
        pd[p] = lerp(c[0], 255, r); pd[p+1] = lerp(c[1], 246, r); pd[p+2] = lerp(c[2], 220, r);
        pd[p+3] = a*Math.min(1, heat*3 + rim)*255;
      }
      const c = ramp(heat, EMBER);
      const ea = Math.min(1, a*Math.min(1, heat*1.6) + sa*(rim*0.55 + heat*0.3));
      ld[p] = lerp(c[0], 255, rim); ld[p+1] = lerp(c[1], 240, rim); ld[p+2] = lerp(c[2], 205, rim);
      ld[p+3] = ea*255;
    }
  }
  return { R, X0, Y0, w, h, cover, paint, glow, lit };
}
/* the raised initial does not burn in one sweep, which on a letter that big
   reads as stripes: it catches at the top of its first stroke and at two
   more sparks, and the fire creeps out from them with a ragged edge. The
   field is when each pixel catches, 0..1 over the letter */
let spreadBuf = new Float32Array(0), spreadKey = '';
function capSpread(ink, w, h, X0, Y0, ch){
  const key = w + ',' + h + ',' + X0 + ',' + Y0 + ',' + ch;
  if(key === spreadKey) return spreadBuf;
  const N = w*h;
  if(spreadBuf.length < N) spreadBuf = new Float32Array(N);
  const pts = [];
  let best = Infinity, bi = -1;
  for(let i=0;i<N;i++) if(ink[i*4+3] > 128){ pts.push(i); const v = (i % w) + (i/w|0)*1.4; if(v < best){ best = v; bi = i; } }
  if(!pts.length){ spreadBuf.fill(0, 0, N); spreadKey = key; return spreadBuf; }
  const rnd = mulberry32(ch.codePointAt(0)*7919 + w);
  const seeds = [bi, pts[(rnd()*pts.length)|0], pts[(rnd()*pts.length)|0]].map(i => [i % w, i/w|0]);
  const delay = [0, 0.12, 0.24];
  let dMax = 1;
  for(let y=0, i=0; y<h; y++) for(let x=0; x<w; x++, i++){
    let d = Infinity;
    for(let k=0;k<seeds.length;k++){ const dd = Math.hypot(x - seeds[k][0], y - seeds[k][1]) + delay[k]*w; if(dd < d) d = dd; }
    spreadBuf[i] = d;
    if(ink[i*4+3] > 128 && d > dMax) dMax = d;
  }
  const nk = 1/FS;
  for(let y=0, i=0; y<h; y++){
    const Y = Y0 + y;
    for(let x=0; x<w; x++, i++){
      const X = X0 + x;
      spreadBuf[i] = spreadBuf[i]/dMax*0.8 + (noiseAt(X*nk, Y*nk) - 0.5)*0.34 + (noiseAt(X*nk*2.3 + 31, Y*nk*2.3 + 97) - 0.5)*0.16 + 0.08;
    }
  }
  spreadKey = key;
  return spreadBuf;
}
/* the letter's alpha spread into a soft halo: two box passes each way */
let softBuf = new Float32Array(0), softTmp = new Float32Array(0);
function softMask(ink, w, h, r){
  const N = w*h;
  if(softBuf.length < N){ softBuf = new Float32Array(N); softTmp = new Float32Array(N); }
  for(let i=0;i<N;i++) softBuf[i] = ink[i*4+3]/255;
  const k = 1/(2*r + 1);
  for(let pass=0; pass<2; pass++){
    for(let y=0; y<h; y++){
      const row = y*w;
      let acc = 0;
      for(let x=-r; x<=r; x++) acc += x >= 0 && x < w ? softBuf[row + x] : 0;
      for(let x=0; x<w; x++){
        softTmp[row + x] = acc*k;
        const a = x - r, b = x + r + 1;
        if(a >= 0) acc -= softBuf[row + a];
        if(b < w) acc += softBuf[row + b];
      }
    }
    for(let x=0; x<w; x++){
      let acc = 0;
      for(let y=-r; y<=r; y++) acc += y >= 0 && y < h ? softTmp[y*w + x] : 0;
      for(let y=0; y<h; y++){
        softBuf[y*w + x] = acc*k;
        const a = y - r, b = y + r + 1;
        if(a >= 0) acc -= softTmp[a*w + x];
        if(b < h) acc += softTmp[b*w + x];
      }
    }
  }
  return softBuf;
}
/* letters taken back off the sheet evaporate: the char warms to a pale magic
   gold, the strokes come apart in a ragged drift from the top down, each grain
   flaring bright just before it goes, and the vapour rises off as mist and
   motes. One record per touched line, so a wiped page goes line after line */
const VAPOR_T = 0.85;
function vaporRects(lay, text, a, b, pad){
  const out = [];
  if(lay.cap && a === 0){
    const c = lay.cap;
    out.push({ x0: c.x - c.l - pad, y0: c.y - c.size - pad, x1: c.x + c.w + pad, y1: c.y + c.size*0.3 + pad, a: 0, b: 1, cap: true });
  }
  lay.lines.forEach(ln=>{
    const a0 = ln.start + (ln.skip||0);
    const s = Math.max(a, a0), e = Math.min(b, ln.end);
    if(e <= s || !text.slice(s, e).trim()) return;
    out.push({ x0: ln.xs[s - ln.start] - pad, x1: ln.xs[e - ln.start] + pad, y0: ln.y - lay.size*INK_UP - pad, y1: ln.y + lay.size*INK_DN + pad, a: s, b: e, ln });
  });
  return out;
}
/* lifts the letters [a, b) off the page: each is redrawn as the sheet shows
   it, char in the strokes and a brown singe round them, and that copy then
   evaporates over the page that no longer has them */
function addVapor(n, text, lay, a, b, stagger){
  const rs = vaporRects(lay, text, a, b, Math.ceil(5*FS));
  if(!rs.length) return;
  const pg = pages[n], t0 = performance.now();
  pg.vapor = pg.vapor || [];
  rs.forEach((r, k)=>{
    const X0 = Math.max(0, Math.floor(r.x0)), Y0 = Math.max(0, Math.floor(r.y0));
    const w = Math.min(PAGE_W, Math.ceil(r.x1)) - X0, h = Math.min(PAGE_H, Math.ceil(r.y1)) - Y0;
    if(w < 1 || h < 1) return;
    const sx = burnScratch('v', w, h);
    sx.translate(-X0, -Y0);
    sx.fillStyle = '#fff';
    if(r.cap){ sx.font = capFont(lay.f, lay.cap.size); sx.fillText(lay.cap.ch, lay.cap.x, lay.cap.y); }
    else{ sx.font = fontCss(lay.f, lay.size); sx.fillText(text.slice(r.a, r.b), r.ln.xs[r.a - r.ln.start], r.ln.y); }
    const ink = sx.getImageData(0, 0, w, h).data;
    const soft = softMask(ink, w, h, Math.max(1, Math.round(1.8*FS)));
    const px = new Uint8ClampedArray(w*h*4);
    for(let i=0, p=0; i<w*h; i++, p+=4){
      const ia = ink[p+3]/255*0.86, ha = Math.min(1, soft[i]*1.4)*0.26;
      const al = ia + ha*(1 - ia);
      if(al < 0.01) continue;
      const t = ia/al;
      px[p] = lerp(132, 62, t); px[p+1] = lerp(90, 40, t); px[p+2] = lerp(52, 22, t);
      px[p+3] = al*255;
    }
    pg.vapor.push({ X0, Y0, w, h, px, t0: t0 + k*stagger*1000, out: false, lay, text, a: r.a, b: r.b });
  });
  while(pg.vapor.length > 80) pg.vapor.shift();
  burning.add(n);
}
/* paints the evaporating letters over the page; returns their light */
function drawVapor(ctx, n, now){
  const pg = pages[n], lights = [];
  if(!burnNoise) burnNoise = fbm(256, 256, 12, 12, 3, 4242);
  const nk = 1/FS;
  pg.vapor = pg.vapor.filter(v=>{
    const tau = (now - v.t0)/1000;
    if(tau >= VAPOR_T) return false;
    const { X0, Y0, w, h, px } = v;
    const sx = burnScratch('w', w, h);
    if(tau < 0){
      const img = sx.createImageData(w, h); img.data.set(px);
      sx.putImageData(img, 0, 0);
      ctx.drawImage(burnCv.w, 0, 0, w, h, X0, Y0, w, h);
      return true;
    }
    if(!v.out){ v.out = true; vaporRise(n, v); }
    const paint = sx.createImageData(w, h), glow = sx.createImageData(w, h);
    const pd = paint.data, ld = glow.data;
    const warm = smooth(clamp(tau/0.2, 0, 1)), drift = tau*40;
    for(let y=0, p=0; y<h; y++){
      const Y = Y0 + y, ny = ((Y*nk) & 255) << 8, my = (((Y*nk*2.2 + drift) | 0) & 255) << 8, fy = y/h;
      for(let x=0; x<w; x++, p+=4){
        const a = px[p+3];
        if(a < 2) continue;
        const X = X0 + x;
        const F = burnNoise[ny | ((X*nk) & 255)]*0.62 + fy*0.38 + (burnNoise[my | (((X*nk*2.2) | 0) & 255)] - 0.5)*0.2;
        const tg = 0.2 + F*0.5;
        if(tau >= tg + 0.07) continue;
        const rem = tau < tg ? 1 : 1 - (tau - tg)/0.07;
        const rim = tau > tg - 0.09 ? clamp(1 - (tg - tau)/0.09, 0, 1) : 0;
        const g = Math.min(1, warm*0.55 + rim*0.45);
        pd[p] = lerp(px[p], 255, g); pd[p+1] = lerp(px[p+1], 222, g); pd[p+2] = lerp(px[p+2], 160, g);
        pd[p+3] = a*rem;
        const e = (a/255)*(warm*0.28 + rim*0.95)*rem;
        ld[p] = lerp(255, 255, rim); ld[p+1] = lerp(196, 238, rim); ld[p+2] = lerp(110, 200, rim); ld[p+3] = Math.min(255, e*255);
      }
    }
    sx.putImageData(paint, 0, 0);
    ctx.drawImage(burnCv.w, 0, 0, w, h, X0, Y0, w, h);
    lights.push({ R: { rects: [[X0, Y0, w, h]] }, X0, Y0, w, h, glow, lit: true });
    return true;
  });
  return lights;
}
/* the letters' vapour leaving: mist off every few letters, a few gold motes */
function vaporRise(n, v){
  const L = v.b - v.a, step = L > 12 ? 3 : 1;
  for(let i=v.a; i<v.b; i+=step){
    emitSmoke(n, v.lay, v.text, i, 1, true);
    if(Math.random() < 0.5) emitSparks(n, v.lay, v.text, i, 1, true);
  }
}
function putScratch(k, img, w, h){
  const x = burnScratch(k, w, h);
  x.putImageData(img, 0, 0);
  return burnCv[k];
}
/* iron-gall ink soaks into the vellum unevenly: a fibre mask for its density
   and a few browner pools where the quill ran dry */
let inkMask = null, inkTint = null, inkLayer = null, singeLayer = null, singeMask = null;
function inkTextures(){
  if(inkMask) return;
  const W = PAGE_W, H = PAGE_H;
  const fine = fbm(W>>1, H>>1, 90, 120, 2, 3131);
  const blot = upsample(fbm(W>>4, H>>4, 6, 8, 3, 717), W>>4, H>>4, W>>1, H>>1);
  const m = cv(W>>1, H>>1), mx = m.getContext('2d'), md = mx.createImageData(W>>1, H>>1);
  const t = cv(W>>1, H>>1), tx = t.getContext('2d'), td = tx.createImageData(W>>1, H>>1);
  for(let i=0,p=0;i<fine.length;i++,p+=4){
    md.data[p] = md.data[p+1] = md.data[p+2] = 0;
    md.data[p+3] = clamp(0.80 + (fine[i]-0.5)*0.5 + (blot[i]-0.5)*0.25, 0.55, 1)*255;
    const b = clamp((blot[i]-0.45)*2.2, 0, 1);
    td.data[p] = 92; td.data[p+1] = 52; td.data[p+2] = 22; td.data[p+3] = b*120;
  }
  mx.putImageData(md, 0, 0); tx.putImageData(td, 0, 0);
  inkMask = m; inkTint = t;
  inkLayer = cv(W, H);
  singeLayer = cv(W, H);
  const sw = W>>2, sh = H>>2, sn = fbm(sw, sh, 5, 7, 3, 919);
  singeMask = cv(sw, sh);
  const smx = singeMask.getContext('2d'), sd = smx.createImageData(sw, sh);
  for(let i=0,p=0;i<sn.length;i++,p+=4) sd.data[p+3] = clamp(0.3 + (sn[i]-0.5)*2.4, 0.12, 1)*255;
  smx.putImageData(sd, 0, 0);
}
/* the initial in the scribe's own ink: a figured capital with a fine inline
   left in reserve. Drawn into the ink layer, so it is burned in like the text */
function drawInitial(ctx, lay){
  const c = lay.cap;
  ctx.save();
  ctx.font = capFont(lay.f, c.size);
  ctx.fillStyle = INK; ctx.strokeStyle = INK;
  ctx.fillText(c.ch, c.x, c.y);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth = Math.max(1, c.size*0.012);
  ctx.globalAlpha = 0.85;
  ctx.translate(c.size*0.012, -c.size*0.012);
  ctx.strokeText(c.ch, c.x, c.y);
  ctx.restore();
}
/* the settled page: ink soaked into the sheet, and the initial */
function drawInkBase(ctx, text, lay, hide){
  const { lines, cap, f, size, lh } = lay;
  inkTextures();
  const ix = inkLayer.getContext('2d');
  ix.clearRect(0, 0, PAGE_W, PAGE_H);
  ix.fillStyle = INK;
  ix.font = fontCss(f, size);
  lines.forEach(ln=>{
    if(ln.y + size*0.3 > lay.box.bottom + lh) return;
    const a0 = ln.start + (ln.skip||0);
    if(!hide){ const s = text.slice(a0, ln.end); if(s) ix.fillText(s, ln.x0, ln.y); return; }
    [[a0, Math.min(ln.end, hide.a)], [Math.max(a0, hide.b), ln.end]].forEach(([a, b])=>{
      if(b > a) ix.fillText(text.slice(a, b), ln.xs[a - ln.start], ln.y);
    });
  });
  if(cap && !(hide && hide.a === 0)) drawInitial(ix, lay);
  ix.globalCompositeOperation = 'destination-in';
  ix.drawImage(inkMask, 0, 0, PAGE_W, PAGE_H);
  ix.globalCompositeOperation = 'source-atop';
  ix.drawImage(inkTint, 0, 0, PAGE_W, PAGE_H);
  ix.globalCompositeOperation = 'source-over';
  /* the singe the spell left round every stroke, darker in patches where the
     fire lingered, a tighter scorch, then the char itself, multiplied so the
     grain of the sheet shows through */
  const sx = singeLayer.getContext('2d');
  sx.clearRect(0, 0, PAGE_W, PAGE_H);
  sx.filter = `blur(${(3.6*FS).toFixed(2)}px) brightness(2.5)`;
  sx.drawImage(inkLayer, 0, 0);
  sx.filter = 'none';
  sx.globalCompositeOperation = 'destination-in';
  sx.drawImage(singeMask, 0, 0, PAGE_W, PAGE_H);
  sx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.62;
  ctx.drawImage(singeLayer, 0, 0);
  ctx.globalAlpha = 0.3;
  ctx.filter = `blur(${(1.1*FS).toFixed(2)}px) brightness(1.6)`;
  ctx.drawImage(inkLayer, 0, 0);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(inkLayer, 0, 0);
  ctx.restore();
  /* the strokes sit a hair below the sheet: the far wall of each groove
     catches the light as a faint warm sheen along the char */
  const o = 1.1*FS;
  sx.clearRect(0, 0, PAGE_W, PAGE_H);
  sx.drawImage(inkLayer, 0, 0);
  sx.globalCompositeOperation = 'destination-out';
  sx.drawImage(inkLayer, -o, -o);
  sx.globalCompositeOperation = 'source-in';
  sx.fillStyle = 'rgb(214,170,112)';
  sx.fillRect(0, 0, PAGE_W, PAGE_H);
  sx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.32;
  ctx.filter = `blur(${(0.5*FS).toFixed(2)}px)`;
  ctx.drawImage(singeLayer, 0, 0);
  ctx.restore();
}
/* what changes from frame to frame: selection, the letters still warm, the caret */
function drawInkOverlay(ctx, text, lay, sel, born, now, bg, caretA){
  const { lines, size, lh } = lay;
  if(sel && sel.a !== sel.b){
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(232,196,120,.7)';
    lines.forEach(ln=>{
      const a = Math.max(sel.a, ln.start), b = Math.min(sel.b, ln.end);
      if(a >= b) return;
      ctx.fillRect(ln.xs[a-ln.start], ln.y - size*0.86, ln.xs[b-ln.start]-ln.xs[a-ln.start], lh*0.98);
    });
    ctx.restore();
  }
  /* a burning letter: the sheet laid back where the spell has not reached yet,
     then the letter's own scorch and ember colour; the glow layer reuses it */
  const burns = [];
  if(born && now && bg){
    eachBurning(lay, text, born, now, (gb, i, ageS)=>{
      const b = burnLetter(lay, text, born, now, gb, i, ageS);
      if(!b) return;
      burns.push(b);
      const { R, X0, Y0, w, h } = b;
      const sx = burnScratch('s', w, h);
      sx.drawImage(bg, X0, Y0, w, h, 0, 0, w, h);
      sx.globalCompositeOperation = 'destination-in';
      sx.drawImage(putScratch('c', b.cover, w, h), 0, 0);
      ctx.save();
      clipRects(ctx, R);
      ctx.drawImage(burnCv.s, 0, 0, w, h, X0, Y0, w, h);
      ctx.drawImage(putScratch('p', b.paint, w, h), 0, 0, w, h, X0, Y0, w, h);
      ctx.restore();
    });
  }
  if(sel && sel.caret){
    const c = caretXY(lay, sel.b);
    ctx.save();
    ctx.globalAlpha = caretA === undefined ? 1 : caretA;
    ctx.fillStyle = INK;
    caretPath(ctx, c.x, c.y, size, 2.9*FS);
    ctx.restore();
  }
  return burns;
}
/* a hairline caret that swells in the middle and tapers to points, like a nib stroke */
function caretPath(ctx, x, y, size, w){
  const top = y - size*0.86, bot = y + size*0.2, mid = (top + bot)/2;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.quadraticCurveTo(x + w, mid, x, bot);
  ctx.quadraticCurveTo(x - w, mid, x, top);
  ctx.fill();
}
/* the caret breathes: solid while the quill moves, then a slow soft pulse */
function caretBreath(){
  const t = Math.max(0, blinkPhase - 0.5);
  return 0.6 + 0.4*Math.cos(t*Math.PI*2/1.6);
}
/* the glow layer: emissive, half resolution, only what is burning right now.
   Drawn over black: the canvas is uploaded unpremultiplied, so a soft edge
   kept only in alpha would light up at full strength */
function drawGlow(ctx, lay, burns, caret, caretA){
  const k = 0.5;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.scale(k, k);
  let any = false;
  burns.forEach(b=>{
    if(!b.lit) return;
    any = true;
    const { R, X0, Y0, w, h } = b;
    ctx.save();
    clipRects(ctx, R);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(putScratch('g', b.glow, w, h), 0, 0, w, h, X0, Y0, w, h);
    ctx.restore();
  });
  if(caret){
    ctx.save();
    ctx.globalAlpha = 0.05 + 0.08*(caretA === undefined ? 1 : caretA);
    ctx.fillStyle = 'rgb(255,170,80)';
    caretPath(ctx, caret.x, caret.y, lay.size, 1.6*FS);
    ctx.restore();
    any = true;
  }
  ctx.restore();
  return any;
}

/* ---------------- pages: data + lazily-built textures ---------------- */
const pages = Array.from({length:N*2}, ()=>({ t:'', f:null, born:null }));
let defaultFont = 'chronicle';
const pageFont = n => fontById(pages[n].f || defaultFont);

const pageMaterial = canvas => new THREE.MeshStandardMaterial({
  map: tex(canvas, {srgb:true, wrap:false}), normalMap: parch.normalTex,
  normalScale: new THREE.Vector2(0.22,0.22), roughness: 1, metalness: 1,
  roughnessMap: gilt().pbr, metalnessMap: gilt().pbr, vertexColors: true
});
/* n = -2 / -1: an unnumbered recto / verso */
const blankMat = [pageMaterial(pageBackground(-2)), pageMaterial(pageBackground(-1))];

const pageCache = new Map();          // n -> { bg, canvas, glow, tex, glowTex, mat, used, lay }
/* a written page costs a phone ~20 MB (its canvas, background, glow and their GPU copies):
   eight is the spread in view, the one either side and a leaf in the air */
const CACHE_MAX = HI_RES ? 12 : 8;
function pageEntry(n){
  let e = pageCache.get(n);
  if(!e){
    const canvas = cv(PAGE_W, PAGE_H);
    const glow = cv(PAGE_W/2, PAGE_H/2);
    const mat = pageMaterial(canvas);
    const glowTex = tex(glow, {srgb:true, wrap:false});
    mat.emissive = new THREE.Color(0xffffff);
    mat.emissiveMap = glowTex;
    mat.emissiveIntensity = 0;
    e = { bg: pageBackground(n), canvas, glow, tex: mat.map, glowTex, mat, used: 0, lay: null, glowing: false };
    pageCache.set(n, e);
    paintPage(n);
  }
  e.used = performance.now();
  return e;
}
/* a canvas let go of at once, not whenever the collector comes round: on a phone the
   pixels of a dropped page would otherwise linger for seconds */
function freeCanvas(c){ if(c) c.width = c.height = 0; }
function trimCache(keep){
  if(pageCache.size <= CACHE_MAX) return;
  const list = [...pageCache.entries()].filter(([n])=>!keep.has(n)).sort((a,b)=>a[1].used-b[1].used);
  while(pageCache.size > CACHE_MAX && list.length){
    const [n, e] = list.shift();
    e.tex.dispose(); e.glowTex.dispose(); e.mat.dispose();
    [e.canvas, e.glow, e.bg, e.inked].forEach(freeCanvas);
    pageCache.delete(n);
  }
}
/* letters given a birth time still to come are not on the page yet */
function unborn(pg, now){
  const b = pg.born, L = Math.min(pg.t.length, b ? b.length : 0);
  let a = -1, z = -1;
  for(let i=0;i<L;i++) if(b[i] > now){ if(a < 0) a = i; z = i; }
  return a < 0 ? null : { a, b: z + 1 };
}
function paintPage(n, now){
  const e = pageCache.get(n);
  if(!e) return;
  now = now || performance.now();
  if(!e.bg) e.bg = pageBackground(n);
  if(!e.canvas.width){ e.canvas.width = PAGE_W; e.canvas.height = PAGE_H; e.glow.width = PAGE_W/2; e.glow.height = PAGE_H/2; }
  const ctx = e.canvas.getContext('2d');
  const editing = writing && writing.n === n;
  /* the soaked-in ink is composed once per text; the warm letters and the
     caret go on top every frame, so the burn-in stays smooth */
  const hide = unborn(pages[n], now);
  if(hide) burning.add(n);
  const tkey = pages[n].t + '\u0001' + pageFont(n).id + (pages[n].c ? '\u0001c' : ''), key = tkey + (hide ? '\u0001' + hide.a + ',' + hide.b : '');
  if(e.inkKey !== key || !e.inked){
    if(!e.inked) e.inked = cv(PAGE_W, PAGE_H);
    const ic = e.inked.getContext('2d');
    ic.drawImage(e.bg, 0, 0);
    if(e.layKey !== tkey || !e.lay){ e.lay = layoutText(pages[n].t, pageFont(n), textBox(n)); e.layKey = tkey; }
    drawInkBase(ic, pages[n].t, e.lay, hide);
    e.inkKey = key;
  }
  const lay = e.lay;
  ctx.drawImage(e.inked, 0, 0);
  let sel = null, caret = null;
  if(editing){
    const a = quill.selectionStart, b = quill.selectionEnd;
    sel = { a:Math.min(a,b), b:Math.max(a,b), caret: a === b };
    if(a === b){ sel.b = a; caret = caretXY(lay, a); }
  }
  const breath = editing ? caretBreath() : 1;
  const burns = drawInkOverlay(ctx, pages[n].t, lay, sel, pages[n].born, now, e.bg, breath);
  if(pages[n].vapor && pages[n].vapor.length) burns.push(...drawVapor(ctx, n, now));
  e.tex.needsUpdate = true;
  let lit = drawGlow(e.glow.getContext('2d'), lay, burns, caret, breath);
  if(lit || e.glowing){
    e.glowTex.needsUpdate = true;
    e.mat.emissiveIntensity = lit ? 1.4 : 0;
  }
  e.glowing = lit;
  /* only the page under the quill keeps its composed ink in memory */
  if(!editing && !burning.has(n)){ freeCanvas(e.inked); e.inked = null; e.inkKey = null; }
}

/* ============================================================================
   5.  boards, spine, gilt
   ==========================================================================*/
function roundedRectShape(w, h, rSpine, rFore){
  const s = new THREE.Shape();
  const y0 = -h/2, y1 = h/2;
  s.moveTo(rSpine, y0);
  s.lineTo(w-rFore, y0); s.quadraticCurveTo(w, y0, w, y0+rFore);
  s.lineTo(w, y1-rFore); s.quadraticCurveTo(w, y1, w-rFore, y1);
  s.lineTo(rSpine, y1);  s.quadraticCurveTo(0, y1, 0, y1-rSpine);
  s.lineTo(0, y0+rSpine); s.quadraticCurveTo(0, y0, rSpine, y0);
  return s;
}
/* local frame: x from the spine edge outwards, z from the inner face (0) to the outer face (CVR) */
function coverBoard(matArt){
  const g = new THREE.ExtrudeGeometry(roundedRectShape(CW, CH, 0.004, 0.10), {
    depth: CVR-0.03, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 4, curveSegments: 8
  });
  g.translate(0, 0, 0.015);
  const m = new THREE.Mesh(g, [matArt, matLeatherEdge]);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
/* the pastedown stops short of the board's edges, so the leather turn-ins show;
   at the spine edge the hinge strip takes over from EP_X0, edge to edge with it.
   flipV: the front pastedown is turned over about x, so its v runs the other way */
function endpaper(flipV){
  const g = new THREE.PlaneGeometry(EP_X1 - EP_X0, EP_H);
  g.translate((EP_X0 + EP_X1)/2, 0, 0);
  const uv = g.attributes.uv;
  for(let i=0;i<uv.count;i++) uv.setXY(i, lerp(HINGE_U, 1, uv.getX(i)), flipV ? 1 - uv.getY(i) : uv.getY(i));
  const m = new THREE.Mesh(g, matEndpaper);
  m.receiveShadow = true;
  return m;
}
/* ---------------- the sapphire: an oval brilliant, cut and set like a jewel ----------------
   only the crown is modelled; the shader traces each ray that enters it through the
   whole stone: down to a virtual pavilion, round by total internal reflection, out
   through a facet (split a little into its colours) into the forest and the sun, the
   blue deepening with every millimetre of corundum the light has crossed; the
   pavilion is backed with foil, so what goes down comes back up as brilliance */
const GEM_A = 0.21, GEM_B = 0.29, GEM_H = 0.095, GEM_G = 0.02, GEM_D = 0.22;
const GEMS = [];
function gemCrownGeometry(){
  const P = (ang, r, z)=>new THREE.Vector3(Math.cos(ang)*r*GEM_A, Math.sin(ang)*r*GEM_B, z);
  const T = [], S = [], G = [], L = [];
  for(let k=0;k<8;k++){ T.push(P(k*Math.PI/4, 0.54, GEM_H)); S.push(P(k*Math.PI/4 + Math.PI/8, 0.8, GEM_H*0.5)); }
  for(let j=0;j<16;j++){ G.push(P(j*Math.PI/8, 1, 0)); L.push(P(j*Math.PI/8, 1, -GEM_G)); }
  const top = new THREE.Vector3(0, 0, GEM_H), bot = new THREE.Vector3(0, 0, -GEM_G);
  const v = [], f = (a, b, c)=>v.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for(let k=0;k<8;k++){
    const k1 = (k+1)%8, km = (k+7)%8, g0 = G[2*k], g1 = G[2*k+1], g2 = G[(2*k+2)%16];
    f(top, T[k], T[k1]);                              // table
    f(T[k], S[k], T[k1]);                             // star
    f(T[k], g0, S[k]); f(T[k], S[km], g0);            // bezel kite
    f(S[k], g0, g1); f(S[k], g1, g2);                 // upper girdle
  }
  for(let j=0;j<16;j++){
    const j1 = (j+1)%16;
    f(G[j], L[j], L[j1]); f(G[j], L[j1], G[j1]); f(bot, L[j1], L[j]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}
/* the stone as a convex solid: the crown's facets, the girdle, and a pavilion of eight
   mains to the culet with sixteen lower-girdle facets, turned off the crown's star */
function gemPlanes(crown){
  const out = [], add = (n, w)=>{
    if(!out.some(p=>p.x*n.x + p.y*n.y + p.z*n.z > 0.99999 && Math.abs(p.w - w) < 1e-5)) out.push(new THREE.Vector4(n.x, n.y, n.z, w));
  };
  const pos = crown.attributes.position, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for(let i=0;i<pos.count;i+=3){
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i+1); c.fromBufferAttribute(pos, i+2);
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    if(n.z < -0.99) continue;
    add(n, n.dot(a));
  }
  const pav = (ang, z0)=>{
    const g = new THREE.Vector3(Math.cos(ang)*GEM_A, Math.sin(ang)*GEM_B, -GEM_G);
    const t = new THREE.Vector3(-Math.sin(ang)*GEM_A, Math.cos(ang)*GEM_B, 0);
    const n = t.clone().cross(g.clone().sub(new THREE.Vector3(0, 0, z0))).normalize();
    add(n, n.dot(g));
  };
  for(let k=0;k<8;k++) pav(k*Math.PI/4 + Math.PI/8, -GEM_G - GEM_D);
  for(let k=0;k<16;k++) pav(k*Math.PI/8 + Math.PI/16, -GEM_G - GEM_D*1.32);
  return out;
}
const GEM_GLSL = n => `
  #define GEM_NP ${n}
  uniform vec4 uGemPl[GEM_NP];
  uniform mat3 uGemRot;
  uniform vec3 uGemSig, uSunDir, uSunCol;
  uniform float uGemEnv, uGemGlow;
  varying vec3 vGemP, vGemC;
  vec3 gemSky(vec3 d){
    vec3 w = normalize(uGemRot*d);
    #if defined(USE_ENVMAP) && defined(ENVMAP_TYPE_CUBE_UV)
      vec3 c = textureCubeUV(envMap, envMapRotation*w, 0.0).rgb;
    #else
      vec3 c = vec3(0.25, 0.3, 0.35)*(0.4 + 0.6*max(w.y, 0.0));
    #endif
    float s = max(dot(w, uSunDir), 0.0);
    return c*uGemEnv + uSunCol*(pow(s, 3000.0)*90.0 + pow(s, 300.0)*1.2);
  }
  vec3 gemTrace(out float fIn){
    vec3 V = normalize(vGemP - vGemC);
    vec3 Nc = cross(dFdx(vGemP), dFdy(vGemP));
    vec3 N = dot(Nc, Nc) > 1e-24 ? normalize(Nc) : -V;
    if(dot(N, V) > 0.0) N = -N;
    float ci = clamp(-dot(V, N), 0.0, 1.0);
    fIn = 0.077 + 0.923*pow(1.0 - ci, 5.0);
    vec3 rd = refract(V, N, 1.0/1.77), p = vGemP;
    vec3 T = vec3(1.0), L = vec3(0.0);
    for(int b = 0; b < 7; b++){
      float tm = 10.0; vec3 nh = vec3(0.0, 0.0, 1.0);
      for(int i = 0; i < GEM_NP; i++){
        vec4 pl = uGemPl[i];
        float dn = dot(pl.xyz, rd);
        if(dn > 1e-4){
          float t = (pl.w - dot(pl.xyz, p))/dn;
          if(t > 2e-4 && t < tm){ tm = t; nh = pl.xyz; }
        }
      }
      if(tm > 9.0) break;
      p += rd*tm;
      T *= exp(-uGemSig*tm);
      float c = dot(rd, nh), k = 1.0 - 3.1329*(1.0 - c*c);
      /* below the girdle the stone sits on bright foil in a closed collet, as old jewels did */
      if(nh.z < 0.05) T *= 0.9;
      else if(k > 0.0){
        float F = 0.077 + 0.923*pow(1.0 - sqrt(k), 5.0);
        vec3 og = refract(rd, -nh, 1.77), orr = refract(rd, -nh, 1.745), ob = refract(rd, -nh, 1.80);
        if(dot(ob, ob) < 0.5) ob = og;
        L += T*(1.0 - F)*vec3(gemSky(orr).r, gemSky(og).g, gemSky(ob).b);
        T *= F;
      }
      rd = reflect(rd, nh);
    }
    L += T*vec3(0.01, 0.02, 0.08)*uGemEnv;
    /* when the book wakes, a light kindles inside the stone */
    L += uGemGlow*vec3(0.1, 0.3, 1.0)*(0.25 + 0.75*exp(-dot(p.xy, p.xy)*40.0));
    return L;
  }`;
const SAPPHIRE_SIG = new THREE.Vector3(4.6, 3.8, 0.32);
function gemMaterial(uni, nPlanes){
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x000000, metalness: 0, roughness: 0.012, ior: 1.77, specularIntensity: 0.75, flatShading: true,
    envMapIntensity: 1.0 });
  m.onBeforeCompile = sh=>{
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGemP, vGemC;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGemP = position; vGemC = (inverse(modelMatrix)*vec4(cameraPosition, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', GEM_GLSL(nPlanes) + '\nvoid main() {')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nfloat gemF; vec3 gemL = gemTrace(gemF); if(any(isnan(gemL)) || any(isinf(gemL)) || isnan(gemF)) { gemL = vec3(0.0); gemF = 1.0; } totalEmissiveRadiance += gemL*(1.0 - gemF);')
      /* a mirror facet catching the sun is one HDR pixel the bloom blows into a square */
      .replace('#include <opaque_fragment>', 'outgoingLight *= min(1.0, 7.0/max(1e-4, max(outgoingLight.r, max(outgoingLight.g, outgoingLight.b))));\n#include <opaque_fragment>');
  };
  m.customProgramCacheKey = ()=>'gem-trace';
  return m;
}
/* polished yellow gold for the setting, brighter than the gilt tooling */
const matJewelGold = new THREE.MeshPhysicalMaterial({
  color: 0xe0b45c, metalness: 1, roughness: 0.17, envMapIntensity: 1.6, emissive: 0xffc56e, emissiveIntensity: 0 });
/* a breath of blue on the leather round the bezel, only while the book wakes */
const haloMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  uniforms: { uHalo: { value: 0 } },
  vertexShader: `varying vec2 vU; void main(){ vU = uv*2.0 - 1.0; gl_Position = projectionMatrix*modelViewMatrix*vec4(position, 1.0); }`,
  fragmentShader: `varying vec2 vU; uniform float uHalo;
    void main(){ float d = length(vU); float a = pow(1.0 - smoothstep(0.3, 1.0, d), 2.2)*uHalo;
      gl_FragColor = vec4(vec3(0.16, 0.36, 1.0)*a, a); }`
});
/* seat: how far the group's origin stands off the leather */
function sapphire(scale, seat, flareW){
  const grp = new THREE.Group();
  const crown = gemCrownGeometry(), planes = gemPlanes(crown);
  const uni = {
    uGemPl: { value: planes }, uGemRot: { value: new THREE.Matrix3() }, uGemSig: { value: SAPPHIRE_SIG },
    uSunDir: { value: SUN_DIR }, uSunCol: { value: new THREE.Color() }, uGemEnv: { value: 2.4 }, uGemGlow: { value: 0 } };
  const gem = new THREE.Mesh(crown, gemMaterial(uni, planes.length));
  gem.position.z = 0.006;
  grp.add(gem);
  const hm = haloMat.clone();
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(GEM_A*5.2, GEM_B*4.4), hm);
  halo.position.z = -(seat - 0.002)/scale;
  halo.userData.noPick = true; halo.raycast = ()=>{};
  halo.renderOrder = 1;
  grp.add(halo);
  /* collet: a slim rim round the girdle, edged with milgrain */
  const ZG = gem.position.z;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 12, 96), matJewelGold);
  rim.scale.set(GEM_A + 0.012, GEM_B + 0.012, 0.32); rim.position.z = ZG - GEM_G*0.5;
  grp.add(rim);
  const NB = 64, bead = new THREE.InstancedMesh(new THREE.SphereGeometry(0.0085, 10, 8), matJewelGold, NB);
  const _m = new THREE.Matrix4();
  for(let i=0;i<NB;i++){
    const a = i/NB*Math.PI*2;
    _m.makeTranslation(Math.cos(a)*(GEM_A + 0.034), Math.sin(a)*(GEM_B + 0.034), ZG - GEM_G*0.5);
    bead.setMatrixAt(i, _m);
  }
  grp.add(bead);
  /* eight claws, leaning in over the girdle to hold the stone */
  const clawGeo = new THREE.CapsuleGeometry(0.013, 0.022, 4, 10);
  const up = new THREE.Vector3(0, 1, 0);
  for(let k=0;k<8;k++){
    const a = k*Math.PI/4 + Math.PI/8;
    const rad = new THREE.Vector3(Math.cos(a)*GEM_B, Math.sin(a)*GEM_A, 0).normalize();
    const base = new THREE.Vector3(Math.cos(a)*(GEM_A + 0.006), Math.sin(a)*(GEM_B + 0.006), ZG - GEM_G*0.6);
    const dir = rad.clone().multiplyScalar(-0.62).add(new THREE.Vector3(0, 0, 0.78)).normalize();
    const claw = new THREE.Mesh(clawGeo, matJewelGold);
    claw.quaternion.setFromUnitVectors(up, dir);
    claw.position.copy(base).addScaledVector(dir, 0.02);
    grp.add(claw);
  }
  grp.scale.setScalar(scale);
  grp.userData.gem = gem;
  GEMS.push({ gem, uni, halo: hm, flareW });
  return grp;
}
const _gemM4 = new THREE.Matrix4();
function stepGems(){
  matJewelGold.emissiveIntensity = st.aura*0.12 + st.gemFlare*0.2;
  GEMS.forEach(G=>{
    const fl = st.gemFlare*G.flareW;
    G.uni.uGemRot.value.setFromMatrix4(_gemM4.extractRotation(G.gem.matrixWorld));
    G.uni.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
    G.uni.uGemGlow.value = fl*0.9 + st.aura*0.35;
    G.halo.uniforms.uHalo.value = fl*0.4 + st.aura*0.22;
  });
}

/* back board: local z from -CVR (outer) to 0 (inner) */
const backGrp = new THREE.Group();
bookRoot.add(backGrp);
let backGoldSlot, frontGoldSlot;
{
  const board = coverBoard(matCoverBack);
  board.position.z = -CVR;
  backGrp.add(board);
  const ep = endpaper(); ep.position.z = 0.002;
  backGrp.add(ep);
  const gm = sapphire(0.6, 0.008, 0.5);
  gm.position.set(CW/2, 0, -CVR-0.008); gm.rotation.y = Math.PI;
  backGrp.add(gm);
  /* the gilt is authored with +z out of the board: flip it onto the outer face */
  backGoldSlot = new THREE.Group();
  backGoldSlot.position.z = -CVR;
  backGoldSlot.rotation.x = Math.PI;
  backGrp.add(backGoldSlot);
}
/* front board: local +z points away from the block (outer face at CVR) */
const frontGrp = new THREE.Group();
bookRoot.add(frontGrp);
let frontGem;
{
  const board = coverBoard(matCoverFront);
  frontGrp.add(board);
  const ep = endpaper(true); ep.rotation.x = Math.PI; ep.position.z = -0.002;
  frontGrp.add(ep);
  frontGem = sapphire(1.0, 0.012, 1); frontGem.position.set(CW/2, 0, CVR + 0.012);
  frontGrp.add(frontGem);
  frontGoldSlot = new THREE.Group();
  frontGoldSlot.position.z = CVR;
  frontGrp.add(frontGoldSlot);
}
frontGrp.traverse(o=>{ if(o.isMesh) o.userData.grab = 'front'; });
backGrp.traverse(o=>{ if(o.isMesh) o.userData.grab = 'back'; });

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

/* ============================================================================
   6.  leaves
   ==========================================================================*/
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
  const tint = 0.84 + rnd()*0.2;
  /* the gutter: a page darkens as it runs down into the sewing, on both sides of
     every leaf, so the spread reads as bound into the spine and not laid beside it */
  const gutter = v => { const s = ((v % A_CNT) % (M+1))/M*len, f = 1 - smooth(clamp(s/0.42, 0, 1)); return 1 - 0.42*Math.pow(f, 1.6); };
  for(let v=0;v<V_CNT;v++){
    const wallV = v >= 2*A_CNT, gs = wallV ? 1 : gutter(v);
    col[v*3]   = wallV ? 0.84*tint : gs;
    col[v*3+1] = wallV ? 0.68*tint : gs;
    col[v*3+2] = wallV ? 0.42*tint*(0.92+rnd()*0.1) : gs;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm,3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv,2));
  g.setAttribute('color', new THREE.BufferAttribute(col,3));
  const across = new Float32Array(V_CNT);
  for(let v=2*A_CNT;v<V_CNT;v++) across[v] = (v - 2*A_CNT) % 2;
  g.setAttribute('aEdge', new THREE.BufferAttribute(across,1));
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

/* ============================================================================
   7.  state, layout
   ==========================================================================*/
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
  shadowDirty = true;
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
    }else{
      mats[0] = blankMat[0]; mats[1] = blankMat[1];
    }
    L.mesh.castShadow = near;
  }
  trimCache(keep);
}

/* ============================================================================
   8.  view: lying on the rock, lifting to be turned, framing
   ==========================================================================*/
/* book +z (the cover / the spread) faces the sky; its head points away */
const qClosedHome = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI/2, -0.38, 0, 'YXZ'));
const qOpenHome   = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI/2, 0, 0, 'YXZ'));
spinGrp.quaternion.copy(qClosedHome);
/* the hand turns spinGoal; the book follows it, so no mouse step is ever seen raw */
const spinGoal = qClosedHome.clone();
let spinAnim = null;
const angVel = { x:0, y:0 };          // rad/s, kept on after a flick
let inertia = false;
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

/* ============================================================================
   9.  persistence
   ==========================================================================*/
const toastEl = document.getElementById('toast');
let toastTm = 0;
function toast(msg, ms){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTm); toastTm = setTimeout(()=>toastEl.classList.remove('show'), ms || 1400);
}
let saveTm = 0;
/* every browser that writes in the book is one hand with its own mark; each
   letter keeps the mark of the hand that wrote it, whoever erases or moves it */
const HAND_KEY = 'liber-arcanum.hand';
const BROWSER_HAND = (()=>{
  let h = null;
  try{ h = localStorage.getItem(HAND_KEY); }catch(e){}
  if(!/^h[0-9a-z]{8,}$/.test(h || '')){
    h = 'h' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    try{ localStorage.setItem(HAND_KEY, h); }catch(e){}
  }
  return h;
})();
/* in a shared book the hand is the signed-in person, and the book lives
   under a key of its own */
let HAND = BROWSER_HAND, bookKey = LS_KEY, shelf = null, booted = false;
function handsOf(n){
  const pg = pages[n];
  if(!pg.a || pg.a.length !== pg.t.length) pg.a = Array(pg.t.length).fill(HAND);
  return pg.a;
}
/* hands are stored once per book, each page as runs of [hand, letters] */
function packHands(a, list){
  const runs = [];
  a.forEach(h=>{
    let i = list.indexOf(h);
    if(i < 0){ i = list.length; list.push(h); }
    const r = runs[runs.length - 1];
    if(r && r[0] === i) r[1]++; else runs.push([i, 1]);
  });
  return runs;
}
function unpackHands(runs, list, len){
  if(!Array.isArray(runs) || !Array.isArray(list)) return null;
  const a = [];
  for(const r of runs){
    const h = list[r && r[0]], c = r ? r[1]|0 : 0;
    if(typeof h !== 'string' || c <= 0 || a.length + c > len) return null;
    for(let i=0;i<c;i++) a.push(h);
  }
  return a.length === len ? a : null;
}
function serialise(){
  const out = {}, hands = [HAND];
  pages.forEach((p,n)=>{
    if(!p.t && !p.f) return;
    const o = { t:p.t, f:p.f };
    if(p.c) o.c = 1;
    if(p.t) o.a = packHands(handsOf(n), hands);
    out[n] = o;
  });
  return { pages: out, hands, open: st.open, k: st.k, w: lastWritten, font: defaultFont, fv: 5 };
}
function saveNow(quiet){
  clearTimeout(saveTm);
  try{
    localStorage.setItem(bookKey, JSON.stringify(serialise()));
    if(!quiet) toast('✒  INSCRIBED');
  }catch(e){ toast('COULD NOT SAVE', 2200); }
  if(bookKey === LS_KEY && pages.some(p => p.t)) keepForever();
  if(shelf){ shelf.sync(); if(bookKey === LS_KEY) shelf.keepSoon(); }
}
/* the browser is asked once, after the first writing, not to clear this site's
   storage by itself (Safari otherwise may, after a week without a visit) */
let persistAsked = false;
function keepForever(){
  if(persistAsked) return;
  persistAsked = true;
  try{
    const s = navigator.storage;
    if(s && s.persisted && s.persist) s.persisted().then(on => on || s.persist()).catch(()=>{});
  }catch(e){}
}
/* the book opens on its title page, or, once there is writing in it, on the
   page last written on (failing that, the last page that has any ink) */
let lastWritten = null;
function homePage(){
  let w = lastWritten;
  if(!(w >= 1 && w < 2*N && pages[w].t)){
    w = 0;
    for(let n=2*N-1;n>=1;n--) if(pages[n].t){ w = n; break; }
  }
  return w;
}
function homeSpread(){ return spreadOf(homePage()); }
function saveSoon(quiet){ clearTimeout(saveTm); saveTm = setTimeout(()=>saveNow(quiet), 450); }
function applyData(d){
  pages.forEach(p=>{ p.t=''; p.f=null; p.born=null; p.c=false; p.a=null; });
  if(d && d.pages) Object.entries(d.pages).forEach(([n,v])=>{
    const i = n|0;
    if(i>=0 && i<pages.length && v){
      pages[i].t = String(v.t||'').slice(0, 6000); pages[i].f = FONTS.some(f=>f.id===v.f) ? v.f : null; pages[i].c = !!v.c;
      /* a book from before hands were kept was written in this browser */
      pages[i].a = unpackHands(v.a, d.hands, pages[i].t.length);
    }
  });
  /* books saved under an older default hand move onto Chronicle; a page given
     any of today's other hands on purpose keeps it */
  defaultFont = 'chronicle';
}
function loadAll(){
  let d = null;
  try{ d = JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){}
  if(d){
    applyData(d);
    lastWritten = (d.w|0) >= 1 ? d.w|0 : null;
    st.open = !!d.open;
    st.k = homeSpread();
    return;
  }
  /* the first build stored HTML per page under liber-arcanum.page.N */
  const OLD_FIRST = 'Booke of Shadowes';
  try{
    for(let n=0;n<14;n++){
      const v = localStorage.getItem(`liber-arcanum.page.${n}`);
      if(!v || v.includes(OLD_FIRST)) continue;
      const host = document.createElement('div');
      host.innerHTML = v.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(div|p)>/gi,'\n');
      pages[n].t = (host.textContent || '').replace(/ /g,' ').replace(/\n+$/,'');
    }
  }catch(e){}
}
/* another tab of the same book saved: take its pages, so this tab never
   writes an older copy back over them when it closes */
addEventListener('storage', e=>{
  if(e.key !== bookKey || !e.newValue) return;
  let d = null;
  try{ d = JSON.parse(e.newValue); }catch(err){ return; }
  clearTimeout(saveTm);
  applyData(d);
  lastWritten = (d.w|0) >= 1 ? d.w|0 : null;
  if(writing){
    const n = writing.n, i = Math.min(quill.selectionEnd, pages[n].t.length);
    quill.value = pages[n].t; quill.setSelectionRange(i, i);
    lastGood = { v: quill.value, a: i, b: i };
  }
  pageCache.forEach((_, n)=>paintPage(n));
});
const fileDate = () => new Date().toISOString().slice(0,10);
function download(name, text, type){
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
}
function exportText(){
  saveNow(true);
  const parts = [];
  pages.forEach((p, n)=>{
    if(n < 1 || !p.t.trim()) return;
    const who = shelf && shelf.shared() ? [...new Set(handsOf(n))].map(h => shelf.name(h)).filter(Boolean) : [];
    parts.push(`Page ${n + 1}${who.length ? ' · ' + who.join(', ') : ''}\n\n${p.t.trim()}`);
  });
  if(!parts.length){ toast('THE BOOK IS STILL EMPTY', 1600); return; }
  download(`liber-arcanum-${fileDate()}.txt`, `Liber Arcanum\n\n\n${parts.join('\n\n\n')}\n`, 'text/plain;charset=utf-8');
  toast('DOWNLOADED', 1800);
}
/* the pages of another book are taken up in place of these */
function useBook(key, hand, booting){
  if(writing) exitWriting();
  saveNow(true);
  clearTimeout(saveTm);
  bookKey = key; HAND = hand; lastErase = null;
  let d = null;
  try{ d = JSON.parse(localStorage.getItem(key)); }catch(e){}
  applyData(d);
  lastWritten = d && (d.w|0) >= 1 ? d.w|0 : null;
  pageCache.forEach((_, n)=>paintPage(n));
  if(booting || !st.open) st.k = st.open ? homeSpread() : st.k;
  else seekSpread(homeSpread(), { flourish: false });
  refreshUI();
}
/* the private book as it is saved, wherever the reader is now */
function personalData(){
  if(bookKey === LS_KEY) return serialise();
  let d = null;
  try{ d = JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){}
  return d && d.pages ? d : { pages: {}, hands: [BROWSER_HAND] };
}
/* a copy taken into the private book: every letter in it becomes this browser's */
function takePersonal(d){
  const data = { ...d, hands: (Array.isArray(d.hands) ? d.hands : []).map(()=> BROWSER_HAND), open: st.open, k: st.k };
  if(bookKey !== LS_KEY){
    try{ localStorage.setItem(LS_KEY, JSON.stringify(data)); }catch(e){ toast('COULD NOT SAVE', 2200); }
    return;
  }
  if(writing) exitWriting();
  clearTimeout(saveTm);
  applyData(data);
  lastWritten = (data.w|0) >= 1 ? data.w|0 : null;
  pageCache.forEach((_, n)=>paintPage(n));
  if(!st.open) st.k = homeSpread();
  else seekSpread(homeSpread(), { flourish: false });
  saveNow(true);
  refreshUI();
}
/* a file that keeps everything: the letters, whose they are and the hands they are written in */
function saveCopy(personal){
  saveNow(true);
  const d = personal ? personalData() : serialise();
  const book = { pages: d.pages || {}, hands: d.hands || [], w: d.w || null, font: d.font || null, fv: d.fv || 5 };
  const name = personal || !shelf || !shelf.shared() ? 'private-book' : 'shared-book';
  download(`liber-arcanum-${name}-${fileDate()}.json`, JSON.stringify({ liber: 'arcanum', v: 1, book }), 'application/json');
  toast('BACKED UP TO A FILE', 1800);
}
const copyPicker = document.createElement('input');
copyPicker.type = 'file'; copyPicker.accept = '.json,application/json'; copyPicker.hidden = true;
document.body.appendChild(copyPicker);
copyPicker.addEventListener('change', async ()=>{
  const f = copyPicker.files && copyPicker.files[0];
  copyPicker.value = '';
  if(!f) return;
  let d = null;
  try{ d = JSON.parse(await f.text()); }catch(e){}
  const book = d && d.liber === 'arcanum' && d.book && typeof d.book.pages === 'object' ? d.book : null;
  if(!book){ toast('THIS IS NOT A BACKUP OF THE BOOK', 2400); return; }
  const now = personalPages().length;
  if(now && shelf){
    const yes = await shelf.ask({
      title: 'RESTORE FROM A FILE',
      text: `The backup takes the place of your private book, which has ${now} written ${now === 1 ? 'page' : 'pages'} now. Back it up first if you want to keep it`,
      yes: 'Replace my private book', no: 'Cancel',
      extra: { label: 'Back up my private book first', fn: ()=> saveCopy(true) },
    });
    if(!yes) return;
  }
  if(shelf && shelf.shared()) shelf.personal();
  takePersonal(book);
  toast('THE BACKUP IS YOUR PRIVATE BOOK NOW', 2400);
});
/* the pages written in this browser's own book, wherever the reader is now */
function personalPages(){
  let list = pages.map((p, n)=>({ n, t: p.t, a: bookKey === LS_KEY ? handsOf(n) : null, f: p.f, c: p.c }));
  if(bookKey !== LS_KEY){
    let d = null;
    try{ d = JSON.parse(localStorage.getItem(LS_KEY)); }catch(e){}
    list = Object.entries((d && d.pages) || {}).map(([n, v])=>{
      const t = String(v.t || '');
      return { n: n|0, t, a: unpackHands(v.a, d.hands, t.length) || Array(t.length).fill(BROWSER_HAND), f: v.f || null, c: !!v.c };
    });
  }
  return list.filter(p => p.n >= 1 && p.n < 2*N && p.t);
}
/* letters that came from another hand over the network burn in where they land */
function applyPage(n, t, a, f, c, quiet){
  if(composing && writing && writing.n === n) return false;
  const pg = pages[n], now = performance.now(), sp = editSpan(pg.t, t), ob = pg.born || [];
  const step = Math.min(14, 900/Math.max(1, sp.ins));
  pg.born = quiet ? null : Array.from({length: sp.at}, (_, i)=> ob[i] || 0)
    .concat(Array.from({length: sp.ins}, (_, i)=> now + i*step), Array.from({length: t.length - sp.at - sp.ins}, (_, i)=> ob[sp.at + sp.del + i] || 0));
  pg.t = t; pg.a = a.slice(); pg.f = FONTS.some(x => x.id === f) ? f : pg.f; pg.c = !!c && !!t;
  if(writing && writing.n === n){
    let i = quill.selectionEnd;
    if(i >= sp.at + sp.del) i += sp.ins - sp.del; else if(i > sp.at) i = sp.at;
    i = clamp(i, 0, t.length);
    quill.value = t; quill.setSelectionRange(i, i);
    lastGood = { v: t, a: i, b: i };
  }
  if(pageCache.has(n)){ if(!quiet) burning.add(n); paintPage(n, now); }
  saveSoon(true);
  return true;
}
function exportFile(){
  saveNow(true);
  const data = { format:'liber-arcanum', version:2, savedAt:new Date().toISOString(), ...serialise() };
  download(`liber-arcanum-${fileDate()}.json`, JSON.stringify(data, null, 2), 'application/json');
  toast('BACKUP DOWNLOADED', 1800);
}
/* ============================================================================
   10. writing
   ==========================================================================*/
const quill = document.getElementById('quill');
let writing = null;           // { n }
let composing = false;
let lastGood = { v:'', a:0, b:0 };
const pageNoEl = document.getElementById('pageNo');
const burning = new Set();    // pages with letters still glowing

/* a keeper the creator lets only read turns the pages but cannot take the quill */
const readOnly = ()=> !!shelf && shelf.readOnly();
function enterWriting(n, idx){
  if(readOnly()){ toast('YOU CAN ONLY READ THIS BOOK', 2200); return; }
  if(writing && writing.n !== n) exitWriting(true);
  const fresh = !writing;
  writing = { n };
  pageEntry(n);
  if(fresh) quill.value = pages[n].t;
  const i = clamp(idx === undefined ? quill.value.length : idx, 0, quill.value.length);
  quill.focus({ preventScroll:true });
  quill.setSelectionRange(i, i);
  lastGood = { v:quill.value, a:i, b:i };
  blinkPhase = 0;
  st.bob = 0;
  burning.add(n);
  paintPage(n);
  refreshUI();
}
function exitWriting(keepFocus){
  if(!writing) return;
  const n = writing.n;
  writing = null;
  if(!keepFocus){ quill.blur(); if(!onePage()) st.focusTo = 0; }
  paintPage(n);
  saveNow(true);
  st.bob = 1;
  refreshUI();
}
/* where an edit changed the text: the common head, then what went and what came */
/* what one stroke of the quill did: at `at`, `del` letters went and `ins`
   came; given the selection it was made on (a, b) and the caret after (c),
   a letter typed beside the same letter of another hand is not taken for theirs */
function editSpan(oldV, newV, a, b, c){
  const lo = Math.min(oldV.length, newV.length);
  let p = 0;
  while(p < lo && oldV[p] === newV[p]) p++;
  let s = 0;
  while(s < lo - p && oldV[oldV.length-1-s] === newV[newV.length-1-s]) s++;
  const least = { at: p, del: oldV.length - p - s, ins: newV.length - p - s };
  /* a reading from the selection is taken only if it deletes no more than
     the plainest reading does */
  if(a !== undefined){
    const d = oldV.length - newV.length;
    const fits = (at, del, ins) => at >= 0 && del >= 0 && ins >= 0 && at + del <= oldV.length &&
      del <= least.del && oldV.length - del + ins === newV.length &&
      newV.slice(0, at) === oldV.slice(0, at) && newV.slice(at + ins) === oldV.slice(at + del);
    for(const [at, del, ins] of [[a, b - a, b - a - d], [c, a - c, 0], [a, d, 0], [a, d + c - a, c - a]])
      if(fits(at, del, ins)) return { at, del, ins };
  }
  return least;
}
function refuseStroke(msg){
  quill.value = lastGood.v;
  quill.setSelectionRange(lastGood.a, lastGood.b);
  toast(msg, 2200);
}
/* keep one birth time per character, so new letters can burn in */
function trackBirths(n, oldV, newV){
  const now = performance.now();
  const old = pages[n].born || [];
  let p = 0;
  const lo = Math.min(oldV.length, newV.length);
  while(p < lo && oldV[p] === newV[p]) p++;
  let s = 0;
  while(s < lo - p && oldV[oldV.length-1-s] === newV[newV.length-1-s]) s++;
  const ins = newV.length - p - s;
  const born = Array.from({length:p}, (_, i)=>old[i] || 0);
  for(let i=0;i<ins;i++) born.push(now);
  for(let i=oldV.length - s; i<oldV.length; i++) born.push(old[i] || 0);
  pages[n].born = born;
  return { at: p, count: ins };
}
function onQuillInput(){
  if(!writing || composing) return;
  pageScroll = 0;
  const n = writing.n, v = quill.value;
  const sp = editSpan(pages[n].t, v, lastGood.a, lastGood.b, quill.selectionEnd), was = handsOf(n);
  const hands = was.slice(0, sp.at).concat(Array(sp.ins).fill(HAND), was.slice(sp.at + sp.del));
  const lay = layoutText(v, pageFont(n), textBox(n));
  if(!lay.ok){
    const res = pour(n, v, quill.selectionEnd, hands);
    if(!res){ refuseStroke('THE BOOK IS FULL'); return; }
    trackBirths(n, pages[n].t, v);
    applyPour(n, res);
    lastWritten = writing ? writing.n : n;
    return;
  }
  const old = pages[n].t, cut = editSpan(old, v), e0 = pageCache.get(n);
  if(cut.del > 0 && e0 && e0.lay){
    addVapor(n, old, e0.lay, cut.at, cut.at + cut.del, cut.del > 40 ? Math.min(0.07, 0.9/Math.max(1, e0.lay.lines.length)) : 0);
    if(!cut.ins) sfx.vanish(cut.del > 1);
  }
  const ins = trackBirths(n, old, v);
  pages[n].t = v;
  pages[n].a = hands;
  lastWritten = n;
  if(!v) pages[n].c = false;
  if(!pages[n].f) pages[n].f = defaultFont;
  lastGood = { v, a:quill.selectionStart, b:quill.selectionEnd };
  blinkPhase = 0;
  burning.add(n);
  document.fonts.load(fontCss(pageFont(n), 40), v.slice(-24) || 'a').then(()=>{ if(pageCache.has(n)) paintPage(n); }).catch(()=>{});
  paintPage(n);
  if(ins.count > 0 && ins.count < 40){
    emitSparks(n, lay, v, ins.at, ins.count);
    emitSmoke(n, lay, v, ins.at, ins.count);
    sfx.burn(ins.at === 0 && !!lay.cap);
    if(/[.!?]/.test(v.charAt(ins.at + ins.count - 1))) sfx.chime();
  }
  saveSoon(false);
}
quill.addEventListener('input', onQuillInput);
quill.addEventListener('compositionstart', ()=>{ composing = true; });
quill.addEventListener('compositionend', ()=>{ composing = false; onQuillInput(); });
const onSel = ()=>{
  if(!writing) return;
  blinkPhase = 0;
  if(!composing){ lastGood.a = quill.selectionStart; lastGood.b = quill.selectionEnd; }
  paintPage(writing.n);
};
document.addEventListener('selectionchange', ()=>{ if(document.activeElement === quill) onSel(); });
quill.addEventListener('keyup', onSel);
quill.addEventListener('keydown', e=>{
  e.stopPropagation();
  if(!writing) return;
  const n = writing.n;
  if(e.key === 'Escape'){ e.preventDefault(); exitWriting(); return; }
  const mod = e.metaKey || e.ctrlKey;
  if(mod && e.code === 'KeyE'){ e.preventDefault(); erasePages([n]); return; }
  if(mod && e.code === 'KeyZ' && !e.shiftKey && lastErase && restoreErased()){ e.preventDefault(); return; }
  if(mod && e.code === 'KeyG'){ e.preventDefault(); openSeek(); return; }
  if(mod && e.code === 'Slash'){ e.preventDefault(); openSpells(); return; }
  if(mod && e.key === 'Enter'){ e.preventDefault(); quillTo(n + 1, 0); return; }
  if(e.key === 'PageDown' || e.key === 'PageUp'){ e.preventDefault(); quillTo(n + (e.key === 'PageDown' ? 1 : -1)); return; }
  if(e.key === 'Backspace' && !mod && !e.altKey && quill.selectionStart === 0 && quill.selectionEnd === 0 && n > 1){ e.preventDefault(); quillTo(n - 1); return; }
  if((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'ы')){ e.preventDefault(); saveNow(); return; }
  if(e.key === 'Tab'){ e.preventDefault(); quill.setRangeText('    ', quill.selectionStart, quill.selectionEnd, 'end'); onQuillInput(); return; }
  const lay = pageEntry(n).lay;
  if(!lay) return;
  const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  const homeEnd = (e.key === 'Home' || e.key === 'End') && !e.metaKey && !e.ctrlKey;
  if(!vertical && !homeEnd) return;
  e.preventDefault();
  const dirBack = quill.selectionDirection === 'backward';
  const focus = dirBack ? quill.selectionStart : quill.selectionEnd;
  const anchor = dirBack ? quill.selectionEnd : quill.selectionStart;
  const c = caretXY(lay, focus);
  let to;
  if(vertical){
    const li = c.li + (e.key === 'ArrowUp' ? -1 : 1);
    if(li < 0) to = 0;
    else if(li >= lay.lines.length) to = quill.value.length;
    else to = indexOnLine(lay, li, c.x);
  }else{
    const ln = lay.lines[c.li];
    to = e.key === 'Home' ? ln.start : (lay.lines[c.li+1] && lay.lines[c.li+1].start === ln.end && ln.end > ln.start ? ln.end-1 : ln.end);
  }
  if(e.shiftKey) quill.setSelectionRange(Math.min(anchor,to), Math.max(anchor,to), to < anchor ? 'backward' : 'forward');
  else quill.setSelectionRange(to, to);
  onSel();
});
let blinkPhase = 0;

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
      const s = smokeNext; smokeNext = (smokeNext + 1) % SMOKE;
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

/* ---------------- sound: the forest from ElevenLabs, the book synthesised ---------------- */
const MUTE_KEY = 'liber-arcanum.muted';
const sfx = (()=>{
  let ac = null, out = null, noise = null;
  let muted = false, ambStarted = false;
  try{ muted = localStorage.getItem(MUTE_KEY) === '1'; }catch(e){}
  function ready(){
    if(muted) return null;
    if(!ac){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return null;
      ac = new AC();
      out = ac.createGain(); out.gain.value = 0.8; out.connect(ac.destination);
      noise = ac.createBuffer(1, ac.sampleRate*2, ac.sampleRate);
      const d = noise.getChannelData(0);
      for(let i=0;i<d.length;i++) d[i] = Math.random()*2 - 1;
    }
    if(ac.state === 'suspended') ac.resume();
    return ac;
  }
  /* a filtered breath of noise: paper, leather, a nib on vellum */
  function hiss(at, dur, f0, f1, q, gain, type){
    const src = ac.createBufferSource(); src.buffer = noise;
    src.playbackRate.value = 0.8 + Math.random()*0.4;
    const flt = ac.createBiquadFilter(); flt.type = type || 'bandpass'; flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, at); flt.frequency.exponentialRampToValueAtTime(f1, at + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.04, dur*0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(flt); flt.connect(g); g.connect(out);
    src.start(at, Math.random()*1.5, dur + 0.05);
  }
  /* the magic forest (assets/audio, made with ElevenLabs): the brook and the birds,
     a bed of breeze and far-off glass chimes, both with their two ends crossfaded
     and kept as WAV so the loops have no codec gap, plus now and then a fairy
     twinkle somewhere left or right. Starts once a first touch has woken the audio */
  const load = url => fetch(url).then(r=>r.arrayBuffer()).then(b=>ac.decodeAudioData(b));
  function twinkles(bufs){
    setTimeout(()=>twinkles(bufs), 7000 + Math.random()*13000);
    if(muted || !ac || ac.state !== 'running') return;
    const at = ac.currentTime + 0.05;
    const src = ac.createBufferSource(); src.buffer = bufs[Math.floor(Math.random()*bufs.length)];
    src.playbackRate.value = 0.9 + Math.random()*0.2;
    const g = ac.createGain(); g.gain.value = 0.16 + Math.random()*0.14;
    const pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
    if(pan){ pan.pan.value = (Math.random()*2 - 1)*0.8; src.connect(pan); pan.connect(g); } else src.connect(g);
    g.connect(out); src.start(at);
  }
  function ambience(){
    if(ambStarted || !ready()) return;
    ambStarted = true;
    load(ASSETS.magicBed).then(buf=>{
      const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.42, ac.currentTime + 6);
      src.connect(g); g.connect(out); src.start();
    }).catch(()=>{});
    Promise.all(ASSETS.twinkles.map(load)).then(bufs=>setTimeout(()=>twinkles(bufs), 5000)).catch(()=>{});
    load(ASSETS.brook).then(buf=>{
      const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.4, ac.currentTime + 4);
      src.connect(g); g.connect(out); src.start();
    }).catch(()=>{});
  }
  function tone(at, freq, dur, gain, type){
    const o = ac.createOscillator(); o.type = type || 'sine'; o.frequency.setValueAtTime(freq, at);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(out);
    o.start(at); o.stop(at + dur + 0.05);
    return o;
  }
  return {
    get muted(){ return muted; },
    setMuted(m){
      muted = m;
      try{ localStorage.setItem(MUTE_KEY, m ? '1' : '0'); }catch(e){}
      if(out && ac){
        out.gain.cancelScheduledValues(ac.currentTime);
        out.gain.setTargetAtTime(m ? 0 : 0.8, ac.currentTime, m ? 0.25 : 0.6);
      }
      if(!m){ ready(); ambience(); }
    },
    ambience,
    wake(){ ready(); },
    page(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, 0.42, 2600, 700, 0.9, 0.22);
      hiss(t + 0.12, 0.5, 1800, 500, 0.7, 0.16);
      hiss(t + 0.05, 0.25, 5200, 2600, 1.4, 0.05);
    },
    settle(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, 0.16, 900, 300, 0.8, 0.12);
      tone(t, 120, 0.12, 0.05);
    },
    /* the joint of an old board creaks as it is moved */
    creak(opening){
      if(!ready()) return;
      const t = ac.currentTime;
      const o = tone(t, opening ? 66 : 58, 0.7, 0.03, 'sawtooth');
      o.frequency.linearRampToValueAtTime(opening ? 98 : 50, t + 0.65);
      hiss(t, 0.7, 1100, 380, 0.6, 0.1);
    },
    /* a breath of air and far-off glass: the magic waking, kept very quiet */
    shimmer(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t + 0.2, 1.6, 5200, 2400, 3, 0.025);
      [880, 1318.5, 1760, 2217].forEach((f, i)=>{
        const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f*(1 + (Math.random()-0.5)*0.004);
        const g = ac.createGain(), at = t + 0.3 + i*0.18;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.012, at + 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 2.2);
        o.connect(g); g.connect(out); o.start(at); o.stop(at + 2.3);
      });
    },
    /* the board shuts on the block */
    thud(){
      if(!ready()) return;
      const t = ac.currentTime;
      tone(t, 64, 0.32, 0.26);
      tone(t, 128, 0.12, 0.06);
      hiss(t, 0.3, 650, 160, 0.7, 0.24);
      hiss(t + 0.03, 0.8, 2400, 900, 0.5, 0.03);
    },
    /* the open board lowered onto the rock */
    land(){
      if(!ready()) return;
      const t = ac.currentTime;
      tone(t, 70, 0.22, 0.08);
      hiss(t, 0.2, 600, 220, 0.7, 0.08);
    },
    /* a letter burning in: a soft sizzle, a warm breath of flame, a few dry
       crackles, and now and then the faintest glass note of the spell */
    burn(cap){
      if(!ready()) return;
      const t = ac.currentTime, len = cap ? 1.1 : 0.32;
      hiss(t, len + Math.random()*0.1, 7000 + Math.random()*1500, 4200, 0.9, cap ? 0.03 : 0.022, 'bandpass');
      hiss(t + 0.02, len*1.2, 700, 420, 0.7, cap ? 0.05 : 0.03, 'lowpass');
      const n = cap ? 7 : 1 + Math.floor(Math.random()*3);
      for(let i=0;i<n;i++) hiss(t + Math.random()*len, 0.008 + Math.random()*0.012, 2500 + Math.random()*3500, 1800, 1.4, 0.04 + Math.random()*0.06, 'highpass');
      if(Math.random() < (cap ? 1 : 0.16)) tone(t + 0.05, [2637, 3136, 3520, 3951][Math.floor(Math.random()*4)], cap ? 1.4 : 0.7, cap ? 0.006 : 0.0035);
    },
    /* a letter evaporating: a small breath drawn upward, now and then a high glass note */
    vanish(many){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, many ? 0.7 : 0.4, 1500, 5600, 1.1, many ? 0.04 : 0.026);
      if(Math.random() < (many ? 1 : 0.2)) tone(t + 0.08, [3520, 3136, 2637][Math.floor(Math.random()*3)], 0.8, many ? 0.008 : 0.004);
    },
    /* ink lifting off the sheet: a breath drawn upward, falling glass notes */
    erase(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, 1.1, 1400, 6200, 1.2, 0.05);
      [1760, 1318.5, 987.8].forEach((f, i)=>tone(t + 0.12 + i*0.17, f, 0.9, 0.011));
    },
    /* words slipping over on to the next page */
    flow(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, 0.6, 3000, 5400, 2, 0.022);
      [1318.5, 1760].forEach((f, i)=>tone(t + 0.1 + i*0.13, f, 0.8, 0.011));
    },
    /* one leaf of a riffle: a short dry flick */
    flick(){
      if(!ready()) return;
      hiss(ac.currentTime, 0.16, 3000, 1100, 0.9, 0.08);
    },
    chime(){
      if(!ready()) return;
      const t = ac.currentTime;
      [1318.5, 1975.5, 2637].forEach((f, i)=>tone(t + i*0.07, f*(1 + (Math.random()-0.5)*0.01), 1.1, 0.018));
    }
  };
})();

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
/* the forest is alive round the rock: now and then a leaf comes down from the crowns,
   and fireflies wander low over the moss in the shade. Nothing drifts between the
   camera and the book.
   The leaves are real ones, photographed (Poly Haven, CC0), some still green, some
   turning. A falling leaf does not sink and spin like a coin: it swings from side to
   side like a pendulum, tilting into each swing, hanging a moment at the ends and
   dropping fastest through the middle, while the breeze carries it along. One in four
   tumbles end over end instead and glides off sideways */
const leafTex = new THREE.TextureLoader().load('assets/leaves/fall_leaves.png');
leafTex.colorSpace = THREE.SRGBColorSpace; leafTex.anisotropy = 4;
const leafSun = { value: SUN_DIR }, leafHaze = { value: null };
const leafMats = [0xd6dcc4, 0xe8dc9a, 0xd8b06c, 0xa88660].map(tint=>{
  const m = new THREE.MeshStandardMaterial({ map: leafTex, color: tint, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, envMapIntensity: 0.55 });
  /* a thin leaf lets the light through, most of all with the low sun behind it, and
     stands in the same haze as the wood behind it */
  m.onBeforeCompile = sh=>{
    sh.uniforms.uSunW = leafSun; sh.uniforms.tHaze = leafHaze;
    sh.vertexShader = 'varying vec4 vScr;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvScr = gl_Position;');
    sh.fragmentShader = 'uniform vec3 uSunW; uniform sampler2D tHaze; varying vec4 vScr;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `
      { vec3 sv = normalize((viewMatrix*vec4(uSunW, 0.0)).xyz);
        float back = pow(clamp(-dot(normalize(vViewPosition), sv), 0.0, 1.0), 2.0);
        outgoingLight += diffuseColor.rgb*vec3(1.0, 0.95, 0.62)*(0.3 + 2.4*back);
        vec3 haze = textureLod(tHaze, vScr.xy/vScr.w*0.5 + 0.5, 4.0).rgb;
        outgoingLight = mix(outgoingLight, haze, clamp(1.0 - exp(-max(length(vViewPosition) - 4.0, 0.0)*0.03), 0.0, 0.45)); }
      #include <opaque_fragment>`);
  };
  return m;
});
/* each leaf of the atlas on its own little sheet, curled along its length and cupped
   across, as a dry leaf is */
const leafGeos = Array.from({length: 8}, (_, c)=>{
  const g = new THREE.PlaneGeometry(0.42, 0.84, 2, 6);
  const p = g.attributes.position, uv = g.attributes.uv;
  const bend = 0.06 + Math.random()*0.1, cup = 0.03 + Math.random()*0.05;
  for(let i=0;i<p.count;i++){
    const x = p.getX(i)/0.21, y = p.getY(i)/0.42;
    p.setZ(i, bend*y*y + cup*x*x);
    uv.setXY(i, (c % 4 + uv.getX(i))/4, 1 - ((c >> 2) + 1 - uv.getY(i))/2);
  }
  g.computeVertexNormals();
  return g;
});
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const AX_Y = new THREE.Vector3(0, 1, 0), AX_Z = new THREE.Vector3(0, 0, 1);
const LEAF_FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI/2);
const fallers = Array.from({length: 14}, (_, i)=>{
  const m = new THREE.Mesh(leafGeos[i % 8], leafMats[(i*3 + (i >> 2)) % 4]);
  m.userData = {};
  m.frustumCulled = false;
  scene.add(m);
  return m;
});
/* the book and its boulder stand in the leaves' way. The breeze parts round them as
   water parts round a stone (flow past a cylinder), so a leaf drifting at them is
   turned aside, and one that still comes down on the boulder slides off its flank.
   The boulder's girth is measured from its mesh, at every bearing and height */
const KEEP_BOOK = 4.4;              // an open book, turned any way, stays inside this
const KEEP_PAD = 0.55;              // half a leaf
const KEEP_NA = 48, KEEP_NY = 24, KEEP_Y0 = GROUND_Y - 0.5, KEEP_DY = 0.25;
let keepRock = null;
function keepAt(x, y, z){
  let r = KEEP_BOOK;
  if(keepRock){
    const fj = (y - KEEP_Y0)/KEEP_DY - 0.5, fa = (Math.atan2(z, x)/(2*Math.PI) + 1)*KEEP_NA - 0.5;
    const j0 = Math.floor(fj), a0 = Math.floor(fa), tj = fj - j0, ta = fa - a0;
    const at = (j, a)=>j < 0 || j >= KEEP_NY ? 0 : keepRock[j*KEEP_NA + (a % KEEP_NA)];
    r = Math.max(r, lerp(lerp(at(j0, a0), at(j0, a0 + 1), ta), lerp(at(j0 + 1, a0), at(j0 + 1, a0 + 1), ta), tj));
  }
  return r + KEEP_PAD;
}
function measureRock(mesh){
  mesh.updateWorldMatrix(true, false);
  const p = mesh.geometry.attributes.position, v = new THREE.Vector3(), raw = new Float32Array(KEEP_NA*KEEP_NY);
  for(let i=0;i<p.count;i++){
    v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld);
    const j = Math.floor((v.y - KEEP_Y0)/KEEP_DY);
    if(j < 0 || j >= KEEP_NY) continue;
    const k = j*KEEP_NA + Math.floor((Math.atan2(v.z, v.x)/(2*Math.PI) + 1)*KEEP_NA) % KEEP_NA;
    raw[k] = Math.max(raw[k], Math.hypot(v.x, v.z));
  }
  /* widened by a cell each way, so a leaf between two bearings never clips the stone */
  keepRock = new Float32Array(raw.length);
  for(let j=0;j<KEEP_NY;j++) for(let a=0;a<KEEP_NA;a++){
    let r = 0;
    for(let jj=Math.max(0, j - 1);jj<=Math.min(KEEP_NY - 1, j + 1);jj++)
      for(let da=-1;da<=1;da++) r = Math.max(r, raw[jj*KEEP_NA + (a + da + KEEP_NA) % KEEP_NA]);
    keepRock[j*KEEP_NA + a] = r;
  }
  fallers.forEach(m=>{ const u = m.userData; if(Math.hypot(u.x, u.z) < keepAt(u.x, u.y, u.z) + u.A) spawnLeaf(m, true); });
}
function spawnLeaf(m, anywhere){
  const u = m.userData;
  u.tumble = Math.random() < 0.25;
  u.A = 0.8 + Math.random()*1.2;
  let x, y, z;
  do{
    x = -18 + Math.random()*36; z = -20 + Math.random()*23;
    y = anywhere ? GROUND_Y + 2 + Math.random()*26 : 24 + Math.random()*8;
  }while(Math.hypot(x, z) < keepAt(x, y, z) + u.A || (Math.abs(x) < 5 && z > -3.5));
  u.x = x; u.y = y; u.z = z;
  u.v0 = (u.tumble ? 4.2 : 2.6) + Math.random()*1.6;
  u.w = 2.0 + Math.random()*1.3; u.ph = Math.random()*6.3;
  u.tilt = 0.45 + Math.random()*0.4;
  u.dir = Math.random()*6.3; u.dirW = (Math.random() - 0.5)*0.5;
  u.spin = Math.random()*6.3; u.spinW = (Math.random() - 0.5)*0.6;
  u.roll = Math.random()*6.3; u.rollW = (Math.random() < 0.5 ? -1 : 1)*(4 + Math.random()*3);
  m.scale.setScalar(0.75 + Math.random()*0.5);
}
fallers.forEach(m=>spawnLeaf(m, true));

/* fireflies: the warm yellow-green of the real ones, a few among the shade. Each
   drifts lazily on its own, dark most of the time, and now and then lights: a quick
   swell and a slow fade, sometimes twice, lifting a little as it glows. So at any
   moment only a handful shine, each in its own time, never all breathing together */
const FLIES = 44;
const fireflyMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uScale: { value: 1 } },
  vertexShader: `attribute float alpha, tint; varying float vA, vT; uniform float uScale;
    void main(){ vA = alpha; vT = tint; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = uScale*(0.7 + 0.9*min(alpha, 1.0))/max(0.1, -mv.z); }`,
  fragmentShader: `varying float vA, vT;
    void main(){ vec2 c = gl_PointCoord - 0.5; float r2 = dot(c, c);
      float core = exp(-r2*220.0), glow = exp(-r2*20.0);
      vec3 col = mix(vec3(0.72, 1.0, 0.34), vec3(1.0, 0.85, 0.45), vT);
      gl_FragColor = vec4((col*glow*1.1 + vec3(1.0, 1.0, 0.8)*core*2.6)*vA, 1.0); }`
});
const flyGeo = new THREE.BufferGeometry();
const flyPos = new Float32Array(FLIES*3), flyAlpha = new Float32Array(FLIES), flyTint = new Float32Array(FLIES);
const flySeed = Array.from({length: FLIES}, ()=>{
  let x, z; do{ x = -20 + Math.random()*40; z = -22 + Math.random()*26; }while(Math.hypot(x, z) < 4 || (Math.abs(x) < 4 && z > 1));
  const r = ()=>Math.random();
  return { x, z, y: GROUND_Y + 0.8 + Math.pow(r(), 1.8)*11,
    a: [0.05 + r()*0.12, 0.11 + r()*0.2, 0.07 + r()*0.14], p: [r()*40, r()*40, r()*40], R: 1.5 + r()*2.5,
    T: 3.5 + r()*5, off: r()*10, twice: r() < 0.3, b: 0.55 + r()*0.45, tint: Math.pow(r(), 2.5) };
});
flySeed.forEach((q, i)=>{ flyTint[i] = q.tint; });
flyGeo.setAttribute('position', new THREE.BufferAttribute(flyPos, 3));
flyGeo.setAttribute('alpha', new THREE.BufferAttribute(flyAlpha, 1));
flyGeo.setAttribute('tint', new THREE.BufferAttribute(flyTint, 1));
const flies = new THREE.Points(flyGeo, fireflyMat);
flies.frustumCulled = false;
scene.add(flies);
function pulse(t){ return t < 0 ? 0 : (t < 0.2 ? smooth(t/0.2) : Math.exp(-(t - 0.2)*4.2)); }

function stepLife(dt){
  const wx = 0.35 + 0.3*Math.sin(clock*0.11), wz = 0.12*Math.sin(clock*0.07 + 1.3);
  for(const m of fallers){
    const u = m.userData;
    u.ph += u.w*dt; u.dir += u.dirW*dt; u.spin += u.spinW*dt;
    const s = Math.sin(u.ph), c = Math.cos(u.ph), dx = Math.cos(u.dir), dz = Math.sin(u.dir);
    let vx = wx + (u.tumble ? dx*0.9 : 0), vz = wz + (u.tumble ? dz*0.9 : 0);
    /* past a cylinder of radius a: w = V - conj(V) a^2/conj(z)^2, a widened by the swing */
    const a = keepAt(u.x, u.y, u.z) + (u.tumble ? 0 : u.A), r2 = u.x*u.x + u.z*u.z;
    if(r2 > a*a){
      const k = a*a/(r2*r2), A = u.x*u.x - u.z*u.z, B = 2*u.x*u.z;
      const gx = vx*A + vz*B, gz = vx*B - vz*A;
      vx -= k*gx; vz -= k*gz;
    }
    u.x += vx*dt; u.z += vz*dt;
    _qa.setFromAxisAngle(AX_Y, -u.dir);
    if(u.tumble){
      u.y -= u.v0*dt;
      u.roll += u.rollW*dt;
      m.position.set(u.x, u.y, u.z);
      _qb.setFromAxisAngle(AX_Z, u.roll);
      m.quaternion.copy(_qa).multiply(_qb).multiply(LEAF_FLAT);
    }else{
      u.y -= u.v0*(0.25 + 0.75*c*c)*dt;
      const lat = u.A*s;
      m.position.set(u.x + dx*lat, u.y + 0.18*u.A*s*s, u.z + dz*lat);
      _qb.setFromAxisAngle(AX_Z, -u.tilt*c);
      _qc.setFromAxisAngle(AX_Y, u.spin);
      m.quaternion.copy(_qa).multiply(_qb).multiply(_qc).multiply(LEAF_FLAT);
    }
    /* whatever still reaches the stone or the book is pushed back out along the radius */
    const px = m.position.x, pz = m.position.z, pr = Math.hypot(px, pz), K = keepAt(px, m.position.y, pz);
    if(pr < K){
      const e = (K - pr)/Math.max(pr, 1e-3);
      u.x += px*e; u.z += pz*e;
      m.position.x += px*e; m.position.z += pz*e;
    }
    if(u.y < GROUND_Y + 0.3) spawnLeaf(m, false);
  }
  for(let i=0;i<FLIES;i++){
    const q = flySeed[i], t = clock;
    const k = ((t + q.off) % q.T + q.T) % q.T;
    const f = Math.min(1, pulse(k) + (q.twice ? 0.8*pulse(k - 0.7) : 0));
    flyPos[i*3]   = q.x + Math.sin(t*q.a[0] + q.p[0])*q.R + Math.sin(t*q.a[1]*1.7 + q.p[1])*q.R*0.35;
    flyPos[i*3+1] = q.y + Math.sin(t*q.a[1] + q.p[2])*0.9 + f*0.35;
    flyPos[i*3+2] = q.z + Math.sin(t*q.a[2] + q.p[1])*q.R + Math.cos(t*q.a[0]*1.3 + q.p[2])*q.R*0.35;
    flyAlpha[i] = 0.03 + f*q.b;
  }
  flyGeo.attributes.position.needsUpdate = true;
  flyGeo.attributes.alpha.needsUpdate = true;
}
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

/* ============================================================================
   11. picking & gestures
   ==========================================================================*/
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pickables(){
  const list = [];
  const c = st.k;
  if(st.riffle){}
  else if(!st.flight){
    if(c > 0) list.push(leaves[c-1].mesh);
    if(c < N) list.push(leaves[c].mesh);
  }else list.push(leaves[st.flight.j].mesh);
  list.forEach(m=>{ const L = leaves[m.userData.leaf]; if(L.bsDirty){ L.geo.computeBoundingSphere(); L.bsDirty = false; } });
  frontGrp.traverse(o=>{ if(o.isMesh && !o.userData.noPick) list.push(o); });
  backGrp.traverse(o=>{ if(o.isMesh && !o.userData.noPick) list.push(o); });
  list.push(spineMesh);
  return list;
}
function pickAt(cx, cy){
  ndc.set((cx/VW)*2-1, -(cy/VH)*2+1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(pickables(), false);
  if(!hits.length) return null;
  let h = hits[0];
  const o = h.object, ud = o.userData;
  if(ud.grab === 'leaf'){
    const open = st.open && Math.abs(st.theta-OPEN) < 1e-3 && !st.flight && !st.riffle;
    /* by the fore edge the ray can meet the open leaf's cut edge or the underside of
       the facing one first: the open page a hair further along is what was meant, and
       failing that the edge stands for that page's edge */
    if(open){
      const isTop = x => x.object.userData.grab === 'leaf' && x.face &&
        ((x.object.userData.leaf === st.k && x.face.materialIndex === 0) || (x.object.userData.leaf === st.k-1 && x.face.materialIndex === 1));
      const top = hits.find(x => x.distance < h.distance + 0.25 && isTop(x));
      if(top) h = top;
      else{
        const right = ud.leaf >= st.k, j = right ? st.k : st.k-1;
        if(j >= 0 && j < N) return { type:'page', n: right ? 2*j : 2*j+1, leaf:j, side: right ? 'right' : 'left', uv:{ x: right ? 1 : 0, y: h.uv ? h.uv.y : 0.5 }, s: leaves[j].len, y: h.uv ? h.uv.y : 0.5 };
      }
    }
    const i = h.object.userData.leaf, mi = h.face ? h.face.materialIndex : 2;
    const L = leaves[i];
    if(open && mi === 0 && i === st.k) return { type:'page', n:2*i, leaf:i, side:'right', uv:h.uv, s: h.uv.x*L.len, y: h.uv.y };
    if(open && mi === 1 && i === st.k-1) return { type:'page', n:2*i+1, leaf:i, side:'left', uv:h.uv, s:(1-h.uv.x)*L.len, y: h.uv.y };
    return { type:'book' };
  }
  if(ud.grab === 'front'){
    const lp = frontGrp.worldToLocal(h.point.clone());
    return { type:'front', local: lp, outer: lp.x > CW*0.42, inner: lp.z < CVR*0.5 };
  }
  return { type:'book' };
}
function toScreen(v){ const p = v.clone().project(camera); return { x:(p.x*0.5+0.5)*VW, y:(-p.y*0.5+0.5)*VH }; }

/* where a point of the flying leaf would be, for a given progress p */
const _tmpV = new THREE.Vector3();
function flightPointAt(fl, p, sG, yN){
  const C = layoutCtx(fl.j + p, st.theta);
  hingeOf(C, fl.j, _H);
  const PR = restParams(C, fl.j, false, _H), PL = restParams(C, fl.j, true, _H);
  const angleAt = flightAngleFn(PR, PL, { p, lead: fl.lead, lag: fl.lag, gy: fl.gy, sagK: fl.sagK }, yN);
  let x = _H.x, z = _H.z;
  const steps = Math.max(1, Math.round(sG/leaves[fl.j].ds));
  const ds = sG/steps;
  for(let m=0;m<steps;m++){ const a = angleAt((m+0.5)*ds); x += Math.cos(a)*ds; z += Math.sin(a)*ds; }
  _tmpV.set(x, yN*PH/2, z);
  return bookRoot.localToWorld(_tmpV);
}
/* near the vertical two poses of the leaf project close together; the bias
   keeps the hand on the pose it already holds instead of jumping between them */
function solveDragP(fl, px, py, prev){
  const f = p=>{ const s = toScreen(flightPointAt(fl, p, fl.sG, fl.yN)), b = (p - prev)*140; return (s.x-px)*(s.x-px) + (s.y-py)*(s.y-py) + b*b; };
  let best = 0, bd = Infinity;
  const NS = 40;
  for(let i=0;i<=NS;i++){ const p = i/NS, d = f(p); if(d < bd){ bd = d; best = p; } }
  let lo = Math.max(0, best - 1/NS), hi = Math.min(1, best + 1/NS);
  for(let it=0; it<14; it++){
    const m1 = lo + (hi-lo)/3, m2 = hi - (hi-lo)/3;
    if(f(m1) < f(m2)) hi = m2; else lo = m1;
  }
  return (lo+hi)/2;
}
function coverPointAt(theta, local){
  const C = layoutCtx(st.k, theta);
  const x = C.ex + C.dx*local.x - C.nx*local.z, z = C.ez + C.dz*local.x - C.nz*local.z;
  _tmpV.set(x, local.y, z);
  return bookRoot.localToWorld(_tmpV);
}
function solveCoverTheta(local, px, py, prev){
  const f = t=>{ const s = toScreen(coverPointAt(t, local)), b = (t - prev)*45; return (s.x-px)*(s.x-px)+(s.y-py)*(s.y-py) + b*b; };
  let best = 0, bd = Infinity;
  const NS = 40;
  for(let i=0;i<=NS;i++){ const t = i/NS*OPEN, d = f(t); if(d < bd){ bd = d; best = t; } }
  let lo = Math.max(0, best - OPEN/NS), hi = Math.min(OPEN, best + OPEN/NS);
  for(let it=0; it<14; it++){
    const m1 = lo + (hi-lo)/3, m2 = hi - (hi-lo)/3;
    if(f(m1) < f(m2)) hi = m2; else lo = m1;
  }
  return (lo+hi)/2;
}

const THRESH = { mouse:6, pen:10, touch:14 };
const pointers = new Map();
let g = null;   // the gesture in progress
let pinch = null;

canvasEl.addEventListener('contextmenu', e=>e.preventDefault());
canvasEl.addEventListener('mousedown', e=>{ if(writing) e.preventDefault(); });
/* the first touch wakes the audio; the forest itself waits until the opening film is over,
   so it never plays under the film's own music */
['pointerdown', 'keydown'].forEach(t=>addEventListener(t, ()=>{ sfx.wake(); Promise.resolve(settled && settled.p).then(()=> sfx.ambience()); }, { once:true, capture:true }));
canvasEl.addEventListener('pointerdown', e=>{
  try{ canvasEl.setPointerCapture(e.pointerId); }catch(_){}
  pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
  if(pointers.size === 2){
    if(g && g.mode === 'turn') endTurn(true);
    if(g && g.mode === 'cover') endCover(true);
    const [a,b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x-b.x, a.y-b.y), z: st.zoom, mx:(a.x+b.x)/2, my:(a.y+b.y)/2, read: onePage() && st.open && st.focusTo > 0.5 };
    g = null;
    return;
  }
  if(pointers.size > 2) return;
  inertia = false; angVel.x = angVel.y = 0;
  orbit.coast = false; orbit.vx = orbit.vy = 0;
  if(spinAnim){ spinAnim = null; spinGoal.copy(spinGrp.quaternion); }
  const hit = e.button === 2 ? null : pickAt(e.clientX, e.clientY);
  g = { id:e.pointerId, sx:e.clientX, sy:e.clientY, px:e.clientX, py:e.clientY, t:performance.now(),
        moved:0, hit, mode:'pending', force: e.button === 2 || e.button === 1, q0: spinGoal.clone(), o0: [orbit.azTo, orbit.elTo],
        slop: THRESH[e.pointerType] || THRESH.mouse };
});
canvasEl.addEventListener('pointermove', e=>{
  const pp = pointers.get(e.pointerId);
  if(pp){ pp.x = e.clientX; pp.y = e.clientY; }
  if(pinch && pointers.size === 2){
    const [a,b] = [...pointers.values()];
    const d = Math.hypot(a.x-b.x, a.y-b.y);
    /* a page read close on a phone is already as near as it comes: spreading the
       fingers over it keeps it, only drawing them together steps back from it */
    if(pinch.read && d >= pinch.d*0.92) return;
    pinch.read = false;
    st.zoom = clamp(pinch.z * pinch.d/Math.max(20,d), 0.3, 3.2);
    const mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
    rotating = true;
    lookAway();
    rotateBy((mx-pinch.mx)*0.006, (my-pinch.my)*0.006);
    pinch.mx = mx; pinch.my = my;
    return;
  }
  if(!g || g.id !== e.pointerId){ hover(e.clientX, e.clientY); return; }
  let dx = e.clientX - g.px, dy = e.clientY - g.py;
  g.px = e.clientX; g.py = e.clientY;
  g.moved += Math.abs(dx) + Math.abs(dy);
  if(g.mode === 'pending'){
    if(Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < g.slop) return;
    const h = g.hit;
    /* a page is turned by sweeping it sideways from anywhere on it, or by its outer
       half in any direction; dragging it up or down, or the open book anywhere else,
       looks round instead of spinning the open book away from the reader */
    const sideways = Math.abs(e.clientX - g.sx) > Math.abs(e.clientY - g.sy)*0.8;
    /* a sweep the other way from the page it starts on (leftward on a left page, as on a
       phone, which shows one page while writing) still turns: the finger cannot hold
       that leaf, so the leaf it means turns over by itself */
    const back = e.clientX > g.sx;
    if(!g.force && h && h.type === 'page' && sideways && (h.side === 'left') !== back){
      g.mode = 'swept';
      pageStep(back ? -1 : 1);
      return;
    }
    /* one page at a time a sideways sweep anywhere goes on through the book, as on a
       phone it always does; only the page under the finger can be held as it turns */
    if(!g.force && onePage() && st.open && sideways && !(h && h.type === 'page')){
      g.mode = 'swept';
      stepPage(back ? -1 : 1);
      return;
    }
    /* reading a page on a phone an up-or-down drag never throws the eye off it: it
       slides the page when the keyboard leaves too little of it, as a page scrolls */
    if(!g.force && onePage() && st.open && st.focusTo > 0.5 && !sideways){
      g.mode = 'scroll'; g.scroll0 = pageScroll;
      return;
    }
    if(!g.force && h && h.type === 'page' && (h.s > PW*0.5 || sideways)) startTurn(h);
    else if(!g.force && h && h.type === 'front' && (st.open ? (h.inner && st.k === 0) : true) && h.outer && !st.flight && !st.riffle) startCover(h);
    else if(!g.force && (!h || st.open)){ g.mode = 'orbit'; lookAway(); dx = e.clientX - g.sx; dy = e.clientY - g.sy; }
    else { g.mode = 'rot'; rotating = true; lookAway(); dx = e.clientX - g.sx; dy = e.clientY - g.sy; }
    document.body.classList.add('grabbing');
  }
  if(g.mode === 'rot'){
    const k = 0.0065;
    rotateBy(dx*k, dy*k);
    const now = performance.now(), dt = clamp((now - (g.lt||now-16))/1000, 0.004, 0.1);
    g.lt = now;
    const a = 1 - Math.exp(-dt*18);
    angVel.x = clamp(lerp(angVel.x, dx*k/dt, a), -9, 9);
    angVel.y = clamp(lerp(angVel.y, dy*k/dt, a), -9, 9);
    return;
  }
  if(g.mode === 'orbit'){
    const k = 0.0052;
    orbit.azTo -= dx*k; orbit.elTo += dy*k;
    const now = performance.now(), dt = clamp((now - (g.lt||now-16))/1000, 0.004, 0.1);
    g.lt = now;
    const a = 1 - Math.exp(-dt*18);
    orbit.vx = clamp(lerp(orbit.vx, -dx*k/dt, a), -6, 6);
    orbit.vy = clamp(lerp(orbit.vy, dy*k/dt, a), -4, 4);
    return;
  }
  if(g.mode === 'turn'){
    const fl = st.flight;
    fl.goal = solveDragP(fl, e.clientX, e.clientY, fl.goal);
    return;
  }
  if(g.mode === 'scroll'){ pageScroll = g.scroll0 - (e.clientY - g.sy)*pagePerPx; return; }
  if(g.mode === 'cover'){
    g.goal = solveCoverTheta(g.local, e.clientX, e.clientY, g.goal);
  }
});
let rotating = false;
/* the eye leaving the page to look round sets the quill down with it: words typed
   then would land on a page no longer in sight */
function lookAway(){
  st.focusTo = 0;
  if(writing) exitWriting();
}
function liftGate(){ return smooth(clamp(st.lift*1.6, 0, 1)); }
function endPointer(e, cancelled){
  pointers.delete(e.pointerId);
  try{ canvasEl.releasePointerCapture(e.pointerId); }catch(_){}
  if(pinch){
    if(pointers.size < 2){
      pinch = null; rotating = false;
      /* drawn in close over the open book, a phone comes down onto its page again */
      if(onePage() && st.open && st.focusTo < 0.5 && st.zoom < 0.8){ st.zoom = 1; st.focusTo = 1; refreshUI(); }
    }
    return;
  }
  if(!g || g.id !== e.pointerId) return;
  const gg = g; g = null;
  rotating = false;
  document.body.classList.remove('grabbing');
  if(gg.mode === 'turn'){ endTurn(cancelled); return; }
  /* a quick press that only slipped a few pixels was meant as a click */
  const tap = !cancelled && performance.now() - gg.t < 350 && gg.moved < 18;
  if(gg.mode === 'cover'){ if(tap && !st.open) click(gg.hit); else endCover(cancelled); return; }
  if((gg.mode === 'rot' || gg.mode === 'orbit') && tap){
    inertia = false; orbit.coast = false; angVel.x = angVel.y = 0; orbit.vx = orbit.vy = 0;
    if(gg.mode === 'rot') spinGoal.copy(gg.q0); else { orbit.azTo = gg.o0[0]; orbit.elTo = gg.o0[1]; }
    click(gg.hit);
    return;
  }
  if(gg.mode === 'rot'){
    if(performance.now() - (gg.lt||0) < 70 && Math.hypot(angVel.x, angVel.y) > 0.25) inertia = true;
    return;
  }
  if(gg.mode === 'orbit'){
    if(performance.now() - (gg.lt||0) < 70 && Math.hypot(orbit.vx, orbit.vy) > 0.2) orbit.coast = true;
    return;
  }
  if(gg.mode === 'swept' || gg.mode === 'scroll') return;
  if(!cancelled) click(gg.hit);
}
canvasEl.addEventListener('pointerup', e=>endPointer(e, false));
canvasEl.addEventListener('pointercancel', e=>endPointer(e, true));
/* trackpad: two-finger swipe looks around, pinch zooms; a mouse wheel zooms */
let padUntil = 0;
function fromTrackpad(e){
  const now = performance.now();
  if(e.deltaMode !== 0) return false;
  if(e.deltaX !== 0 || (e.wheelDeltaY && e.wheelDeltaY === -3*e.deltaY)) padUntil = now + 400;
  return now < padUntil;
}
canvasEl.addEventListener('wheel', e=>{
  e.preventDefault();
  if(e.ctrlKey){
    st.zoom = clamp(st.zoom * Math.exp(e.deltaY*0.01), 0.3, 3.2);
    return;
  }
  if(!fromTrackpad(e)){
    st.zoom = clamp(st.zoom * Math.exp(e.deltaY*0.0012), 0.3, 3.2);
    return;
  }
  if(g && g.mode !== 'pending') return;
  const k = 0.0045;
  orbit.coast = false; orbit.vx = orbit.vy = 0;
  lookAway();
  orbit.azTo += e.deltaX*k;
  orbit.elTo -= e.deltaY*k;
}, { passive:false });
/* Safari reports a trackpad pinch as gesture events, not ctrl+wheel */
let gestureZoom = 1;
addEventListener('gesturestart', e=>{ e.preventDefault(); gestureZoom = st.zoom; });
addEventListener('gesturechange', e=>{ e.preventDefault(); st.zoom = clamp(gestureZoom / Math.max(0.05, e.scale), 0.3, 3.2); });
addEventListener('gestureend', e=>e.preventDefault());

function startTurn(h){
  if(writing){ resumeWriting = true; exitWriting(true); }
  const right = h.side === 'right';
  st.flight = { j: right ? st.k : st.k-1, p: right ? 0 : 1, dragging:true, lead:0, lag:0, sagK:0.35, vel:0,
                gy: clamp(h.y*2-1, -1, 1), sG: clamp(h.s, PW*0.4, PW), yN: clamp(h.y*2-1, -1, 1), anim:null, settle:null };
  st.flight.goal = st.flight.p;
  g.mode = 'turn';
  sfx.page();
}
function endTurn(cancelled){
  const fl = st.flight;
  if(!fl || !fl.dragging) return;
  fl.dragging = false;
  /* held close over one page the finger cannot carry the leaf past the spine, so a
     fifth of the way over is already a turn */
  const from = fl.j < st.k ? 1 : 0, need = onePage() ? 0.2 : 0.5;
  let to = Math.abs(fl.goal - from) > need ? 1 - from : from;
  if(!cancelled){ if(fl.vel > 1.2) to = 1; else if(fl.vel < -1.2) to = 0; }
  else to = fl.j < st.k ? 1 : 0;
  fl.settle = glideFrom(fl.p, fl.vel, to, Math.max(0.32, 0.9*Math.abs(to - fl.p)));
  /* one page at a time the eye goes with the leaf to the page it uncovered */
  if(onePage() && (to === 1) !== (fl.j < st.k)){ st.focusSide = to === 1 ? -1 : 1; st.focusTo = 1; }
  refreshUI();
}
function startCover(h){
  if(writing) exitWriting();
  if(!st.open && st.theta < 1e-3 && !coverAnim){ st.k = homeSpread(); lastSig = ''; }
  g.mode = 'cover';
  g.local = h.local;
  g.goal = st.theta;
  coverAnim = null;
}
function endCover(cancelled){
  let open = st.theta > OPEN*0.5;
  if(!cancelled){ if(st.thetaVel > 2.2) open = true; else if(st.thetaVel < -2.2) open = false; }
  setOpen(open, true);
}

/* turning is done by dragging, so a click on the book, however it was left turned,
   means writing: it swings back square to the reader, closed or open, and the quill
   comes up where it was last written or where the click fell on a page */
const EDGE_TURN = 0.84;
function click(hit){
  if(!hit){ if(writing) exitWriting(); else st.focusTo = 0; return; }
  if(!st.open){ writePose(); return; }
  if(hit.type === 'page' && st.open){
    /* a click by the fore edge of a square book turns the leaf; the title page is only leaned in to */
    if(hit.s > PW*EDGE_TURN && atHome() && !spinAnim){ pageStep(hit.side === 'right' ? 1 : -1); return; }
    if(hit.n === 0){ if(writing) exitWriting(); st.focusSide = 1; st.focusTo = 1; return; }
    const e = pageEntry(hit.n);
    if(!e.lay) paintPage(hit.n);
    const idx = indexAt(e.lay, hit.uv.x*PAGE_W, (1-hit.uv.y)*PAGE_H);
    writePose(hit.n, idx);
    return;
  }
  writePose();
}
/* the title page is never written on: writing starts on the spread after it */
let writeOnOpen = false;
function writePose(n, idx){
  if(st.flight || st.riffle) return;
  if(n === 0) n = idx = undefined;
  if(!st.open){
    /* closed, the two stacks lie exactly alike, so the book can open on any
       spread without a leaf visibly moving: on the page last written on, or
       on its title when it is still empty */
    const h = homePage();
    if(!coverAnim){ st.k = spreadOf(h); lastSig = ''; }
    if(n === undefined && h >= 1 && st.k === spreadOf(h)) n = h;
    setOpen(true);
  }
  const homing = spinAnim && spinAnim.q1.angleTo(qOpenHome) < 1e-4;
  if(!homing && (!atHome() || spinAnim)) glideSpin(qOpenHome, 1.4, st.lift < 0.05);
  st.zoom = 1;
  if(st.k === 0){
    /* the title is shown first; the leaf is turned over once the board is down */
    if(coverAnim){ writeOnOpen = true; return; }
    st.focusSide = -1; st.focusTo = 1;
    resumeWriting = true; flip(1);
    return;
  }
  if(n === undefined) n = onePage() ? shownPage() : nextWritablePage();
  st.focusSide = n % 2 === 0 ? 1 : -1;
  st.focusTo = 1;
  if(writing && writing.n === n){
    quill.focus({preventScroll:true});
    if(idx !== undefined){ quill.setSelectionRange(idx, idx); onSel(); }
  }else enterWriting(n, idx);
}
/* the left page of the spread until it is full, then the right */
function nextWritablePage(){
  const left = 2*st.k - 1, right = 2*st.k;
  if(st.k >= N) return left;
  if(left < 1) return right;
  const room = layoutText(pages[left].t + '\nmm', pageFont(left), textBox(left)).ok;
  return room ? left : right;
}
let hoverRaf = 0, hoverXY = null;
function hover(x, y){
  hoverXY = [x,y];
  if(hoverRaf) return;
  hoverRaf = requestAnimationFrame(()=>{
    hoverRaf = 0;
    if(!hoverXY || g) return;
    const h = pickAt(hoverXY[0], hoverXY[1]);
    const b = document.body.classList;
    b.remove('cur-turn','cur-text','cur-pointer');
    if(!h) return;
    if(h.type === 'page') b.add(h.s > PW*EDGE_TURN ? 'cur-turn' : h.n === 0 ? 'cur-pointer' : 'cur-text');
    else if(!st.open) b.add('cur-pointer');
  });
}

/* ============================================================================
   12. open / close / flip
   ==========================================================================*/
let coverAnim = null;
/* opening: the book rises a hand's breadth, the board is eased off the block,
   rests a moment, then swings over with its weight while warm light and gold
   leave the pages. closing: the board is lifted past upright, hangs, and falls
   shut under its own weight with a thud and a breath of dust */
function coverPath(open){
  const th = st.theta, segs = [];
  if(open){
    if(th < 0.1){
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
  if(!open) writeOnOpen = false;
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
    const from = open ? qClosedHome : qOpenHome, home = spinGrp.quaternion.angleTo(from) < 0.07;
    if(open){ freeFrame(); if(home) glideSpin(qOpenHome, 2.2, st.lift < 0.05); }
    else holdFrame(home ? qClosedHome : null, st.lift < 0.05);
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

/* ============================================================================
   12b. spells: ink that runs on to the next page, pages wiped clean, the book
        turning itself to a page, and the keys that call them
   ==========================================================================*/
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
function spreadOf(n){ return n <= 0 ? 0 : (n % 2 ? (n + 1)/2 : n/2); }
const seek = { goal: null, resume: null, keepQuill: false, flourish: true };
let lastErase = null;

/* golden wisps carrying the words over to the next page */
const WISPS = 96;
const wispGeo = new THREE.BufferGeometry();
const wispPos = new Float32Array(WISPS*3), wispAlpha = new Float32Array(WISPS);
const wispPath = new Float32Array(WISPS*9), wispT = new Float32Array(WISPS), wispDur = new Float32Array(WISPS).fill(1), wispLive = new Uint8Array(WISPS);
wispGeo.setAttribute('position', new THREE.BufferAttribute(wispPos, 3));
wispGeo.setAttribute('alpha', new THREE.BufferAttribute(wispAlpha, 1));
const wispMat = sparkMat.clone();
wispMat.uniforms.uScale = { get value(){ return burstMat.uniforms.uScale.value*4.5; }, set value(v){} };
wispMat.fragmentShader = `varying float vA;
  void main(){ float d = length(gl_PointCoord - 0.5); float core = pow(smoothstep(0.22, 0.0, d), 1.5), halo = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(vec3(1.0, 0.8, 0.45)*(2.6*core + 0.45*halo*halo)*vA, 1.0); }`;
const wisps = new THREE.Points(wispGeo, wispMat);
wisps.frustumCulled = false;
scene.add(wisps);
const trail = particlePool(320, burstMat);
let wispNext = 0, wispsLive = 0;
const _wa = new THREE.Vector3(), _wb = new THREE.Vector3(), _wn = new THREE.Vector3();
function emitWisps(fromN, toN, count){
  const bf = textBox(fromN), bt = toN === null ? null : textBox(toN);
  for(let i=0;i<count;i++){
    const a = pagePointWorld(fromN, lerp(bf.x, bf.x + bf.w, Math.random()), bf.bottom - Math.random()*36*SC);
    _wa.copy(a.p); _wn.copy(a.n);
    if(bt) _wb.copy(pagePointWorld(toN, lerp(bt.x, bt.x + bt.w*0.7, Math.random()), bt.y + Math.random()*28*SC).p);
    else{
      const c = pagePointWorld(fromN, fromN % 2 ? 0 : PAGE_W, PAGE_H*(0.82 + Math.random()*0.16));
      _wb.copy(c.p).addScaledVector(c.n, 0.25);
    }
    const s = wispNext; wispNext = (wispNext + 1) % WISPS;
    const P = wispPath, o = s*9, up = 0.7 + Math.random()*0.6;
    P[o] = _wa.x; P[o+1] = _wa.y; P[o+2] = _wa.z;
    P[o+3] = (_wa.x + _wb.x)/2 + _wn.x*up + (Math.random() - 0.5)*0.5;
    P[o+4] = (_wa.y + _wb.y)/2 + _wn.y*up + 0.35;
    P[o+5] = (_wa.z + _wb.z)/2 + _wn.z*up + (Math.random() - 0.5)*0.5;
    P[o+6] = _wb.x; P[o+7] = _wb.y; P[o+8] = _wb.z;
    wispT[s] = -i*0.011; wispDur[s] = 0.55 + Math.random()*0.25; wispLive[s] = 1;
  }
  wispsLive = 1;
}
function stepWisps(dt){
  trail.step(dt, 1.4, 0.06);
  if(!wispsLive) return;
  let any = 0;
  for(let s=0;s<WISPS;s++){
    if(!wispLive[s]){ wispAlpha[s] = 0; continue; }
    any = 1;
    wispT[s] += dt;
    const k = wispT[s]/wispDur[s];
    if(k < 0){ wispAlpha[s] = 0; continue; }
    if(k >= 1){ wispLive[s] = 0; wispAlpha[s] = 0; continue; }
    const e = easeSine(k), u = 1 - e, o = s*9, P = wispPath;
    for(let c=0;c<3;c++) wispPos[s*3+c] = u*u*P[o+c] + 2*u*e*P[o+3+c] + e*e*P[o+6+c];
    wispPos[s*3+1] += Math.sin(k*8 + s)*0.025;
    wispAlpha[s] = Math.sin(Math.PI*k)*0.9;
    if(Math.random() < dt*9) trail.emit(wispPos[s*3], wispPos[s*3+1], wispPos[s*3+2], (Math.random() - 0.5)*0.08, 0.04, (Math.random() - 0.5)*0.08, 0.45 + Math.random()*0.35, 0.35);
  }
  wispsLive = any;
  wispGeo.attributes.position.needsUpdate = true;
  wispGeo.attributes.alpha.needsUpdate = true;
}

/* ---------------- a full page runs on to the next ---------------- */
/* the lines that no longer fit go over to the next page, pushing what is
   there along, page after page; null when even the last page is full */
function pour(n, v, caret, hv){
  const out = new Map(), hout = new Map(), moves = [];
  let page = n, text = v, hands = hv, cp = n, ci = caret, inc = null;
  const joinSep = (a, b) => a && b && !/\s$/.test(a) && !/^\s/.test(b) ? ' ' : '';
  for(;;){
    const lay = layoutText(text, pageFont(page), page === n ? textBox(page) : { ...textBox(page), flow: true });
    if(lay.ok){ out.set(page, text); hout.set(page, hands); break; }
    const bad = lay.lines.findIndex(ln => ln.y + lay.size*0.3 > lay.box.bottom);
    const cut = lay.lines[bad].start;
    const m = page + 1;
    if(cut <= 0 || m >= 2*N) return null;
    let keep = text.slice(0, cut), kh = hands.slice(0, cut);
    if(keep.endsWith('\n')){ keep = keep.slice(0, -1); kh = kh.slice(0, -1); }
    const moved = text.slice(cut), nextT = pages[m].t;
    const sep = joinSep(moved, nextT);
    out.set(page, keep); hout.set(page, kh);
    if(cp === page){
      if(ci >= cut){ cp = m; ci -= cut; }
      else ci = Math.min(ci, keep.length);
    }
    moves.push({ from: page, to: m, count: moved.length + sep.length });
    inc = { t: moved, h: hands.slice(cut) };
    hands = inc.h.concat(sep ? [inc.h[inc.h.length - 1]] : [], handsOf(m));
    page = m; text = moved + sep + nextT;
  }
  return { out, hout, moves, cp, ci };
}
/* the words arriving on a page write themselves in, one after another */
function applyPour(n, res){
  const now = performance.now();
  const f = pages[n].f || defaultFont;
  res.out.forEach((T, p)=>{
    const pg = pages[p];
    let born;
    if(p === n) born = (pg.born || []).slice(0, T.length);
    else{
      const mv = res.moves.find(m => m.to === p), old = pg.born || [];
      born = Array.from({length: mv.count}, (_, i)=> now + 260 + Math.min(i*11, 480))
        .concat(Array.from({length: pg.t.length}, (_, i)=> old[i] || 0)).slice(0, T.length);
      if(!pg.f) pg.f = f;
      pg.c = true;
    }
    pg.t = T; pg.a = res.hout.get(p); pg.born = born;
    if(pageCache.has(p)){ burning.add(p); paintPage(p, now); }
  });
  if(!pages[n].f) pages[n].f = defaultFont;
  res.moves.forEach(mv=>{
    if(spreadOf(mv.from) !== st.k) return;
    const same = spreadOf(mv.to) === st.k;
    emitWisps(mv.from, same ? mv.to : null, same ? 44 : 26);
  });
  sfx.flow();
  if(res.cp !== n) quillTo(res.cp, res.ci);
  else{
    quill.value = pages[n].t;
    quill.setSelectionRange(res.ci, res.ci);
    lastGood = { v: quill.value, a: res.ci, b: res.ci };
    blinkPhase = 0;
    paintPage(n);
  }
  saveSoon(true);
}
/* the quill moves to page m; on another spread the leaves turn under it */
function quillTo(m, idx){
  if(m < 1 || m >= 2*N) return false;
  if(idx === undefined) idx = pages[m].t.length;
  enterWriting(m, idx);
  st.focusSide = m % 2 ? -1 : 1; st.focusTo = 1;
  const k = spreadOf(m);
  if(k !== st.k || st.flight) seekSpread(k, { keepQuill: true, flourish: false });
  return true;
}

/* ---------------- a page wiped clean, and the ink called back ---------------- */
/* the whole page goes, whoever wrote it; in a shared book the page is kept
   in its history first, so any keeper can bring it back later */
function erasePages(list){
  if(readOnly()){ toast('YOU CAN ONLY READ THIS BOOK', 2200); return; }
  const now = performance.now(), gone = [];
  list.forEach(n=>{
    if(n < 1 || n >= 2*N || !pages[n].t) return;
    const pg = pages[n], hands = handsOf(n);
    const e = pageEntry(n);
    burning.add(n);
    paintPage(n, now);
    addVapor(n, pg.t, e.lay, 0, pg.t.length, Math.min(0.07, 0.9/Math.max(1, e.lay.lines.length)));
    gone.push({ n, t: pg.t, a: hands.slice(), f: pg.f, c: pg.c, left: '' });
    pg.t = ''; pg.a = []; pg.born = null; pg.c = false;
    if(writing && writing.n === n){
      quill.value = ''; quill.setSelectionRange(0, 0);
      lastGood = { v: '', a: 0, b: 0 };
    }
    paintPage(n, now);
  });
  if(!gone.length){ toast('NOTHING TO ERASE', 1800); return; }
  lastErase = { pages: gone, at: now };
  sfx.erase();
  saveSoon(true);
  toast(`ERASED · ${MOD}Z BRINGS IT BACK`, 2800);
}
/* the ink comes back and writes itself in, letter by letter */
function restoreErased(){
  if(readOnly()) return false;
  if(!lastErase || performance.now() - lastErase.at > 60000) return false;
  const back = lastErase.pages.filter(p => pages[p.n].t === p.left);
  lastErase = null;
  if(!back.length) return false;
  const now = performance.now();
  back.forEach(p=>{
    const pg = pages[p.n];
    const step = Math.min(14, 1500/Math.max(1, p.t.length));
    pg.t = p.t; pg.a = p.a; pg.f = p.f; pg.c = p.c; pg.vapor = null;
    let j = 0;
    pg.born = p.a.map(()=> now + 120 + (j++)*step);
    if(writing && writing.n === p.n){
      quill.value = pg.t; quill.setSelectionRange(pg.t.length, pg.t.length);
      lastGood = { v: pg.t, a: pg.t.length, b: pg.t.length };
    }
    if(pageCache.has(p.n)){ burning.add(p.n); paintPage(p.n, now); }
  });
  sfx.shimmer();
  saveSoon(true);
  toast('THE INK RETURNS', 1600);
  return true;
}
/* one page at a time, never the whole book: the page under the quill, else
   the one page of the open spread that has writing on it */
function eraseTargets(){
  if(writing) return [writing.n];
  if(!st.open) return [];
  return [2*st.k - 1, 2*st.k].filter(n => n >= 1 && n < 2*N && pages[n].t);
}
function eraseHere(){
  if(!writing && !st.open){ toast('OPEN THE BOOK FIRST', 1400); return; }
  const list = eraseTargets();
  if(list.length === 2){
    if(list.includes(lastWritten)) return erasePages([lastWritten]);
    toast('CHOOSE THE PAGE IN THE ⋯ MENU', 2000);
    return;
  }
  erasePages(list);
}

/* ---------------- the book turns itself to a page ---------------- */
/* leaves riffle over faster the further there is to go, slowing for the last */
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
    /* closed, the book simply falls open where it is told */
    if(!coverAnim){ st.k = k; lastSig = ''; }
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
    /* gold sparks off the fore edges going over */
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
/* a long way to go: the leaves fan over together, several in the air at once,
   the riffle gathering speed through the middle and easing down for the last
   few, which settle one on another */
const easeRiffle = t => 1 - Math.pow(1 - easeSine(t), 1.4);
const riffleLeaf = (rf, m)=> rf.fwd ? rf.k0 + m : rf.k0 - 1 - m;
function startRiffle(k1){
  if(writing && !seek.keepQuill) exitWriting(true);
  const k0 = st.k, d = Math.abs(k1 - k0);
  st.riffle = { k0, k1, d, fwd: k1 > k0, W: Math.min(3.4, 1.2 + d*0.28), t: 0, dur: 0.9 + 0.42*Math.sqrt(d),
    tau: 0, p: new Float32Array(d).fill(k1 > k0 ? 0 : 1), lead: new Float32Array(d), lag: new Float32Array(d), lifted: 0, landed: 0, tick: 0, shown: k0,
    warm: [2*k1 - 1, 2*k1, 2*k1 - 2, 2*k1 + 1, 2*k1 - 3, 2*k1 - 4, 2*k1 + 2, 2*k1 + 3].filter(n => n >= 0 && n < 2*N && !pageCache.has(n)) };
  sfx.page();
}
function stepRiffle(dt){
  const rf = st.riffle;
  if(!rf) return;
  rf.t += dt; rf.tick -= dt;
  /* the spreads it lands among are painted one a frame on the way, not all at the end */
  if(rf.warm.length) pageEntry(rf.warm.shift());
  const e = easeRiffle(clamp(rf.t/rf.dur, 0, 1));
  rf.tau = e*(rf.d - 1 + rf.W);
  const dir = rf.fwd ? 1 : -1;
  for(let m=0;m<rf.d;m++){
    const u = clamp((rf.tau - m)/rf.W, 0, 1), q = easeSine(u);
    rf.p[m] = rf.fwd ? q : 1 - q;
    /* the fore edge leads while the leaf is lifted, then trails it through the air
       and is still up when the leaf's back is down */
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
    lastSig = '';
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
/* page P as printed in the corner, 1 .. 100 */
function turnToPage(P){
  const n = clamp(Math.round(P) - 1, 0, 2*N - 1);
  const resume = writing && n >= 1 ? { n, idx: pages[n].t.length } : null;
  st.focusSide = sideOf(n);
  if(onePage()) st.focusTo = 1;
  if(writing && spreadOf(n) !== st.k) exitWriting(true);
  seekSpread(spreadOf(n), { resume });
  if(seek.goal === st.k && st.open && !coverAnim && !st.flight && !st.riffle) arrive();
}

/* ---------------- the little windows: a page to turn to, the list of spells ---------------- */
const spellsEl = document.getElementById('spells');
/* the page field in the pager: tap it, type a number, Go */
const seekIn = document.getElementById('pageIn');
function openSeek(first){
  closeSpells(); closeMenu();
  if(!st.open) toggleBook();
  seekIn.value = first || '';
  seekIn.focus({ preventScroll: true });
}
function closeSeek(){
  if(document.activeElement !== seekIn) return;
  if(writing) quill.focus({ preventScroll: true });
  else seekIn.blur();
}
seekIn.addEventListener('focus', ()=>{ seekIn.value = ''; });
seekIn.addEventListener('blur', ()=> refreshUI());
seekIn.addEventListener('input', ()=>{ seekIn.value = seekIn.value.replace(/\D/g, '').slice(0, 3); });
seekIn.addEventListener('keydown', e=>{
  e.stopPropagation();
  if(e.key === 'Escape'){ e.preventDefault(); closeSeek(); }
  else if(e.key === 'Enter'){
    e.preventDefault();
    const P = parseInt(seekIn.value, 10);
    closeSeek();
    if(P >= 1) turnToPage(Math.min(P, 2*N));
  }
});

const SPELLS = [
  ['The book', [
    ['O', 'Open or close the book'],
    ['Enter', 'Lay it open and take up the quill'],
    ['← →', 'Turn a leaf'],
    ['Shift ← →', 'Riffle five leaves'],
    ['Home  End', 'First or last page'],
    ['G  0–9', 'Turn to a page'],
    ['E', 'Erase your writing on the open page'],
  ]],
  ['By hand', [
    ['Swipe', 'Sweep a page sideways to turn it'],
    ['Edge', 'Click by a page\'s outer edge to turn it'],
    ['Click', 'Write where you click on the page'],
    ['Drag', 'Off the pages: look round the glade'],
  ]],
  ['With the quill', [
    [`${MOD}E`, 'Erase your writing on this page'],
    [`${MOD}Z`, 'Undo erase'],
    [`${MOD}G`, 'Turn to a page'],
    [`${MOD}Enter`, 'Carry on at the next page'],
    ['PgUp  PgDn', 'Quill to the page before or after'],
    ['⌫', 'At the start of a page: back to the page before'],
    ['Esc', 'Set the quill down, again to close'],
  ]],
  ['Always', [
    ['M', 'Sound on or off'],
    [`${MOD}S`, 'Save now (it saves itself anyway)'],
    [`${MOD}Shift S`, 'Back up the book to a file'],
    ['?', 'This list'],
  ]],
];
(()=>{
  const card = spellsEl.querySelector('.card');
  SPELLS.forEach(([title, rows])=>{
    const h = document.createElement('h3'); h.textContent = title; card.appendChild(h);
    rows.forEach(([k, what])=>{
      const r = document.createElement('div'); r.className = 'row';
      const d = document.createElement('span'); d.textContent = what;
      const kk = document.createElement('span'); kk.className = 'keys';
      k.split('  ').forEach(part=>{ const kb = document.createElement('kbd'); kb.textContent = part; kk.appendChild(kb); });
      r.append(d, kk); card.appendChild(r);
    });
  });
  const foot = document.createElement('p'); foot.className = 'foot';
  foot.textContent = 'When a page is full, the words run on to the next page by themselves';
  card.appendChild(foot);
  const foot2 = document.createElement('p'); foot2.className = 'foot';
  foot2.textContent = 'In a shared book anyone can erase or change any page. Each page keeps its history in the ⋯ menu, so whatever was erased can be brought back';
  card.appendChild(foot2);
})();
function openSpells(){ closeSeek(); closeMenu(); spellsEl.hidden = false; if(writing) quill.blur(); }
function closeSpells(){
  if(spellsEl.hidden) return;
  spellsEl.hidden = true;
  if(writing) quill.focus({ preventScroll: true });
}
spellsEl.addEventListener('pointerdown', e=>{ if(e.target === spellsEl) closeSpells(); });
spellsEl.querySelector('.close').addEventListener('click', closeSpells);

/* ============================================================================
   13. UI
   ==========================================================================*/
const pagerEl = document.getElementById('pager');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnWrite = document.getElementById('btnWrite');
const btnBook = document.getElementById('btnBook');
btnPrev.addEventListener('click', ()=> pageStep(-1));
btnNext.addEventListener('click', ()=> pageStep(1));
btnWrite.addEventListener('click', ()=> writing ? exitWriting() : writePose());
btnBook.addEventListener('click', ()=> toggleBook());

/* everything that otherwise lives on a key, for a phone */
const btnMore = document.getElementById('btnMore');
const menuEl = document.getElementById('menu');
const menuBtn = act => menuEl.querySelector(`[data-act="${act}"]`);
/* one erase line per page of the open spread that has writing on it */
const eraseLabel = n => `Erase page ${n + 1}`;
/* the pages whose history the menu opens: the one under the quill, else the open spread */
const historyPages = ()=> writing ? [writing.n] : st.open ? [2*st.k - 1, 2*st.k].filter(n => n >= 1 && n < 2*N) : [];
function menuView(name){
  menuEl.querySelectorAll('.view').forEach(v=>{ v.hidden = v.dataset.view !== name; });
}
function openMenu(){
  closeSpells();
  menuView('main');
  const share = menuBtn('share');
  share.hidden = !sharingOn;
  share.querySelector('span').textContent = shelf ? shelf.note() : 'Send the book to a friend';
  const list = readOnly() ? [] : eraseTargets();
  [menuBtn('erase'), menuBtn('erase2')].forEach((b, i)=>{
    const n = list[i];
    b.hidden = n === undefined;
    b.dataset.page = n === undefined ? '' : n;
    if(n !== undefined) b.textContent = eraseLabel(n);
  });
  menuBtn('restore').hidden = readOnly() || !lastErase || performance.now() - lastErase.at > 60000;
  menuBtn('history').hidden = !shelf || !shelf.shared() || !historyPages().length;
  menuBtn('files').querySelector('span').textContent = !shelf || shelf.kept() ? 'Download or restore the book' : 'Back it up to keep it safe';
  menuEl.querySelector('.menu-note').textContent = shelf ? shelf.status() : 'Saves automatically';
  menuEl.hidden = false;
  btnMore.setAttribute('aria-expanded', 'true');
}
function replayOpening(){
  const u = new URL(location.href);
  u.searchParams.set('intro', '');
  location.href = u;
}
function closeMenu(){
  if(menuEl.hidden) return;
  menuEl.hidden = true;
  btnMore.setAttribute('aria-expanded', 'false');
}
btnMore.addEventListener('click', ()=> menuEl.hidden ? openMenu() : closeMenu());
menuEl.addEventListener('click', e=>{
  const b = e.target.closest('button[data-act]');
  if(!b || b.disabled) return;
  if(b.dataset.act === 'files' || b.dataset.act === 'main'){
    menuView(b.dataset.act);
    menuEl.querySelector(`.view:not([hidden]) button:not([hidden])`).focus();
    return;
  }
  closeMenu();
  const page = ()=> erasePages([+b.dataset.page]);
  ({ erase: page, erase2: page, restore: restoreErased, exportText, saveCopy: ()=> saveCopy(false), openCopy: ()=> copyPicker.click(), replay: replayOpening, spells: openSpells, share: ()=> shelf && shelf.open(), history: ()=> shelf && shelf.history(historyPages()) })[b.dataset.act]();
});
addEventListener('pointerdown', e=>{
  if(!menuEl.hidden && !menuEl.contains(e.target) && !btnMore.contains(e.target)) closeMenu();
}, true);
[btnPrev, btnNext, btnWrite, btnBook, btnMore, ...menuEl.querySelectorAll('button')].forEach(b=>b.addEventListener('mousedown', e=>e.preventDefault()));

const spreadLabel = c => c === 0 ? '1' : c === N ? `${2*N}` : `${2*c}–${2*c+1}`;
const btnSound = document.getElementById('btnSound');
function showSound(){
  btnSound.classList.toggle('muted', sfx.muted);
  btnSound.setAttribute('aria-pressed', String(!sfx.muted));
  btnSound.title = sfx.muted ? 'Sound off (M)' : 'Sound on (M)';
}
function toggleSound(){
  sfx.setMuted(!sfx.muted); showSound();
  toast(sfx.muted ? 'SOUND OFF' : 'SOUND ON', 1000);
}
btnSound.addEventListener('mousedown', e=>e.preventDefault());
btnSound.addEventListener('click', toggleSound);
showSound();

function refreshUI(){
  pagerEl.hidden = !st.open;
  const one = onePage(), n = one ? shownPage() : 0;
  btnPrev.disabled = one ? n === 0 : st.k === 0;
  btnNext.disabled = one ? n === 2*N - 1 : st.k === N;
  btnWrite.classList.toggle('on', !!writing);
  document.body.classList.toggle('quill-up', !!writing);
  btnBook.classList.toggle('open', st.open);
  const bookAct = st.open ? 'Close the book' : 'Open the book';
  btnBook.title = `${bookAct} (O)`;
  btnBook.setAttribute('aria-label', bookAct);
  if(document.activeElement !== seekIn) seekIn.value = one ? `${n + 1}` : spreadLabel(st.k);
  btnWrite.title = writing ? 'Set the quill down' : readOnly() ? 'You can only read this book' : 'Lay the book open and write';
}

/* keys instead of buttons, read by position so a Cyrillic layout works the
   same; SPELLS lists them */
function toggleBook(){
  if(!st.open){ seekSpread(homeSpread(), { flourish: false }); return; }
  if(!st.flight && !st.riffle) setOpen(false);
}
document.addEventListener('keydown', e=>{
  if(e.target === quill || e.target === seekIn) return;
  if(shelf && shelf.isOpen()){ if(e.key === 'Escape'){ e.preventDefault(); shelf.close(); } return; }
  const mod = e.metaKey || e.ctrlKey, code = e.code;
  if(!menuEl.hidden && e.key === 'Escape'){ e.preventDefault(); closeMenu(); return; }
  if(!spellsEl.hidden){
    if(e.key === 'Escape' || e.key === '?' || code === 'Slash'){ e.preventDefault(); closeSpells(); }
    return;
  }
  if(e.key === '?' || (mod && code === 'Slash')){ e.preventDefault(); openSpells(); }
  else if(e.key === 'ArrowRight' || e.key === 'PageDown'){
    e.preventDefault();
    if(!st.open) seekSpread(homeSpread(), { flourish: false });
    else if(e.shiftKey) seekSpread(st.k + 5);
    else pageStep(1);
  }
  else if(e.key === 'ArrowLeft' || e.key === 'PageUp'){
    e.preventDefault();
    if(st.open) e.shiftKey ? seekSpread(st.k - 5) : pageStep(-1);
  }
  else if(e.key === 'Home'){ e.preventDefault(); seekSpread(0); }
  else if(e.key === 'End'){ e.preventDefault(); seekSpread(N); }
  else if(e.key === 'Escape'){ if(st.open && !st.flight && !st.riffle) setOpen(false); }
  else if(e.key === 'Enter' && !mod){ e.preventDefault(); writePose(); }
  else if(mod && code === 'KeyZ' && !e.shiftKey){ if(restoreErased()) e.preventDefault(); }
  else if(code === 'KeyG' && !e.altKey){ e.preventDefault(); openSeek(); }
  else if(/^(Digit|Numpad)[0-9]$/.test(code) && !mod && !e.altKey && !e.shiftKey){ e.preventDefault(); openSeek(code.slice(-1)); }
  else if(code === 'KeyE' && !e.altKey && !e.shiftKey){ e.preventDefault(); eraseHere(); }
  else if(code === 'KeyO' && !mod && !e.altKey){ e.preventDefault(); toggleBook(); }
  else if(code === 'KeyM' && !mod){ toggleSound(); }
  else if(mod && code === 'KeyS'){
    e.preventDefault();
    if(e.shiftKey) exportFile(); else saveNow();
  }
});
addEventListener('beforeunload', ()=>saveNow(true));
addEventListener('pagehide', ()=>{ saveNow(true); if(shelf) shelf.flush(); });
document.addEventListener('visibilitychange', ()=>{ if(document.hidden){ saveNow(true); if(shelf) shelf.flush(); } });
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) saveNow(true); });

/* ============================================================================
   14. assets: scans + Blender models
   ==========================================================================*/
/* a busy local server now and then drops a connection: try again before giving up */
const loadImage = (src, tries = 3) => new Promise((res, rej)=>{
  const i = new Image();
  i.onload = ()=>res(i);
  i.onerror = ()=>{
    if(tries > 1) setTimeout(()=>loadImage(src, tries - 1).then(res, rej), 400);
    else rej(new Error('Could not load ' + src + ' (open the book through the local server, not as a file)'));
  };
  i.src = src;
});
/* a picture that never changes once it is on the GPU: a phone lets go of its own copy
   (image, canvas or data) right after the upload. iOS counts every byte of a tab, and
   the forest, the boards and the rock held twice took Safari past its limit */
function shed(t){
  if(HI_RES || !t || t.userData.shed) return t;
  t.userData.shed = true;
  const after = t.onUpdate;
  t.onUpdate = ()=>{
    t.onUpdate = after;
    if(after) after(t);
    const im = t.source.data;
    if(im instanceof HTMLCanvasElement){ im.width = im.height = 0; }
    else if(im && im.close) im.close();
    t.source.data = null;
  };
  return t;
}
/* the same for any other load: run it again, a little later each time, before giving up */
async function retry(load, tries = 3){
  for(let k = 1; ; k++){
    try{ return await load(); }
    catch(e){
      if(k >= tries) throw e;
      await new Promise(r=>setTimeout(r, 300*k + Math.random()*200));
    }
  }
}
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/draco/gltf/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
const firstMesh = gltf => { let m = null; gltf.scene.traverse(o=>{ if(!m && o.isMesh) m = o; }); return m; };

/* navy-dyed leather from the scan's luminance, so the grain and creases survive */
function dyeLeather(img, size, pal){
  const c = cv(size, size), x = c.getContext('2d');
  x.drawImage(img, 0, 0, size, size);
  const d = x.getImageData(0, 0, size, size), p = d.data;
  const hist = new Uint32Array(256);
  for(let i=0;i<p.length;i+=4) hist[(p[i]*0.3 + p[i+1]*0.59 + p[i+2]*0.11)|0]++;
  const pct = q=>{ let acc = 0, tot = p.length/4; for(let i=0;i<256;i++){ acc += hist[i]; if(acc >= tot*q) return i/255; } return 1; };
  const lo = pct(0.02), hi = pct(0.98);
  const [D, Mv, Hl] = pal || [[3, 8, 14], [12, 30, 54], [50, 80, 108]];
  for(let i=0;i<p.length;i+=4){
    const l = clamp(((p[i]*0.3 + p[i+1]*0.59 + p[i+2]*0.11)/255 - lo)/((hi-lo)||1), 0, 1);
    const t = Math.pow(l, 1.15);
    for(let k=0;k<3;k++) p[i+k] = t < 0.7 ? lerp(D[k], Mv[k], t/0.7) : lerp(Mv[k], Hl[k], (t-0.7)/0.3);
  }
  x.putImageData(d, 0, 0);
  return c;
}
function tiled(src, W, H, tile){
  const c = cv(W, H), x = c.getContext('2d');
  for(let y=0;y<H;y+=tile) for(let xx=0;xx<W;xx+=tile) x.drawImage(src, xx, y, tile, tile);
  return c;
}
/* one board's maps: tiled grain, worn edges, and the leather pressed down and
   darkened where the tool bit around the gilt */
function composeBoard(dyed, norImg, roughImg, mask, flipY){
  const W = 1024, H = Math.round(W*CH/CW), tile = 560;
  const col = tiled(dyed, W, H, tile);
  const nor = tiled(norImg, W, H, tile);
  const rgh = tiled(roughImg, W, H, tile);
  const mk = (blur)=>{
    const c = cv(W, H), x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0,0,W,H);
    if(blur) x.filter = `blur(${blur}px)`;
    if(flipY){ x.translate(0, H); x.scale(1, -1); }
    x.drawImage(mask, 0, 0, W, H);
    return x.getImageData(0,0,W,H).data;
  };
  const sharp = mk(0), wide = mk(5), tight = mk(1.5);
  const cd = col.getContext('2d').getImageData(0,0,W,H), cp = cd.data;
  const nd = nor.getContext('2d').getImageData(0,0,W,H), np = nd.data;
  const rd = rgh.getContext('2d').getImageData(0,0,W,H), rp = rd.data;
  const wear = upsample(fbm(W>>3, H>>3, 3, 4, 3, 77), W>>3, H>>3, W, H);
  const crk = fieldFromCanvas(crackCanvas(W, H, flipY ? 4111 : 2024, 1.15));
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i = y*W + x, p = i*4;
      const pressed = wide[p]/255, s = sharp[p]/255;
      const ex = Math.min(x, W-1-x)/W, ey = Math.min(y, H-1-y)/H;
      const edge = 1 - smooth(clamp(Math.min(ex, ey)/0.06, 0, 1));
      const rub = clamp((wear[i]-0.48)*2.2, 0, 1)*0.6 + edge*0.65;
      for(let k=0;k<3;k++){
        let v = cp[p+k]*(1 - pressed*0.45)*(1 - Math.min(1, crk[i]*1.6)*0.72);
        v = lerp(v, v*1.55 + 10, rub*0.6);
        v = lerp(v, [120, 86, 34][k], s*0.35);
        cp[p+k] = clamp(v, 0, 255);
      }
      /* emboss: the tooled groove around each line of gilt */
      const xm = Math.max(0,x-1), xp = Math.min(W-1,x+1), ym = Math.max(0,y-1), yp = Math.min(H-1,y+1);
      const dx = (tight[(y*W+xp)*4] - tight[(y*W+xm)*4])/255;
      const dy = (tight[(yp*W+x)*4] - tight[(ym*W+x)*4])/255;
      const cdx = (crk[y*W+xp] - crk[y*W+xm]), cdy = (crk[yp*W+x] - crk[ym*W+x]);
      let nx = (np[p]/255*2-1) + dx*1.6 + cdx*1.1, ny = (np[p+1]/255*2-1) - dy*1.6 - cdy*1.1, nz = np[p+2]/255*2-1;
      const l = Math.hypot(nx, ny, nz) || 1;
      np[p] = (nx/l*0.5+0.5)*255; np[p+1] = (ny/l*0.5+0.5)*255; np[p+2] = (nz/l*0.5+0.5)*255;
      rp[p] = rp[p+1] = rp[p+2] = clamp(100 + rp[p]*0.55 - pressed*30 - rub*20 + Math.min(1, crk[i]*1.6)*40, 40, 240);
    }
  }
  col.getContext('2d').putImageData(cd, 0, 0);
  nor.getContext('2d').putImageData(nd, 0, 0);
  rgh.getContext('2d').putImageData(rd, 0, 0);
  return { col, nor, rgh };
}
function setBoardMaps(mat, maps){
  const map = shed(tex(maps.col, {srgb:true, wrap:false}));
  const nrm = shed(tex(maps.nor, {wrap:false}));
  const rgh = shed(tex(maps.rgh, {wrap:false}));
  [map, nrm, rgh].forEach(t=>{ t.repeat.set(1/CW, 1/CH); t.offset.set(0, 0.5); });
  mat.map = map; mat.normalMap = nrm; mat.roughnessMap = rgh;
  mat.color.set(0xffffff); mat.roughness = 1;
  mat.needsUpdate = true;
}
/* gilt tooling of the doublure, drawn in book units from the panel's top left */
/* an open-work leaf: outline, midrib and a few side veins, the way a tooled
   leaf reads in gold, instead of a solid blot */
function laceLeaf(g, x, y, ang, L, W, lw){
  g.save(); g.translate(x, y); g.rotate(ang);
  g.lineWidth = lw;
  g.beginPath(); g.moveTo(0, 0);
  g.bezierCurveTo(W, -L*0.3, W*0.7, -L*0.75, 0, -L);
  g.bezierCurveTo(-W*0.7, -L*0.75, -W, -L*0.3, 0, 0);
  g.stroke();
  g.lineWidth = lw*0.7;
  g.beginPath(); g.moveTo(0, -L*0.05); g.lineTo(0, -L*0.85);
  for(const t of [0.3, 0.5, 0.68]){ const yy = -L*t, ww = W*0.55*(1 - t*0.6); g.moveTo(0, yy); g.lineTo(ww, yy - L*0.12); g.moveTo(0, yy); g.lineTo(-ww, yy - L*0.12); }
  g.stroke();
  g.restore();
}
function doublureGilt(g, w, h){
  const rule = (i, lw)=>{ g.lineWidth = lw; g.strokeRect(i, i, w - 2*i, h - 2*i); };
  rule(0.055, 0.013); rule(0.08, 0.005);
  const dots = (i, step, r)=>{
    const run = (ax, ay, bx, by)=>{ const L = Math.hypot(bx-ax, by-ay), n = Math.round(L/step);
      for(let k=0;k<=n;k++){ g.beginPath(); g.arc(ax + (bx-ax)*k/n, ay + (by-ay)*k/n, r, 0, 7); g.fill(); } };
    run(i, i, w-i, i); run(i, h-i, w-i, h-i); run(i, i, i, h-i); run(w-i, i, w-i, h-i);
  };
  dots(0.108, 0.034, 0.0065);
  rule(0.14, 0.005); rule(0.163, 0.012);
  const ci = 0.163;
  /* a filigree corner piece: two scrolled arms running along the panel's edges,
     each budding small leaves and tendrils, an acanthus spray on the diagonal */
  const corner = (x, y, sx, sy)=>{
    g.save(); g.translate(x, y); g.scale(sx, sy); g.scale(1.9, 1.9);
    const lozenge = (cx, cy, r)=>{ g.beginPath(); g.moveTo(cx, cy-r); g.lineTo(cx+r, cy); g.lineTo(cx, cy+r); g.lineTo(cx-r, cy); g.closePath(); g.fill(); };
    const bead = (cx, cy, r)=>{ g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); };
    lozenge(0.03, 0.03, 0.02);
    for(const sw of [false, true]){
      const P = (px, py)=> sw ? [py, px] : [px, py];
      const bz = (a, b, c, d, lw)=>{ g.lineWidth = lw; g.beginPath(); g.moveTo(...P(...a)); g.bezierCurveTo(...P(...b), ...P(...c), ...P(...d)); g.stroke(); };
      const sp = (cx, cy, r0, r1, a0, turns, cw, lw)=>{ g.lineWidth = lw; const [X, Y] = P(cx, cy); g.beginPath(); spiralPath(g, X, Y, r0, r1, sw ? Math.PI/2 - a0 : a0, turns, sw ? -cw : cw); g.stroke(); };
      const leaf = (px, py, ang, L, Wd)=>{ const [X, Y] = P(px, py); laceLeaf(g, X, Y, sw ? Math.PI/2 - ang + Math.PI : ang, L, Wd, 0.0028); };
      /* the long arm with its end scroll */
      bz([0.05, 0.026], [0.14, 0.004], [0.26, 0.05], [0.36, 0.034], 0.0062);
      sp(0.385, 0.058, 0.026, 0.003, -Math.PI*0.6, 1.4, 1, 0.0052);
      /* a second, inner arm curling back toward the corner */
      bz([0.08, 0.05], [0.16, 0.05], [0.21, 0.09], [0.18, 0.13], 0.005);
      sp(0.158, 0.118, 0.02, 0.003, -Math.PI*0.05, 1.3, 1, 0.0042);
      /* tendrils off the long arm */
      bz([0.2, 0.031], [0.22, 0.055], [0.25, 0.075], [0.235, 0.092], 0.0036);
      sp(0.222, 0.085, 0.013, 0.002, 0.2, 1.2, -1, 0.0032);
      bz([0.3, 0.04], [0.31, 0.012], [0.33, 0.004], [0.345, 0.008], 0.0032);
      /* small leaves budding along the arms */
      leaf(0.12, 0.016, Math.PI*0.62, 0.05, 0.015);
      leaf(0.27, 0.046, Math.PI*0.42, 0.045, 0.013);
      leaf(0.33, 0.036, Math.PI*0.85, 0.04, 0.012);
      leaf(0.19, 0.075, Math.PI*0.95, 0.045, 0.013);
      [[0.43, 0.026, 0.0065], [0.405, 0.012, 0.004], [0.29, 0.1, 0.005], [0.245, 0.012, 0.004], [0.11, 0.095, 0.0045]].forEach(([px, py, r])=>bead(...P(px, py), r));
    }
    /* acanthus spray on the diagonal */
    laceLeaf(g, 0.05, 0.05, Math.PI*0.75, 0.17, 0.036, 0.0032);
    laceLeaf(g, 0.062, 0.062, Math.PI*0.75 - 0.66, 0.105, 0.024, 0.0028);
    laceLeaf(g, 0.062, 0.062, Math.PI*0.75 + 0.66, 0.105, 0.024, 0.0028);
    g.lineWidth = 0.004;
    [-1, 1].forEach(d=>{ g.beginPath(); spiralPath(g, d > 0 ? 0.2 : 0.13, d > 0 ? 0.13 : 0.2, 0.014, 0.002, d > 0 ? Math.PI*0.25 : Math.PI*1.25, 1.1, d); g.stroke(); });
    bead(0.205, 0.205, 0.008); bead(0.235, 0.235, 0.005);
    g.restore();
  };
  corner(ci, ci, 1, 1); corner(w-ci, ci, -1, 1); corner(ci, h-ci, 1, -1); corner(w-ci, h-ci, -1, -1);
  /* small fleurons at the middle of each side of the panel */
  const mid = (x, y, a)=>{
    g.save(); g.translate(x, y); g.rotate(a);
    laceLeaf(g, 0, 0.012, Math.PI, 0.13, 0.032, 0.0034);
    laceLeaf(g, 0, 0.012, Math.PI - 0.75, 0.085, 0.022, 0.003);
    laceLeaf(g, 0, 0.012, Math.PI + 0.75, 0.085, 0.022, 0.003);
    g.lineWidth = 0.0055;
    [-1, 1].forEach(d=>{ g.beginPath(); spiralPath(g, d*0.05, 0.03, 0.022, 0.003, d > 0 ? Math.PI : 0, 1.15, d); g.stroke(); });
    g.restore();
  };
  mid(w/2, ci, 0); mid(w/2, h-ci, Math.PI); mid(ci, h/2, -Math.PI/2); mid(w-ci, h/2, Math.PI/2);
}
function buildDoublure(img){
  const SWU = EP_X1 - EP_X0 + EP_HINGE;
  const W = 1280, H = Math.round(W*EP_H/SWU), ppu = W/SWU, x0 = HINGE_U*W;
  const tile = Math.round(ppu*1.6);
  const dyed = dyeLeather(img.leaAlbedo, 1024, [[8, 5, 3], [30, 20, 13], [84, 60, 40]]);
  const col = tiled(dyed, W, H, tile), nor = tiled(img.leaNor, W, H, tile), rgh = tiled(img.leaRough, W, H, tile);
  const mask = cv(W, H), g = mask.getContext('2d');
  g.translate(x0, 0); g.scale(ppu, ppu);
  g.fillStyle = g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
  doublureGilt(g, EP_X1 - EP_X0, EP_H);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const blurOf = px=>{ const c = cv(W, H), x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.filter = `blur(${px}px)`; x.drawImage(mask, 0, 0); return x.getImageData(0, 0, W, H).data; };
  const sharp = blurOf(0), tight = blurOf(1.4), wide = blurOf(4);
  const wear = fbm(W>>1, H>>1, 40, 50, 3, 3131);
  const cd = col.getContext('2d').getImageData(0, 0, W, H), cp = cd.data;
  const nd = nor.getContext('2d').getImageData(0, 0, W, H), np = nd.data;
  const rd = rgh.getContext('2d').getImageData(0, 0, W, H), rp = rd.data;
  const pbr = cv(W, H), pc = pbr.getContext('2d'), pd = pc.createImageData(W, H), pp = pd.data;
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const i = y*W + x, p = i*4;
    const wv = wear[((y>>1)*(W>>1)) + (x>>1)];
    const gm = sharp[p]/255*(wv > 0.74 ? 0.6 : 1), burn = wide[p]/255;
    const lum = 0.86 + (wv - 0.5)*0.3;
    const gold = [214*lum, 168*lum, 82*lum];
    for(let k=0;k<3;k++){
      const leather = cp[p+k]*(1 - burn*0.35);
      cp[p+k] = clamp(lerp(leather, gold[k], gm), 0, 255);
    }
    const xm = Math.max(0, x-1), xp = Math.min(W-1, x+1), ym = Math.max(0, y-1), yp = Math.min(H-1, y+1);
    const dx = (tight[(y*W+xp)*4] - tight[(y*W+xm)*4])/255, dy = (tight[(yp*W+x)*4] - tight[(ym*W+x)*4])/255;
    let nx = (np[p]/255*2-1)*(1 - gm*0.8) + dx*1.4, ny = (np[p+1]/255*2-1)*(1 - gm*0.8) - dy*1.4, nz = np[p+2]/255*2-1;
    const l = Math.hypot(nx, ny, nz) || 1;
    np[p] = (nx/l*0.5+0.5)*255; np[p+1] = (ny/l*0.5+0.5)*255; np[p+2] = (nz/l*0.5+0.5)*255;
    pp[p] = 0; pp[p+1] = lerp(clamp(90 + rp[p]*0.55, 60, 220), 70, gm); pp[p+2] = gm*255; pp[p+3] = 255;
  }
  col.getContext('2d').putImageData(cd, 0, 0);
  nor.getContext('2d').putImageData(nd, 0, 0);
  pc.putImageData(pd, 0, 0);
  const pbrTex = shed(tex(pbr, { wrap:false }));
  matEndpaper.map = shed(tex(col, { srgb:true, wrap:false }));
  matEndpaper.normalMap = shed(tex(nor, { wrap:false }));
  matEndpaper.normalScale.set(0.8, 0.8);
  matEndpaper.roughnessMap = pbrTex; matEndpaper.metalnessMap = pbrTex;
  matEndpaper.color.set(0xffffff); matEndpaper.roughness = 1; matEndpaper.metalness = 1;
  matEndpaper.envMapIntensity = 1.0;
  matEndpaper.needsUpdate = true;
}
function applyLeather(img){
  const dyed = dyeLeather(img.leaAlbedo, 1024);
  setBoardMaps(matCoverFront, composeBoard(dyed, img.leaNor, img.leaRough, img.maskFront, false));
  setBoardMaps(matCoverBack,  composeBoard(dyed, img.leaNor, img.leaRough, img.maskBack, true));
  const tileMap = t=>{ t.repeat.set(2.4, 2.4); return t; };
  matLeatherEdge.map = tileMap(shed(tex(dyed, {srgb:true})));
  matLeatherEdge.normalMap = tileMap(shed(tex(img.leaNor)));
  matLeatherEdge.roughnessMap = tileMap(shed(tex(img.leaRough)));
  matLeatherEdge.color.set(0xffffff); matLeatherEdge.roughness = 1;
  matLeatherEdge.needsUpdate = true;
  paintSpine(dyed, img.leaNor, img.leaRough);
  buildDoublure(img);
}

/* the boulder: moss and stone from the scan, mapped triplanar (it has no UVs) */
/* the boulder: weathered granite under a thick cushion of moss that lies on its
   crown and runs down its flanks in tongues, as in the reference. Both stones are
   painted textures laid on triplanar (the rock has no UVs); the moss is given
   depth by shells of strands standing off the surface */
const MOSS_GLSL = `
  float h31(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x + p.y + p.z)); }
  float vn3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0 - 2.0*f);
    return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }
  float mossMask(vec3 p, vec3 n){
    float up = smoothstep(-0.05, 0.75, n.y);
    float big = vn3(p*0.32) + 0.5*vn3(p*0.75 + 11.0);
    float drip = vn3(vec3(p.x*1.1, p.y*0.22, p.z*1.1) + 4.0);
    float high = smoothstep(-4.5, 0.0, p.y);
    /* ragged edges: moss creeps over the stone in clumps, not in clean blots */
    float rag = (vn3(p*2.6 + 3.0) - 0.5)*0.35 + (vn3(p*7.5) - 0.5)*0.22 + (vn3(p*19.0) - 0.5)*0.12;
    float m = up*0.5 + (big - 0.75)*1.0 + (drip - 0.5)*0.8*(1.0 - up) + high*0.12 - 0.2 + rag;
    return smoothstep(0.1, 0.46, m);
  }
  /* cushions: yellow-green where they swell into the light, deep olive between them,
     and here and there a patch gone brown and dry */
  vec3 mossTone(vec3 c, vec3 p){
    c = mix(c, dot(c, vec3(0.3, 0.59, 0.11))*vec3(1.06, 1.0, 0.6), 0.3)*1.2;
    float cush = vn3(p*3.2 + 9.0), hue = vn3(p*0.55 + 2.0), dry = smoothstep(0.66, 0.8, vn3(p*1.1 + 20.0));
    c *= mix(vec3(0.74, 0.82, 0.64), vec3(1.25, 1.2, 0.95), hue);
    c = mix(c, dot(c, vec3(0.3, 0.59, 0.11))*vec3(1.25, 0.95, 0.55), dry*0.55);
    return c*mix(0.7, 1.15, cush)*(0.62 + 0.25*vn3(p*0.9));
  }
  vec3 stoneN(vec3 a, vec3 b){ a = a*2.0 - 1.0; b = b*2.0 - 1.0;
    return normalize(vec3(a.xy + b.xy*0.6, a.z*b.z))*0.5 + 0.5; }
  vec3 triW(vec3 n){ vec3 b = pow(abs(n), vec3(5.0)); return b/(b.x + b.y + b.z); }
  vec4 tri(sampler2D t, vec3 p, vec3 w){ return texture2D(t, p.zy)*w.x + texture2D(t, p.xz)*w.y + texture2D(t, p.xy)*w.z; }
`;
/* moss lets the low sun through: lit from behind, its tips glow */
const MOSS_LIT = amt => `
  #if NUM_DIR_LIGHTS > 0
  { vec3 Vd = normalize(vWp - cameraPosition);
    float wrapL = smoothstep(-0.35, 0.5, dot(Nw, uSunDir));
    float fwd = pow(max(dot(Vd, uSunDir), 0.0), 3.0);
    reflectedLight.directDiffuse += directLight.color*diffuseColor.rgb*vec3(1.0, 0.96, 0.55)*(${amt})*wrapL*(0.12 + 0.9*fwd); }
  #endif
  { /* the canopy between: the sun comes through in drifting patches, as on the forest floor */
    vec3 sq = vWp - uSunDir*dot(vWp, uSunDir);
    vec3 dq = vec3(sq.x*0.42 + uTime*0.035, sq.y*0.42 + sq.z*0.3, uTime*0.06);
    float leafy = vn3(dq) *0.6 + vn3(dq*2.7 + 3.0)*0.4;
    float dap = mix(0.3, 1.15, smoothstep(0.38, 0.62, leafy));
    reflectedLight.directDiffuse *= dap; reflectedLight.directSpecular *= dap; }
  #include <lights_fragment_end>`;
function rockTex(im, srgb){
  const x = new THREE.Texture(im);
  x.wrapS = x.wrapT = THREE.RepeatWrapping;
  x.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  x.anisotropy = 8; x.needsUpdate = true;
  return shed(x);
}
/* a tangent-space normal map from the painted stone's own light and shade */
function heightNormal(im, strength){
  const S = 1024, c = cv(S, S), x = c.getContext('2d');
  x.drawImage(im, 0, 0, S, S);
  const d = x.getImageData(0, 0, S, S).data, hf = new Float32Array(S*S);
  for(let i=0;i<S*S;i++) hf[i] = (d[i*4]*0.3 + d[i*4+1]*0.59 + d[i*4+2]*0.11)/255;
  return rockTex(normalFromHeight(hf, S, S, strength), false);
}
const rockTime = { value: 0 };
function rockMaterial(img){
  const u = {
    tGranite: { value: rockTex(img.granite, true) }, tGraniteN: { value: heightNormal(img.granite, 1.4) },
    tStone: { value: rockTex(img.stone, true) }, tStoneN: { value: rockTex(img.stoneNor, false) }, sScale: { value: 0.085 },
    tMoss: { value: rockTex(img.moss, true) }, tMossN: { value: heightNormal(img.moss, 3.0) },
    gScale: { value: 0.3 }, mScale: { value: 0.7 }, uSunDir: { value: SUN_DIR }, uTime: rockTime
  };
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 1.3 });
  m.onBeforeCompile = sh=>{
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec3 vWp; varying vec3 vWn;\n' + sh.vertexShader.replace('#include <fog_vertex>',
      '#include <fog_vertex>\n vWp = (modelMatrix*vec4(position,1.0)).xyz; vWn = normalize(mat3(modelMatrix)*normal);');
    sh.fragmentShader = `uniform sampler2D tGranite, tGraniteN, tMoss, tMossN, tStone, tStoneN; uniform float gScale, mScale, sScale, uTime; uniform vec3 uSunDir;
      varying vec3 vWp; varying vec3 vWn;` + MOSS_GLSL + sh.fragmentShader
      .replace('#include <map_fragment>', `
        /* the lower half of the boulder is buried: cut at the floor, or it hangs below the
           forest's ground as a dark skirt that slides over the moss as one walks round */
        if(vWp.y < ${GROUND_Y.toFixed(2)}) discard;
        vec3 Nw = normalize(vWn), Wt = triW(Nw);
        float mm = mossMask(vWp, Nw);
        /* the scanned stone gives the boulder its lichen, stains and cracks at the scale of
           the whole rock; the granite's grain is laid over it for the eye that comes close */
        vec3 stone = tri(tStone, vWp*sScale + 0.37, Wt).rgb;
        float grain = dot(tri(tGranite, vWp*gScale, Wt).rgb, vec3(0.3, 0.59, 0.11));
        vec3 gran = stone*mix(1.0, grain/0.25, 0.45)*2.4;
        gran *= mix(0.78, 1.08, vn3(vWp*0.45 + 7.0));
        vec3 mos = mossTone(tri(tMoss, vWp*mScale, Wt).rgb, vWp);
        /* the stone darkens and greens where the moss is about to take it */
        float edge = smoothstep(0.0, 0.35, mm)*(1.0 - smoothstep(0.35, 0.9, mm));
        gran *= 1.0 - edge*0.35;
        diffuseColor.rgb *= mix(gran, mos, smoothstep(0.25, 0.75, mm));
        /* shade gathering low down, where the boulder sinks into the forest floor */
        diffuseColor.rgb *= mix(0.4, 1.0, smoothstep(${GROUND_Y.toFixed(2)} - 0.2, ${(GROUND_Y + 2.6).toFixed(2)}, vWp.y));`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.82, 0.97, mm);')
      .replace('#include <lights_fragment_end>', MOSS_LIT('smoothstep(0.3, 0.8, mm)'))
      .replace('#include <normal_fragment_maps>', `
        { vec3 p = vWp*mix(gScale, mScale, step(0.5, mm)), q = vWp*sScale + 0.37;
          vec3 tx = mix(stoneN(texture2D(tStoneN, q.zy).xyz, texture2D(tGraniteN, p.zy).xyz), texture2D(tMossN, p.zy).xyz, mm)*2.0 - 1.0;
          vec3 ty = mix(stoneN(texture2D(tStoneN, q.xz).xyz, texture2D(tGraniteN, p.xz).xyz), texture2D(tMossN, p.xz).xyz, mm)*2.0 - 1.0;
          vec3 tz = mix(stoneN(texture2D(tStoneN, q.xy).xyz, texture2D(tGraniteN, p.xy).xyz), texture2D(tMossN, p.xy).xyz, mm)*2.0 - 1.0;
          tx = vec3(tx.xy + Nw.zy, abs(tx.z)*Nw.x); ty = vec3(ty.xy + Nw.xz, abs(ty.z)*Nw.y); tz = vec3(tz.xy + Nw.xy, abs(tz.z)*Nw.z);
          vec3 nW = normalize(tx.zyx*Wt.x + ty.xzy*Wt.y + tz*Wt.z);
          normal = normalize((viewMatrix*vec4(nW, 0.0)).xyz); }`);
  };
  m.userData.u = u;
  return m;
}
/* shells of moss strands: each a copy of the rock pushed out along its normals,
   keeping only the strands tall enough to reach it, darker toward the roots */
function mossShells(rock, u, count){
  const grp = new THREE.Group();
  grp.name = 'moss';
  for(let i=1;i<=count;i++){
    const t = i/count;
    const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, envMapIntensity: 0.6 });
    m.onBeforeCompile = sh=>{
      Object.assign(sh.uniforms, u, { uT: { value: t }, uLen: { value: 0.11 } });
      sh.vertexShader = 'uniform float uT, uLen; varying vec3 vWp; varying vec3 vWn; varying float vBed;\n' + sh.vertexShader
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' +
          /* pressed flat where the book lies: the rock's book-rest ellipse (blender build_rock) */
          ' float bed = smoothstep(1.0, 1.4, (position.x*position.x)/21.16 + (position.y*position.y)/10.89);\n' +
          ' transformed += normal*uT*uLen*bed; vBed = bed;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\n vWp = (modelMatrix*vec4(transformed,1.0)).xyz; vWn = normalize(mat3(modelMatrix)*normal);');
      sh.fragmentShader = `uniform sampler2D tMoss; uniform float mScale, uT, uTime; uniform vec3 uSunDir; varying vec3 vWp; varying vec3 vWn; varying float vBed;` + MOSS_GLSL + sh.fragmentShader
        .replace('#include <lights_fragment_end>', MOSS_LIT('0.6 + 0.6*uT'))
        .replace('#include <map_fragment>', `
          vec3 Nw = normalize(vWn), Wt = triW(Nw);
          float mm = mossMask(vWp, Nw);
          if(vWp.y < ${GROUND_Y.toFixed(2)}) discard;
          vec3 sp = vWp*70.0;
          float strand = vn3(sp) *0.65 + vn3(sp*2.3 + 5.0)*0.35;
          /* cushions: the strands stand tall in clumps and lie low between them */
          float clump = vn3(vWp*3.2 + 9.0);
          if(vBed < 0.15 || strand < 0.32 + uT*0.42 || mm < 0.3 + uT*0.55 || clump < uT*0.7 - 0.05) discard;
          vec3 mos = mossTone(tri(tMoss, vWp*mScale, Wt).rgb, vWp);
          diffuseColor.rgb *= mos*(0.55 + 0.6*uT);`);
    };
    const sh = new THREE.Mesh(rock.geometry, m);
    sh.receiveShadow = true;
    grp.add(sh);
  }
  return grp;
}

/* the forest all round: built in Blender (blender/build_forest.py) and rendered as a
   360 panorama from 1 m over the boulder, with its distance from that point for every
   direction. Each pixel of the dome is found where the eye's ray meets that surface,
   so the forest keeps its true shape and parallax as one walks round the rock. Where
   walking round uncovers what a near trunk or fern hid, a second render with those
   left out shows it. The water, known from its own render pass, runs the way the
   stream runs */
const FOREST_CAP = new THREE.Vector3(0, GROUND_Y + 10, 0);      // the capture point, 1 m over the floor
const FOREST_GAIN = 2.0;                                         // the picture is stored at half its light
const FOREST_EXPOSURE = 2.2;                                     // and shown a little brighter than it was rendered
const DEPTH_NEAR = 5, DEPTH_FAR = 4000;                          // its distance range, in tenths of a metre
/* how far the boulder reaches out over the floor round its foot, by bearing in the
   panorama's own frame (the rock's, before FOREST_YAW), filled once the rock is in */
const ROCK_FOOT_N = 64;
const rockFoot = new Float32Array(ROCK_FOOT_N);
function measureFoot(rock, grp){
  grp.updateMatrix();
  const p = rock.geometry.attributes.position, v = new THREE.Vector3();
  for(let i=0;i<p.count;i++){
    v.fromBufferAttribute(p, i).applyMatrix4(grp.matrix);
    if(v.y < GROUND_Y - 0.4 || v.y > GROUND_Y + 0.8) continue;
    const k = Math.floor((Math.atan2(v.z, v.x)/(2*Math.PI) + 1)*ROCK_FOOT_N) % ROCK_FOOT_N;
    rockFoot[k] = Math.max(rockFoot[k], Math.hypot(v.x, v.z));
  }
}
async function decodeDepth(url, smooth){
  const res = await fetch(url);
  if(!res.ok) throw new Error('Could not load ' + url + ' (' + res.status + ')');
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const w = bmp.width, h = bmp.height, q = new Uint16Array(w*h);
  /* read through a strip: iOS Safari refuses any canvas over 4096 x 4096 pixels, and a
     phone reads a thin one, so the strip and its pixel copy stay small */
  const band = Math.max(1, Math.min(h, ((HI_RES ? 4194304 : 1048576)/w)|0));
  const c = cv(w, band), x = c.getContext('2d', { willReadFrequently: true });
  for(let y0=0;y0<h;y0+=band){
    const rows = Math.min(band, h - y0);
    x.clearRect(0, 0, w, band);
    x.drawImage(bmp, 0, y0, w, rows, 0, 0, w, rows);
    const d = x.getImageData(0, 0, w, rows).data;
    for(let i=0, o=y0*w;i<w*rows;i++) q[o + i] = d[i*4]*256 + d[i*4 + 1];
  }
  bmp.close && bmp.close();
  const out = new Uint16Array(w*h);
  /* stored top row first; textures read bottom row first */
  for(let y=0;y<h;y++){
    const src = (h - 1 - y)*w, dst = y*w;
    for(let i=0;i<w;i++) out[dst + i] = THREE.DataUtils.toHalfFloat(q[src + i]/65535);
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RedFormat, THREE.HalfFloatType);
  /* the forest's own layer is read nearest, not filtered: a leaf against the sky must not
     blend into a surface halfway between. The layer behind only fills the strips a near
     trunk uncovers, and is read filtered, so what shows there is stretched smoothly over
     its own edges instead of breaking into blocks */
  t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter; t.needsUpdate = true;
  if(!smooth) t.userData.soft = softDepth(q, w, h, Math.max(1, Math.round(w/768)));
  return shed(t);
}
/* the canopy overhead seen as one soft surface: thousands of leaves against the sky
   leap in distance from texel to texel, and stepping aside from the capture point would
   break them into a mosaic of blocks. Averaged over a few leaves and blurred, the
   crown only bends a little as one walks round, the way a far crown does */
function softDepth(q, w, h, k){
  const W = w/k|0, H = h/k|0, a = new Float32Array(W*H), b = new Float32Array(W*H);
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    let s = 0;
    for(let j=0;j<k;j++){ const row = ((H - 1 - y)*k + j)*w; for(let i=0;i<k;i++) s += q[row + x*k + i]; }
    a[y*W + x] = s/(k*k*65535);
  }
  const R = 3;
  for(let pass=0;pass<2;pass++){
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){ let s = 0; for(let i=-R;i<=R;i++) s += a[y*W + ((x + i + W) % W)]; b[y*W + x] = s/(2*R + 1); }
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){ let s = 0; for(let j=-R;j<=R;j++) s += b[Math.min(H - 1, Math.max(0, y + j))*W + x]; a[y*W + x] = s/(2*R + 1); }
  }
  const out = new Uint16Array(W*H);
  for(let i=0;i<W*H;i++) out[i] = THREE.DataUtils.toHalfFloat(a[i]);
  const t = new THREE.DataTexture(out, W, H, THREE.RedFormat, THREE.HalfFloatType);
  t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return shed(t);
}
function makeBackdrop(pano, depth, water, back, backDepth){
  const tex = (im, srgb)=>{ const t = new THREE.Texture(im); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true; return shed(t); };
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: {
      tPano: { value: tex(pano, true) }, tDepth: { value: depth }, tWater: { value: tex(water, false) },
      tBack: { value: tex(back, true) }, tBackDepth: { value: backDepth }, tSoft: { value: depth.userData.soft },
      uCam: { value: new THREE.Vector3() }, uCap: { value: FOREST_CAP }, uYaw: { value: new THREE.Vector2(Math.cos(FOREST_YAW), Math.sin(FOREST_YAW)) }, uTime: { value: 0 }, uGain: { value: FOREST_GAIN*FOREST_EXPOSURE },
      uNear: { value: DEPTH_NEAR }, uFar: { value: DEPTH_FAR }, uSun: { value: SUN_DIR }, uFoot: { value: rockFoot } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }',
    fragmentShader: `#define MARCH_STEPS ${HI_RES ? 112 : 60}
      uniform sampler2D tPano, tDepth, tWater, tBack, tBackDepth, tSoft; uniform vec2 uYaw;
      vec3 unyaw(vec3 v){ return vec3(uYaw.x*v.x - uYaw.y*v.z, v.y, uYaw.y*v.x + uYaw.x*v.z); } uniform vec3 uCam, uCap, uSun; uniform float uTime, uGain, uNear, uFar;
      uniform float uFoot[${ROCK_FOOT_N}];
      varying vec3 vDir;
      float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x*p.y); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0 - 2.0*f);
        return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y); }
      vec2 eqUv(vec3 q){ return vec2(atan(q.z, q.x)*0.15915494 + 0.5, asin(clamp(q.y, -1.0, 1.0))*0.31830989 + 0.5); }
      float unpack(float inv){ return 1.0/(inv*(1.0/uNear - 1.0/uFar) + 1.0/uFar); }
      float distF(vec3 q){ vec2 u = eqUv(q); float a = textureLod(tDepth, u, 0.0).r, w = smoothstep(0.14, 0.42, q.y);
        if(w > 0.0) a = mix(a, textureLod(tSoft, u, 0.0).r, w);
        return unpack(a); }
      float distB(vec3 q){ return unpack(textureLod(tBackDepth, eqUv(q), 0.0).r); }
      /* march the eye's ray out from the camera until it passes behind one layer's
         surface (as the capture point saw it), then close in on the crossing. Where the
         surface is the same on both sides of the crossing the ray has met it. Where it
         leaps away (the edge of a trunk) the ray has only slipped into the trunk's shadow
         as the capture point saw it, so it walks on to whatever lies beyond. gap is that
         leap, kept when nothing beyond is met: the ray then ends where the capture point
         could not see, on the far side of the edge rather than smeared along the trunk */
      #define SLIP 0.04
      #define MARCH(DIST, d, o, T, GAP) { float ta = 2.0, tb = 2.0, fa = -1.0, tS = -1.0, gS = 0.0; T = -1.0; GAP = 0.0; \
        for(int i=1;i<=MARCH_STEPS;i++){ tb = 2.0*pow(3000.0, float(i)/float(MARCH_STEPS)); vec3 P_ = o + tb*d; float L_ = length(P_), f_ = L_ - DIST(P_/L_); \
          if(f_ > 0.0 && fa <= 0.0){ float lo = ta, hi = tb; \
            for(int k=0;k<7;k++){ float tm = 0.5*(lo + hi); vec3 Q_ = o + tm*d; float Lq = length(Q_); if(Lq - DIST(Q_/Lq) > 0.0) hi = tm; else lo = tm; } \
            float dLo = DIST(normalize(o + lo*d)), dHi = DIST(normalize(o + hi*d)), jump = (dLo - dHi)/dHi; \
            if(jump < SLIP){ T = hi; GAP = 0.0; break; } \
            if(tS < 0.0){ tS = lo; gS = jump; } } \
          ta = tb; fa = f_; } \
        if(T < 0.0){ if(tS > 0.0){ T = tS; GAP = gS; } else { T = 6000.0; GAP = 0.0; } } }
      void main(){
        vec3 d = unyaw(normalize(vDir)), o = unyaw(uCam - uCap);
        float t, gap, tAlt, gapAlt;
        MARCH(distF, d, o, t, gap);
        /* the layer behind only fills what a near thing hid, never with open sky, and
           fades in rather than switching, so no hard-edged patch shows */
        float wBack = 0.0;
        if(gap > 0.04){ MARCH(distB, d, o, tAlt, gapAlt); if(gapAlt < gap && tAlt < 2500.0) wBack = smoothstep(0.04, 0.16, gap - gapAlt); }
        vec3 P = o + t*d, q = normalize(P);
        vec2 uv = eqUv(q);
        vec2 uvB = eqUv(normalize(o + (wBack > 0.0 ? tAlt : t)*d));
        /* gradients taken across the wrap as well, so the seam where the panorama
           closes on itself does not drop to the coarsest mip */
        vec2 gx = dFdx(uv), gy = dFdy(uv);
        vec2 uw = vec2(fract(uv.x + 0.5), uv.y), gxw = dFdx(uw), gyw = dFdy(uw);
        if(abs(gxw.x) + abs(gyw.x) < abs(gx.x) + abs(gy.x)){ gx = gxw; gy = gyw; }
        /* where neighbouring pixels meet different surfaces the picture's gradient leaps
           and would fetch a coarse, blocky mip: it is held near what the eye's own ray
           sweeps, grown by how much farther the surface is from the eye than from the
           capture point */
        vec2 ud = eqUv(d), hx = dFdx(ud), hy = dFdy(ud);
        vec2 udw = vec2(fract(ud.x + 0.5), ud.y), hxw = dFdx(udw), hyw = dFdy(udw);
        if(abs(hxw.x) + abs(hyw.x) < abs(hx.x) + abs(hy.x)){ hx = hxw; hy = hyw; }
        float lim = 3.0*max(length(hx), length(hy))*t/length(P);
        gx *= min(1.0, lim/max(length(gx), 1e-7)); gy *= min(1.0, lim/max(length(gy), 1e-7));
        /* past the book the lens lets the far wood go soft */
        float soft = mix(1.0, 2.6, smoothstep(150.0, 700.0, t));
        gx *= soft; gy *= soft;
        /* read with the same gradients: along the seam an implicit fetch drops to the
           coarsest mip, the whole stream averaged, and a line of sun glints ran over the grass */
        vec4 wf = textureGrad(tWater, uv, gx/soft, gy/soft);
        vec3 col;
        if(wf.r > 0.02){
          /* running water: ripples of three sizes carried downstream bend what shows
             through and tilt the surface, which mirrors the canopy more as one looks along
             it and catches glints of sun on the steeper crests. Each size calms to a mirror
             only where a pixel spans more than its own wavelength, so far off the stream
             still moves in its long swells and never boils into glitter up close. Two
             patterns slide at different speeds in each size, so the surface keeps changing
             instead of scrolling past like a belt, and slow bands of light drift down it */
          vec3 W = P + uCap;
          vec2 fl = normalize(wf.gb*2.0 - 1.0 + 1e-4), fr = vec2(-fl.y, fl.x);
          vec2 p = W.xz, s = vec2(dot(p, fl), dot(p, fr));
          float fw = min(length(fwidth(p)), 8.0);
          vec2 gs = vec2(0.0);
          const float E = 0.15;
          for(int b=0;b<3;b++){
            float k = b == 0 ? 0.22 : (b == 1 ? 0.62 : 1.7), A = b == 0 ? 0.42 : (b == 1 ? 0.13 : 0.045);
            float v = b == 0 ? 2.2 : (b == 1 ? 2.8 : 3.4), c = 1.0/(1.0 + pow(fw*k*1.4, 2.0));
            for(int l=0;l<2;l++){
              float vl = l == 0 ? v : v*0.62;
              vec2 cc = vec2((s.x - uTime*vl)*k*0.6, s.y*k) + float(b*2 + l)*7.31;
              float h0 = vn(cc);
              gs += vec2((vn(cc + vec2(E, 0.0)) - h0)*k*0.6, (vn(cc + vec2(0.0, E)) - h0)*k)/E*A*c*0.5;
            }
          }
          vec2 slope = (fl*gs.x + fr*gs.y)*wf.r;
          vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
          vec3 q2 = normalize(P + vec3(slope.x, 0.0, slope.y)*4.0);
          col = textureGrad(tPano, eqUv(q2), gx, gy).rgb;
          vec3 R = reflect(d, n); R.y = abs(R.y);
          vec3 refl = textureLod(tPano, eqUv(R), 2.5).rgb;
          float F = 0.03 + 0.97*pow(1.0 - max(dot(-d, n), 0.0), 5.0);
          col = mix(col, max(col, refl), clamp(F, 0.0, 0.6)*wf.r);
          float band = vn(vec2((s.x - uTime*2.6)*0.07, s.y*0.22) + 3.1)*0.6 + vn(vec2((s.x - uTime*1.7)*0.16, s.y*0.4) + 8.7)*0.4;
          col *= 1.0 + (band - 0.5)*0.32*wf.r;
          float sr = max(dot(R, unyaw(uSun)), 0.0), calm = 1.0/(1.0 + 2.0*fw);
          col += vec3(1.0, 0.94, 0.82)*(pow(sr, 600.0)*3.0*calm + pow(sr, 40.0)*0.06)*wf.r;
        }else{
          col = textureGrad(tPano, uv, gx, gy).rgb;
          if(wBack > 0.0) col = mix(col, textureGrad(tBack, uvB, gx*2.0, gy*2.0).rgb, wBack);
          /* the floor under the boulder's foot, black in the render, shows as a crack where
             the stone's cut meets it: there it takes the moss a step further out, deep in the
             stone's shade. Outside the foot the render's own shadow and occlusion are kept */
          vec3 Wg = P + uCap;
          float rg = length(Wg.xz);
          if(Wg.y < ${(GROUND_Y + 1.0).toFixed(2)} && rg < 9.0){
            float fa = atan(Wg.z, Wg.x)*${(ROCK_FOOT_N/(2*Math.PI)).toFixed(6)} + ${ROCK_FOOT_N.toFixed(1)};
            int f0 = int(floor(fa)) % ${ROCK_FOOT_N}, f1 = (f0 + 1) % ${ROCK_FOOT_N};
            float rf = mix(uFoot[f0], uFoot[f1], fract(fa));
            if(rf > 0.0 && rg < rf){
              vec3 Po = vec3(Wg.x*(1.0 + 1.6/rg), Wg.y, Wg.z*(1.0 + 1.6/rg)) - uCap;
              vec3 moss = textureGrad(tPano, eqUv(normalize(Po)), gx, gy).rgb;
              float shade = mix(0.3, 0.5, smoothstep(rf - 1.0, rf, rg));
              col = max(col, moss*shade);
            }
          }
        }
        gl_FragColor = vec4(col*uGain, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  /* the march is the costliest thing on screen, so it runs once per CSS pixel into a
     picture of its own, and the dome in the scene shows that picture over the frame */
  const march = new THREE.Mesh(new THREE.SphereGeometry(300, 96, 48), m);
  march.frustumCulled = false;
  const marchScene = new THREE.Scene();
  marchScene.add(march);
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const dome = new THREE.Mesh(march.geometry, new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: { tLow: { value: rt.texture } },
    vertexShader: 'varying vec4 vClip; void main(){ vClip = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = vClip.xyww; }',
    fragmentShader: 'uniform sampler2D tLow; varying vec4 vClip; void main(){ gl_FragColor = vec4(texture2D(tLow, vClip.xy/vClip.w*0.5 + 0.5).rgb, 1.0); }'
  }));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  dome.onBeforeRender = (r, sc, cam)=>dome.position.copy(cam.position);
  backdrop = {
    material: m,
    picture: rt.texture,
    draw(){
      const pr = backdropPR(), w = Math.max(1, Math.round(VW*pr)), h = Math.max(1, Math.round(VH*pr));
      if(rt.width !== w || rt.height !== h) rt.setSize(w, h);
      march.position.copy(camera.position);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(marchScene, camera);
      renderer.setRenderTarget(prev);
    }
  };
  return dome;
}
/* a phone marches the forest at half its frame's pixels, the picture is hazy enough to bear it */
const backdropPR = ()=> HI_RES ? Math.min(DPR, 1) : DPR*0.5;
let backdrop = null;

/* the near field: what grows round the boulder (ferns, flowers, grass, stones) is real
   3D, set where blender/build_forest.py put it, so it keeps its true shape as one walks
   round; the panorama behind only carries its shadows on the moss. Each plant is dimmed
   as much as the canopy shades it from the sun there (baked in the same build), and the
   ferns and grass stir in the breeze */
const nearTime = { value: 0 };
async function nearField(){
  let data;
  try{ data = await retry(async ()=>{ const r = await fetch(ASSETS.forestNear); if(!r.ok) throw new Error(r.status); return r.json(); }); }catch(e){ return; }
  const list = data.items;
  /* the floor and the stream's surface round the boulder, drawn only into depth, so what
     is buried in the moss or lies under the water stays hidden */
  if(data.ground){
    const G = data.ground, geo = new THREE.PlaneGeometry(G.size, G.size, G.n - 1, G.n - 1);
    geo.rotateX(-Math.PI/2);
    const pos = geo.attributes.position;
    for(let i=0;i<pos.count;i++) pos.setY(i, G.h[i]);
    geo.computeBoundingSphere();
    const floor = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false }));
    floor.renderOrder = -5; floor.userData.noPick = true;
    floor.rotation.y = FOREST_YAW;
    scene.add(floor);
  }
  const byAsset = new Map();
  list.forEach(it=>{ if(!byAsset.has(it.a)) byAsset.set(it.a, []); byAsset.get(it.a).push(it); });
  const SWAY = { fern_02: 1.0, grass_medium_02: 1.4, celandine_01: 0.6, periwinkle_plant: 0.6 };
  const grp = new THREE.Group();
  grp.name = 'near';
  const _m = new THREE.Matrix4(), _c = new THREE.Color(), _v = new THREE.Vector3();
  const stones = [];
  await Promise.all([...byAsset].map(async ([a, items])=>{
    /* a plant that still will not come is left out rather than losing the whole book */
    const gl = await retry(()=>gltfLoader.loadAsync(`assets/plants/${a}/${a}_1k.gltf`)).catch(e=>{ console.warn('Plant left out:', a, e); return null; });
    if(!gl) return;
    const meshes = new Map();
    gl.scene.traverse(o=>{ if(o.isMesh){ const n = (o.parent && o.parent.name && !o.parent.isScene ? o.parent.name : o.name); meshes.set(o.name, o); meshes.set(n, o); } });
    const find = v => meshes.get(v) || meshes.get(v + '_LOD0') || meshes.get(v.replace(/_LOD0$/, '')) || [...meshes.values()][0];
    const byVar = new Map();
    items.forEach(it=>{ const m = find(it.v); if(!byVar.has(m)) byVar.set(m, []); byVar.get(m).push(it); });
    byVar.forEach((its, src)=>{
      const mat = src.material.clone();
      ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap'].forEach(k=>shed(mat[k]));
      const plant = SWAY[a] !== undefined;
      if(plant){ mat.side = THREE.DoubleSide; mat.alphaTest = 0.5; mat.transparent = false; mat.envMapIntensity = 1.6; }
      if(plant){
        mat.onBeforeCompile = sh=>{
          sh.uniforms.uTime = nearTime;
          sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
            { vec3 w = (instanceMatrix*vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              float h = max(position.y, 0.0);
              float g = sin(uTime*1.3 + w.x*0.35 + w.z*0.27)*0.6 + sin(uTime*2.1 + w.x*0.9)*0.25;
              transformed.xz += vec2(g, g*0.6)*h*h*${(0.08*SWAY[a]).toFixed(3)}; }`);
          /* thin leaves glow when the sun is behind them, as the floor of the wood does */
          sh.uniforms.uSunW = { value: SUN_DIR };
          /* and stand in the same haze as the wood behind them: the farther off, the more
             they take the colour of what lies beyond, blurred */
          sh.uniforms.tHaze = { value: backdrop.picture };
          sh.vertexShader = 'varying vec4 vScr;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvScr = gl_Position;');
          sh.fragmentShader = 'uniform vec3 uSunW; uniform sampler2D tHaze; varying vec4 vScr;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `
            { vec3 sv = normalize((viewMatrix*vec4(uSunW, 0.0)).xyz);
              float back = pow(clamp(-dot(normalize(vViewPosition), sv), 0.0, 1.0), 3.0);
              outgoingLight += diffuseColor.rgb*vec3(1.0, 0.96, 0.82)*(0.35 + 1.4*back)*0.55;
              vec3 haze = textureLod(tHaze, vScr.xy/vScr.w*0.5 + 0.5, 4.0).rgb;
              outgoingLight = mix(outgoingLight, haze, clamp(1.0 - exp(-max(length(vViewPosition) - 12.0, 0.0)*0.009), 0.0, 0.5)); }
            #include <opaque_fragment>`);
        };
      }
      const im = new THREE.InstancedMesh(src.geometry, mat, its.length);
      its.forEach((it, i)=>{
        _m.fromArray(it.m); im.setMatrixAt(i, _m);
        const k = (plant ? 0.78 : 0.82) + (plant ? 0.32 : 0.22)*(it.s ?? 1);
        im.setColorAt(i, _c.setRGB(k, k, k));
        if(!plant){
          if(!src.geometry.boundingSphere) src.geometry.computeBoundingSphere();
          const bs = src.geometry.boundingSphere;
          _v.copy(bs.center).applyMatrix4(_m);
          stones.push([_v.x, _v.z, bs.radius*_m.getMaxScaleOnAxis()*0.8]);
        }
      });
      im.instanceMatrix.needsUpdate = true;
      if(im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = false; im.receiveShadow = false;
      im.frustumCulled = false;
      im.userData.noPick = true;
      grp.add(im);
    });
  }));
  if(data.ground) grp.add(grassField(data.ground, stones));
  grp.rotation.y = FOREST_YAW;
  scene.add(grp);
}

/* grass round the boulder: thin blades in clumps, rooted on the floor the forest render
   shows and coloured by it where they stand, so they rise out of the moss in its own
   light and shade. Where that floor is bare earth, water or hidden from the capture
   point no blade grows, and at the near field's edge they shorten and thin out into
   the picture. Built in the forest's own frame (the group turns it by FOREST_YAW) */
function grassField(G, stones){
  const N = HI_RES ? 56000 : 16000, SEG = HI_RES ? 5 : 3;
  const R1 = 32, R2 = 58;
  const half = G.size/2, step = G.size/(G.n - 1);
  const hAt = (x, z)=>{
    const fx = clamp((x + half)/step, 0, G.n - 1.001), fz = clamp((z + half)/step, 0, G.n - 1.001);
    const j = fx|0, i = fz|0, u = fx - j, v = fz - i, H = G.h, n = G.n;
    return lerp(lerp(H[i*n + j], H[i*n + j + 1], u), lerp(H[(i + 1)*n + j], H[(i + 1)*n + j + 1], u), v);
  };
  const hh = (x, z)=>{ const s = Math.sin(x*127.1 + z*311.7)*43758.5453; return s - Math.floor(s); };
  const vnz = (x, z)=>{ const i = Math.floor(x), j = Math.floor(z), a = smooth(x - i), b = smooth(z - j);
    return lerp(lerp(hh(i, j), hh(i + 1, j), a), lerp(hh(i, j + 1), hh(i + 1, j + 1), a), b); };
  const sstep = (a, b, x)=> smooth(clamp((x - a)/(b - a), 0, 1));
  const footAt = (x, z)=>{ const k = Math.floor((Math.atan2(z, x)/(2*Math.PI) + 1)*ROCK_FOOT_N) % ROCK_FOOT_N;
    return Math.max(rockFoot[k], rockFoot[(k + 1) % ROCK_FOOT_N]); };
  const CELL = 6, cells = new Map(), key = (i, j)=> i*4096 + j;
  stones.forEach(s=>{
    for(let i=Math.floor((s[0] - s[2])/CELL);i<=Math.floor((s[0] + s[2])/CELL);i++)
      for(let j=Math.floor((s[1] - s[2])/CELL);j<=Math.floor((s[1] + s[2])/CELL);j++){
        const k = key(i, j); if(!cells.has(k)) cells.set(k, []); cells.get(k).push(s);
      }
  });
  const underStone = (x, z)=>{ const c = cells.get(key(Math.floor(x/CELL), Math.floor(z/CELL)));
    return !!c && c.some(s=> (x - s[0])**2 + (z - s[1])**2 < s[2]*s[2]); };
  const rnd = mulberry32(2718), root = new Float32Array(N*4), blade = new Float32Array(N*4);
  let n = 0;
  for(let tries=0; n < N && tries < N*14; tries++){
    const r = R2*Math.sqrt(rnd()), a = rnd()*2*Math.PI, x = r*Math.cos(a), z = r*Math.sin(a);
    const edge = 1 - sstep(R1, R2, r);
    const dense = sstep(0.4, 0.72, vnz(x*0.16, z*0.16)*0.65 + vnz(x*0.5 + 7.3, z*0.5 + 1.9)*0.35);
    if(rnd() > edge*(0.1 + 0.9*dense)) continue;
    if(r < footAt(x, z) + 0.15 || underStone(x, z)) continue;
    const tall = (0.45 + 0.55*dense)*(0.5 + 0.5*edge);
    root[n*4] = x; root[n*4 + 1] = hAt(x, z) - 0.05; root[n*4 + 2] = z; root[n*4 + 3] = rnd();
    blade[n*4] = rnd()*2*Math.PI;
    blade[n*4 + 1] = (0.55 + 1.25*rnd()*rnd())*tall;
    blade[n*4 + 2] = 0.05 + 0.05*rnd();
    blade[n*4 + 3] = 0.1 + 0.7*rnd()*rnd();
    n++;
  }
  const ig = new THREE.InstancedBufferGeometry();
  const pos = [], idx = [];
  for(let s=0;s<=SEG;s++){ const t = s/SEG; pos.push(-0.5, t, 0, 0.5, t, 0); }
  for(let s=0;s<SEG;s++){ const a = s*2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  ig.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  ig.setIndex(idx);
  ig.setAttribute('aRoot', new THREE.InstancedBufferAttribute(root.subarray(0, n*4), 4));
  ig.setAttribute('aBlade', new THREE.InstancedBufferAttribute(blade.subarray(0, n*4), 4));
  ig.instanceCount = n;
  const U = backdrop.material.uniforms;
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uTime: nearTime, tPano: U.tPano, tWater: U.tWater, tDepth: U.tDepth, uNear: U.uNear, uFar: U.uFar,
      uCap: { value: FOREST_CAP }, uGain: U.uGain, uSun: { value: SUN_DIR }, tHaze: { value: backdrop.picture } },
    vertexShader: `uniform float uTime, uGain, uNear, uFar; uniform sampler2D tPano, tWater, tDepth; uniform vec3 uCap;
      attribute vec4 aRoot, aBlade;
      varying vec3 vCol, vWp; varying float vT; varying vec4 vScr;
      vec2 eqUv(vec3 q){ return vec2(atan(q.z, q.x)*0.15915494 + 0.5, asin(clamp(q.y, -1.0, 1.0))*0.31830989 + 0.5); }
      void main(){
        vec3 r = aRoot.xyz, rel = r - uCap;
        float L = length(rel);
        vec2 uv = eqUv(rel/L);
        vec3 fl = textureLod(tPano, uv, 1.0).rgb;
        float wet = textureLod(tWater, uv, 0.0).r;
        float seen = 1.0/(textureLod(tDepth, uv, 0.0).r*(1.0/uNear - 1.0/uFar) + 1.0/uFar);
        float green = fl.g/max(max(fl.r, fl.b), 1e-4);
        float keep = smoothstep(0.9, 1.1, green)*(1.0 - smoothstep(0.0, 0.08, wet))*step(L*0.85, seen);
        float t = position.y, H = aBlade.y*keep, lean = aBlade.w;
        vec2 f = vec2(cos(aBlade.x), sin(aBlade.x)), sd = vec2(-f.y, f.x);
        float w = aBlade.z*pow(1.0 - t, 0.6);
        float g = sin(uTime*1.3 + r.x*0.35 + r.z*0.27)*0.6 + sin(uTime*2.1 + r.x*0.9)*0.25 + sin(uTime*3.7 + aRoot.w*40.0)*0.06;
        vec2 bend = f*lean*H*t*t + vec2(g, g*0.6)*t*t*H*0.14;
        vec3 p = r + vec3(sd.x*position.x*w + bend.x, H*t*(1.0 - 0.3*lean*t), sd.y*position.x*w + bend.y);
        vec4 wp = modelMatrix*vec4(p, 1.0);
        vWp = wp.xyz;
        gl_Position = projectionMatrix*viewMatrix*wp;
        vScr = gl_Position;
        float lum = dot(fl, vec3(0.3, 0.59, 0.11));
        vec3 c = max(mix(vec3(lum), fl, 1.3), 0.0)*mix(0.85, 1.15, fract(aRoot.w*7.13));
        if(fract(aRoot.w*3.7) < 0.12) c = mix(c, lum*vec3(1.3, 1.1, 0.55), 0.6*t);
        vCol = c*uGain; vT = t;
      }`,
    fragmentShader: `uniform vec3 uSun; uniform sampler2D tHaze;
      varying vec3 vCol, vWp; varying float vT; varying vec4 vScr;
      void main(){
        vec3 V = vWp - cameraPosition;
        float d = length(V);
        float back = pow(clamp(dot(V/d, uSun), 0.0, 1.0), 3.0);
        vec3 c = vCol*mix(0.6, 1.12, vT) + vCol*vec3(0.9, 1.15, 0.45)*back*1.3*vT;
        vec3 haze = textureLod(tHaze, vScr.xy/vScr.w*0.5 + 0.5, 4.0).rgb;
        c = mix(c, haze, clamp(1.0 - exp(-max(d - 12.0, 0.0)*0.009), 0.0, 0.5));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  const mesh = new THREE.Mesh(ig, mat);
  mesh.name = 'grass';
  mesh.frustumCulled = false;
  mesh.userData.noPick = true;
  return mesh;
}

async function loadAssets(){
  const imgs = {};
  const imgJobs = ['forest','forestWater','forestBack','granite','moss','stone','stoneNor','leaAlbedo','leaNor','leaRough','maskFront','maskBack']
    .map(k=>loadImage(ASSETS[k]).then(i=>{ imgs[k] = i; }));
  const model = url => retry(()=>gltfLoader.loadAsync(url));
  const models = Promise.all([model(ASSETS.goldFront), model(ASSETS.goldBack), model(ASSETS.rock)]);
  /* a phone decodes the two depth maps one after the other: each needs ~100 MB on the way */
  const depth = retry(()=>decodeDepth(ASSETS.forestDepth));
  const backDepth = HI_RES ? retry(()=>decodeDepth(ASSETS.forestBackDepth, true)) : depth.then(()=>retry(()=>decodeDepth(ASSETS.forestBackDepth, true)));
  const light = retry(()=>new RGBELoader().loadAsync(ASSETS.forestLight));
  await Promise.all(imgJobs);
  const [gf, gb, rk] = await models;
  /* the boulder and the book are lit by the forest they stand in, the same render */
  const hdr = await light;
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromEquirectangular(hdr).texture;
  pm.dispose(); hdr.dispose();
  scene.environmentIntensity = 1.15;
  scene.environmentRotation.set(0, FOREST_YAW, 0);
  scene.background = null;
  applyLeather(imgs);
  scene.add(makeBackdrop(imgs.forest, await depth, imgs.forestWater, imgs.forestBack, await backDepth));
  leafHaze.value = backdrop.picture;
  [[gf, frontGoldSlot], [gb, backGoldSlot]].forEach(([gl, slot])=>{
    const m = firstMesh(gl);
    m.material = matGold;
    m.castShadow = false; m.receiveShadow = true;
    m.userData.noPick = true;
    m.position.set(0,0,0); m.rotation.set(0,0,0); m.scale.set(1,1,1);
    slot.add(m);
  });
  const rock = firstMesh(rk);
  rock.material = rockMaterial(imgs);
  rock.receiveShadow = true; rock.castShadow = true;
  const rockGrp = new THREE.Group();
  rockGrp.rotation.x = -Math.PI/2;
  rockGrp.position.y = ROCK_TOP;
  rock.position.set(0,0,0); rock.rotation.set(0,0,0);
  rockGrp.add(rock);
  rockGrp.add(mossShells(rock, rock.material.userData.u, HI_RES ? 9 : 4));
  const rockYaw = new THREE.Group();
  rockYaw.rotation.y = FOREST_YAW;
  rockYaw.add(rockGrp);
  scene.add(rockYaw);
  measureRock(rock);
  measureFoot(rock, rockGrp);
  /* drawn before the floor that hides what is buried: that floor is coarser than the
     render's ground and would otherwise shave the stone's foot off, baring the black
     earth beneath it */
  rockGrp.traverse(o=>{ if(o.isMesh) o.renderOrder = -6; });
  await nearField();
  /* the boulder's shadow is in the forest render itself; the backdrop only fills the
     floor under its foot (uFoot) */
}

/* ============================================================================
   15. loop
   ==========================================================================*/
const liveFov = ()=> clamp(2*Math.atan(Math.tan(20*Math.PI/180)*0.8/(VW/VH))*180/Math.PI, 40, 62);
function onResize(){
  if(!measureViewport()) return;
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
const _bc = new THREE.Vector3();
function update(dt){
  clock += dt;
  stepFrame(dt);
  const theta0 = st.theta;
  if(g && g.mode === 'cover'){
    st.theta = damp(st.theta, g.goal, 18, dt);
  }else if(coverAnim && coverAnim.glide){
    const done = glideStep(coverAnim.glide, dt);
    st.theta = clamp(coverAnim.glide.x, 0, OPEN);
    if(done){ if(coverAnim.to === 0) releaseFrame(); st.theta = coverAnim.to; coverAnim = null; if(Math.abs(st.thetaVel) > 0.6) sfx.land(); refreshUI(); }
  }else if(coverAnim && coverAnim.fall){
    if(stepFall(coverAnim.fall, dt)){ st.theta = 0; coverAnim = null; releaseFrame(); refreshUI(); }
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
      if(A.fallV !== undefined) coverAnim = fallCover(A.fallV);
      else { coverAnim = null; coverLanded(A); refreshUI(); }
    }
    else{
      const sg = A.path[A.i], k = A.t/sg.d;
      if(sg.fire && !sg.fired && sg.at !== undefined && k >= sg.at){ sg.fired = true; coverEvent(sg.fire); }
      st.theta = lerp(A.from, sg.to, sg.e(k));
    }
  }
  st.thetaVel = damp(st.thetaVel, (st.theta - theta0)/Math.max(dt, 1e-3), 14, dt);
  if(writeOnOpen && !coverAnim && st.open && st.theta >= OPEN - 1e-3){ writeOnOpen = false; writePose(); }
  stepFlight(dt);
  stepRiffle(dt);
  for(const L of leaves) if(L.flt < FLOAT_T) L.flt += dt;
  if(spinAnim){
    spinAnim.t += dt;
    const k = Math.min(1, spinAnim.t/spinAnim.dur);
    spinGrp.quaternion.slerpQuaternions(spinAnim.q0, spinAnim.q1, easeIO(k));
    spinGoal.copy(spinGrp.quaternion);
    if(k >= 1) spinAnim = null;
  }else{
    if(inertia){
      rotateBy(angVel.x*dt, angVel.y*dt);
      const f = Math.exp(-dt*3.4);
      angVel.x *= f; angVel.y *= f;
      if(Math.hypot(angVel.x, angVel.y) < 0.03) inertia = false;
    }
    /* still on the rock it turns lazily, it follows the hand once it has risen */
    spinGrp.quaternion.slerp(spinGoal, 1 - Math.exp(-dt*lerp(7, 16, liftGate())));
  }
  /* the book rises off the rock to be turned and settles back when it is home */
  const wantLift = rotating || inertia || !atHome() ? 1 : 0;
  st.lift = lerp(st.lift, wantLift, 1 - Math.exp(-dt*(wantLift ? 3.2 : 2.4)));
  if(st.lift < 0.0005) st.lift = 0;
  if(writing){
    blinkPhase += dt;
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
      pagePerPx = perPx/PH*PAGE_H;
      if(half < PAGE_H/2 && e && e.lay){
        const lay = e.lay, cy = caretXY(lay, clamp(quill.selectionEnd, 0, pages[writing.n].t.length)).y - lay.size*0.35;
        const base = clamp(cy, half, PAGE_H - half);
        py = clamp(base + pageScroll, half, PAGE_H - half);
        pageScroll = py - base;
      }else pageScroll = 0;
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
  st.zoom = Math.min(st.zoom, Math.max(1, CAM_REACH/fitDistance()));
  sdamp(st, 'camD', lerp(Math.min(fitDistance()*st.zoom, CAM_REACH), pageD, fz), 0.45, dt);
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
  if(fz < 0.001 && Math.abs(orbit.azTo) > Math.PI){ const w = Math.round(orbit.azTo/(2*Math.PI))*2*Math.PI; orbit.azTo -= w; orbit.az -= w; }
  sdamp(orbit, 'az', orbit.azTo, 0.22, dt); sdamp(orbit, 'el', orbit.elTo, 0.22, dt);
  const az = orbit.az*(1 - fz), el = clamp(el0 + orbit.el*(1 - fz), ORBIT_EL[0], Math.max(ORBIT_EL[1], el0));
  const ce = Math.cos(el)*st.camD;
  camera.position.set(camTarget.x + Math.sin(az)*ce, camTarget.y + Math.sin(el)*st.camD, camTarget.z + Math.cos(az)*ce);
  camera.position.y = Math.max(camera.position.y, GROUND_Y + 1.0);
  /* closed, the view is lifted a little above the book, so the forest beyond it shows */
  const lift = lerp(2.4, 0, smooth(clamp(frameTheta()/OPEN, 0, 1)))*(1 - fz);
  _bc.set(camTarget.x, camTarget.y + lift, camTarget.z);
  camera.lookAt(_bc);
  if(camBlend) stepCamBlend(dt);
  if(FILM && window.__filmCam) window.__filmCam(dt);
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
  const m = bookRoot.matrixWorld.elements;
  for(let i=0;i<16;i++) if(m[i] !== shadowKey[i]){ shadowKey[i] = m[i]; shadowDirty = true; }
  renderer.shadowMap.needsUpdate = shadowDirty;
  shadowDirty = false;
  if(backdrop) backdrop.draw();
  composer.render(dt);
  prewarmPages(now);
}
/* a phone that cannot keep up draws fewer pixels: after two slow seconds it steps down,
   after three quick ones in a row back up, only while nothing moves, since the new
   targets take a moment to make */
const PR_STEPS = [1, 1.25, 1.5, 2].filter(p=>p < DPR_MAX).concat(DPR_MAX);
let prSum = 0, prN = 0, prQuick = 0;
function adaptPixels(raw){
  if(HI_RES) return;
  if(document.hidden || raw > 0.5 || resting()){ prSum = 0; prN = 0; return; }
  prSum += raw; prN++;
  if(prSum < 2) return;
  const avg = prSum/prN;
  prSum = 0; prN = 0;
  if(g || pinch || st.flight || st.riffle || coverAnim || spinAnim) return;
  const i = PR_STEPS.indexOf(DPR);
  let to = i;
  if(avg > 1/32){ to = Math.max(0, i - 1); prQuick = 0; }
  else if(avg < 1/48){ if(++prQuick >= 3){ to = Math.min(PR_STEPS.length - 1, i + 1); prQuick = 0; } }
  else prQuick = 0;
  if(to === i) return;
  DPR = PR_STEPS[to];
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
  return performance.now() - activeAt > 2500 && !g && !pinch && !st.flight && !st.riffle
    && !coverAnim && !spinAnim && !inertia && !orbit.coast && seek.goal === null;
}
function resting(){ return !HI_RES && still(); }
function rafLoop(now){
  requestAnimationFrame(rafLoop);
  const step = still() ? 1000/30 : 1000/60;
  if(now - drawnAt < step - 1) return;
  drawnAt = Math.max(drawnAt + step, now - step);
  frame();
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

/* ============================================================================
   16. the opening film
   ==========================================================================*/
/* the title page's ornament, gilt and lettering catch a light that runs out from the
   middle of the sheet (reach 0..1) and leaves them glowing warm (amt fades it) */
const shineMasks = new Map();
let shineLayer = null;
function pageShine(n, amt, reach){
  const e = pageEntry(n), W = e.glow.width, H = e.glow.height;
  if(amt <= 0){ if(e.glowing){ e.glowing = true; paintPage(n); } return; }
  let mask = shineMasks.get(n);
  if(!mask){
    const art = cv(PAGE_W, PAGE_H), a = art.getContext('2d');
    a.drawImage(borderArt(), 0, 0);
    a.drawImage(gilt().color, 0, 0);
    if(n === 0) drawTitle(a);
    mask = cv(W, H);
    const m = mask.getContext('2d');
    m.filter = 'blur(2px)'; m.globalAlpha = 0.7;
    m.drawImage(art, 0, 0, W, H);
    m.filter = 'none'; m.globalAlpha = 1;
    m.drawImage(art, 0, 0, W, H);
    shineMasks.set(n, mask);
    shineLayer = shineLayer || cv(W, H);
  }
  const L = shineLayer.getContext('2d');
  L.globalCompositeOperation = 'source-over';
  L.clearRect(0, 0, W, H);
  const cx = W/2, cy = H*0.42, R = Math.max(1, Math.hypot(W, H)*0.62*reach);
  const gr = L.createRadialGradient(cx, cy, 0, cx, cy, R);
  gr.addColorStop(0, 'rgba(255,170,60,.55)');
  gr.addColorStop(0.78, 'rgba(255,190,90,.85)');
  gr.addColorStop(0.93, 'rgba(255,240,200,1)');
  gr.addColorStop(1, 'rgba(255,220,150,0)');
  L.fillStyle = gr;
  L.fillRect(0, 0, W, H);
  L.globalCompositeOperation = 'destination-in';
  L.drawImage(mask, 0, 0);
  const g = e.glow.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.globalAlpha = clamp(amt, 0, 1);
  g.drawImage(shineLayer, 0, 0);
  g.globalAlpha = 1;
  e.glowTex.needsUpdate = true;
  e.mat.emissiveIntensity = 3.2;
  e.glowing = true;
}
/* the film opens the book on a bare title page; the lettering soaks up into the sheet
   from the middle outward, raggedly, like ink taken up by the fibres, as the circle
   comes down on it (reach 0..1) */
let titleFull = null, titleBare = null, titleMix = null, titleMask = null, soak = null;
function titleReveal(reach){
  const e = pageEntry(0);
  if(!titleFull){
    titleFull = pageBackground(0);
    titleHidden = true; titleBare = pageBackground(0); titleHidden = false;
    titleMix = cv(PAGE_W, PAGE_H); titleMask = cv(PAGE_W, PAGE_H);
    const w = PAGE_W >> 2, h = PAGE_H >> 2;
    soak = { w, h, c: cv(w, h), n: fbm(w, h, 7, 9, 4, 4242) };
  }
  if(reach >= 1) e.bg = titleFull;
  else if(reach <= 0) e.bg = titleBare;
  else {
    const { w, h, c, n } = soak, sc = c.getContext('2d'), img = sc.createImageData(w, h), d = img.data;
    const cx = w/2, cy = h*0.42, R = Math.hypot(w, h)*0.62;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const i = y*w + x, r = Math.hypot(x - cx, y - cy)/R;
      const v = (reach - r)/0.16 + (n[i] - 0.5)*1.6;
      d[i*4 + 3] = 255*smooth(clamp(v, 0, 1));
    }
    sc.putImageData(img, 0, 0);
    const m = titleMask.getContext('2d'), x = titleMix.getContext('2d');
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, PAGE_W, PAGE_H);
    m.drawImage(titleFull, 0, 0);
    m.globalCompositeOperation = 'destination-in';
    m.imageSmoothingQuality = 'high';
    m.drawImage(c, 0, 0, PAGE_W, PAGE_H);
    x.drawImage(titleBare, 0, 0);
    x.drawImage(titleMask, 0, 0);
    e.bg = titleMix;
  }
  e.inkKey = null;
  paintPage(0);
}
/* the film's circle lies on the title page as light, and from it a spark flies to each
   letter of the lettering, which then burns in exactly as a letter written in the book
   does (burnLetter): the paper browns in its shape, a ragged white-gold front eats
   through it along the pen's slant, the stroke glows ember and cools into ink.
   The letters are the title page's own, cut apart where its ink has gaps.
   o: { M (sigil units -> page px), sig (circle's light 0..1), t, start (when the first
   letter catches), done } */
let tb = null;
function burnInit(){
  titleReveal(-1);
  const W = PAGE_W, H = PAGE_H;
  const d = cv(W, H), dc = d.getContext('2d');
  dc.drawImage(titleBare, 0, 0);
  dc.globalCompositeOperation = 'difference';
  dc.drawImage(titleFull, 0, 0);
  const px = dc.getImageData(0, 0, W, H).data, inkA = new Uint8ClampedArray(W*H);
  for(let i=0;i<W*H;i++) inkA[i] = Math.min(255, (px[i*4] + px[i*4+1] + px[i*4+2])*1.6);
  /* lines: runs of rows with ink; letters: runs of columns with ink within a line */
  const rowInk = y => { for(let x=0;x<W;x++) if(inkA[y*W + x] > 40) return true; return false; };
  const bands = [];
  for(let y=0;y<H;y++){
    if(!rowInk(y)) continue;
    const last = bands[bands.length - 1];
    if(last && y - last.y1 <= 6*FS) last.y1 = y; else bands.push({ y0: y, y1: y });
  }
  const glyphs = [];
  bands.forEach((b, bi)=>{
    const cols = [];
    for(let x=0;x<W;x++){ let on = false; for(let y=b.y0;y<=b.y1 && !on;y++) on = inkA[y*W + x] > 40; cols.push(on); }
    let x = 0;
    while(x < W){
      if(!cols[x]){ x++; continue; }
      let x1 = x;
      while(x1 + 1 < W && (cols[x1 + 1] || (x1 + 3 < W && cols[x1 + 2] && !cols[x1 + 1] && false))) x1++;
      const last = glyphs[glyphs.length - 1];
      if(last && last.band === bi && x - last.x1 < 1) last.x1 = x1;
      else glyphs.push({ band: bi, x0: x, x1, y0: b.y0, y1: b.y1 });
      x = x1 + 1;
    }
  });
  if(!burnNoise) burnNoise = fbm(256, 256, 12, 12, 3, 4242);
  tb = { W, H, inkA, bands, glyphs, mix: cv(W, H), done: cv(W, H), tmp: cv(W, H), cvs: [cv(8, 8), cv(8, 8), cv(8, 8)], M: null };
  tb.done.getContext('2d').drawImage(titleBare, 0, 0);
}
/* when each letter catches, after the first: line after line down the page, each
   from its first letter to its last as a hand would write it, the next line starting
   while the last is still being written; the ornaments go quicker */
function titleBurnPlan(pace = 1){
  if(!tb) burnInit();
  const B = tb.bands, H = tb.H;
  return tb.glyphs.map(g=>{
    const b = B[g.band], xs = tb.glyphs.filter(q=>q.band === g.band);
    const bx0 = xs[0].x0, bx1 = xs[xs.length - 1].x1, ornament = (b.y1 - b.y0) < H*0.012 || xs.length < 4;
    g.s = pace*(g.band*0.32 + ((g.x0 + g.x1)/2 - bx0)/Math.max(1, bx1 - bx0)*(ornament ? 0.5 : 1.0));
    return { px: (g.x0 + g.x1)/2, py: (g.y0 + g.y1)/2, s: g.s };
  });
}
function sigilLines(M, blur, col, wk = 1){
  const c = cv(PAGE_W, PAGE_H), x = c.getContext('2d');
  x.setTransform(...M);
  x.strokeStyle = x.fillStyle = col; x.lineCap = 'round'; x.lineJoin = 'round';
  if(blur) x.filter = `blur(${blur}px)`;
  const ring = (r, lw)=>{ x.lineWidth = lw*wk; x.beginPath(); x.arc(0, 0, r, 0, Math.PI*2); x.stroke(); };
  ring(118, 1.7); ring(112, 0.9); ring(84, 1.2); ring(80, 0.7); ring(30, 1.0);
  for(let i=0;i<7;i++){ const a = -Math.PI/2 + i*Math.PI*2/7; x.beginPath(); x.arc(Math.cos(a)*118, Math.sin(a)*118, 3.2, 0, Math.PI*2); x.fill(); }
  x.lineWidth = 1.1*wk; x.beginPath();
  for(let i=0;i<=7;i++){ const a = -Math.PI/2 + i*3*Math.PI*2/7; i ? x.lineTo(Math.cos(a)*80, Math.sin(a)*80) : x.moveTo(Math.cos(a)*80, Math.sin(a)*80); }
  x.stroke();
  const rnd = mulberry32(777);
  x.lineWidth = 1.1*wk;
  for(let i=0;i<28;i++){ x.save(); x.rotate(i/28*Math.PI*2); x.translate(0, -98); runeStroke(x, Math.floor(rnd()*6), 7, 3.6); x.restore(); }
  return c;
}
function titleBurn(o){
  if(!tb) burnInit();
  const e = pageEntry(0), T = tb, W = T.W, H = T.H;
  const g = e.glow.getContext('2d'), gw = e.glow.width, gh = e.glow.height;
  if(o.done){
    e.bg = titleFull; e.inkKey = null; paintPage(0);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(0, 0, gw, gh);
    e.glowTex.needsUpdate = true; e.mat.emissiveIntensity = 0; e.glowing = false;
    return;
  }
  if(!T.M || T.M.join() !== o.M.join()){
    T.M = o.M.slice();
    T.sigLine = sigilLines(T.M, 0, 'rgb(255,214,140)', 1.1);
    T.sigSoft = sigilLines(T.M, 4*SC, 'rgb(255,170,80)', 2.0);
  }
  const m = T.mix.getContext('2d'), dn = T.done.getContext('2d');
  /* the light is gathered aside: painting the page clears its glow layer */
  if(!T.acc || T.acc.width !== gw) T.acc = cv(gw, gh);
  const g0 = g, ga = T.acc.getContext('2d');
  { const g = ga;
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(0, 0, gw, gh);
  g.globalCompositeOperation = 'lighter';
  if(o.sig > 0){
    g.globalAlpha = o.sig*0.55; g.drawImage(T.sigSoft, 0, 0, gw, gh);
    g.globalAlpha = o.sig; g.drawImage(T.sigLine, 0, 0, gw, gh);
    g.globalAlpha = 1;
  }
  m.globalCompositeOperation = 'source-over'; m.globalAlpha = 1;
  m.drawImage(T.done, 0, 0);
  const Tb = BURN_T, C = COOL_T, PRE = Tb*0.4, RIM = 0.08, CH = CHAR, HOT = 0.06, nk = 1/FS, s = 60*FS;
  const live = [];
  for(const G of T.glyphs){
    if(G.finished) continue;
    const age = o.t - (o.start + G.s);
    if(age < -PRE) continue;
    if(age > Tb + 2.8*C){
      G.finished = true;
      dn.save(); dn.beginPath(); dn.rect(G.x0 - s*0.2, G.y0 - s*0.2, G.x1 - G.x0 + s*0.6, G.y1 - G.y0 + s*0.4); dn.clip();
      dn.drawImage(titleFull, 0, 0); dn.restore();
      m.save(); m.beginPath(); m.rect(G.x0 - s*0.2, G.y0 - s*0.2, G.x1 - G.x0 + s*0.6, G.y1 - G.y0 + s*0.4); m.clip();
      m.drawImage(titleFull, 0, 0); m.restore();
      continue;
    }
    live.push([G, age]);
  }
  for(const [G, age] of live){
    const X0 = Math.max(0, Math.floor(G.x0 - s*0.14)), Y0 = Math.max(0, Math.floor(G.y0 - s*0.12));
    const X1 = Math.min(W, Math.ceil(G.x1 + s*0.32)), Y1 = Math.min(H, Math.ceil(G.y1 + s*0.12));
    const w = X1 - X0, h = Y1 - Y0;
    const ink = new Uint8ClampedArray(w*h*4);
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const X = X0 + x;
      ink[(y*w + x)*4 + 3] = X >= G.x0 && X <= G.x1 ? T.inkA[(Y0 + y)*W + X] : 0;
    }
    const soft = softMask(ink, w, h, Math.max(1, Math.round(2.4*FS)));
    const sMin = G.x0*NIB_DX + G.y0*NIB_DY, sSpan = Math.max(1, G.x1*NIB_DX + G.y1*NIB_DY - sMin);
    const [cc, pc, lc] = T.cvs;
    [cc, pc, lc].forEach(c=>{ if(c.width < w || c.height < h){ c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); } });
    const cover = new ImageData(w, h), paint = new ImageData(w, h), glow = new ImageData(w, h);
    const cd = cover.data, pd = paint.data, ld = glow.data, rise = age*70;
    for(let y=0, p=0; y<h; y++){
      const Y = Y0 + y, ny = ((Y*nk) & 255) << 8, fy = (((Y*nk*1.7 + rise) | 0) & 255) << 8;
      for(let x=0; x<w; x++, p+=4){
        const a = ink[p+3]/255, sa = soft[p>>2];
        if(sa < 0.004) continue;
        const X = X0 + x;
        const F = clamp((X*NIB_DX + Y*NIB_DY - sMin)/sSpan, -0.2, 1.2)*0.74 + burnNoise[ny | ((X*nk) & 255)]*0.42 - 0.08;
        const la = age - Tb*F;
        if(la < 0){
          cd[p+3] = Math.min(255, sa*640);
          if(la > -PRE){
            const k = 1 + la/PRE, q = k*k, c = la > -CH ? 1 + la/CH : 0;
            pd[p] = lerp(120, 30, c); pd[p+1] = lerp(66, 14, c); pd[p+2] = lerp(28, 6, c);
            pd[p+3] = Math.min(1, (a*0.55 + sa*0.1)*q + (a*0.9 + sa*0.25)*c)*255;
            if(la > -HOT){ const e2 = a*(1 + la/HOT)*0.3; ld[p] = 210; ld[p+1] = 90; ld[p+2] = 30; ld[p+3] = e2*255; }
          }
          continue;
        }
        if(la < HOT) cd[p+3] = Math.min(255, sa*640)*(1 - la/HOT);
        const fl = burnNoise[fy | (((X*nk*1.7) | 0) & 255)];
        const edge = clamp((1 - sa)*2.5, 0, 1);
        const heat = Math.min(1, Math.exp(-la/(C*(0.55 + 1.1*edge)))*(0.72 + 0.56*fl));
        const rim = la < RIM ? 1 - la/RIM : 0;
        if(heat < 0.01 && rim === 0) continue;
        if(a > 0.004){
          const c = ramp(heat, SINGE), r = rim*0.8;
          pd[p] = lerp(c[0], 255, r); pd[p+1] = lerp(c[1], 246, r); pd[p+2] = lerp(c[2], 220, r);
          pd[p+3] = a*Math.min(1, heat*3 + rim)*255;
        }
        const c = ramp(heat, EMBER);
        const ea = Math.min(1, a*Math.min(1, heat*1.6) + sa*(rim*0.55 + heat*0.3));
        ld[p] = lerp(c[0], 255, rim); ld[p+1] = lerp(c[1], 240, rim); ld[p+2] = lerp(c[2], 205, rim);
        ld[p+3] = ea*255;
      }
    }
    /* the letter as it ends, the parchment still unburnt over it, its colour, its light */
    m.save(); m.beginPath(); m.rect(X0, Y0, w, h); m.clip();
    m.drawImage(titleFull, 0, 0);
    cc.getContext('2d').putImageData(cover, 0, 0);
    const t2 = T.tmp.getContext('2d');
    t2.globalCompositeOperation = 'source-over'; t2.clearRect(X0, Y0, w, h);
    t2.drawImage(titleBare, X0, Y0, w, h, X0, Y0, w, h);
    t2.globalCompositeOperation = 'destination-in';
    t2.drawImage(cc, 0, 0, w, h, X0, Y0, w, h);
    t2.globalCompositeOperation = 'source-over';
    m.drawImage(T.tmp, X0, Y0, w, h, X0, Y0, w, h);
    pc.getContext('2d').putImageData(paint, 0, 0);
    m.drawImage(pc, 0, 0, w, h, X0, Y0, w, h);
    m.restore();
    lc.getContext('2d').putImageData(glow, 0, 0);
    ga.drawImage(lc, 0, 0, w, h, X0*gw/W, Y0*gh/H, w*gw/W, h*gh/H);
  }
  }
  e.bg = T.mix; e.inkKey = null; paintPage(0);
  g0.globalCompositeOperation = 'source-over'; g0.globalAlpha = 1;
  g0.drawImage(T.acc, 0, 0);
  e.glowTex.needsUpdate = true; e.mat.emissiveIntensity = 1.4; e.glowing = true;
}
/* a puff of smoke off the title page at (px, py) */
function pagePuff(px, py){
  const { p, n: nrm } = pagePointWorld(0, px, py);
  const s = smokeNext; smokeNext = (smokeNext + 1) % SMOKE;
  smokePos[s*3] = p.x + nrm.x*0.01; smokePos[s*3+1] = p.y + nrm.y*0.01; smokePos[s*3+2] = p.z + nrm.z*0.01;
  smokeVel[s*3] = (Math.random() - 0.5)*0.03; smokeVel[s*3+1] = 0.16 + Math.random()*0.08; smokeVel[s*3+2] = (Math.random() - 0.5)*0.03;
  smokeWait[s] = 0; smokeKind[s] = 0; smokeAge[s] = 0; smokeLife[s] = 1.3 + Math.random()*0.8; smokeSeed[s] = Math.random();
}
/* the live book takes over from the film's last frame: the eye starts where the film's
   camera stood, cropped or letterboxed to this screen as the video was (intro.fit is
   object-fit), holds there while the pictures cross, then eases to this screen's own
   framing. A touch or a key hurries it, and the buttons and the invitation wait for it */
let camBlend = null;
const settled = intro ? (()=>{ let r; const p = new Promise(x=>r=x); return { p, r }; })() : null;
const BLEND_EVENTS = ['pointerdown', 'wheel', 'keydown'];
const hurryBlend = ()=>{ if(camBlend) camBlend.rate = 5; };
const settle = ()=>{
  document.documentElement.classList.remove('settling');
  for(const ev of BLEND_EVENTS) removeEventListener(ev, hurryBlend, { capture: true });
  if(settled) settled.r();
};
const _cq = new THREE.Quaternion();
function startCamBlend(pose, hold){
  if(!pose) return;
  const A = pose.aspect, B = VW/VH;
  const widthFits = intro.fit === 'contain' ? B < A : B > A;
  const t = Math.tan(pose.fov*Math.PI/360)*(widthFits ? A/B : 1);
  camBlend = { p: new THREE.Vector3().fromArray(pose.pos), q: new THREE.Quaternion().fromArray(pose.quat),
    fov: Math.atan(t)*360/Math.PI, t: -hold, d: 1.0, rate: 1 };
}
function stepCamBlend(dt){
  const B = camBlend;
  B.t += dt*B.rate;
  const k = easeSine(clamp(B.t/B.d, 0, 1));
  _cq.copy(camera.quaternion);
  camera.position.lerpVectors(B.p, camera.position, k);
  camera.quaternion.slerpQuaternions(B.q, _cq, k);
  camera.fov = lerp(B.fov, liveFov(), k);
  camera.updateProjectionMatrix();
  if(k >= 1){ camBlend = null; settle(); }
}
/* 'open': the film ran to its end, so the book lies open on its title page as the
   film left it, and then turns to the page last written on. 'closed': the film never
   played (no autoplay, reduced motion), its first frame stood in, and the book opens now */
function takeOver(mode, poses){
  const pose = poses && poses[intro.kind];
  if(mode === 'open'){ st.open = true; st.k = 0; }
  else { st.open = false; st.k = homeSpread(); }
  lastSig = '';
  st.theta = st.open ? OPEN : 0;
  spinGrp.quaternion.copy(homeQuat());
  spinGoal.copy(spinGrp.quaternion);
  orbit.az = orbit.azTo = orbit.el = orbit.elTo = 0;
  st.zoom = 1;
  layout(true);
  st.camD = fitDistance();
  camTarget.set(0, ROCK_TOP + 0.4, 0);
  onResize();
  for(let i=0;i<150;i++) update(1/30);
  startCamBlend(pose && (mode === 'open' ? pose.end : pose.start), 0.3);
  if(camBlend) for(const ev of BLEND_EVENTS) addEventListener(ev, hurryBlend, { capture: true, passive: true });
  else settle();
  refreshUI();
  frame();
  setTimeout(()=>{
    if(mode === 'open'){ if(homeSpread() !== st.k) seekSpread(homeSpread()); }
    else if(!st.open && !coverAnim) seekSpread(homeSpread(), { flourish: false });
  }, mode === 'open' ? 1300 : 1500);
}

/* ============================================================================
   17. boot
   ==========================================================================*/
async function boot(){
  try{
    await Promise.race([
      Promise.all([
        ...FONTS.map(f=>document.fonts.load(fontCss(f, 40), 'AaЯяЖж')),
        document.fonts.load('600 40px "Cormorant SC"', 'LIBER ARCANUM'),
        document.fonts.load('700 40px "Cormorant SC"', 'LIBER ARCANUM'),
        document.fonts.load('40px "UnifrakturMaguntia"', TITLE),
        ...FONTS.map(f=>document.fonts.load(capFont(f, 80), 'HIZЗЖВ')),
        document.fonts.load('italic 500 40px "Cormorant Garamond"', MOTTO.join(' '))
      ]),
      new Promise(r=>setTimeout(r, 4000))
    ]);
  }catch(e){}
  try{
    await loadAssets();
    if(intro && intro.stage) intro.stage(.88);
  }catch(e){
    const l = document.getElementById('introNote');
    if(l){ l.textContent = 'THE TOME COULD NOT BE KINDLED'; l.parentNode.classList.add('wait'); }
    throw e;
  }
  loadAll();
  shelf = createShelf({
    N, page: n => pages[n], handsOf, personalHand: BROWSER_HAND, toast, personalPages, applyPage,
    personalData, takePersonal, exportText, saveCopy,
    useBook: (key, hand)=> useBook(key, hand, !booted),
    settled: ()=> settled ? settled.p : Promise.resolve(),
    usePersonal: ()=> useBook(LS_KEY, BROWSER_HAND, !booted),
    refresh: ()=>{ if(writing && readOnly()) exitWriting(); refreshUI(); if(!menuEl.hidden) menuEl.querySelector('.menu-note').textContent = shelf.status(); },
    blurQuill: ()=>{ closeMenu(); if(writing) quill.blur(); },
    focusQuill: ()=>{ if(writing) quill.focus({ preventScroll: true }); },
    paper: invitePaper,
    sfx: (k, arg)=>{ if(sfx[k]) sfx[k](arg); },
  });
  shelf.start();
  /* the title page and the blanks were painted before the fonts arrived */
  blankMat[0].map.image = pageBackground(-2); blankMat[0].map.needsUpdate = true;
  blankMat[1].map.image = pageBackground(-1); blankMat[1].map.needsUpdate = true;
  pageCache.forEach((e,n)=>{ e.bg = pageBackground(n); paintPage(n); });
  if(FILM) st.open = false;
  await warmUp();
  if(intro){
    if(intro.stage) intro.stage(.95);
    const poses = await fetch('assets/intro/poses.json').then(r=>r.json()).catch(()=>null);
    window.__book.bootMs = Math.round(performance.now() - T0);
    await new Promise(r=>intro.ready(mode=>{ takeOver(mode, poses); r(); }));
  }else{
    st.theta = st.open ? OPEN : 0;
    spinGrp.quaternion.copy(homeQuat());
    spinGoal.copy(spinGrp.quaternion);
    layout(true);
    st.camD = fitDistance();
    camTarget.set(0, ROCK_TOP + 0.4, 0);
    onResize();
    refreshUI();
    frame();
    window.__book.bootMs = Math.round(performance.now() - T0);
  }
  booted = true;
  if(FILM){
    window.__book.film = { THREE, scene, renderer, st, orbit, setOpen, beam, beamU, BEAM_DIR, pageShine, frame, update, camera, frontGem, spinGrp, spinGoal, qOpenHome, fallers, emitOpenBurst, matGold, pagePointWorld, PAGE_W, PAGE_H, bookRoot, floatGrp, OPEN, frontGrp, CW, CH, CVR, titleReveal, matSpine, titleBurn, titleBurnPlan, pagePuff,
      render(){ renderer.shadowMap.needsUpdate = true; if(backdrop){ backdrop.material.uniforms.uCam.value.copy(camera.position); backdrop.draw(); } composer.render(0); } };
    import('./film.js?v=' + Date.now());
    return;
  }
  requestAnimationFrame(rafLoop);
}
document.fonts.addEventListener && document.fonts.addEventListener('loadingdone', ()=>{ pageCache.forEach((e,n)=>paintPage(n)); });

window.__book = { st, orbit, leaves, pages, composer, get backdrop(){ return backdrop; }, flip, setOpen, seekSpread, turnToPage, erasePages, restoreErased, quillTo, pour, enterWriting, exitWriting, pickAt, camera, scene, renderer, spinGrp, THREE, glideSpin, homeQuat,
  shelf: ()=> shelf,
  info(){ return { open:st.open, k:st.k, theta:st.theta, lift:+st.lift.toFixed(3), writing: writing && writing.n, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, cache: pageCache.size }; } };
boot();
