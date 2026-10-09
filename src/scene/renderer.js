import * as THREE from 'three';
import { setMaxAniso } from '../lib/textures.js';
import { HI_RES, VH, VW } from '../core/config.js';

const canvasEl = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: false, alpha: false, powerPreference: 'high-performance' });
const dprCap = ()=> Math.min(devicePixelRatio || 1, HI_RES ? 2 : 1.5);
const DPR_MAX = dprCap();
const PR_FLOOR = Math.min(DPR_MAX, 1);
const PR_LEVELS = [];
for(let p = DPR_MAX; p > PR_FLOOR + 0.02; p *= 0.875) PR_LEVELS.push(+p.toFixed(3));
PR_LEVELS.push(PR_FLOOR);
const PR_PIN = +new URLSearchParams(location.search).get('pr') || 0;
const PX_MAX = 6.2e6;
const deskRatio = ()=> Math.min(dprCap(), Math.max(1.25, Math.sqrt(PX_MAX/(VW*VH))));
let DPR = PR_PIN || (HI_RES ? deskRatio() : DPR_MAX);
function setDPR(v){ DPR = v; }
renderer.setPixelRatio(DPR);
renderer.setSize(VW, VH, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
/* a window moved to a sharper screen, or zoomed, changes the ratio without always resizing */
if(HI_RES && !PR_PIN){
  const watch = ()=> matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', ()=>{ watch(); dispatchEvent(new Event('resize')); }, { once: true });
  watch();
}
/* a restored context comes back empty: shed textures, the forest light, the held-stone mask and the shadow maps cannot be drawn again; the pages are saved on pagehide */
canvasEl.addEventListener('webglcontextrestored', ()=> location.reload());
const SUN_TAPS = HI_RES ? 20 : 12;
THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment
  .replace('float getShadow(', `float sunShadow( sampler2D map, vec2 mapSize, float spread, vec4 c ){
    vec2 texel = 1.0/mapSize;
    float rot = 6.2831853*fract(52.9829189*fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float search = spread*0.18 + 2.0*texel.x, sum = 0.0, n = 0.0;
    for(int i=0;i<12;i++){
      float r = sqrt((float(i) + 0.5)/12.0), a = float(i)*2.39996 + rot;
      float d = unpackRGBAToDepth(texture2D(map, c.xy + vec2(cos(a), sin(a))*r*search));
      if(d < c.z){ sum += d; n += 1.0; }
    }
    if(n < 0.5) return 1.0;
    float pen = max((c.z - sum/n)*spread, 1.5*texel.x);
    if(n > 11.5 && pen < search) return 0.0;
    float lit = 0.0;
    for(int i=0;i<${SUN_TAPS};i++){
      float r = sqrt((float(i) + 0.5)/${SUN_TAPS}.0), a = float(i)*2.39996 + rot;
      lit += texture2DCompare(map, c.xy + vec2(cos(a), sin(a))*r*pen, c.z);
    }
    return lit/${SUN_TAPS}.0;
  }
  float getShadow(`)
  .replace(/(if \( frustumTest \) \{\s*)#if defined\( SHADOWMAP_TYPE_PCF \)/,
    '$1if( shadowRadius < 0.0 ) shadow = sunShadow( shadowMap, shadowMapSize, -shadowRadius, shadowCoord ); else {\n\t\t#if defined( SHADOWMAP_TYPE_PCF )')
  .replace(/(shadow = texture2DCompare\( shadowMap, shadowCoord\.xy, shadowCoord\.z \);\s*#endif)/, '$1\n\t\t}');
let shadowDirty = true;
function setShadowDirty(v){ shadowDirty = v; }
const shadowKey = new Float32Array(16);
setMaxAniso(renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f08);
const camera = new THREE.PerspectiveCamera(40, VW/VH, 0.1, 400);
camera.position.set(0, 8, 9);

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
const SUN_SOFT = 0.015;
sun.shadow.radius = -SUN_SOFT*(sun.shadow.camera.far - sun.shadow.camera.near)/(sun.shadow.camera.right - sun.shadow.camera.left);
scene.add(sun, sun.target);
const gemLight = new THREE.PointLight(0x5aa0ff, 0.5, 2.2, 2);
scene.add(gemLight);

export {
  camera, canvasEl, deskRatio, DPR, FOREST_YAW, gemLight, PR_LEVELS, PR_PIN, renderer, scene, setDPR,
  setShadowDirty, shadowDirty, shadowKey, sun, SUN_DIR
};
