import * as THREE from 'three';
import { HI_RES, ROCK_TOP } from '../core/config.js';
import { spinGrp } from './rig.js';

const CONTACT_LAYER = 5;
const SPAN = 8, BELOW = 6, DEPTH = 14;
const rt = new THREE.WebGLRenderTarget(HI_RES ? 512 : 256, HI_RES ? 512 : 256, { depthBuffer: true });
rt.texture.generateMipmaps = false;
const cam = new THREE.OrthographicCamera(-SPAN, SPAN, SPAN, -SPAN, 0, DEPTH);
cam.position.set(0, ROCK_TOP - BELOW, 0);
cam.up.set(0, 0, -1);
cam.lookAt(0, ROCK_TOP, 0);
cam.layers.set(CONTACT_LAYER);
cam.updateMatrixWorld();
const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
const contactU = {
  tContact: { value: rt.texture },
  uContactMat: { value: new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse) },
  uContactY: { value: new THREE.Vector2(ROCK_TOP - BELOW, DEPTH) }
};
const CONTACT_GLSL = `
  uniform sampler2D tContact; uniform mat4 uContactMat; uniform vec2 uContactY;
  float contactShade(vec3 p){
    if(p.y < ${(ROCK_TOP - 2.5).toFixed(2)}) return 0.0;
    float occ = 0.0;
    for(int i=0;i<8;i++){
      float r = 0.75*sqrt((float(i) + 0.5)/8.0), a = float(i)*2.39996;
      vec4 c = uContactMat*vec4(p + vec3(cos(a)*r, 0.0, sin(a)*r), 1.0);
      vec2 uv = c.xy*0.5 + 0.5;
      float d = unpackRGBAToDepth(texture2D(tContact, uv));
      if(d < 0.999){ float h = max(uContactY.x + d*uContactY.y - p.y, 0.0); occ += exp(-h/0.35); }
    }
    return occ/8.0;
  }
`;
const _cc = new THREE.Color();
function drawContact(renderer, scene){
  spinGrp.traverse(o=>{ if(o.isMesh){ if(o.castShadow) o.layers.enable(CONTACT_LAYER); else o.layers.disable(CONTACT_LAYER); } });
  const was = renderer.getRenderTarget(), auto = renderer.autoClear, ca = renderer.getClearAlpha(), sm = renderer.shadowMap.needsUpdate;
  renderer.getClearColor(_cc);
  const bg = scene.background, ov = scene.overrideMaterial;
  scene.background = null; scene.overrideMaterial = depthMat;
  renderer.shadowMap.needsUpdate = false;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0xffffff, 1);
  renderer.autoClear = true;
  renderer.render(scene, cam);
  scene.background = bg; scene.overrideMaterial = ov;
  renderer.setRenderTarget(was);
  renderer.setClearColor(_cc, ca);
  renderer.autoClear = auto;
  renderer.shadowMap.needsUpdate = sm;
}

export {
  CONTACT_GLSL, contactU, drawContact
};
