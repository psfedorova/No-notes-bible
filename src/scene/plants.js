/* the near field round the boulder: ferns, flowers, stones and grass in real 3D */
import * as THREE from 'three';
import { clamp, lerp, smooth, mulberry32 } from '../lib/textures.js';
import { ASSETS, HI_RES } from '../core/config.js';
import { FOREST_YAW, scene, SUN_DIR } from './renderer.js';
import { gltfLoader, retry, shed } from '../assets/loaders.js';
import { backdrop, FOREST_CAP, ROCK_FOOT_N, rockFoot } from './forest.js';

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

export {
  nearField, nearTime
};
