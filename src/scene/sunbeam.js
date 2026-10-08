import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { mulberry32, cv, makeSpriteCanvas, makeRayAlpha } from '../lib/textures.js';
import { HI_RES } from '../core/config.js';
import { NOISE_GLSL, noiseTex } from '../lib/noise.js';
import { camera, scene, SUN_DIR } from './renderer.js';
import { GUST_GLSL, nearGust } from './plants.js';

const BEAM_AT = new THREE.Vector3(0, 0.3, 0);
const BEAM_R = 4.6;
const BEAM_FROM = 34;
const BEAM_DIR = SUN_DIR;
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

const beamU = {
  uA: { value: BEAM_AT }, uD: { value: BEAM_DIR }, uSig: { value: BEAM_R*0.5 }, uLen: { value: BEAM_FROM*1.1 },
  uTime: { value: 0 }, uK: { value: 1 }, uGobo: { value: BEAM_R*2.5 },
  uX: { value: new THREE.Vector3() }, uY: { value: new THREE.Vector3() },
  uCol: { value: new THREE.Color(0xfff0dc).multiplyScalar(0.05) }
};
beamU.uX.value.crossVectors(new THREE.Vector3(0, 1, 0), BEAM_DIR).normalize();
beamU.uY.value.crossVectors(BEAM_DIR, beamU.uX.value).normalize();
const VIEW_DIST = `float viewDist(float z){
  vec4 v = uInvProj*vec4(vUv*2.0 - 1.0, z*2.0 - 1.0, 1.0); v /= v.w;
  return z > 0.99999 ? 800.0 : length(v.xyz); }`;
const BEAM_MIX = `${VIEW_DIST}
  vec3 beamAt(){
    if(uK < 0.001) return vec3(0.0);
    float d = viewDist(texture2D(tDepth, vUv).x);
    ivec2 sz = textureSize(tLow, 0);
    vec2 g = vUv*vec2(sz) - 0.5, f = fract(g);
    ivec2 i0 = ivec2(floor(g));
    float acc = 0.0, wsum = 0.0;
    for(int k=0;k<4;k++){
      ivec2 o = ivec2(k & 1, k >> 1);
      vec2 s = texelFetch(tLow, clamp(i0 + o, ivec2(0), sz - 1), 0).rg;
      float w = (o.x == 1 ? f.x : 1.0 - f.x)*(o.y == 1 ? f.y : 1.0 - f.y);
      w *= exp(-abs(s.g - d)/(0.03*d + 0.02)) + 1e-4;
      acc += s.r*w; wsum += w;
    }
    return uCol*(acc/wsum)*uK;
  }`;
class BeamPass extends Pass {
  constructor(){
    super();
    this.needsSwap = false;
    this.low = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...beamU, tDepth: { value: null }, tGobo: { value: goboTex }, tNoise: { value: noiseTex },
        uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D tDepth, tGobo; uniform mat4 uInvProj, uCamWorld;
        uniform vec3 uA, uD, uX, uY; uniform float uSig, uLen, uTime, uGobo; varying vec2 vUv;
        ${VIEW_DIST}
        ${NOISE_GLSL}
        void main(){
          float tEnd = viewDist(texture2D(tDepth, vUv).x);
          gl_FragColor = vec4(0.0, tEnd, 0.0, 1.0);
          vec4 v = uInvProj*vec4(vUv*2.0 - 1.0, 0.0, 1.0); v /= v.w;
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
          gl_FragColor.r = acc*dt*hg;
        }`
    });
    this.quad = new FullScreenQuad(this.material);
    this.uniforms = { tLow: { value: this.low.texture }, uInvProj: this.material.uniforms.uInvProj, uCol: beamU.uCol, uK: beamU.uK };
  }
  setSize(w, h){ this.low.setSize(Math.max(1, Math.round(w/2)), Math.max(1, Math.round(h/2))); }
  render(renderer, writeBuffer, readBuffer){
    const u = this.material.uniforms;
    u.tDepth.value = readBuffer.depthTexture;
    u.uInvProj.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
    if(beamU.uK.value < 0.001) return;
    renderer.setRenderTarget(this.low);
    this.quad.render(renderer);
  }
}

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
    uniforms: { uA: beamU.uA, uD: beamU.uD, uSig: beamU.uSig, uTime: beamU.uTime, uGust: nearGust, uK: { value: 1 }, uScale: { value: 1 } },
    vertexShader: `attribute vec4 seed; uniform vec3 uA, uD; uniform float uSig, uTime, uScale; varying float vA;
      ${GUST_GLSL}
      void main(){
        vec3 n1 = normalize(cross(uD, vec3(0.0, 1.0, 0.0))), n2 = cross(n1, uD);
        float ph = seed.w*40.0, t = uTime*(0.05 + 0.08*seed.w);
        float s = seed.x + sin(t*1.3 + ph)*0.8;
        float a = seed.y + t*0.4, r = seed.z*(1.0 + 0.12*sin(t*0.9 + ph));
        vec3 p = uA + uD*s + (n1*cos(a) + n2*sin(a))*r + vec3(sin(t*2.1 + ph), cos(t*1.7 + ph*1.3), sin(t*1.9 + ph*0.7))*0.35;
        vec2 gw = gustAt(p.xz)*exp(-max(p.y, 0.0)*0.12);
        p += vec3(gw.x, length(gw)*0.5, gw.y)*1.6;
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

export {
  beam, BEAM_AT, BEAM_DIR, BEAM_MIX, beamMotes, BeamPass, beamU, dust, rayGroup
};
