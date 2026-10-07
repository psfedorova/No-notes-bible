import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { camera } from './renderer.js';

const softScene = new THREE.Scene();
const softU = {
  tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
  uNear: { value: camera.near }, uFar: { value: camera.far }
};
const cardGeo = new THREE.PlaneGeometry(1, 1);
function softCard(map, color, soft, glow){
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    uniforms: { ...softU, map: { value: map }, uCol: { value: new THREE.Color(color) }, uOp: { value: 0 }, uRot: { value: 0 }, uSoft: { value: soft } },
    defines: glow ? { GLOW: '' } : {},
    vertexShader: `uniform float uRot; varying vec2 vUv; varying float vZ;
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix*vec4(0.0, 0.0, 0.0, 1.0);
        vec2 p = position.xy*vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz)), r = vec2(cos(uRot), sin(uRot));
        mv.xy += vec2(r.x*p.x - r.y*p.y, r.y*p.x + r.x*p.y);
        vZ = -mv.z;
        gl_Position = projectionMatrix*mv;
      }`,
    fragmentShader: `#include <packing>
      uniform sampler2D map, tDepth; uniform vec2 uRes; uniform vec3 uCol; uniform float uOp, uSoft, uNear, uFar;
      varying vec2 vUv; varying float vZ;
      void main(){
        vec4 t = texture2D(map, vUv);
        float z = -perspectiveDepthToViewZ(texture2D(tDepth, gl_FragCoord.xy/uRes).x, uNear, uFar);
        float a = t.a*uOp*smoothstep(0.0, 1.0, (z - vZ)/uSoft);
        #ifdef GLOW
        gl_FragColor = vec4(t.rgb*uCol*a, 0.0);
        #else
        gl_FragColor = vec4(t.rgb*uCol*a, a);
        #endif
      }`
  });
  const m = new THREE.Mesh(cardGeo, mat);
  m.visible = false;
  softScene.add(m);
  return m;
}

const SOFT_MIX = `
  float viewZ(float z){ vec4 v = uInvProj*vec4(0.0, 0.0, z*2.0 - 1.0, 1.0); return -v.z/v.w; }
  vec4 softAt(){
    if(uSoftOn < 0.5) return vec4(0.0);
    float d = viewZ(texture2D(tDepth, vUv).x);
    ivec2 sz = textureSize(tSoft, 0);
    vec2 g = vUv*vec2(sz) - 0.5, f = fract(g);
    ivec2 i0 = ivec2(floor(g));
    vec4 acc = vec4(0.0); float wsum = 0.0;
    for(int k=0;k<4;k++){
      ivec2 o = ivec2(k & 1, k >> 1), i = clamp(i0 + o, ivec2(0), sz - 1);
      float s = viewZ(texture2D(tDepth, (vec2(i) + 0.5)/vec2(sz)).x);
      float w = (o.x == 1 ? f.x : 1.0 - f.x)*(o.y == 1 ? f.y : 1.0 - f.y);
      w *= exp(-abs(s - d)/(0.03*d + 0.02)) + 1e-4;
      acc += texelFetch(tSoft, i, 0)*w; wsum += w;
    }
    return acc/wsum;
  }`;
const _cc = new THREE.Color();
class SoftPass extends Pass {
  constructor(){
    super();
    this.needsSwap = false;
    this.low = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.uniforms = { tSoft: { value: this.low.texture }, uSoftOn: { value: 0 } };
  }
  setSize(w, h){
    const W = Math.max(1, Math.round(w/2)), H = Math.max(1, Math.round(h/2));
    this.low.setSize(W, H);
    softU.uRes.value.set(W, H);
  }
  render(renderer, writeBuffer, readBuffer){
    const on = softScene.children.some(o => o.visible);
    this.uniforms.uSoftOn.value = on ? 1 : 0;
    if(!on) return;
    softU.tDepth.value = readBuffer.depthTexture;
    softU.uNear.value = camera.near; softU.uFar.value = camera.far;
    renderer.getClearColor(_cc);
    const ca = renderer.getClearAlpha(), auto = renderer.autoClear;
    renderer.setRenderTarget(this.low);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.autoClear = false;
    renderer.render(softScene, camera);
    renderer.autoClear = auto;
    renderer.setClearColor(_cc, ca);
  }
}

export {
  softCard, SOFT_MIX, SoftPass
};
