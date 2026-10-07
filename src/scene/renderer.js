/* the WebGL renderer, the scene, the camera and the forest sun */
import * as THREE from 'three';
import { setMaxAniso } from '../lib/textures.js';
import { HI_RES, VH, VW } from '../core/config.js';

const canvasEl = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: false, alpha: false, powerPreference: 'high-performance' });
/* a phone starts at 1.5 device pixels to a CSS pixel and steps down while its frames run
   slow (adaptPixels in app/loop.js). A computer draws at its screen's own ratio, up to 2,
   and is never stepped down to buy frames; only a huge sharp screen (4K at 2x) is drawn
   at no more than about six million pixels, which from where one sits looks the same */
const DPR_MAX = Math.min(devicePixelRatio, HI_RES ? 2 : 1.5);
const PR_FLOOR = Math.min(DPR_MAX, 1);
const PR_LEVELS = [];
for(let p = DPR_MAX; p > PR_FLOOR + 0.02; p *= 0.875) PR_LEVELS.push(+p.toFixed(3));
PR_LEVELS.push(PR_FLOOR);
/* ?pr=1.5 pins the ratio and stops the ladder, for measuring */
const PR_PIN = +new URLSearchParams(location.search).get('pr') || 0;
const PX_MAX = 6.2e6;
const deskRatio = ()=> Math.min(DPR_MAX, Math.max(1.25, Math.sqrt(PX_MAX/(VW*VH))));
let DPR = PR_PIN || (HI_RES ? deskRatio() : DPR_MAX);
function setDPR(v){ DPR = v; }
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
function setShadowDirty(v){ shadowDirty = v; }
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

export {
  camera, canvasEl, deskRatio, DPR, FOREST_YAW, gemLight, PR_LEVELS, PR_PIN, renderer, scene, setDPR,
  setShadowDirty, shadowDirty, shadowKey, sun, SUN_DIR
};
