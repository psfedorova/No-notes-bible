import * as THREE from 'three';
import { clamp, lerp, smooth, mulberry32 } from '../lib/textures.js';
import { ASSETS, HI_RES } from '../core/config.js';
import { FOREST_YAW, scene, SUN_DIR } from './renderer.js';
import { gltfLoader, retry, shed } from '../assets/loaders.js';
import { backdrop, FOREST_CAP, ROCK_FOOT_N, rockFoot } from './forest.js';

const nearTime = { value: 0 };
const nearGust = { value: new THREE.Vector2(-100, 0) };
function gust(k){ nearGust.value.set(nearTime.value, k); }
const GUST_GLSL = `uniform vec2 uGust;
  float wHash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)))*43758.5453); }
  float wNoise(vec2 p){
    vec2 i = floor(p), f = fract(p); f = f*f*(3.0 - 2.0*f);
    return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  vec2 breezeAt(vec2 xz, float seed){
    vec2 dir = vec2(0.86, 0.51);
    float roll = wNoise(xz*0.05 - dir*uTime*0.16)*0.7 + wNoise(xz*0.13 - dir*uTime*0.42 + 7.3)*0.3;
    float lean = smoothstep(0.2, 0.9, roll);
    float ripple = sin(uTime*1.9 - dot(xz, dir)*0.45 + seed*0.6)*(0.3 + 0.7*lean);
    return dir*(lean - 0.15 + ripple*0.12) + vec2(-dir.y, dir.x)*ripple*0.05;
  }
  vec2 gustAt(vec2 xz){
    float d = length(xz), a = uTime - uGust.x - d/14.0;
    if(a <= 0.0 || uGust.y <= 0.0) return vec2(0.0);
    float u = a/0.55;
    return xz/max(d, 0.5)*uGust.y*exp(-d/60.0)*u*exp(1.0 - u);
  }
`;
const GRASS_R1 = HI_RES ? 32 : 24, GRASS_R2 = HI_RES ? 58 : 42;
const STONE_HAZE = [10, 0.012, 0.7];
const FAR_R = 30;
const FLOWERS = ['periwinkle_plant'], GONE = ['celandine_01'];
const GRASS_LOD = [16, 30];
function footAround(a){
  const fa = (a/(2*Math.PI) + 1)*ROCK_FOOT_N, f0 = Math.floor(fa) % ROCK_FOOT_N, f1 = (f0 + 1) % ROCK_FOOT_N;
  return lerp(rockFoot[f0] || rockFoot[f1], rockFoot[f1] || rockFoot[f0], fa - Math.floor(fa));
}
function groundHeight(G){
  const half = G.size/2, step = G.size/(G.n - 1);
  return (x, z)=>{
    const fx = clamp((x + half)/step, 0, G.n - 1.001), fz = clamp((z + half)/step, 0, G.n - 1.001);
    const j = fx|0, i = fz|0, u = fx - j, v = fz - i, H = G.h, n = G.n;
    return lerp(lerp(H[i*n + j], H[i*n + j + 1], u), lerp(H[(i + 1)*n + j], H[(i + 1)*n + j + 1], u), v);
  };
}
function mossSkirt(G, mat){
  const A = 192, R = 16, hAt = groundHeight(G), rnd = mulberry32(5150);
  const waves = [1, 2, 3, 5, 8].map(k => [k, rnd()*6.283, 1/k]);
  const reachAt = a => 0.9 + 2.6*Math.pow(0.5 + 0.5*waves.reduce((s, [k, ph, w])=> s + Math.sin(a*k + ph)*w, 0)/1.9, 1.5);
  const pos = new Float32Array(A*R*3), fade = new Float32Array(A*R), idx = [];
  for(let i=0;i<A;i++){
    const a = i/A*2*Math.PI, f = footAround(a), r1 = f + reachAt(a), ca = Math.cos(a), sa = Math.sin(a);
    for(let j=0;j<R;j++){
      const t = j/(R - 1), r = lerp(f - 0.8, r1, Math.pow(t, 0.8)), x = r*ca, z = r*sa, k = i*R + j;
      pos[k*3] = x; pos[k*3 + 1] = hAt(x, z) + 0.05; pos[k*3 + 2] = z;
      fade[k] = 1 - smooth(clamp((r - f)/(r1 - f), 0, 1));
    }
  }
  for(let i=0;i<A;i++) for(let j=0;j<R - 1;j++){
    const a = i*R + j, b = ((i + 1) % A)*R + j;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.userData.noPick = true;
  mesh.name = 'moss-skirt';
  return mesh;
}
function footPlants(G, list){
  const hAt = groundHeight(G), rnd = mulberry32(7741), out = [];
  const pick = a => list.filter(it => it.a === a);
  const clumps = [rnd()*2*Math.PI];
  clumps.push(clumps[0] + Math.PI*(0.55 + 0.5*rnd()));
  const kinds = [['fern_02', 3, 0.5, 1.6, 4.5, 7, 0], ['periwinkle_plant', 3, 0.6, 1.4, 5, 6.5, 0.95]];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  kinds.forEach(([a, count, r0, r1, s0, s1, aside], ki)=>{
    const src = pick(a);
    if(!src.length) return;
    for(let c=0;c<count;c++){
      const ang = clumps[(c + ki) % 2] + ((c >> 1) % 2 ? -aside : aside) + (rnd() - 0.5)*(aside ? 0.3 : 0.8), f = footAround(ang);
      if(!(f > 0)) continue;
      const r = f + lerp(r0, r1, rnd()), x = r*Math.cos(ang), z = r*Math.sin(ang);
      const s = lerp(s0, s1, rnd());
      m.compose(p.set(x, hAt(x, z) - 0.1, z), q.setFromAxisAngle(up, rnd()*6.283), sc.set(s, s, s));
      out.push({ a, v: src[Math.floor(rnd()*src.length)].v, m: m.toArray(), s: 0.25 + 0.2*rnd(), foot: true });
    }
  });
  return out;
}
async function nearField(skirtMat){
  let data;
  try{ data = await retry(async ()=>{ const r = await fetch(ASSETS.forestNear); if(!r.ok) throw new Error(r.status); return r.json(); }); }catch(e){ return; }
  const list = (data.ground ? data.items.concat(footPlants(data.ground, data.items)) : data.items)
    .filter(it => !GONE.includes(it.a) && (!FLOWERS.includes(it.a) || it.foot));
  let floorGeo = null;
  if(data.ground){
    const G = data.ground, geo = floorGeo = new THREE.PlaneGeometry(G.size, G.size, G.n - 1, G.n - 1);
    geo.rotateX(-Math.PI/2);
    const pos = geo.attributes.position;
    for(let i=0;i<pos.count;i++) pos.setY(i, G.h[i]);
    geo.computeBoundingSphere();
    const floor = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false }));
    floor.renderOrder = -5; floor.userData.noPick = true;
    floor.rotation.y = FOREST_YAW;
    scene.add(floor);
    /* iOS WebGL has no OES_texture_float_linear, so filtered data textures are half float */
    const gt = new THREE.DataTexture(Uint16Array.from(G.h, THREE.DataUtils.toHalfFloat), G.n, G.n, THREE.RedFormat, THREE.HalfFloatType);
    gt.magFilter = gt.minFilter = THREE.LinearFilter; gt.needsUpdate = true;
    const U = backdrop.material.uniforms;
    U.tGround.value = gt;
    U.uGround.value.set(G.n, G.size, GRASS_R1, GRASS_R2);
  }
  const byAsset = new Map();
  list.forEach(it=>{ if(!byAsset.has(it.a)) byAsset.set(it.a, []); byAsset.get(it.a).push(it); });
  const SWAY = { fern_02: 1.0, periwinkle_plant: 0.6 };
  const SHADE = { fern_02: 0.4, periwinkle_plant: 0.32 };
  const grp = new THREE.Group();
  grp.name = 'near';
  const _m = new THREE.Matrix4(), _c = new THREE.Color(), _v = new THREE.Vector3();
  const stones = [], tufts = [], bare = [];
  const hAt = data.ground ? groundHeight(data.ground) : null;
  const buried = (geo, m)=>{
    if(!hAt) return false;
    _m.fromArray(m);
    const p = geo.attributes.position;
    for(let k=0;k<p.count;k++){
      _v.fromBufferAttribute(p, k).applyMatrix4(_m);
      if(_v.y > hAt(_v.x, _v.z) - 0.1) return false;
    }
    return true;
  };
  await Promise.all([...byAsset].map(async ([a, items])=>{
    const [gl, far] = await Promise.all([
      retry(()=>gltfLoader.loadAsync(`assets/plants/${a}/${a}${HI_RES && SWAY[a] !== undefined ? '_2k' : ''}.glb?v=2`)).catch(e=>{ console.warn('Plant left out:', a, e); return null; }),
      SWAY[a] === undefined ? retry(()=>gltfLoader.loadAsync(`assets/plants/${a}/${a}_far.glb?v=3`)).catch(()=>null) : null
    ]);
    if(!gl) return;
    const index = g=>{
      const meshes = new Map();
      g.scene.traverse(o=>{ if(o.isMesh){ const n = (o.parent && o.parent.name && !o.parent.isScene ? o.parent.name : o.name); meshes.set(o.name, o); meshes.set(n, o); } });
      return v => meshes.get(v) || meshes.get(v + '_LOD0') || meshes.get(v.replace(/_LOD0$/, '')) || [...meshes.values()][0];
    };
    const find = index(gl), findFar = far ? index(far) : null;
    const byVar = new Map();
    items.forEach(it=>{ const m = find(it.v); if(!byVar.has(m)) byVar.set(m, []); byVar.get(m).push(it); });
    byVar.forEach((its, src)=>{
      const farGeo = findFar ? findFar(its[0].v).geometry : null;
      const mat = src.material.clone();
      ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap'].forEach(k=>shed(mat[k]));
      const plant = SWAY[a] !== undefined;
      if(plant){ mat.side = THREE.DoubleSide; mat.alphaTest = 0.5; mat.alphaToCoverage = true; mat.transparent = false; mat.envMapIntensity = 0.9; }
      if(plant){
        mat.onBeforeCompile = sh=>{
          sh.uniforms.uTime = nearTime; sh.uniforms.uGust = nearGust;
          sh.vertexShader = 'uniform float uTime;\n' + GUST_GLSL + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
            { vec3 w = (instanceMatrix*vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              float h = max(position.y, 0.0);
              vec2 bz = breezeAt(w.xz, wHash(w.xz));
              vec3 bl = vec3(bz.x, 0.0, bz.y)*mat3(instanceMatrix);
              transformed.xz += bl.xz/max(length(instanceMatrix[0].xyz), 1e-4)*h*h*${(0.08*SWAY[a]).toFixed(3)};
              vec2 gw = gustAt(w.xz);
              vec3 gl = vec3(gw.x, 0.0, gw.y)*mat3(instanceMatrix);
              transformed.xz += gl.xz/max(length(instanceMatrix[0].xyz), 1e-4)*h*h*${(1.1*SWAY[a]).toFixed(3)}; }`);
          sh.uniforms.uSunW = { value: SUN_DIR };
          sh.uniforms.tHaze = { value: backdrop.picture };
          sh.vertexShader = 'varying vec4 vScr;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvScr = gl_Position;');
          sh.fragmentShader = 'uniform vec3 uSunW; uniform sampler2D tHaze; varying vec4 vScr;\n' + sh.fragmentShader.replace('#include <alphatest_fragment>', `
            #ifdef USE_MAP
            { vec2 ts = vec2(textureSize(map, 0)), dx = dFdx(vMapUv*ts), dy = dFdy(vMapUv*ts);
              diffuseColor.a *= 1.0 + 0.25*max(0.0, 0.5*log2(max(dot(dx, dx), dot(dy, dy)))); }
            #endif
            #include <alphatest_fragment>`).replace('#include <opaque_fragment>', `
            { vec3 sv = normalize((viewMatrix*vec4(uSunW, 0.0)).xyz);
              float back = pow(clamp(-dot(normalize(vViewPosition), sv), 0.0, 1.0), 3.0);
              outgoingLight += diffuseColor.rgb*vec3(1.0, 0.96, 0.82)*(0.35 + 1.4*back)*0.55;
              vec3 haze = textureLod(tHaze, vScr.xy/vScr.w*0.5 + 0.5, 6.5).rgb;
              outgoingLight = mix(outgoingLight, haze, clamp(1.0 - exp(-max(length(vViewPosition) - 40.0, 0.0)*0.005), 0.0, 0.3)); }
            #include <opaque_fragment>`);
        };
      }else{
        mat.onBeforeCompile = sh=>{
          sh.uniforms.tHaze = { value: backdrop.picture };
          sh.vertexShader = 'varying vec4 vScr;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvScr = gl_Position;');
          sh.fragmentShader = 'uniform sampler2D tHaze; varying vec4 vScr;\n' + sh.fragmentShader.replace('#include <opaque_fragment>', `
            { vec3 haze = textureLod(tHaze, vScr.xy/vScr.w*0.5 + 0.5, 6.5).rgb;
              outgoingLight = mix(outgoingLight, haze, clamp(1.0 - exp(-max(length(vViewPosition) - ${STONE_HAZE[0].toFixed(1)}, 0.0)*${STONE_HAZE[1].toFixed(4)}), 0.0, ${STONE_HAZE[2].toFixed(2)})); }
            #include <opaque_fragment>`);
        };
      }
      const isFar = it => Math.hypot(it.m[12], it.m[14]) > FAR_R;
      const sunk = its.filter(it => !plant && buried(src.geometry, it.m));
      sunk.forEach(it => stones.push({ geo: src.geometry, m: new THREE.Matrix4().fromArray(it.m) }));
      const shown = its.filter(it => !sunk.includes(it));
      [shown.filter(it => !isFar(it)), shown.filter(isFar)].forEach((part, pi)=>{
        if(!part.length) return;
        const im = new THREE.InstancedMesh(pi && farGeo || src.geometry, mat, part.length);
        part.forEach((it, i)=>{
          _m.fromArray(it.m); im.setMatrixAt(i, _m);
          const k = (plant ? 0.78 : 0.82) + (plant ? 0.32 : 0.22)*(it.s ?? 1);
          im.setColorAt(i, _c.setRGB(k, k, k));
          if(!plant) stones.push({ geo: src.geometry, m: _m.clone() });
          else{
            if(!src.geometry.boundingBox) src.geometry.computeBoundingBox();
            const b = src.geometry.boundingBox;
            const reach = Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z)*_m.getMaxScaleOnAxis();
            tufts.push([_m.elements[12], _m.elements[14], reach, SHADE[a] ?? 0.35]);
            if(FLOWERS.includes(a)) bare.push([_m.elements[12], _m.elements[14], Math.max(0.7, reach*0.9)]);
          }
        });
        im.instanceMatrix.needsUpdate = true;
        if(im.instanceColor) im.instanceColor.needsUpdate = true;
        im.castShadow = plant && !pi; im.receiveShadow = true;
        im.frustumCulled = false;
        im.userData.noPick = true;
        grp.add(im);
      });
    });
  }));
  if(data.ground) grp.add(grassField(data.ground, stones, tufts, bare));
  if(data.ground) backdrop.setHeld(stones, floorGeo);
  if(data.ground && skirtMat) grp.add(mossSkirt(data.ground, skirtMat));
  grp.rotation.y = FOREST_YAW;
  scene.add(grp);
}

