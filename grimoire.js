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
import {
  clamp, lerp, smooth, mulberry32, fbm, upsample, cv, normalFromHeight, tex,
  setMaxAniso, makeSpriteCanvas, makeRayAlpha, crackCanvas, fieldFromCanvas
} from './textures.js?v=4';

const T0 = performance.now();
const easeIO = t => t<.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
const easeSine = t => 0.5 - 0.5*Math.cos(Math.PI*t);
/* a leaf is lifted briskly and comes down slowly on its cushion of air */
const easeFlip = t => 1 - Math.pow(1 - easeSine(t), 1.35);
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
const RB = T/1.2;                  // radius of the spine back when open
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

/* one hand for the whole book: Latin in Fondamento, a calligraphic book hand,
   Russian in Ponomar, an Old Russian half-uncial; the canvas picks per glyph
   from the stack. Initials are Fraktur capitals, Triodion for Cyrillic. */
const FONTS = [
  { id:'chronicle', name:'Chronicle', css:'"Fondamento", "Ponomar"', capCss:'"UnifrakturMaguntia", "Triodion"',
    weight:400, style:'normal', size:42 }
];
const fontById = id => FONTS.find(f=>f.id===id) || FONTS[0];
const capFont = (f, size) => `${Math.round(size)}px ${f.capCss || f.css}, ${f.css}, serif`;
const fontCss = (f, size, weight) => `${f.style==='italic'?'italic ':''}${weight||f.weight} ${Math.round(size)}px ${f.css}, "Cormorant Garamond", serif`;

