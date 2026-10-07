/* the sapphire on the front board: an oval brilliant, cut and set like a jewel */
import * as THREE from 'three';
import { sun, SUN_DIR } from '../scene/renderer.js';
import { st } from './state.js';

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

export {
  backGrp, sapphire, stepGems
};