function grassField(G, stones, tufts, bare){
  const N = HI_RES ? 220000 : 90000, SEG = HI_RES ? 4 : 2, WIDE = HI_RES ? 1 : 1.3;
  const R1 = GRASS_R1, R2 = GRASS_R2;
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
  const CELL = 0.3, SPAN = Math.ceil(2*R2/CELL) + 2, rocky = new Uint8Array(SPAN*SPAN);
  const cellOf = (x, z)=>{ const i = Math.floor((x + R2)/CELL), j = Math.floor((z + R2)/CELL);
    return i < 0 || j < 0 || i >= SPAN || j >= SPAN ? -1 : j*SPAN + i; };
  stones.forEach(({ geo, m })=>{
    const p = geo.attributes.position, v = new THREE.Vector3();
    for(let k=0;k<p.count;k++){
      v.fromBufferAttribute(p, k).applyMatrix4(m);
      if(v.y < hAt(v.x, v.z) - 0.1) continue;
      const c = cellOf(v.x, v.z);
      if(c >= 0) rocky[c] = 1;
    }
  });
  const open = new Uint8Array(SPAN*SPAN);
  bare.forEach(([x, z, r])=>{
    for(let dz=-r;dz<=r;dz+=CELL*0.5) for(let dx=-r;dx<=r;dx+=CELL*0.5){ const c = dx*dx + dz*dz <= r*r ? cellOf(x + dx, z + dz) : -1; if(c >= 0) open[c] = 1; }
  });
  const cleared = (x, z)=>{ const c = cellOf(x, z); return c >= 0 && open[c] === 1; };
  const underStone = (x, z)=>{
    for(let dz=-CELL;dz<=CELL;dz+=CELL) for(let dx=-CELL;dx<=CELL;dx+=CELL){ const c = cellOf(x + dx, z + dz); if(c >= 0 && rocky[c]) return true; }
    return false;
  };
  const AO_R = R2 + 6, AO_N = Math.ceil(2*AO_R/CELL), AO_W = AO_N*CELL, ao = new Float32Array(AO_N*AO_N);
  tufts.forEach(([x, z, reach, k])=>{
    const sg = Math.max(0.35, reach*0.3), R = sg*2.5;
    for(let j=Math.max(0, Math.floor((z - R + AO_R)/CELL));j<=Math.min(AO_N - 1, Math.floor((z + R + AO_R)/CELL));j++)
      for(let i=Math.max(0, Math.floor((x - R + AO_R)/CELL));i<=Math.min(AO_N - 1, Math.floor((x + R + AO_R)/CELL));i++){
        const dx = -AO_R + (i + 0.5)*CELL - x, dz = -AO_R + (j + 0.5)*CELL - z;
        const c = j*AO_N + i;
        ao[c] = 1 - (1 - ao[c])*(1 - k*Math.exp(-(dx*dx + dz*dz)/(2*sg*sg)));
      }
  });
  const rim = new Float32Array(AO_N*AO_N), tmp = new Float32Array(AO_N*AO_N);
  for(let j=0;j<AO_N;j++) for(let i=0;i<AO_N;i++){ const c = cellOf(-AO_R + (i + 0.5)*CELL, -AO_R + (j + 0.5)*CELL); rim[j*AO_N + i] = c >= 0 && rocky[c] ? 1 : 0; }
  for(let pass=0;pass<1;pass++){
    const B = 2;
    for(let j=0;j<AO_N;j++) for(let i=0;i<AO_N;i++){ let t = 0; for(let d=-B;d<=B;d++) t += rim[j*AO_N + Math.min(AO_N - 1, Math.max(0, i + d))]; tmp[j*AO_N + i] = t/(2*B + 1); }
    for(let j=0;j<AO_N;j++) for(let i=0;i<AO_N;i++){ let t = 0; for(let d=-B;d<=B;d++) t += tmp[Math.min(AO_N - 1, Math.max(0, j + d))*AO_N + i]; rim[j*AO_N + i] = t/(2*B + 1); }
  }
  for(let j=0;j<AO_N;j++) for(let i=0;i<AO_N;i++){
    const x = -AO_R + (i + 0.5)*CELL, z = -AO_R + (j + 0.5)*CELL, d = Math.hypot(x, z) - footAt(x, z);
    if(d > -0.5 && d < 2){ const c = j*AO_N + i; ao[c] = 1 - (1 - ao[c])*(1 - 0.3*Math.exp(-Math.max(0, d)/0.45)); }
  }
  for(let c=0;c<ao.length;c++) ao[c] = Math.min(0.45, 1 - (1 - ao[c])*(1 - 0.4*rim[c]));
  const aoTex = new THREE.DataTexture(Uint16Array.from(ao, THREE.DataUtils.toHalfFloat), AO_N, AO_N, THREE.RedFormat, THREE.HalfFloatType);
  aoTex.magFilter = aoTex.minFilter = THREE.LinearFilter; aoTex.needsUpdate = true;
  const BU = backdrop.material.uniforms;
  BU.tAO.value = aoTex; BU.uAO.value.set(AO_R, AO_W);
  const rnd = mulberry32(2718), root = new Float32Array(N*4), blade = new Float32Array(N*4);
  let n = 0;
  for(let c=0, C = HI_RES ? 700 : 380; c<C && n<N; c++){
    const a = (c + rnd()*0.8)/C*2*Math.PI, ca = Math.cos(a), sa = Math.sin(a);
    const f = footAt(ca, sa);
    if(!(f > 0)) continue;
    const lush = sstep(0.25, 0.75, vnz(a*1.9 + 3.1, 0.5)*0.7 + vnz(a*5.3, 4.2)*0.3);
    if(rnd() > 0.85 + 0.15*lush) continue;
    const r = f - 0.05 + (0.3 + 0.7*lush)*rnd()*rnd(), cx = r*ca, cz = r*sa;
    if(underStone(cx, cz)) continue;
    const k = 6 + Math.floor((4 + 3*lush)*rnd()), spread = 0.25 + 0.25*rnd(), tall = (0.62 + 0.18*lush)*(0.9 + 0.2*rnd());
    for(let b=0;b<k && n<N;b++){
      const q = Math.sqrt(rnd()), qa = rnd()*2*Math.PI, x = cx + spread*q*Math.cos(qa), z = cz + spread*q*Math.sin(qa);
      if(Math.hypot(x, z) < footAt(x, z) - 0.12 || cleared(x, z)) continue;
      root[n*4] = x; root[n*4 + 1] = hAt(x, z) - 0.05; root[n*4 + 2] = z; root[n*4 + 3] = rnd();
      blade[n*4] = Math.atan2(z, x) + (rnd() - 0.5)*1.6;
      blade[n*4 + 1] = (0.7 + 0.9*rnd()*rnd())*(1.15 - 0.4*q)*tall;
      blade[n*4 + 2] = (0.045 + 0.05*rnd())*WIDE;
      blade[n*4 + 3] = 0.08 + 0.55*q + 0.2*rnd();
      n++;
    }
  }
  for(let tries=0; n < N && tries < N*4; tries++){
    const r = R2*Math.sqrt(rnd()), a = rnd()*2*Math.PI, cx = r*Math.cos(a), cz = r*Math.sin(a);
    const edge = 1 - sstep(R1, R2, r);
    const dense = Math.max(sstep(0.4, 0.72, vnz(cx*0.16, cz*0.16)*0.65 + vnz(cx*0.5 + 7.3, cz*0.5 + 1.9)*0.35),
      0.85*(1 - sstep(1.5, 6, r - footAt(cx, cz))));
    if(rnd() > edge*(0.85 + 0.15*dense)) continue;
    const tall = (0.8 + 0.2*dense)*(0.5 + 0.5*edge);
    const k = 7 + Math.floor((4 + 3*dense)*rnd()), spread = 0.4 + 0.2*rnd() + 0.1*dense;
    for(let b=0;b<k && n<N;b++){
      const q = Math.sqrt(rnd()), qa = rnd()*2*Math.PI, x = cx + spread*q*Math.cos(qa), z = cz + spread*q*Math.sin(qa);
      if(Math.hypot(x, z) < footAt(x, z) || underStone(x, z) || cleared(x, z)) continue;
      root[n*4] = x; root[n*4 + 1] = hAt(x, z) - 0.05; root[n*4 + 2] = z; root[n*4 + 3] = rnd();
      blade[n*4] = qa + (rnd() - 0.5)*1.4;
      blade[n*4 + 1] = (0.75 + 0.6*rnd()*rnd())*(1.1 - 0.3*q)*tall*(0.8 + 0.3*rnd());
      blade[n*4 + 2] = (0.035 + 0.065*rnd())*WIDE;
      blade[n*4 + 3] = 0.08 + 0.55*q + 0.2*rnd();
      n++;
    }
  }
  const PLOT = 24, PN = Math.ceil(2*R2/PLOT), plots = [];
  for(let i=0;i<PN*PN;i++) plots.push([]);
  const plotOf = i => Math.min(PN - 1, Math.max(0, Math.floor((root[i*4 + 2] + R2)/PLOT)))*PN + Math.min(PN - 1, Math.max(0, Math.floor((root[i*4] + R2)/PLOT)));
  for(let i=0;i<n;i++){
    const r = Math.hypot(root[i*4], root[i*4 + 2]);
    if(r <= R1 + 4 || hh(i*0.37, 5.1) >= 0.4*sstep(R1 + 4, R1 + 14, r)) plots[plotOf(i)].push(i);
  }
  const tmpls = [SEG, Math.min(SEG, 2), 1].map(segs=>{
    const pos = [], idx = [];
    for(let s=0;s<=segs;s++){ const t = s/segs; pos.push(-0.5, t, 0, 0.5, t, 0); }
    for(let s=0;s<segs;s++){ const a = s*2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    return [new THREE.Float32BufferAttribute(pos, 3), new THREE.Uint16BufferAttribute(idx, 1)];
  });
  const lodOf = i =>{ const r = Math.hypot(root[i*4], root[i*4 + 2]); return r < GRASS_LOD[0] ? 0 : r < GRASS_LOD[1] ? 1 : 2; };
  const U = backdrop.material.uniforms;
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, lights: true,
    uniforms: { ...THREE.UniformsLib.lights, uTime: nearTime, uGust: nearGust, tPano: U.tPano, tWater: U.tWater, tDepth: U.tDepth, uNear: U.uNear, uFar: U.uFar, tAO: U.tAO, uAO: U.uAO,
      uCap: { value: FOREST_CAP }, uGain: U.uGain, uSun: { value: SUN_DIR }, tHaze: { value: backdrop.picture }, uFoot: U.uFoot },
    vertexShader: `uniform float uTime, uGain, uNear, uFar; uniform sampler2D tPano, tWater, tDepth, tAO; uniform vec3 uCap; uniform vec2 uAO;
      uniform float uFoot[${ROCK_FOOT_N}];
      #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
      uniform mat4 directionalShadowMatrix[NUM_DIR_LIGHT_SHADOWS];
      varying vec4 vSunShadow;
      varying float vShade;
      #endif
      ${GUST_GLSL}
      attribute vec4 aRoot, aBlade;
      varying vec3 vCol, vWp; varying float vT, vLit; varying vec4 vScr;
      vec2 eqUv(vec3 q){ return vec2(atan(q.z, q.x)*0.15915494 + 0.5, asin(clamp(q.y, -1.0, 1.0))*0.31830989 + 0.5); }
      void main(){
        vec3 r = aRoot.xyz, rel = r - uCap;
        float L = length(rel);
        vec2 uv = eqUv(rel/L);
        vec3 fl = textureLod(tPano, uv, 1.0).rgb;
        float l0 = dot(fl, vec3(0.3, 0.59, 0.11));
        vLit = 1.0;
        { float rr = length(r.xz), fa = atan(r.z, r.x)*${(ROCK_FOOT_N/(2*Math.PI)).toFixed(6)} + ${ROCK_FOOT_N.toFixed(1)};
          int f0 = int(floor(fa)) % ${ROCK_FOOT_N}, f1 = (f0 + 1) % ${ROCK_FOOT_N};
          float rf = mix(uFoot[f0], uFoot[f1], fract(fa));
          if(rf > 0.0 && rr < rf + 3.5){
            vec2 o = r.xz/rr, s = vec2(-o.y, o.x);
            vec3 fo = vec3(0.0);
            for(int k=0;k<4;k++){
              vec2 q = o*(rf + 3.0 + float(k/2)*1.5) + s*(float(k%2)*2.0 - 1.0)*1.2;
              fo += textureLod(tPano, eqUv(normalize(vec3(q.x, r.y, q.y) - uCap)), 2.0).rgb;
            }
            fl = max(fl, fo*0.25*mix(0.3, 0.6, smoothstep(rf, rf + 3.5, rr)));
            vLit = clamp(l0/max(dot(fl, vec3(0.3, 0.59, 0.11)), 1e-4), 0.0, 1.0);
          } }
        float wet = textureLod(tWater, uv, 0.0).r;
        float seen = 1.0/(textureLod(tDepth, uv, 0.0).r*(1.0/uNear - 1.0/uFar) + 1.0/uFar);
        vec3 fs = pow(textureLod(tPano, uv, 5.0).rgb, vec3(1.0/2.2));
        float hue = (fs.g - fs.b)/max(fs.r - fs.b, 1e-3);
        float bank = smoothstep(0.02, 0.15, textureLod(tWater, uv, 5.0).r);
        float keep = max(smoothstep(0.45, 0.75, hue), bank)*(1.0 - smoothstep(0.0, 0.08, wet))*step(L*0.4, seen);
        float t = position.y, H = aBlade.y*step(fract(aRoot.w*17.31), keep), lean = aBlade.w;
        vec2 f = vec2(cos(aBlade.x), sin(aBlade.x)), sd = vec2(-f.y, f.x);
        float w = aBlade.z*pow(1.0 - t, 0.6);
        vec2 bz = breezeAt(r.xz, fract(aRoot.w*13.7));
        vec2 gb = gustAt(r.xz)*0.9;
        vec2 bend = f*lean*H*t*t + bz*t*t*H*0.14 + gb*t*t*H;
        float lay = 1.0 - 0.45*min(dot(gb, gb), 1.0)*t;
        vec3 p = r + vec3(sd.x*position.x*w + bend.x, H*t*(1.0 - 0.3*lean*t)*lay, sd.y*position.x*w + bend.y);
        vec4 wp = modelMatrix*vec4(p, 1.0);
        #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
        vSunShadow = directionalShadowMatrix[0]*wp;
        vShade = step(length(r.xz), 16.0);
        #endif
        vWp = wp.xyz;
        gl_Position = projectionMatrix*viewMatrix*wp;
        vScr = gl_Position;
        float lum = dot(fl, vec3(0.3, 0.59, 0.11));
        vec3 c = max(mix(vec3(lum), fl, 1.3), 0.0)*mix(0.85, 1.15, fract(aRoot.w*7.13));
        float plot = fract(sin(dot(floor(r.xz*0.35), vec2(12.9898, 78.233)))*43758.5453);
        c *= mix(vec3(1.0), vec3(1.05, 1.04, 0.92), smoothstep(0.35, 0.9, plot));
        if(fract(aRoot.w*3.7) < 0.1) c = mix(c, lum*vec3(1.35, 1.12, 0.55), 0.4*t);
        vCol = c*uGain*(1.0 - textureLod(tAO, (r.xz + uAO.x)/uAO.y, 0.0).r*(1.0 - 0.6*t)); vT = t;
      }`,
    fragmentShader: `uniform vec3 uSun; uniform sampler2D tHaze;
      varying vec3 vCol, vWp; varying float vT, vLit; varying vec4 vScr;
      #include <common>
      #include <packing>
      #include <shadowmap_pars_fragment>
      #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
      varying vec4 vSunShadow;
      varying float vShade;
      #endif
      void main(){
        float sh = 1.0;
        #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
        if(vShade > 0.5){ DirectionalLightShadow ds = directionalLightShadows[0];
          sh = getShadow(directionalShadowMap[0], ds.shadowMapSize, ds.shadowIntensity, ds.shadowBias, ds.shadowRadius, vSunShadow); }
        #endif
        vec3 V = vWp - cameraPosition;
        float d = length(V);
        float back = pow(clamp(dot(V/d, uSun), 0.0, 1.0), 3.0);
        vec3 c = vCol*mix(0.6, 1.12, vT)*mix(0.45, 1.0, mix(1.0, sh, vLit)) +vCol*vec3(0.9, 1.15, 0.45)*back*1.3*vT*vLit*sh;
        vec3 haze = textureLod(tHaze, vScr.xy/vScr.w*0.5 + 0.5, 6.5).rgb;
        c = mix(c, haze, clamp(1.0 - exp(-max(d - 40.0, 0.0)*0.005), 0.0, 0.3));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  const field = new THREE.Group();
  field.name = 'grass';
  plots.flatMap(order => [0, 1, 2].map(l => [order.filter(i => lodOf(i) === l), l])).forEach(([order, lod])=>{
    const m = order.length;
    if(!m) return;
    const r4 = new Float32Array(m*4), b4 = new Float32Array(m*4);
    let cx = 0, cy = 0, cz = 0;
    order.forEach((i, o)=>{ r4.set(root.subarray(i*4, i*4 + 4), o*4); b4.set(blade.subarray(i*4, i*4 + 4), o*4); cx += root[i*4]; cy += root[i*4 + 1]; cz += root[i*4 + 2]; });
    const c = new THREE.Vector3(cx/m, cy/m, cz/m);
    let rad = 0;
    for(let o=0;o<m;o++) rad = Math.max(rad, Math.hypot(r4[o*4] - c.x, r4[o*4 + 1] - c.y, r4[o*4 + 2] - c.z));
    const ig = new THREE.InstancedBufferGeometry();
    ig.setAttribute('position', tmpls[lod][0]);
    ig.setIndex(tmpls[lod][1]);
    ig.setAttribute('aRoot', new THREE.InstancedBufferAttribute(r4, 4));
    ig.setAttribute('aBlade', new THREE.InstancedBufferAttribute(b4, 4));
    ig.instanceCount = m;
    ig.boundingSphere = new THREE.Sphere(c, rad + 4);
    const mesh = new THREE.Mesh(ig, mat);
    mesh.userData.noPick = true;
    mesh.receiveShadow = true;
    field.add(mesh);
  });
  return field;
}

export {
  gust, GUST_GLSL, nearField, nearGust, nearTime
};