const ASSETS = {
  forest: HI_RES ? 'assets/forest/forest.jpg' : 'assets/forest/forest_4k.jpg',
  forestDepth: 'assets/forest/depth.png', forestWater: 'assets/forest/water.png', forestLight: 'assets/forest/light.hdr',
  forestBack: 'assets/forest/back.jpg', forestBackDepth: 'assets/forest/back_depth.png', forestNear: 'assets/forest/near.json',
  brook: 'assets/audio/forest_brook.wav', magicBed: 'assets/audio/magic_forest.wav',
  twinkles: ['assets/audio/twinkle_a.mp3', 'assets/audio/twinkle_b.mp3', 'assets/audio/twinkle_c.mp3'],
  leaAlbedo: 'assets/leather/brown_leather_albedo_2k.jpg', leaNor: 'assets/leather/brown_leather_nor_gl_2k.jpg',
  leaRough: 'assets/leather/brown_leather_rough_2k.jpg',
  goldFront: 'models/gold_front.glb?v=2', goldBack: 'models/gold_back.glb?v=2',
  maskFront: 'models/gold_front_mask.png?v=2', maskBack: 'models/gold_back_mask.png?v=2',
  rock: 'models/rock.glb?v=2',
  granite: 'assets/rock/granite.jpg', moss: 'assets/rock/moss.jpg'
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
const DPR = Math.min(devicePixelRatio, 2);
renderer.setPixelRatio(DPR);
renderer.setSize(VW, VH, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
const sun = new THREE.DirectionalLight(0xfff2e2, 2.3);
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
/* a shaft of sun through the canopy, landing on the right-hand page */
const beam = new THREE.SpotLight(0xffe2b8, 1.8, 0, 0.15, 1.0, 0);
beam.position.copy(SUN_DIR).multiplyScalar(20).add(new THREE.Vector3(1.4, 0, -0.2));
beam.target.position.set(1.6, 0, -0.3);
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

/* post: bloom for the gilt and the magic, then a warm grade */
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(VW*DPR, VH*DPR, { type: THREE.HalfFloatType, samples: 4 }));
composer.setPixelRatio(DPR);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(VW, VH), 0.34, 0.6, 0.9);
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
  return { base: c, normalTex: tex(normalFromHeight(hf,S,S,3.0), {rx:2.5, ry:2.5}) };
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
const matEndpaper = new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.7, metalness: 0, side: THREE.DoubleSide });

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
    const h = 7*SC, w = 3.6*SC;
    ctx.beginPath(); ctx.moveTo(0, -h); ctx.lineTo(0, h);
    const kind = Math.floor(rnd()*6);
    if(kind === 0){ ctx.moveTo(0, -h); ctx.lineTo(w, -h*0.3); }
    else if(kind === 1){ ctx.moveTo(0, -h*0.4); ctx.lineTo(w, -h); ctx.moveTo(0, h*0.2); ctx.lineTo(w, -h*0.4); }
    else if(kind === 2){ ctx.moveTo(-w, -h*0.5); ctx.lineTo(w, h*0.5); }
    else if(kind === 3){ ctx.moveTo(0, -h); ctx.lineTo(w, -h*0.5); ctx.lineTo(0, 0); }
    else if(kind === 4){ ctx.moveTo(-w, -h); ctx.lineTo(0, -h*0.3); ctx.lineTo(w, -h); }
    else { ctx.moveTo(0, -h*0.2); ctx.lineTo(-w, h*0.6); ctx.moveTo(0, -h*0.2); ctx.lineTo(w, h*0.6); }
    ctx.stroke();
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
  if(n >= 0){
    ctx.fillStyle = PINK(.8);
    ctx.font = `italic 500 ${13*SC}px "Cormorant Garamond", serif`;
    ctx.textAlign = 'center';
    ctx.fillText(String(n+1), PAGE_W/2, 458*SC);
    ctx.textAlign = 'left';
  }
  if(n === 0) drawTitle(ctx);
  return c;
}
function drawTitle(ctx){
  divider(ctx, PAGE_W/2, 108*SC, 62, SC);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(40,22,8,.92)';
  ctx.shadowColor = 'rgba(40,22,8,.35)'; ctx.shadowBlur = 2;
  ctx.font = `${46*SC}px "UnifrakturMaguntia", "Cormorant SC", serif`;
  ctx.fillText('Liber Arcanum', PAGE_W/2, 152*SC);
  ctx.restore();
  divider(ctx, PAGE_W/2, 172*SC, 62, SC);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = PINK(.85);
  ctx.font = `italic 500 ${15*SC}px "Cormorant Garamond", serif`;
  ctx.fillText('a book of secret writings', PAGE_W/2, 204*SC);
  ctx.restore();
  divider(ctx, PAGE_W/2, 218*SC, 26, SC*0.8);
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
  const size = f.size*FS, lh = Math.round(size*1.38);
  measCtx.font = fontCss(f, size);
  const lines = [];
  let cap = null;
  const first = text.charAt(0);
  if(first && !box.flow && /\p{L}/u.test(first)){
    /* a raised initial: a big figured capital standing on the first line's
       baseline, the rest of the word running on from it */
    const capSize = size*2.45;
    measCtx.font = capFont(f, capSize);
    const cw = measCtx.measureText(first).width;
    cap = { ch:first, size:capSize, w: cw + size*0.06, lines:1, x: box.x };
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
const GLOW_T = 0.95;
const lineText = (text, ln)=> text.slice(ln.start + (ln.skip||0), ln.end);
/* every glowing letter, with its age 0..1 */
function eachBurning(lay, text, born, now, fn){
  if(!born) return;
  for(let i=0;i<text.length;i++){
    const age = (now - (born[i]||0))/1000;
    if(age >= GLOW_T || age < 0) continue;
    const ch = text[i]; if(ch === ' ' || ch === '\n') continue;
    const gb = glyphBox(lay, text, i); if(!gb) continue;
    fn(gb, age/GLOW_T);
  }
}
/* paints one burning letter exactly as the ink has it: the whole line is
   redrawn through a clip around that letter, so kerning and ligatures match */
function paintThroughClip(ctx, lay, text, gb){
  ctx.save();
  ctx.beginPath();
  if(gb.cap){
    const c = lay.cap;
    ctx.rect(c.x - lay.size*0.2, c.y - c.size*0.95, c.w + lay.size*0.2, c.size*1.2);
    ctx.clip();
    ctx.font = capFont(lay.f, c.size);
    ctx.fillText(c.ch, c.x, c.y);
  }else{
    ctx.rect(gb.x - 0.5, gb.y - lay.size*1.05, gb.w + 1, lay.lh);
    ctx.clip();
    ctx.font = fontCss(lay.f, lay.size);
    ctx.fillText(lineText(text, gb.ln), gb.ln.x0, gb.ln.y);
  }
  ctx.restore();
}
/* iron-gall ink soaks into the vellum unevenly: a fibre mask for its density
   and a few browner pools where the quill ran dry */
let inkMask = null, inkTint = null, inkLayer = null;
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
}
/* the initial in the scribe's own ink: a figured capital with a fine inline
   left in reserve, and pen flourishes curling off into the margin. Drawn into
   the ink layer, so it soaks into the sheet exactly like the text. */
function drawInitial(ctx, lay){
  const c = lay.cap, f = lay.f, size = lay.size;
  ctx.save();
  ctx.font = capFont(f, c.size);
  const x = c.x, y = c.y, top = y - c.size*0.72;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = INK; ctx.fillStyle = INK;
  /* penwork: a stem down the margin with curls and pearls, a sprig over the cap */
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = Math.max(1.2, size*0.03);
  const sx = x - size*0.3;
  ctx.beginPath(); ctx.moveTo(sx, top + size*0.15);
  ctx.bezierCurveTo(sx - size*0.12, top + c.size*0.5, sx + size*0.08, y + lay.lh*0.4, sx - size*0.04, y + lay.lh*1.2);
  ctx.stroke();
  ctx.beginPath(); spiralPath(ctx, sx + size*0.12, y + lay.lh*1.2, size*0.16, size*0.03, Math.PI, 1.3, -1); ctx.stroke();
  ctx.beginPath(); spiralPath(ctx, sx + size*0.14, top + size*0.04, size*0.14, size*0.03, Math.PI*1.1, 1.25, 1); ctx.stroke();
  [[0.42, 0.14], [0.6, -0.1], [0.8, 0.12]].forEach(([t, dx])=>{
    const py = top + (y + lay.lh*1.2 - top)*t;
    ctx.beginPath(); ctx.arc(sx + dx*size, py, size*0.03, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(sx, py); ctx.quadraticCurveTo(sx - size*0.17, py - size*0.1, sx - size*0.22, py + size*0.04); ctx.stroke();
  });
  ctx.beginPath(); ctx.moveTo(x + c.w*0.3, top - size*0.1);
  ctx.bezierCurveTo(x + c.w*0.55, top - size*0.42, x + c.w*0.95, top - size*0.32, x + c.w*1.05, top - size*0.08);
  ctx.stroke();
  ctx.beginPath(); spiralPath(ctx, x + c.w*1.12, top - size*0.02, size*0.1, size*0.02, Math.PI*1.2, 1.2, 1); ctx.stroke();
  /* the capital, with a hairline inline knocked out of its body */
  ctx.globalAlpha = 1;
  ctx.fillText(c.ch, x, y);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth = Math.max(1, c.size*0.012);
  ctx.globalAlpha = 0.85;
  ctx.save();
  ctx.translate(c.size*0.012, -c.size*0.012);
  ctx.strokeText(c.ch, x, y);
  ctx.restore();
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
  /* a faint bleed into the fibres, then the ink itself, multiplied so the
     grain of the sheet shows through every stroke */
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.filter = `blur(${(1.1*FS).toFixed(2)}px)`;
  ctx.drawImage(inkLayer, 0, 0);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(inkLayer, 0, 0);
  ctx.restore();
}
/* what changes from frame to frame: selection, the letters still warm, the caret */
function drawInkOverlay(ctx, text, lay, sel, born, now){
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
  /* a fresh letter is warm amber for a moment, then cools into the ink */
  if(born && now){
    ctx.save();
    ctx.fillStyle = '#c8893a';
    eachBurning(lay, text, born, now, (gb, age)=>{
      ctx.globalAlpha = 0.65*(1 - smooth(age));
      paintThroughClip(ctx, lay, text, gb);
    });
    ctx.restore();
  }
  if(sel && sel.caret){
    const c = caretXY(lay, sel.b);
    ctx.fillStyle = INK;
    ctx.fillRect(c.x - 1.4*FS, c.y - size*0.82, 2.8*FS, size*1.06);
  }
}
/* the glow layer: emissive, half resolution, only what is burning right now */
function drawGlow(ctx, text, lay, born, now, caret){
  const k = 0.5;
  ctx.clearRect(0,0,ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.scale(k, k);
  let any = false;
  eachBurning(lay, text, born, now, (gb, age)=>{
    any = true;
    const a = 1 - smooth(age);
    ctx.globalAlpha = a*0.45;
    ctx.shadowColor = 'rgba(255,170,80,1)'; ctx.shadowBlur = 4;
    ctx.fillStyle = 'rgb(255,196,120)';
    paintThroughClip(ctx, lay, text, gb);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = a*0.7;
    ctx.fillStyle = 'rgb(255,226,170)';
    paintThroughClip(ctx, lay, text, gb);
  });
  if(caret){
    const pulse = 0.3 + 0.12*Math.sin(now/220);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = 'rgb(255,214,140)';
    ctx.fillRect(caret.x - 1.2*FS, caret.y - lay.size*0.82, 2.4*FS, lay.size*1.06);
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
  roughnessMap: gilt().pbr, metalnessMap: gilt().pbr
});
/* n = -2 / -1: an unnumbered recto / verso */
const blankMat = [pageMaterial(pageBackground(-2)), pageMaterial(pageBackground(-1))];

const pageCache = new Map();          // n -> { bg, canvas, glow, tex, glowTex, mat, used, lay }
const CACHE_MAX = HI_RES ? 10 : 12;
function pageEntry(n){
  let e = pageCache.get(n);
  if(!e){
    const canvas = cv(PAGE_W, PAGE_H);
    const glow = cv(PAGE_W/2, PAGE_H/2);
    const mat = pageMaterial(canvas);
    const glowTex = tex(glow, {srgb:true, wrap:false});
    mat.emissive = new THREE.Color(0xffd08a);
    mat.emissiveMap = glowTex;
    mat.emissiveIntensity = 0;
    e = { bg: pageBackground(n), canvas, glow, tex: mat.map, glowTex, mat, used: 0, lay: null, glowing: false };
    pageCache.set(n, e);
    paintPage(n);
  }
  e.used = performance.now();
  return e;
}
function trimCache(keep){
  if(pageCache.size <= CACHE_MAX) return;
  const list = [...pageCache.entries()].filter(([n])=>!keep.has(n)).sort((a,b)=>a[1].used-b[1].used);
  while(pageCache.size > CACHE_MAX && list.length){
    const [n, e] = list.shift();
    e.tex.dispose(); e.glowTex.dispose(); e.mat.dispose();
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
  const fade = pages[n].fade;
  if(fade) fadeInk(ctx, n, fade, now);
  let sel = null, caret = null;
  if(editing){
    const a = quill.selectionStart, b = quill.selectionEnd;
    sel = { a:Math.min(a,b), b:Math.max(a,b), caret: caretOn && a === b };
    if(a === b){ sel.b = a; caret = caretXY(lay, a); }
  }
  drawInkOverlay(ctx, pages[n].t, lay, sel, pages[n].born, now);
  e.tex.needsUpdate = true;
  let lit = drawGlow(e.glow.getContext('2d'), pages[n].t, lay, pages[n].born, now, caret);
  if(fade && fadeGlow(e.glow.getContext('2d'), fade, now)) lit = true;
  if(lit || e.glowing){
    e.glowTex.needsUpdate = true;
    e.mat.emissiveIntensity = lit ? 0.6 : 0;
  }
  e.glowing = lit;
  /* only the page under the quill keeps its composed ink in memory */
  if(!editing && !burning.has(n)){ e.inked = null; e.inkKey = null; }
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
  const g = new THREE.ExtrudeGeometry(roundedRectShape(CW, CH, 0.03, 0.10), {
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
function sapphire(scale){
  const grp = new THREE.Group();
  const dome = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI*2, 0, Math.PI/2);
  dome.rotateX(Math.PI/2);
  const gem = new THREE.Mesh(dome,
    new THREE.MeshPhysicalMaterial({
      color: 0x1d4fb8, metalness: 0.1, roughness: 0.06, ior: 1.77, specularIntensity: 1.0,
      clearcoat: 1.0, clearcoatRoughness: 0.02, envMapIntensity: 2.6, sheen: 0.4, sheenColor: new THREE.Color(0x9cc4ff),
      emissive: new THREE.Color(0x0b2f8a), emissiveIntensity: 0.55 }));
  gem.scale.set(0.21, 0.29, 0.16);
  gem.position.z = -0.02;
  grp.add(gem);
  const bezelMat = matGold;
  const bez = new THREE.Mesh(new THREE.TorusGeometry(1, 0.075, 16, 64), bezelMat);
  bez.scale.set(0.228, 0.31, 0.45); bez.position.z = 0.02;
  grp.add(bez);
  for(let i=0;i<4;i++){
    const a = Math.PI/4 + i*Math.PI/2;
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 10), bezelMat);
    p.position.set(Math.cos(a)*0.20, Math.sin(a)*0.275, 0.03);
    grp.add(p);
  }
  grp.scale.setScalar(scale);
  grp.userData.gem = gem;
  return grp;
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
  const gm = sapphire(0.6);
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
  frontGem = sapphire(1.0); frontGem.position.set(CW/2, 0, CVR + 0.012);
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
function paintSpine(tile){
  const SW = 512, SH = 1536;
  const sc = cv(SW,SH), x = sc.getContext('2d');
  for(let y=0;y<SH;y+=SW) x.drawImage(tile, 0, y, SW, SW);
  const gilt = (y0, y1)=>{ const g = x.createLinearGradient(0,y0,0,y1); g.addColorStop(0,'#fbe6ad'); g.addColorStop(.5,'#d7a64d'); g.addColorStop(1,'#7f5a1c'); return g; };
  BANDS.forEach(v=>{
    const y = (1-v)*SH, bh = SH*0.026;
    x.fillStyle='rgba(0,0,0,.18)'; x.fillRect(0, y-bh/2, SW, bh);
    [-bh/2-5, bh/2+5].forEach(dy=>{ x.fillStyle = gilt(y+dy-2, y+dy+2); x.fillRect(SW*0.06, y+dy-1.6, SW*0.88, 3.2); });
    x.fillStyle = gilt(y-3, y+3);
    for(let px=SW*0.1; px<SW*0.9; px+=14){ x.beginPath(); x.arc(px, y, 2.2, 0, 7); x.fill(); }
  });
  /* a canvas pixel across the round covers less leather than one along the spine:
     draw wide by that ratio so the lettering lands undistorted */
  const stretch = (SW*(1 - 2*SP_UV_EDGE)/spineArc)/(SH/CH);
  const across = SW*(1 - 2*SP_UV_EDGE);
  /* each word fills at most two thirds of the round and half its panel's height */
  const title = (word, v0, v1, size)=>{
    const y = (1-(v0+v1)/2)*SH;
    x.font = `700 ${size}px "Cormorant SC", serif`;
    const w = x.measureText(word).width*stretch;
    const fit = Math.min(1, across*0.66/w, (v1 - v0)*SH*0.5/size);
    const s2 = Math.floor(size*fit);
    x.save(); x.translate(SW/2, y); x.scale(stretch, 1);
    x.font = `700 ${s2}px "Cormorant SC", serif`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = 'rgba(0,0,0,.55)'; x.fillText(word, 1.2, 2);
    x.fillStyle = gilt(-s2/2, s2/2); x.fillText(word, 0, 0);
    x.restore();
    return s2;
  };
  /* the title in the second and third panels from the head, between fine gilt rules */
  const rule = (v)=>{ const y = (1-v)*SH; x.fillStyle = gilt(y-1.5, y+1.5); x.fillRect(across*0.2 + SW*SP_UV_EDGE, y-1.2, across*0.6, 2.4); };
  title('LIBER', BANDS[2], BANDS[3], 120);
  title('ARCANUM', BANDS[1], BANDS[2], 120);
  [BANDS[2] + 0.025, BANDS[3] - 0.025, BANDS[1] + 0.025, BANDS[2] - 0.025].forEach(rule);
  /* fleurons in the other panels, sized to the round */
  const fleuron = (v)=>{
    const y = (1-v)*SH, k = Math.min(1.1, across*0.42/(76*stretch));
    x.save(); x.translate(SW/2, y); x.scale(stretch*k, k);
    x.fillStyle = gilt(-40, 40); x.strokeStyle = gilt(-40,40); x.lineWidth = 2;
    for(let q=0;q<4;q++){
      x.save(); x.rotate(q*Math.PI/2);
      x.beginPath(); x.moveTo(0,-4); x.bezierCurveTo(9,-14,6,-30,0,-38); x.bezierCurveTo(-6,-30,-9,-14,0,-4); x.fill();
      x.beginPath(); spiralPath(x, 10, -16, 7, 1.5, Math.PI, 1.2, 1); x.stroke();
      x.beginPath(); spiralPath(x, -10, -16, 7, 1.5, 0, 1.2, -1); x.stroke();
      x.restore();
    }
    x.beginPath(); x.arc(0,0,5,0,7); x.fill();
    x.restore();
  };
  fleuron((BANDS[3] + 1)/2); fleuron((BANDS[0] + BANDS[1])/2); fleuron(BANDS[0]/2);
  const vig = x.createLinearGradient(0,0,SW,0);
  vig.addColorStop(0,'rgba(3,5,10,.55)'); vig.addColorStop(SP_UV_EDGE + 0.03,'rgba(3,5,10,0)');
  vig.addColorStop(1 - SP_UV_EDGE - 0.03,'rgba(3,5,10,0)'); vig.addColorStop(1,'rgba(3,5,10,.55)');
  x.fillStyle = vig; x.fillRect(0,0,SW,SH);
  matSpine.map = tex(sc, {srgb:true, wrap:false});
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
/* tight back: the hide runs from the back board, round the sewn backs of the
   leaves (offset outwards by BACK_GAP), to the front board. Closed it is the
   rounded spine; open it arches up under the gutter, as a real one does. */
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
  const LAPN = 5;
  for(let i=0;i<LAPN;i++){ const t=i/LAPN; P.push([ax + SP_LAP*(1-t), az, 0]); }
  /* each board edge rounds onto the nearest sewn back: a quadratic whose
     control point runs back along the board, so the hide leaves it tangentially */
  const L0 = back[0], L1 = back[back.length-1];
  const TR = 8;
  const dA = Math.max(0, ax - L0[0]);
  const cAx = ax - dA, cAz = az;
  for(let i=0;i<TR;i++){
    const t = i/TR, u = 1-t;
    P.push([u*u*ax + 2*u*t*cAx + t*t*L0[0], u*u*az + 2*u*t*cAz + t*t*L0[1], t]);
  }
  const NB = SP_U + 1 - 2*LAPN - 2*TR;
  for(let i=0;i<NB;i++){
    const f = i/(NB-1)*(back.length-1);
    const a = back[Math.floor(f)], b = back[Math.min(back.length-1, Math.floor(f)+1)], t = f - Math.floor(f);
    P.push([lerp(a[0],b[0],t), lerp(a[1],b[1],t), 1]);
  }
  const dB = Math.max(0, (bx - L1[0])*C.dx + (bz - L1[1])*C.dz);
  const cBx = bx - C.dx*dB, cBz = bz - C.dz*dB;
  for(let i=1;i<=TR;i++){
    const t = i/TR, u = 1-t;
    P.push([u*u*L1[0] + 2*u*t*cBx + t*t*bx, u*u*L1[1] + 2*u*t*cBz + t*t*bz, 1-t]);
  }
  for(let i=1;i<=LAPN;i++){ const t=i/LAPN; P.push([bx + C.dx*SP_LAP*t, bz + C.dz*SP_LAP*t, 0]); }
  for(let i=0;i<=SP_U;i++){
    const a = P[Math.max(0,i-1)], b = P[Math.min(SP_U,i+1)];
    let tx = b[0]-a[0], tz = b[1]-a[1];
    const l = Math.hypot(tx,tz) || 1; tx/=l; tz/=l;
    _sp.px[i]=P[i][0]; _sp.pz[i]=P[i][1]; _sp.nx[i]=-tz; _sp.nz[i]=tx; _sp.w[i]=smooth(clamp(P[i][2],0,1));
  }
  /* the leather's artwork is laid by arc length: the round of the back (board edge to
     board edge) takes the middle of the canvas, the laps onto the boards its margins,
     so lettering keeps its shape and never wraps under the boards */
  const r0 = LAPN, r1 = SP_U - LAPN;
  let arc = 0;
  _sp.u[r0] = 0;
  for(let i=r0+1;i<=r1;i++){ arc += Math.hypot(P[i][0]-P[i-1][0], P[i][1]-P[i-1][1]); _sp.u[i] = arc; }
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
      const off = 0.0035 + bump*_sp.w[i];
      pos.setXYZ(j*(SP_U+1)+i, _sp.px[i] + _sp.nx[i]*off, y, _sp.pz[i] + _sp.nz[i]*off);
    }
  }
  pos.needsUpdate = true;
  spineGeo.computeVertexNormals();
  spineGeo.computeBoundingSphere();
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
  /* hand-cut leaves: no two are quite the same size, so the edges are uneven */
  const len = PW*(1 - 0.011*rnd());
  const yb = -PH/2 + 0.009*(rnd()-0.35), yt = PH/2 - 0.009*(rnd()-0.35);
  const tint = 0.84 + rnd()*0.2;
  for(let v=0;v<V_CNT;v++){
    const wallV = v >= 2*A_CNT;
    col[v*3]   = wallV ? 0.84*tint : 1;
    col[v*3+1] = wallV ? 0.68*tint : 1;
    col[v*3+2] = wallV ? 0.42*tint*(0.92+rnd()*0.1) : 1;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm,3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv,2));
  g.setAttribute('color', new THREE.BufferAttribute(col,3));
  g.setIndex(leafIndex.list);
  g.addGroup(0, leafIndex.nTop, 0);
  g.addGroup(leafIndex.nTop, leafIndex.nBot, 1);
  g.addGroup(leafIndex.nTop + leafIndex.nBot, leafIndex.nWall, 2);
  const mesh = new THREE.Mesh(g, [blankMat[0], blankMat[1], matLeafEdge]);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.userData = { grab:'leaf', leaf:i };
  bookRoot.add(mesh);
  leaves.push({ i, mesh, geo:g, pos, nrm, sig:'', a0:0, len, ds: len/M, yb, yt, flt: 9 });
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
function restParams(C, i, left, H){
  let rise, q;
  if(!left){
    rise = (EPS + (N-1-i+0.5)*LT) - (H.z - ZB);
    q = (N - C.sigma) > 0.5 ? (N-1-i)/(N - C.sigma) : 0;
  }else{
    rise = (EPS + (i+0.5)*LT) - ((H.x-C.ex)*C.nx + (H.z-C.ez)*C.nz);
    q = C.sigma > 0.5 ? i/C.sigma : 0;
  }
  const ell = clamp(0.45 + 2.2*Math.abs(rise), 0.45, 0.8*PW);
  /* a leaf that has just landed shivers once before it lies still */
  const t = leaves[i].flt, flutter = t < 0.75 ? 0.08*Math.exp(-t*6)*Math.abs(Math.sin(t*16)) : 0;
  return { phi0: solvePhi(rise/ell), ell, fan: FAN*clamp(q,0,1)*C.b*C.b + flutter, left, theta: C.theta };
}
function restAngle(P, s){
  const fanW = smooth(clamp((s/PW - 0.62)/0.38, 0, 1));
  const beta = P.phi0*gFn(s/P.ell) + P.fan*fanW;
  return P.left ? P.theta - beta : beta;
}
/* a leaf in flight: blend of its two rest shapes plus a curl along the arc,
   held between the two rests so it can never cut into either stack */
function flightAngle(PR, PL, p, curl, s){
  const aR = restAngle(PR, s), aL = restAngle(PL, s);
  const a = lerp(aR, aL, p) + curl*Math.pow(s/PW, 1.3);
  return clamp(a, Math.min(aR,aL), Math.max(aR,aL));
}
const TWIST = 0.55;
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
  flight: null,       // { j, p, dragging, curl, vel, gy, anim }
  open: false,
  zoom: 1, camD: 14,
  bob: 1,
  lift: 0,
  focus: 0, focusTo: 0, focusSide: 1,  // the camera leaning in over the page being written
  thetaVel: 0,
  hover: 0, hoverTo: 0, aura: 0, auraTo: 0, glow: 0, glowTo: 0, gemFlare: 0   // the opening's quiet magic
};
const queue = [];
const _H = { x:0, z:0 };
let lastSig = '';
function currentSigma(){ return st.flight ? st.flight.j + st.flight.p : st.k; }

function layout(force){
  const fl = st.flight;
  const sigma = currentSigma();
  const fluttering = leaves.reduce((a, L)=> L.flt < 0.75 ? a + L.flt : a, 0);
  const sig = `${st.theta.toFixed(5)}|${sigma.toFixed(5)}|${fl ? fl.curl.toFixed(4)+','+fl.gy.toFixed(3) : ''}|${fluttering.toFixed(3)}`;
  if(!force && sig === lastSig) return;
  lastSig = sig;
  const C = layoutCtx(sigma, st.theta);

  backGrp.position.set(C.xb, 0, ZB);
  frontGrp.position.set(C.ex, 0, C.ez);
  frontGrp.rotation.y = -C.theta;

  for(let i=0;i<N;i++){
    const L = leaves[i];
    hingeOf(C, i, _H);
    if(fl && i === fl.j){
      const PR = restParams(C, i, false, _H), PL = restParams(C, i, true, _H);
      for(let r=0;r<=R;r++){
        const yN = -1 + 2*r/R;
        const cr = fl.curl*(1 + TWIST*fl.gy*yN);
        integrate(_H.x, _H.z, s=>flightAngle(PR, PL, fl.p, cr, s), _X[r], _Z[r], _A[r], L.ds);
      }
      writeLeaf(L, true);
      L.sig = '';
      L.a0 = _A[R>>1][0];
    }else{
      const left = i < (fl ? fl.j : st.k);
      const P = restParams(C, i, left, _H);
      const s2 = `${_H.x.toFixed(5)},${_H.z.toFixed(5)},${P.phi0.toFixed(5)},${P.ell.toFixed(4)},${P.fan.toFixed(4)},${left?C.theta.toFixed(5):'r'}`;
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
  /* endpaper joints: board spine edge -> first / last leaf's sewing */
  const joint = (mesh, sx, sz, dx, dz, hx, hz)=>{
    const p = mesh.geometry.attributes.position;
    const ax = sx + dx*EP_X0, az = sz + dz*EP_X0;
    for(let c=0;c<10;c++){
      const t = c/9, u = 1-t;
      const x = u*u*ax + 2*u*t*sx + t*t*hx, z = u*u*az + 2*u*t*sz + t*t*hz;
      p.setXYZ(c, x, -JOINT_H/2, z); p.setXYZ(10+c, x, JOINT_H/2, z);
    }
    p.needsUpdate = true; mesh.geometry.computeVertexNormals();
  };
  hingeOf(C, 0, _H);
  joint(jointF, C.ex + C.nx*0.0015, C.ez + C.nz*0.0015, C.dx, C.dz, _H.x, _H.z);
  hingeOf(C, N-1, _H);
  joint(jointB, C.xb, ZB + 0.0015, 1, 0, _H.x, _H.z);
}

/* which page textures are live, and which leaves cast shadows */
function updateVisibility(){
  const c = st.flight ? st.flight.j : st.k;
  const keep = new Set();
  const open = st.theta > 0.02;
  for(let i=0;i<N;i++){
    const L = leaves[i];
    const near = open && i >= c-2 && i <= c+1;
    const mats = L.mesh.material;
    if(near){
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

function homeQuat(){ return st.open ? qOpenHome : qClosedHome; }
function camElevation(){ return lerp(0.26, 0.9, smooth(clamp(st.theta/OPEN,0,1))); }
function fitDistance(){
  const b = smooth(clamp(st.theta/OPEN,0,1));
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
function atHome(){ return (spinAnim && spinAnim.settle) || spinGoal.angleTo(homeQuat()) < 0.05; }

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
function serialise(){
  const out = {};
  pages.forEach((p,n)=>{ if(p.t || p.f) out[n] = p.c ? { t:p.t, f:p.f, c:1 } : { t:p.t, f:p.f }; });
  return { pages: out, open: st.open, k: st.k, font: defaultFont, fv: 4 };
}
function saveNow(quiet){
  clearTimeout(saveTm);
  try{
    localStorage.setItem(LS_KEY, JSON.stringify(serialise()));
    if(!quiet) toast('✒  INSCRIBED');
  }catch(e){ toast('COULD NOT SAVE', 2200); }
}
function saveSoon(quiet){ clearTimeout(saveTm); saveTm = setTimeout(()=>saveNow(quiet), 450); }
function applyData(d){
  pages.forEach(p=>{ p.t=''; p.f=null; p.born=null; p.c=false; });
  if(d && d.pages) Object.entries(d.pages).forEach(([n,v])=>{
    const i = n|0;
    if(i>=0 && i<pages.length && v){ pages[i].t = String(v.t||'').slice(0, 6000); pages[i].f = FONTS.some(f=>f.id===v.f) ? v.f : null; pages[i].c = !!v.c; }
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
    st.open = !!d.open;
    st.k = clamp(d.k|0, 0, N);
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
function exportFile(){
  saveNow(true);
  const data = { format:'liber-arcanum', version:2, savedAt:new Date().toISOString(), ...serialise() };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `liber-arcanum-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  toast('BOOK SAVED TO FILE', 1800);
}
/* ============================================================================
   10. writing
   ==========================================================================*/
const quill = document.getElementById('quill');
let writing = null;           // { n }
let caretOn = true, composing = false;
let lastGood = { v:'', a:0, b:0 };
const hintEl = document.getElementById('hint');
const pageNoEl = document.getElementById('pageNo');
const burning = new Set();    // pages with letters still glowing

function enterWriting(n, idx){
  if(writing && writing.n !== n) exitWriting(true);
  const fresh = !writing;
  writing = { n };
  pageEntry(n);
  if(fresh) quill.value = pages[n].t;
  const i = clamp(idx === undefined ? quill.value.length : idx, 0, quill.value.length);
  quill.focus({ preventScroll:true });
  quill.setSelectionRange(i, i);
  lastGood = { v:quill.value, a:i, b:i };
  caretOn = true; blinkPhase = 0;
  st.bob = 0;
  burning.add(n);
  paintPage(n);
  refreshUI();
}
function exitWriting(keepFocus){
  if(!writing) return;
  const n = writing.n;
  writing = null;
  if(!keepFocus){ quill.blur(); st.focusTo = 0; }
  paintPage(n);
  saveNow(true);
  st.bob = 1;
  refreshUI();
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
  const n = writing.n, v = quill.value;
  const lay = layoutText(v, pageFont(n), textBox(n));
  if(!lay.ok){
    const res = pour(n, v, quill.selectionEnd);
    if(!res){
      quill.value = lastGood.v;
      quill.setSelectionRange(lastGood.a, lastGood.b);
      toast('THE BOOK IS FULL', 2000);
      return;
    }
    trackBirths(n, pages[n].t, v);
    applyPour(n, res);
    return;
  }
  const ins = trackBirths(n, pages[n].t, v);
  pages[n].t = v;
  if(!v) pages[n].c = false;
  if(!pages[n].f) pages[n].f = defaultFont;
  lastGood = { v, a:quill.selectionStart, b:quill.selectionEnd };
  caretOn = true; blinkPhase = 0;
  burning.add(n);
  document.fonts.load(fontCss(pageFont(n), 40), v.slice(-24) || 'a').then(()=>{ if(pageCache.has(n)) paintPage(n); }).catch(()=>{});
  paintPage(n);
  if(ins.count > 0 && ins.count < 40){
    emitSparks(n, lay, v, ins.at, ins.count);
    sfx.quill();
    if(/[.!?]/.test(v.charAt(ins.at + ins.count - 1))) sfx.chime();
  }
  saveSoon(false);
}
quill.addEventListener('input', onQuillInput);
quill.addEventListener('compositionstart', ()=>{ composing = true; });
quill.addEventListener('compositionend', ()=>{ composing = false; onQuillInput(); });
const onSel = ()=>{ if(writing){ caretOn = true; blinkPhase = 0; lastGood.a = quill.selectionStart; lastGood.b = quill.selectionEnd; paintPage(writing.n); } };
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

/* sparks rising from a freshly written letter */
const SPARKS = 240;
const sparkGeo = new THREE.BufferGeometry();
const sparkPos = new Float32Array(SPARKS*3), sparkVel = new Float32Array(SPARKS*3), sparkLife = new Float32Array(SPARKS);
const sparkAlpha = new Float32Array(SPARKS);
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
const sparks = new THREE.Points(sparkGeo, sparkMat);
sparks.frustumCulled = false;
scene.add(sparks);
let sparkNext = 0;
function emitSparks(n, lay, text, at, count){
  for(let i=at; i<at+count; i++){
    const gb = glyphBox(lay, text, i);
    if(!gb) continue;
    const { p, n: nrm } = pagePointWorld(n, gb.x + gb.w*0.5, gb.y - lay.size*0.35);
    for(let k=0;k<2;k++){
      const s = sparkNext; sparkNext = (sparkNext+1) % SPARKS;
      sparkPos[s*3] = p.x; sparkPos[s*3+1] = p.y; sparkPos[s*3+2] = p.z;
      const sp = 0.18 + Math.random()*0.25;
      sparkVel[s*3]   = nrm.x*sp + (Math.random()-0.5)*0.35;
      sparkVel[s*3+1] = nrm.y*sp + (Math.random()-0.5)*0.35 + 0.15;
      sparkVel[s*3+2] = nrm.z*sp + (Math.random()-0.5)*0.35;
      sparkLife[s] = 0.45 + Math.random()*0.45;
    }
  }
}
function stepSparks(dt){
  for(let s=0;s<SPARKS;s++){
    if(sparkLife[s] <= 0){ sparkAlpha[s] = 0; continue; }
    sparkLife[s] -= dt;
    sparkPos[s*3]   += sparkVel[s*3]*dt;
    sparkPos[s*3+1] += sparkVel[s*3+1]*dt;
    sparkPos[s*3+2] += sparkVel[s*3+2]*dt;
    sparkVel[s*3+1] += 0.25*dt;
    sparkAlpha[s] = clamp(sparkLife[s]/0.8, 0, 1);
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
    quill(){
      if(!ready()) return;
      const t = ac.currentTime;
      hiss(t, 0.05 + Math.random()*0.05, 4200 + Math.random()*2500, 2800, 2.5, 0.06, 'bandpass');
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
/* warm light spilling out of the gap as the board lifts */
const innerGlow = new THREE.PointLight(0xff9f45, 0, 6, 1.6);
scene.add(innerGlow);
const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: (()=>{ const t = new THREE.CanvasTexture(makeSpriteCanvas(128)); t.colorSpace = THREE.SRGBColorSpace; return t; })(),
  color: 0xffa850, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true }));
glowSprite.scale.set(5, 5, 1);
scene.add(glowSprite);
const _gp = new THREE.Vector3();
/* the forest is alive round the rock: leaves come down now and then, turning as
   they fall, and fireflies wander low over the moss. Nothing drifts between the
   camera and the book */
const leafMats = [[0x8f9a4e, 0], [0xa88a46, 1], [0x6f8a3e, 2]].map(([tint, seed])=>{
  const c = cv(64, 96), x = c.getContext('2d');
  const gr = x.createLinearGradient(0, 0, 0, 96);
  gr.addColorStop(0, '#fff'); gr.addColorStop(1, '#c9c9b0');
  x.fillStyle = gr;
  x.beginPath(); x.moveTo(32, 94); x.bezierCurveTo(70, 70, 60, 20, 32, 2); x.bezierCurveTo(4, 20, -6, 70, 32, 94); x.fill();
  x.strokeStyle = 'rgba(90,80,40,.45)'; x.lineWidth = 1.4;
  x.beginPath(); x.moveTo(32, 92); x.lineTo(32, 8);
  for(let k=0;k<5;k++){ const y = 80 - k*14; x.moveTo(32, y); x.lineTo(14 + k*2, y - 10); x.moveTo(32, y); x.lineTo(50 - k*2, y - 10); }
  x.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  /* emissive from the same map: the low sun shines through a thin leaf */
  return new THREE.MeshStandardMaterial({ map: t, color: tint, emissive: tint, emissiveMap: t, emissiveIntensity: 0.12, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75, metalness: 0 });
});
const leafGeo = new THREE.PlaneGeometry(0.24, 0.36);
const fallers = Array.from({length: 22}, (_, i)=>{
  const m = new THREE.Mesh(leafGeo, leafMats[i % 3]);
  m.userData = { vy:0, ph:0, amp:0, w:0, spin:new THREE.Vector3() };
  scene.add(m);
  return m;
});
function spawnLeaf(m, anywhere){
  let x, z;
  do{ x = -13 + Math.random()*26; z = -16 + Math.random()*18; }while(Math.hypot(x, z) < 4.5 || (Math.abs(x) < 5 && z > -3.5));
  m.position.set(x, anywhere ? -2 + Math.random()*11 : 9 + Math.random()*3, z);
  m.rotation.set(Math.random()*6.3, Math.random()*6.3, Math.random()*6.3);
  const u = m.userData;
  u.vy = 0.28 + Math.random()*0.3; u.ph = Math.random()*6.3; u.amp = 0.4 + Math.random()*0.6; u.w = 0.8 + Math.random()*0.9;
  u.spin.set((Math.random()-0.5)*2.2, (Math.random()-0.5)*1.6, (Math.random()-0.5)*2.4);
}
fallers.forEach(m=>spawnLeaf(m, true));
const FLIES = 72;
const flyGeo = new THREE.BufferGeometry();
const flyPos = new Float32Array(FLIES*3), flyAlpha = new Float32Array(FLIES), flyTint = new Float32Array(FLIES);
const flySeed = Array.from({length: FLIES}, (_, i)=>{
  let x, z; do{ x = -12 + Math.random()*24; z = -14 + Math.random()*17; }while(Math.hypot(x, z) < 3.4 || (Math.abs(x) < 3.5 && z > 2));
  flyTint[i] = i % 3 ? 0 : 1;
  return { x, z, y: GROUND_Y + 0.4 + Math.pow(Math.random(), 1.6)*6.5, ph: Math.random()*40, f: 0.2 + Math.random()*0.35 }; });
flyGeo.setAttribute('position', new THREE.BufferAttribute(flyPos, 3));
flyGeo.setAttribute('alpha', new THREE.BufferAttribute(flyAlpha, 1));
flyGeo.setAttribute('tint', new THREE.BufferAttribute(flyTint, 1));
const flies = new THREE.Points(flyGeo, flyMat);
flies.frustumCulled = false;
scene.add(flies);

function stepLife(dt){
  for(const m of fallers){
    const u = m.userData;
    m.position.y -= u.vy*dt;
    m.position.x += (Math.sin(clock*u.w + u.ph)*u.amp + 0.15)*dt;
    m.position.z += Math.cos(clock*u.w*0.7 + u.ph)*u.amp*0.5*dt;
    m.rotation.x += u.spin.x*dt; m.rotation.y += u.spin.y*dt; m.rotation.z += u.spin.z*dt;
    if(m.position.y < -3) spawnLeaf(m, false);
  }
  for(let i=0;i<FLIES;i++){
    const q = flySeed[i], t = clock*q.f + q.ph;
    flyPos[i*3]   = q.x + Math.sin(t*0.9)*0.8 + Math.sin(t*0.37)*0.6;
    flyPos[i*3+1] = q.y + Math.sin(t*0.6 + 1.3)*0.45;
    flyPos[i*3+2] = q.z + Math.cos(t*0.7)*0.8;
    const blink = 0.5 + 0.5*Math.sin(t*1.6);
    flyAlpha[i] = (0.3 + Math.pow(blink, 4)*0.9)*(flyTint[i] ? 0.85 : 1);
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
  innerGlow.intensity = gl*5.5;
  glowSprite.position.copy(_gp);
  glowSprite.material.opacity = gl*0.15;
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
  if(!st.flight){
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
  const h = hits[0], o = h.object, ud = o.userData;
  if(ud.grab === 'leaf'){
    const i = ud.leaf, mi = h.face ? h.face.materialIndex : 2;
    const L = leaves[i];
    const open = st.open && Math.abs(st.theta-OPEN) < 1e-3 && !st.flight;
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
  const cr = fl.curl*(1 + TWIST*fl.gy*yN);
  let x = _H.x, z = _H.z;
  const steps = Math.max(1, Math.round(sG/leaves[fl.j].ds));
  const ds = sG/steps;
  for(let m=0;m<steps;m++){ const a = flightAngle(PR, PL, p, cr, (m+0.5)*ds); x += Math.cos(a)*ds; z += Math.sin(a)*ds; }
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

const THRESH = 6;
const pointers = new Map();
let g = null;   // the gesture in progress
let pinch = null;

canvasEl.addEventListener('contextmenu', e=>e.preventDefault());
canvasEl.addEventListener('mousedown', e=>{ if(writing) e.preventDefault(); });
['pointerdown', 'keydown'].forEach(t=>addEventListener(t, ()=>sfx.ambience(), { once:true, capture:true }));
canvasEl.addEventListener('pointerdown', e=>{
  try{ canvasEl.setPointerCapture(e.pointerId); }catch(_){}
  pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
  if(pointers.size === 2){
    if(g && g.mode === 'turn') endTurn(true);
    if(g && g.mode === 'cover') endCover(true);
    const [a,b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x-b.x, a.y-b.y), z: st.zoom, mx:(a.x+b.x)/2, my:(a.y+b.y)/2 };
    g = null;
    return;
  }
  if(pointers.size > 2) return;
  inertia = false; angVel.x = angVel.y = 0;
  orbit.coast = false; orbit.vx = orbit.vy = 0;
  if(spinAnim){ spinAnim = null; spinGoal.copy(spinGrp.quaternion); }
  const hit = e.button === 2 ? null : pickAt(e.clientX, e.clientY);
  g = { id:e.pointerId, sx:e.clientX, sy:e.clientY, px:e.clientX, py:e.clientY, t:performance.now(),
        moved:0, hit, mode:'pending', force: e.button === 2 || e.button === 1 };
});
canvasEl.addEventListener('pointermove', e=>{
  const pp = pointers.get(e.pointerId);
  if(pp){ pp.x = e.clientX; pp.y = e.clientY; }
  if(pinch && pointers.size === 2){
    const [a,b] = [...pointers.values()];
    const d = Math.hypot(a.x-b.x, a.y-b.y);
    st.zoom = clamp(pinch.z * pinch.d/Math.max(20,d), 0.3, 3.2);
    const mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
    rotating = true;
    st.focusTo = 0;
    rotateBy((mx-pinch.mx)*0.006, (my-pinch.my)*0.006);
    pinch.mx = mx; pinch.my = my;
    return;
  }
  if(!g || g.id !== e.pointerId){ hover(e.clientX, e.clientY); return; }
  let dx = e.clientX - g.px, dy = e.clientY - g.py;
  g.px = e.clientX; g.py = e.clientY;
  g.moved += Math.abs(dx) + Math.abs(dy);
  if(g.mode === 'pending'){
    if(g.moved < THRESH) return;
    const h = g.hit;
    if(!g.force && h && h.type === 'page' && h.s > PW*0.5) startTurn(h);
    else if(!g.force && h && h.type === 'front' && (st.open ? (h.inner && st.k === 0) : true) && h.outer && !st.flight) startCover(h);
    else if(!g.force && !h){ g.mode = 'orbit'; st.focusTo = 0; dx = e.clientX - g.sx; dy = e.clientY - g.sy; }
    else { g.mode = 'rot'; rotating = true; st.focusTo = 0; dx = e.clientX - g.sx; dy = e.clientY - g.sy; }
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
  if(g.mode === 'cover'){
    g.goal = solveCoverTheta(g.local, e.clientX, e.clientY, g.goal);
  }
});
let rotating = false;
function liftGate(){ return smooth(clamp(st.lift*1.6, 0, 1)); }
function endPointer(e, cancelled){
  pointers.delete(e.pointerId);
  try{ canvasEl.releasePointerCapture(e.pointerId); }catch(_){}
  if(pinch){ if(pointers.size < 2){ pinch = null; rotating = false; } return; }
  if(!g || g.id !== e.pointerId) return;
  const gg = g; g = null;
  rotating = false;
  document.body.classList.remove('grabbing');
  if(gg.mode === 'turn'){ endTurn(cancelled); return; }
  if(gg.mode === 'cover'){ endCover(cancelled); return; }
  if(gg.mode === 'rot'){
    if(performance.now() - (gg.lt||0) < 70 && Math.hypot(angVel.x, angVel.y) > 0.25) inertia = true;
    return;
  }
  if(gg.mode === 'orbit'){
    if(performance.now() - (gg.lt||0) < 70 && Math.hypot(orbit.vx, orbit.vy) > 0.2) orbit.coast = true;
    return;
  }
  if(!cancelled) click(gg.hit);
}
canvasEl.addEventListener('pointerup', e=>endPointer(e, false));
canvasEl.addEventListener('pointercancel', e=>endPointer(e, true));
canvasEl.addEventListener('wheel', e=>{
  e.preventDefault();
  st.zoom = clamp(st.zoom * Math.exp(e.deltaY*0.0012), 0.3, 3.2);
}, { passive:false });

function startTurn(h){
  if(writing){ resumeWriting = true; exitWriting(true); }
  const right = h.side === 'right';
  st.flight = { j: right ? st.k : st.k-1, p: right ? 0 : 1, dragging:true, curl:0, vel:0,
                gy: clamp(h.y*2-1, -1, 1), sG: clamp(h.s, PW*0.4, PW), yN: clamp(h.y*2-1, -1, 1), anim:null, settle:null };
  st.flight.goal = st.flight.p;
  g.mode = 'turn';
  sfx.page();
}
function endTurn(cancelled){
  const fl = st.flight;
  if(!fl || !fl.dragging) return;
  fl.dragging = false;
  let to = fl.goal > 0.5 ? 1 : 0;
  if(!cancelled){ if(fl.vel > 1.2) to = 1; else if(fl.vel < -1.2) to = 0; }
  else to = fl.j < st.k ? 1 : 0;
  fl.settle = glideFrom(fl.p, fl.vel, to, Math.max(0.32, 0.9*Math.abs(to - fl.p)));
}
function startCover(h){
  if(writing) exitWriting();
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

/* a click on any part of the book lays it down open and leans in to write */
function click(hit){
  if(!hit){ if(writing) exitWriting(); else st.focusTo = 0; return; }
  if(hit.type === 'page' && st.open){
    const e = pageEntry(hit.n);
    if(!e.lay) paintPage(hit.n);
    const idx = indexAt(e.lay, hit.uv.x*PAGE_W, (1-hit.uv.y)*PAGE_H);
    writePose(hit.n, idx);
    return;
  }
  writePose();
}
/* the title page is never written on: writing starts on the spread after it */
function writePose(n, idx){
  if(st.flight) return;
  if(n === 0) n = idx = undefined;
  if(!st.open){
    /* closed, the two stacks lie exactly alike, so the book can open on the
       first spread after the title without a leaf visibly moving: the title
       leaf simply rides over with the cover */
    if(!coverAnim){ st.k = 1; lastSig = ''; }
    setOpen(true);
  }
  const homing = spinAnim && spinAnim.q1.angleTo(qOpenHome) < 1e-4;
  if(!homing && (!atHome() || spinAnim)) glideSpin(qOpenHome, 1.4, st.lift < 0.05);
  st.zoom = 1;
  if(st.k === 0){
    st.focusSide = -1; st.focusTo = 1;
    if(!coverAnim){ resumeWriting = true; flip(1); }
    return;
  }
  if(n === undefined) n = nextWritablePage();
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
    if(h.type === 'page') b.add(h.s > PW*0.5 && !writing ? 'cur-turn' : 'cur-text');
    else if(h.type === 'front' && !st.open) b.add('cur-pointer');
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
    if(th > 1.6) segs.push({ d:Math.max(0.3, 0.85*(th - 1.52)/(OPEN - 1.52)), to:1.52, e:easeSine }, { d:0.34, to:1.44, e:easeSine, fire:'settle' });
    segs.push({ d:0.44*Math.sqrt(Math.min(th, 1.44)/1.44), to:0, e:easeIn2, end:'thud' });
    segs.push({ d:0.09, to:0.04, e:easeOut2 }, { d:0.13, to:0, e:easeIn2 });
    st.hoverTo = 0.16; st.auraTo = 0.45; st.glowTo = 0;
  }
  return { path: segs, i:0, t:0, from: th, to: open ? OPEN : 0 };
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
  if(st.flight && open === false) return;
  if(writing && !open) exitWriting();
  if(!open && seek.goal !== null){ seek.goal = null; seek.resume = null; pageNoEl.classList.remove('seeking'); }
  const wasOpen = st.open;
  st.open = open;
  const to = open ? OPEN : 0;
  const dur = 1.15*Math.max(0.35, Math.abs(to - st.theta)/OPEN);
  if(thrown || (coverAnim && Math.abs(st.thetaVel) > 0.05)){
    coverAnim = { glide: glideFrom(st.theta, st.thetaVel, to, dur), to };
    st.hoverTo = st.auraTo = st.glowTo = 0;
  }else coverAnim = coverPath(open);
  if(Math.abs(to - st.theta) > 0.4) sfx.creak(open);
  if(wasOpen !== open){
    const from = open ? qClosedHome : qOpenHome;
    if(spinGrp.quaternion.angleTo(from) < 0.07) glideSpin(open ? qOpenHome : qClosedHome, open ? 2.2 : 1.4, st.lift < 0.05);
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
  leaves[fl.j].flt = 0;
  st.flight = null;
  sfx.settle();
  saveSoon(true);
  refreshUI();
  if(queue.length){ flip(queue.shift()); return; }
  if(resumeWriting){ resumeWriting = false; writePose(); }
}
let resumeWriting = false;
function flip(dir, magic){
  if(!st.open || st.theta < OPEN - 1e-3 || coverAnim){ return; }
  if(!magic && seek.goal !== null){ seek.goal = null; seek.resume = null; st.auraTo = 0; pageNoEl.classList.remove('seeking'); }
  if(writing && !(magic && seek.keepQuill)){ resumeWriting = !magic; exitWriting(true); }
  if(st.flight){ if(queue.length < 8) queue.push(dir); return; }
  if(dir > 0 && st.k < N){
    st.flight = { j: st.k, p:0, dragging:false, curl:0, vel:0, gy:-0.85, sG:PW, yN:-1, anim:null, settle:null };
    animateFlight(1);
    magic && flightPace() > 2 ? sfx.flick() : sfx.page();
  }else if(dir < 0 && st.k > 0){
    st.flight = { j: st.k-1, p:1, dragging:false, curl:0, vel:0, gy:-0.85, sG:PW, yN:-1, anim:null, settle:null };
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
  /* the pulled fore edge leads; let go, the leaf leads while it rises and
     trails once it is falling past the vertical, as paper does in air */
  const dir = Math.abs(fl.vel) > 0.05 ? Math.sign(fl.vel) : (fl.j < st.k ? -1 : 1);
  const prog = dir > 0 ? fl.p : 1 - fl.p;
  const target = fl.dragging ? 0.55*Math.sin(Math.PI*fl.p)*dir : 0.5*Math.sin(2*Math.PI*prog)*dir;
  fl.curl = lerp(fl.curl, target, 1 - Math.exp(-dt*10));
}

/* ============================================================================
   12b. spells: ink that runs on to the next page, pages wiped clean, the book
        turning itself to a page, and the keys that call them
   ==========================================================================*/
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const spreadOf = n => n <= 0 ? 0 : (n % 2 ? (n + 1)/2 : n/2);
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
function pour(n, v, caret){
  const out = new Map(), moves = [];
  let page = n, text = v, cp = n, ci = caret;
  for(;;){
    const lay = layoutText(text, pageFont(page), page === n ? textBox(page) : { ...textBox(page), flow: true });
    if(lay.ok){ out.set(page, text); break; }
    const bad = lay.lines.findIndex(ln => ln.y + lay.size*0.3 > lay.box.bottom);
    const cut = lay.lines[bad].start;
    const m = page + 1;
    if(cut <= 0 || m >= 2*N) return null;
    let keep = text.slice(0, cut);
    if(keep.endsWith('\n')) keep = keep.slice(0, -1);
    const moved = text.slice(cut), nextT = pages[m].t;
    const sep = moved && nextT && !/\s$/.test(moved) && !/^\s/.test(nextT) ? ' ' : '';
    out.set(page, keep);
    if(cp === page){
      if(ci >= cut){ cp = m; ci -= cut; }
      else ci = Math.min(ci, keep.length);
    }
    moves.push({ from: page, to: m, count: moved.length + sep.length });
    page = m; text = moved + sep + nextT;
  }
  return { out, moves, cp, ci };
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
    pg.t = T; pg.born = born;
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
    caretOn = true; blinkPhase = 0;
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
/* line after line the ink warms to gold and lifts off the sheet as sparks */
const FADE_D = 0.6;
function fadeLines(fade, now, fn){
  const L = fade.lay.lines, stag = Math.min(0.07, 0.9/Math.max(1, L.length));
  let alive = false;
  L.forEach((ln, li)=>{
    const k = ((now - fade.t0)/1000 - li*stag)/FADE_D;
    if(k < 1) alive = true;
    fn(ln, li, clamp(k, 0, 1));
  });
  return alive;
}
function fadeInk(ctx, n, fade, now){
  const lay = fade.lay, bx = lay.box.x;
  const alive = fadeLines(fade, now, (ln, li, k)=>{
    if(k > 0 && li >= fade.next){
      fade.next = li + 1;
      const step = Math.max(2, Math.round((ln.end - ln.start)/9));
      for(let i=ln.start; i<ln.end; i+=step) emitSparks(n, lay, fade.text, i, 1);
    }
    if(k >= 1) return;
    const y0 = ln.y - lay.size*1.05;
    ctx.save();
    ctx.beginPath();
    if(li === 0){ ctx.rect(0, 0, PAGE_W, y0 + lay.lh); ctx.rect(0, y0 + lay.lh, bx - 1, lay.lh*2); }
    else ctx.rect(bx - 1, y0, PAGE_W - bx + 1, li === fade.lay.lines.length - 1 ? PAGE_H - y0 : lay.lh);
    ctx.clip();
    ctx.globalAlpha = 1 - smooth(k);
    ctx.drawImage(fade.cv, 0, 0);
    ctx.restore();
  });
  if(!alive) pages[n].fade = null;
}
function fadeGlow(gx, fade, now){
  const lay = fade.lay;
  let any = false;
  gx.save();
  gx.scale(0.5, 0.5);
  fadeLines(fade, now, (ln, li, k)=>{
    if(k <= 0 || k >= 1) return;
    any = true;
    gx.globalAlpha = Math.sin(Math.PI*k)*0.85;
    gx.fillStyle = 'rgb(255,214,150)';
    if(li === 0 && lay.cap){ gx.font = capFont(lay.f, lay.cap.size); gx.fillText(lay.cap.ch, lay.cap.x, lay.cap.y); }
    gx.font = fontCss(lay.f, lay.size);
    gx.fillText(lineText(fade.text, ln), ln.x0, ln.y);
  });
  gx.restore();
  return any;
}
function erasePages(list){
  const now = performance.now(), gone = [];
  list.forEach(n=>{
    if(n < 1 || n >= 2*N || !pages[n].t) return;
    const e = pageEntry(n);
    burning.add(n);
    paintPage(n, now);
    const old = cv(PAGE_W, PAGE_H);
    old.getContext('2d').drawImage(e.inked, 0, 0);
    gone.push({ n, t: pages[n].t, f: pages[n].f, c: pages[n].c });
    pages[n].fade = { cv: old, lay: e.lay, text: pages[n].t, t0: now, next: 0 };
    pages[n].t = ''; pages[n].born = null; pages[n].c = false;
    if(writing && writing.n === n){
      quill.value = ''; quill.setSelectionRange(0, 0);
      lastGood = { v:'', a:0, b:0 };
    }
    paintPage(n, now);
  });
  if(!gone.length){ toast('NOTHING TO ERASE', 1200); return; }
  lastErase = { pages: gone, at: now };
  sfx.erase();
  saveSoon(true);
  toast(`ERASED · ${MOD}Z BRINGS IT BACK`, 2800);
}
/* the ink comes back and writes itself in, letter by letter */
function restoreErased(){
  if(!lastErase || performance.now() - lastErase.at > 60000) return false;
  const back = lastErase.pages.filter(p => !pages[p.n].t);
  lastErase = null;
  if(!back.length) return false;
  const now = performance.now();
  back.forEach(p=>{
    const pg = pages[p.n];
    const step = Math.min(14, 1500/Math.max(1, p.t.length));
    pg.t = p.t; pg.f = p.f; pg.c = p.c; pg.fade = null;
    pg.born = Array.from({length: p.t.length}, (_, i)=> now + 120 + i*step);
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
function eraseHere(){
  if(writing) return erasePages([writing.n]);
  if(!st.open){ toast('OPEN THE BOOK FIRST', 1400); return; }
  erasePages([2*st.k - 1, 2*st.k]);
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
  flip(Math.sign(seek.goal - st.k), true);
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
  if(writing && spreadOf(n) !== st.k) exitWriting(true);
  seekSpread(spreadOf(n), { resume });
  if(seek.goal === st.k && st.open && !coverAnim && !st.flight) arrive();
}

/* ---------------- the little windows: a page to turn to, the list of spells ---------------- */
const seekEl = document.getElementById('seek'), seekIn = document.getElementById('seekIn');
const spellsEl = document.getElementById('spells');
function openSeek(first){
  closeSpells();
  seekEl.hidden = false;
  seekIn.value = first || '';
  seekIn.focus({ preventScroll: true });
  seekIn.setSelectionRange(seekIn.value.length, seekIn.value.length);
}
function closeSeek(){
  if(seekEl.hidden) return;
  seekEl.hidden = true;
  if(writing) quill.focus({ preventScroll: true });
  else seekIn.blur();
}
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
seekIn.addEventListener('blur', ()=> setTimeout(()=>{ if(document.activeElement !== seekIn) seekEl.hidden = true; }, 120));
pageNoEl.addEventListener('click', ()=> openSeek());
pageNoEl.addEventListener('mousedown', e=> e.preventDefault());

const SPELLS = [
  ['The book', [
    ['O', 'Open or close the book'],
    ['Enter', 'Lay it open and take up the quill'],
    ['← →', 'Turn a leaf'],
    ['Shift ← →', 'Riffle five leaves'],
    ['Home  End', 'First or last page'],
    ['G  0–9', 'Turn to a page'],
    ['E', 'Erase the open spread'],
  ]],
  ['With the quill', [
    [`${MOD}E`, 'Erase this page'],
    [`${MOD}Z`, 'Bring the erased ink back'],
    [`${MOD}G`, 'Turn to a page'],
    [`${MOD}Enter`, 'Carry on at the next page'],
    ['PgUp  PgDn', 'Quill to the page before or after'],
    ['⌫', 'At the start of a page: back to the page before'],
    ['Esc', 'Set the quill down, again to close'],
  ]],
  ['Always', [
    ['M', 'Sound on or off'],
    [`${MOD}S`, 'Save'],
    [`${MOD}Shift S`, 'Save the book to a file'],
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
})();
function openSpells(){ closeSeek(); spellsEl.hidden = false; if(writing) quill.blur(); }
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
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnWrite = document.getElementById('btnWrite');
btnPrev.addEventListener('click', ()=> flip(-1));
btnNext.addEventListener('click', ()=> flip(1));
btnWrite.addEventListener('mousedown', e=>e.preventDefault());
btnWrite.addEventListener('click', ()=> writePose());
[btnPrev, btnNext].forEach(b=>b.addEventListener('mousedown', e=>e.preventDefault()));
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
  btnPrev.hidden = btnNext.hidden = !st.open;
  btnPrev.disabled = st.k === 0;
  btnNext.disabled = st.k === N;
  btnWrite.classList.toggle('on', !!writing);
  if(writing){
    hintEl.textContent = `The quill is inked, page ${writing.n+1} · Click off the book or press Esc to set it down · ${MOD}/ Shortcuts`;
  }else if(st.open){
    hintEl.textContent = 'Click the book to write · Hold and drag a page by its edge to turn it · Drag the forest to look around · ? Shortcuts';
  }else{
    hintEl.textContent = 'Click the book to open it and write · Drag the book to spin it · Drag the forest to look around · ? Shortcuts';
  }
  const c = st.k;
  pageNoEl.textContent = st.open ? (c === 0 ? 'ENDPAPER · 1' : c === N ? `${2*N} · ENDPAPER` : `${2*c} · ${2*c+1}`) : '';
}

/* keys instead of buttons, read by position so a Cyrillic layout works the
   same; SPELLS lists them */
function toggleBook(){
  if(!st.open){ seekSpread(st.k, { flourish: false }); return; }
  if(!st.flight) setOpen(false);
}
document.addEventListener('keydown', e=>{
  if(e.target === quill || e.target === seekIn) return;
  const mod = e.metaKey || e.ctrlKey, code = e.code;
  if(!spellsEl.hidden){
    if(e.key === 'Escape' || e.key === '?' || code === 'Slash'){ e.preventDefault(); closeSpells(); }
    return;
  }
  if(e.key === '?' || (mod && code === 'Slash')){ e.preventDefault(); openSpells(); }
  else if(e.key === 'ArrowRight' || e.key === 'PageDown'){
    e.preventDefault();
    if(!st.open) seekSpread(st.k, { flourish: false });
    else if(e.shiftKey) seekSpread(st.k + 5);
    else flip(1);
  }
  else if(e.key === 'ArrowLeft' || e.key === 'PageUp'){
    e.preventDefault();
    if(st.open) e.shiftKey ? seekSpread(st.k - 5) : flip(-1);
  }
  else if(e.key === 'Home'){ e.preventDefault(); seekSpread(0); }
  else if(e.key === 'End'){ e.preventDefault(); seekSpread(N); }
  else if(e.key === 'Escape'){ if(st.open && !st.flight) setOpen(false); }
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
  const map = tex(maps.col, {srgb:true, wrap:false});
  const nrm = tex(maps.nor, {wrap:false});
  const rgh = tex(maps.rgh, {wrap:false});
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
  const pbrTex = tex(pbr, { wrap:false });
  matEndpaper.map = tex(col, { srgb:true, wrap:false });
  matEndpaper.normalMap = tex(nor, { wrap:false });
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
  matLeatherEdge.map = tileMap(tex(dyed, {srgb:true}));
  matLeatherEdge.normalMap = tileMap(tex(img.leaNor));
  matLeatherEdge.roughnessMap = tileMap(tex(img.leaRough));
  matLeatherEdge.color.set(0xffffff); matLeatherEdge.roughness = 1;
  matLeatherEdge.needsUpdate = true;
  matSpine.normalMap = tex(img.leaNor, {rx:1.4, ry:4});
  matSpine.roughnessMap = tex(img.leaRough, {rx:1.4, ry:4});
  matSpine.roughness = 1;
  paintSpine(dyed);
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
  return x;
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
    tGranite: { value: rockTex(img.granite, true) }, tGraniteN: { value: heightNormal(img.granite, 2.2) },
    tMoss: { value: rockTex(img.moss, true) }, tMossN: { value: heightNormal(img.moss, 3.0) },
    gScale: { value: 0.22 }, mScale: { value: 0.42 }, uSunDir: { value: SUN_DIR }, uTime: rockTime
  };
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 1.3 });
  m.onBeforeCompile = sh=>{
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec3 vWp; varying vec3 vWn;\n' + sh.vertexShader.replace('#include <fog_vertex>',
      '#include <fog_vertex>\n vWp = (modelMatrix*vec4(position,1.0)).xyz; vWn = normalize(mat3(modelMatrix)*normal);');
    sh.fragmentShader = `uniform sampler2D tGranite, tGraniteN, tMoss, tMossN; uniform float gScale, mScale, uTime; uniform vec3 uSunDir;
      varying vec3 vWp; varying vec3 vWn;` + MOSS_GLSL + sh.fragmentShader
      .replace('#include <map_fragment>', `
        vec3 Nw = normalize(vWn), Wt = triW(Nw);
        float mm = mossMask(vWp, Nw);
        vec3 gran = tri(tGranite, vWp*gScale, Wt).rgb*0.95*vec3(0.97, 1.0, 1.0);
        vec3 mos = tri(tMoss, vWp*mScale, Wt).rgb*(0.62 + 0.25*vn3(vWp*0.9));
        mos = mix(mos, dot(mos, vec3(0.3, 0.59, 0.11))*vec3(1.06, 1.0, 0.6), 0.3)*1.2;
        /* the stone darkens and greens where the moss is about to take it */
        float edge = smoothstep(0.0, 0.35, mm)*(1.0 - smoothstep(0.35, 0.9, mm));
        gran *= 1.0 - edge*0.35;
        diffuseColor.rgb *= mix(gran, mos, smoothstep(0.25, 0.75, mm));
        /* shade gathering low down, where the boulder sinks into the forest floor */
        diffuseColor.rgb *= mix(0.4, 1.0, smoothstep(${GROUND_Y.toFixed(2)} - 0.2, ${(GROUND_Y + 2.6).toFixed(2)}, vWp.y));`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.82, 0.97, mm);')
      .replace('#include <lights_fragment_end>', MOSS_LIT('smoothstep(0.3, 0.8, mm)'))
      .replace('#include <normal_fragment_maps>', `
        { vec3 p = vWp*mix(gScale, mScale, step(0.5, mm));
          vec3 tx = mix(texture2D(tGraniteN, p.zy).xyz, texture2D(tMossN, p.zy).xyz, mm)*2.0 - 1.0;
          vec3 ty = mix(texture2D(tGraniteN, p.xz).xyz, texture2D(tMossN, p.xz).xyz, mm)*2.0 - 1.0;
          vec3 tz = mix(texture2D(tGraniteN, p.xy).xyz, texture2D(tMossN, p.xy).xyz, mm)*2.0 - 1.0;
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
          vec3 sp = vWp*46.0;
          float strand = vn3(sp) *0.65 + vn3(sp*2.3 + 5.0)*0.35;
          /* cushions: the strands stand tall in clumps and lie low between them */
          float clump = vn3(vWp*3.2 + 9.0);
          if(vBed < 0.15 || strand < 0.32 + uT*0.42 || mm < 0.3 + uT*0.55 || clump < uT*0.7 - 0.05) discard;
          vec3 mos = tri(tMoss, vWp*mScale, Wt).rgb*(0.62 + 0.25*vn3(vWp*0.9));
          mos = mix(mos, dot(mos, vec3(0.3, 0.59, 0.11))*vec3(1.06, 1.0, 0.6), 0.3)*1.2;
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
async function decodeDepth(url){
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = cv(bmp.width, bmp.height), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, bmp.width, bmp.height).data, n = bmp.width*bmp.height;
  const out = new Uint16Array(n);
  /* stored top row first; textures read bottom row first */
  for(let y=0;y<bmp.height;y++){
    const src = (bmp.height - 1 - y)*bmp.width, dst = y*bmp.width;
    for(let i=0;i<bmp.width;i++){ const k = (src + i)*4; out[dst + i] = THREE.DataUtils.toHalfFloat((d[k]*256 + d[k+1])/65535); }
  }
  const t = new THREE.DataTexture(out, bmp.width, bmp.height, THREE.RedFormat, THREE.HalfFloatType);
  /* nearest, not filtered: a leaf against the sky must not blend into a surface halfway between */
  t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.NearestFilter; t.needsUpdate = true;
  return t;
}
function makeBackdrop(pano, depth, water, back, backDepth){
  const tex = (im, srgb)=>{ const t = new THREE.Texture(im); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true; return t; };
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: {
      tPano: { value: tex(pano, true) }, tDepth: { value: depth }, tWater: { value: tex(water, false) },
      tBack: { value: tex(back, true) }, tBackDepth: { value: backDepth },
      uCam: { value: new THREE.Vector3() }, uCap: { value: FOREST_CAP }, uYaw: { value: new THREE.Vector2(Math.cos(FOREST_YAW), Math.sin(FOREST_YAW)) }, uTime: { value: 0 }, uGain: { value: FOREST_GAIN*FOREST_EXPOSURE },
      uNear: { value: DEPTH_NEAR }, uFar: { value: DEPTH_FAR }, uSun: { value: SUN_DIR } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }',
    fragmentShader: `#define MARCH_STEPS ${HI_RES ? 112 : 60}
      uniform sampler2D tPano, tDepth, tWater, tBack, tBackDepth; uniform vec2 uYaw;
      vec3 unyaw(vec3 v){ return vec3(uYaw.x*v.x - uYaw.y*v.z, v.y, uYaw.y*v.x + uYaw.x*v.z); } uniform vec3 uCam, uCap, uSun; uniform float uTime, uGain, uNear, uFar;
      varying vec3 vDir;
      float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x*p.y); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0 - 2.0*f);
        return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y); }
      vec2 eqUv(vec3 q){ return vec2(atan(q.z, q.x)*0.15915494 + 0.5, asin(clamp(q.y, -1.0, 1.0))*0.31830989 + 0.5); }
      float unpack(float inv){ return 1.0/(inv*(1.0/uNear - 1.0/uFar) + 1.0/uFar); }
      float distF(vec3 q){ return unpack(textureLod(tDepth, eqUv(q), 0.0).r); }
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
        vec4 wf = texture(tWater, uv);
        vec3 col;
        if(wf.r > 0.02){
          /* running water: ripples carried downstream wobble the picture and catch the light */
          vec3 W = P + uCap;
          vec2 fl = normalize(wf.gb*2.0 - 1.0 + 1e-4);
          vec2 p = W.xz;
          float n1 = vn(p*1.3 - fl*uTime*2.2), n2 = vn(p*2.7 - fl*uTime*3.4 + 7.3);
          vec3 q2 = normalize(P + vec3(n1 - 0.5, 0.0, n2 - 0.5)*0.45*wf.r);
          col = textureGrad(tPano, eqUv(q2), gx, gy).rgb;
          float g = pow(vn(p*5.0 - fl*uTime*4.0), 10.0) + pow(vn(p*8.0 - fl*uTime*5.5 + 3.1), 12.0);
          float lum = dot(col, vec3(0.3, 0.59, 0.11));
          col += vec3(1.0, 0.9, 0.72)*g*wf.r*smoothstep(0.02, 0.25, lum)*1.4;
        }else{
          col = textureGrad(tPano, uv, gx, gy).rgb;
          if(wBack > 0.0) col = mix(col, textureGrad(tBack, uvB, gx, gy).rgb, wBack);
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
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
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
    draw(){
      const w = Math.max(1, Math.round(VW*BACKDROP_PR)), h = Math.max(1, Math.round(VH*BACKDROP_PR));
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
const BACKDROP_PR = Math.min(DPR, 1);
let backdrop = null;

/* the near field: what grows round the boulder (ferns, flowers, grass, stones) is real
   3D, set where blender/build_forest.py put it, so it keeps its true shape as one walks
   round; the panorama behind only carries its shadows on the moss. Each plant is dimmed
   as much as the canopy shades it from the sun there (baked in the same build), and the
   ferns and grass stir in the breeze */
const nearTime = { value: 0 };
async function nearField(){
  let data;
  try{ data = await (await fetch(ASSETS.forestNear)).json(); }catch(e){ return; }
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
  const _m = new THREE.Matrix4(), _c = new THREE.Color();
  await Promise.all([...byAsset].map(async ([a, items])=>{
    const gl = await gltfLoader.loadAsync(`assets/plants/${a}/${a}_1k.gltf`);
    const meshes = new Map();
    gl.scene.traverse(o=>{ if(o.isMesh){ const n = (o.parent && o.parent.name && !o.parent.isScene ? o.parent.name : o.name); meshes.set(o.name, o); meshes.set(n, o); } });
    const find = v => meshes.get(v) || meshes.get(v + '_LOD0') || meshes.get(v.replace(/_LOD0$/, '')) || [...meshes.values()][0];
    const byVar = new Map();
    items.forEach(it=>{ const m = find(it.v); if(!byVar.has(m)) byVar.set(m, []); byVar.get(m).push(it); });
    byVar.forEach((its, src)=>{
      const mat = src.material.clone();
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
        };
      }
      const im = new THREE.InstancedMesh(src.geometry, mat, its.length);
      its.forEach((it, i)=>{
        _m.fromArray(it.m); im.setMatrixAt(i, _m);
        const k = (plant ? 0.78 : 0.82) + (plant ? 0.32 : 0.22)*(it.s ?? 1);
        im.setColorAt(i, _c.setRGB(k, k, k));
      });
      im.instanceMatrix.needsUpdate = true;
      if(im.instanceColor) im.instanceColor.needsUpdate = true;
      im.castShadow = false; im.receiveShadow = false;
      im.frustumCulled = false;
      im.userData.noPick = true;
      grp.add(im);
    });
  }));
  grp.rotation.y = FOREST_YAW;
  scene.add(grp);
}

async function loadAssets(){
  const imgs = {};
  const imgJobs = ['forest','forestWater','forestBack','granite','moss','leaAlbedo','leaNor','leaRough','maskFront','maskBack']
    .map(k=>loadImage(ASSETS[k]).then(i=>{ imgs[k] = i; }));
  const models = Promise.all([gltfLoader.loadAsync(ASSETS.goldFront), gltfLoader.loadAsync(ASSETS.goldBack), gltfLoader.loadAsync(ASSETS.rock)]);
  const depth = decodeDepth(ASSETS.forestDepth), backDepth = decodeDepth(ASSETS.forestBackDepth);
  const light = new RGBELoader().loadAsync(ASSETS.forestLight);
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
  rockGrp.add(mossShells(rock, rock.material.userData.u, HI_RES ? 9 : 6));
  const rockYaw = new THREE.Group();
  rockYaw.rotation.y = FOREST_YAW;
  rockYaw.add(rockGrp);
  scene.add(rockYaw);
  await nearField();
  /* the boulder's shadow and the shade round its foot are in the forest render itself */
}

/* ============================================================================
   15. loop
   ==========================================================================*/
function onResize(){
  if(!measureViewport()) return;
  renderer.setSize(VW, VH, false);
  composer.setSize(VW, VH);
  camera.aspect = VW/VH;
  camera.updateProjectionMatrix();
  sparkMat.uniforms.uScale.value = VH*DPR*0.012;
  moteMat.uniforms.uScale.value = VH*DPR*0.009;
  auraMat.uniforms.uScale.value = VH*DPR*0.08;
  burstMat.uniforms.uScale.value = VH*DPR*0.015;
  dustMat.uniforms.uScale.value = VH*DPR*0.34;
  flyMat.uniforms.uScale.value = VH*DPR*0.16;
}
addEventListener('resize', onResize);
try{ new ResizeObserver(()=>onResize()).observe(document.documentElement); }catch(_){}

let last = performance.now(), clock = 0, bobAmt = 1;
const _bc = new THREE.Vector3();
function update(dt){
  clock += dt;
  const theta0 = st.theta;
  if(g && g.mode === 'cover'){
    st.theta = damp(st.theta, g.goal, 18, dt);
  }else if(coverAnim && coverAnim.glide){
    const done = glideStep(coverAnim.glide, dt);
    st.theta = clamp(coverAnim.glide.x, 0, OPEN);
    if(done){ st.theta = coverAnim.to; coverAnim = null; if(Math.abs(st.thetaVel) > 0.6) sfx.land(); refreshUI(); }
  }else if(coverAnim && coverAnim.path){
    const A = coverAnim;
    A.t += dt;
    while(A.i < A.path.length && A.t >= A.path[A.i].d){
      const sg = A.path[A.i];
      if(sg.fire && !sg.fired) coverEvent(sg.fire);
      if(sg.end) coverEvent(sg.end);
      A.t -= sg.d; A.from = sg.to; A.i++;
    }
    if(A.i >= A.path.length){ st.theta = A.to; coverAnim = null; coverLanded(A); refreshUI(); }
    else{
      const sg = A.path[A.i], k = A.t/sg.d;
      if(sg.fire && !sg.fired && sg.at !== undefined && k >= sg.at){ sg.fired = true; coverEvent(sg.fire); }
      st.theta = lerp(A.from, sg.to, sg.e(k));
    }
  }
  st.thetaVel = damp(st.thetaVel, (st.theta - theta0)/Math.max(dt, 1e-3), 14, dt);
  stepFlight(dt);
  for(const L of leaves) if(L.flt < 0.75) L.flt += dt;
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
    const on = (blinkPhase % 1.06) < 0.62;
    if(on !== caretOn){ caretOn = on; paintPage(writing.n); }
  }
  /* letters burning in: repaint at ~30 fps while any is still lit */
  if(burning.size){
    const now = performance.now();
    burning.forEach(n=>{
      const e = pageCache.get(n);
      if(!e){ burning.delete(n); return; }
      paintPage(n, now);
      const lastBorn = (pages[n].born || []).reduce((a,b)=>Math.max(a, b||0), 0);
      if(!(writing && writing.n === n) && (now - lastBorn)/1000 > GLOW_T && !pages[n].fade){ burning.delete(n); paintPage(n, now); }
    });
  }
  stepSparks(dt);
  stepMotes(dt);
  stepMagic(dt);
  stepWisps(dt);
  stepSeek();
  /* centre of the tome, so it turns about its own middle */
  const b = smooth(clamp(st.theta/OPEN,0,1));
  bookRoot.position.set(-lerp((XJ_C + CW - 0.13)/2, 0, b), 0, -lerp(0, ZB*0.4, b));
  bobAmt = lerp(bobAmt, st.bob*st.lift, 1 - Math.exp(-dt*2));
  const restY = ROCK_TOP + 0.004 - (ZB - CVR - 0.004 + bookRoot.position.z);
  floatGrp.position.y = restY + st.lift*LIFT_H + st.hover + Math.sin(clock*0.78)*0.10*bobAmt + Math.sin(clock*1.3)*0.025*st.hover/0.3;
  floatGrp.rotation.z = Math.sin(clock*0.53)*0.012*bobAmt;
  /* camera: high and to the south, following the book up and down; while
     writing it leans in over the page, looking down on it like a reader */
  /* the camera watches the board swing over and leans in only once it is down */
  const opening = coverAnim && coverAnim.to === OPEN && st.theta < OPEN*0.8;
  sdamp(st, 'focus', opening ? 0 : st.focusTo, 0.55, dt);
  const fz = smooth(clamp(st.focus, 0, 1));
  _bc.set(fz*st.focusSide*(XJ_O + PW*0.5), floatGrp.position.y, fz*0.12);
  sdamp(camTarget, 'x', _bc.x, 0.4, dt); sdamp(camTarget, 'y', _bc.y, 0.3, dt); sdamp(camTarget, 'z', _bc.z, 0.4, dt);
  const fitW = 2*Math.tan(camera.fov*Math.PI/360);
  const pageD = Math.max((PH + 0.7)/fitW, (PW + 0.7)/(fitW*VW/VH));
  sdamp(st, 'camD', lerp(fitDistance()*st.zoom, pageD, fz), 0.45, dt);
  if(st.camEl === undefined) st.camEl = camElevation();
  const el0 = sdamp(st, 'camEl', lerp(camElevation(), 1.22, fz), 0.5, dt);
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
  const lift = lerp(2.4, 0, smooth(clamp(st.theta/OPEN, 0, 1)))*(1 - fz);
  _bc.set(camTarget.x, camTarget.y + lift, camTarget.z);
  camera.lookAt(_bc);
  layout(false);
  floatGrp.updateMatrixWorld(true);

  frontGem.userData.gem.material.envMapIntensity = 2.1 + Math.sin(clock*0.9)*0.5 + st.gemFlare*3 + st.aura*0.8;
  /* the gilt breathes with a faint light of its own */
  matGold.emissiveIntensity = 0.05 + 0.07*Math.pow(0.5 + 0.5*Math.sin(clock*0.7), 2) + st.aura*0.2 + st.gemFlare*0.3;
  frontGem.userData.gem.material.emissiveIntensity = 0.55 + st.gemFlare*1.4 + st.aura*0.4;
  frontGem.getWorldPosition(gemLight.position);
  gemLight.intensity = 0.3 + 0.3*(0.5+0.5*Math.sin(clock*1.1)) + st.gemFlare*1.6 + st.aura*0.4;
  rayGroup.children.forEach(m=>{ m.material.opacity = m.userData.base*(0.7 + 0.35*Math.sin(clock*0.3 + m.userData.ph)); });
  rockTime.value = clock; nearTime.value = clock;
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
function frame(){
  const w = innerWidth || 0, h = innerHeight || 0;
  if(w >= 2 && h >= 2 && (w !== VW || h !== VH)) onResize();
  const now = performance.now();
  const dt = Math.min(0.05, (now-last)/1000);
  last = now;
  update(dt);
  if(backdrop) backdrop.draw();
  composer.render(dt);
}
function rafLoop(){ frame(); requestAnimationFrame(rafLoop); }
setInterval(()=>{ if(document.hidden) frame(); }, 250);

/* ============================================================================
   16. boot
   ==========================================================================*/
async function boot(){
  try{
    await Promise.race([
      Promise.all([
        ...FONTS.map(f=>document.fonts.load(fontCss(f, 40), 'AaЯяЖж')),
        document.fonts.load('600 40px "Cormorant SC"', 'LIBER ARCANUM'),
        document.fonts.load('700 40px "Cormorant SC"', 'LIBER ARCANUM'),
        document.fonts.load('40px "UnifrakturMaguntia"', 'Liber Arcanum'),
        ...FONTS.map(f=>document.fonts.load(capFont(f, 80), 'HIZЗЖВ')),
        document.fonts.load('italic 500 40px "Cormorant Garamond"', 'a book of secret writings')
      ]),
      new Promise(r=>setTimeout(r, 4000))
    ]);
  }catch(e){}
  try{
    await loadAssets();
  }catch(e){
    const l = document.getElementById('loading');
    if(l) l.lastElementChild.textContent = 'THE TOME COULD NOT BE KINDLED';
    throw e;
  }
  loadAll();
  /* the title page and the blanks were painted before the fonts arrived */
  blankMat[0].map.image = pageBackground(-2); blankMat[0].map.needsUpdate = true;
  blankMat[1].map.image = pageBackground(-1); blankMat[1].map.needsUpdate = true;
  pageCache.forEach((e,n)=>{ e.bg = pageBackground(n); paintPage(n); });
  st.theta = st.open ? OPEN : 0;
  spinGrp.quaternion.copy(homeQuat());
  spinGoal.copy(spinGrp.quaternion);
  layout(true);
  st.camD = fitDistance();
  camTarget.set(0, ROCK_TOP + 0.4, 0);
  onResize();
  refreshUI();
  frame();
  requestAnimationFrame(rafLoop);
  const l = document.getElementById('loading');
  l.classList.add('gone');
  setTimeout(()=>l.remove(), 1300);
  window.__book.bootMs = Math.round(performance.now() - T0);
}
document.fonts.addEventListener && document.fonts.addEventListener('loadingdone', ()=>{ pageCache.forEach((e,n)=>paintPage(n)); });

window.__book = { st, orbit, leaves, pages, flip, setOpen, seekSpread, turnToPage, erasePages, restoreErased, quillTo, pour, enterWriting, exitWriting, pickAt, camera, scene, renderer, spinGrp, THREE, glideSpin, homeQuat,
  info(){ return { open:st.open, k:st.k, theta:st.theta, lift:+st.lift.toFixed(3), writing: writing && writing.n, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, cache: pageCache.size }; } };
boot();
