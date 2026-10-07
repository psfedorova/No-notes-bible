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
/* the grass grows out to GRASS_R1 and thins away by GRASS_R2 (tenths of a metre from the rock);
   a phone grows it as thick, on the ground nearer the rock */
const GRASS_R1 = HI_RES ? 32 : 24, GRASS_R2 = HI_RES ? 58 : 42;
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
    /* the floor's height for the forest's march, which softens it where the grass stands;
       half floats, since a phone will not filter full ones */
    const gt = new THREE.DataTexture(Uint16Array.from(G.h, THREE.DataUtils.toHalfFloat), G.n, G.n, THREE.RedFormat, THREE.HalfFloatType);
    gt.magFilter = gt.minFilter = THREE.LinearFilter; gt.needsUpdate = true;
    const U = backdrop.material.uniforms;
    U.tGround.value = gt;
    U.uGround.value.set(G.n, G.size, GRASS_R1, GRASS_R2);
  }
  const byAsset = new Map();
  list.forEach(it=>{ if(!byAsset.has(it.a)) byAsset.set(it.a, []); byAsset.get(it.a).push(it); });
  const SWAY = { fern_02: 1.0, grass_medium_02: 1.4, celandine_01: 0.6, periwinkle_plant: 0.6 };
  /* how deep the shade is on the ground at each plant's foot */
  const SHADE = { fern_02: 0.4, grass_medium_02: 0.25, celandine_01: 0.32, periwinkle_plant: 0.32 };
  const grp = new THREE.Group();
  grp.name = 'near';
  const _m = new THREE.Matrix4(), _c = new THREE.Color();
  const stones = [], tufts = [];
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
        if(!plant) stones.push({ geo: src.geometry, m: _m.clone() });
        else{
          if(!src.geometry.boundingBox) src.geometry.computeBoundingBox();
          const b = src.geometry.boundingBox;
          const reach = Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z)*_m.getMaxScaleOnAxis();
          tufts.push([_m.elements[12], _m.elements[14], reach, SHADE[a] ?? 0.35]);
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
  if(data.ground) grp.add(grassField(data.ground, stones, tufts));
  grp.rotation.y = FOREST_YAW;
  scene.add(grp);
}

/* grass round the boulder: blades in tufts, rooted on the floor the forest render
   shows and coloured by it where they stand, so they rise out of the moss in its own
   light and shade. Each tuft fans out from its root, the outer blades leaning most, and
   the tufts stand close enough to hide the painted floor between them. No blade grows
   on brown earth, in the water, inside a stone's outline at the floor or far behind
   what the capture point saw; moss turned yellow by the sun is still moss, and the pale
   bank grows grass down to the water. Where the floor is half earth the tufts thin out
   rather than shrink, and at the near field's edge they shorten and thin out into the
   picture. Built in the forest's own frame (the group turns it by FOREST_YAW) */
function grassField(G, stones, tufts){
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
  /* most stones sit deep in the moss, so what keeps the grass off one is the outline it
     shows at the floor, not its whole size */
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
  const underStone = (x, z)=>{
    for(let dz=-CELL;dz<=CELL;dz+=CELL) for(let dx=-CELL;dx<=CELL;dx+=CELL){ const c = cellOf(x + dx, z + dz); if(c >= 0 && rocky[c]) return true; }
    return false;
  };
  /* the shade at the foot of each plant and round each stone: what leaves and stone keep
     from the sky darkens the ground and the grass close by, soft and without their shape,
     so they stand in the meadow instead of on it. One map, read by the grass here and by
     the forest's floor */
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
  /* the boulder keeps the most sky from the floor at its foot: deep shade where it goes
     into the ground, fading within a metre or so, so it sits in the earth and not on it */
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
  /* the grass grows up against the stone all round its foot, thick and tall there as in
     the shelter of any boulder; blades rooted a little under its edge rise in front of it */
  for(let c=0, C = HI_RES ? 300 : 180; c<C && n<N; c++){
    const a = (c + rnd()*0.8)/C*2*Math.PI, ca = Math.cos(a), sa = Math.sin(a);
    const f = footAt(ca, sa);
    if(!(f > 0)) continue;
    const r = f + 0.05 + 0.55*rnd()*rnd(), cx = r*ca, cz = r*sa;
    if(underStone(cx, cz)) continue;
    const k = 5 + Math.floor(7*rnd()), spread = 0.2 + 0.25*rnd(), tall = 0.6 + 0.3*rnd();
    for(let b=0;b<k && n<N;b++){
      const q = Math.sqrt(rnd()), qa = rnd()*2*Math.PI, x = cx + spread*q*Math.cos(qa), z = cz + spread*q*Math.sin(qa);
      if(Math.hypot(x, z) < footAt(x, z) - 0.12) continue;
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
    const dense = sstep(0.4, 0.72, vnz(cx*0.16, cz*0.16)*0.65 + vnz(cx*0.5 + 7.3, cz*0.5 + 1.9)*0.35);
    if(rnd() > edge*(0.45 + 0.55*dense)) continue;
    const tall = (0.5 + 0.5*dense)*(0.5 + 0.5*edge);
    const k = 5 + Math.floor((4 + 10*dense)*rnd()), spread = 0.25 + 0.35*rnd() + 0.3*dense;
    for(let b=0;b<k && n<N;b++){
      const q = Math.sqrt(rnd()), qa = rnd()*2*Math.PI, x = cx + spread*q*Math.cos(qa), z = cz + spread*q*Math.sin(qa);
      if(Math.hypot(x, z) < footAt(x, z) || underStone(x, z)) continue;
      root[n*4] = x; root[n*4 + 1] = hAt(x, z) - 0.05; root[n*4 + 2] = z; root[n*4 + 3] = rnd();
      blade[n*4] = qa + (rnd() - 0.5)*1.4;
      blade[n*4 + 1] = (0.6 + 0.9*rnd()*rnd())*(1.15 - 0.45*q)*tall;
      blade[n*4 + 2] = (0.045 + 0.05*rnd())*WIDE;
      blade[n*4 + 3] = 0.08 + 0.55*q + 0.2*rnd();
      n++;
    }
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
    uniforms: { uTime: nearTime, tPano: U.tPano, tWater: U.tWater, tDepth: U.tDepth, uNear: U.uNear, uFar: U.uFar, tAO: U.tAO, uAO: U.uAO,
      uCap: { value: FOREST_CAP }, uGain: U.uGain, uSun: { value: SUN_DIR }, tHaze: { value: backdrop.picture } },
    vertexShader: `uniform float uTime, uGain, uNear, uFar; uniform sampler2D tPano, tWater, tDepth, tAO; uniform vec3 uCap; uniform vec2 uAO;
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
        vec3 fs = pow(textureLod(tPano, uv, 5.0).rgb, vec3(1.0/2.2));
        float hue = (fs.g - fs.b)/max(fs.r - fs.b, 1e-3);
        float bank = smoothstep(0.02, 0.15, textureLod(tWater, uv, 5.0).r);
        float keep = max(smoothstep(0.45, 0.75, hue), bank)*(1.0 - smoothstep(0.0, 0.08, wet))*step(L*0.4, seen);
        float t = position.y, H = aBlade.y*step(fract(aRoot.w*17.31), keep), lean = aBlade.w;
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
        vCol = c*uGain*(1.0 - textureLod(tAO, (r.xz + uAO.x)/uAO.y, 0.0).r*(1.0 - 0.6*t)); vT = t;
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
