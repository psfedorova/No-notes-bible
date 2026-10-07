/* the boulder the book lies on: granite and moss, laid on triplanar */
import * as THREE from 'three';
import { cv, normalFromHeight } from '../lib/textures.js';
import { GROUND_Y } from '../core/config.js';
import { SUN_DIR } from './renderer.js';
import { shed } from '../assets/loaders.js';

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
  /* cushions: yellow-green where they swell into the light, deep olive between them,
     and here and there a patch gone brown and dry */
  vec3 mossTone(vec3 c, vec3 p){
    c = mix(c, dot(c, vec3(0.3, 0.59, 0.11))*vec3(1.06, 1.0, 0.6), 0.3)*1.2;
    float cush = vn3(p*3.2 + 9.0), hue = vn3(p*0.55 + 2.0), dry = smoothstep(0.66, 0.8, vn3(p*1.1 + 20.0));
    c *= mix(vec3(0.74, 0.82, 0.64), vec3(1.25, 1.2, 0.95), hue);
    c = mix(c, dot(c, vec3(0.3, 0.59, 0.11))*vec3(1.25, 0.95, 0.55), dry*0.55);
    return c*mix(0.7, 1.15, cush)*(0.62 + 0.25*vn3(p*0.9));
  }
  vec3 stoneN(vec3 a, vec3 b){ a = a*2.0 - 1.0; b = b*2.0 - 1.0;
    return normalize(vec3(a.xy + b.xy*0.6, a.z*b.z))*0.5 + 0.5; }
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
  return shed(x);
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
    tGranite: { value: rockTex(img.granite, true) }, tGraniteN: { value: heightNormal(img.granite, 1.4) },
    tStone: { value: rockTex(img.stone, true) }, tStoneN: { value: rockTex(img.stoneNor, false) }, sScale: { value: 0.085 },
    tMoss: { value: rockTex(img.moss, true) }, tMossN: { value: heightNormal(img.moss, 3.0) },
    gScale: { value: 0.3 }, mScale: { value: 0.7 }, uSunDir: { value: SUN_DIR }, uTime: rockTime
  };
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, envMapIntensity: 1.3 });
  m.onBeforeCompile = sh=>{
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec3 vWp; varying vec3 vWn;\n' + sh.vertexShader.replace('#include <fog_vertex>',
      '#include <fog_vertex>\n vWp = (modelMatrix*vec4(position,1.0)).xyz; vWn = normalize(mat3(modelMatrix)*normal);');
    sh.fragmentShader = `uniform sampler2D tGranite, tGraniteN, tMoss, tMossN, tStone, tStoneN; uniform float gScale, mScale, sScale, uTime; uniform vec3 uSunDir;
      varying vec3 vWp; varying vec3 vWn;` + MOSS_GLSL + sh.fragmentShader
      .replace('#include <map_fragment>', `
        /* the lower half of the boulder is buried: cut at the floor, or it hangs below the
           forest's ground as a dark skirt that slides over the moss as one walks round */
        if(vWp.y < ${GROUND_Y.toFixed(2)}) discard;
        vec3 Nw = normalize(vWn), Wt = triW(Nw);
        float mm = mossMask(vWp, Nw);
        /* the scanned stone gives the boulder its lichen, stains and cracks at the scale of
           the whole rock; the granite's grain is laid over it for the eye that comes close */
        vec3 stone = tri(tStone, vWp*sScale + 0.37, Wt).rgb;
        float grain = dot(tri(tGranite, vWp*gScale, Wt).rgb, vec3(0.3, 0.59, 0.11));
        vec3 gran = stone*mix(1.0, grain/0.25, 0.45)*2.4;
        gran *= mix(0.78, 1.08, vn3(vWp*0.45 + 7.0));
        vec3 mos = mossTone(tri(tMoss, vWp*mScale, Wt).rgb, vWp);
        /* the stone darkens and greens where the moss is about to take it */
        float edge = smoothstep(0.0, 0.35, mm)*(1.0 - smoothstep(0.35, 0.9, mm));
        gran *= 1.0 - edge*0.35;
        diffuseColor.rgb *= mix(gran, mos, smoothstep(0.25, 0.75, mm));
        /* shade gathering low down, where the boulder sinks into the forest floor */
        diffuseColor.rgb *= mix(0.4, 1.0, smoothstep(${GROUND_Y.toFixed(2)} - 0.2, ${(GROUND_Y + 2.6).toFixed(2)}, vWp.y));`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.82, 0.97, mm);')
      .replace('#include <lights_fragment_end>', MOSS_LIT('smoothstep(0.3, 0.8, mm)'))
      .replace('#include <normal_fragment_maps>', `
        { vec3 p = vWp*mix(gScale, mScale, step(0.5, mm)), q = vWp*sScale + 0.37;
          vec3 tx = mix(stoneN(texture2D(tStoneN, q.zy).xyz, texture2D(tGraniteN, p.zy).xyz), texture2D(tMossN, p.zy).xyz, mm)*2.0 - 1.0;
          vec3 ty = mix(stoneN(texture2D(tStoneN, q.xz).xyz, texture2D(tGraniteN, p.xz).xyz), texture2D(tMossN, p.xz).xyz, mm)*2.0 - 1.0;
          vec3 tz = mix(stoneN(texture2D(tStoneN, q.xy).xyz, texture2D(tGraniteN, p.xy).xyz), texture2D(tMossN, p.xy).xyz, mm)*2.0 - 1.0;
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
  grp.name = 'moss';
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
          if(vWp.y < ${GROUND_Y.toFixed(2)}) discard;
          vec3 sp = vWp*70.0;
          float strand = vn3(sp) *0.65 + vn3(sp*2.3 + 5.0)*0.35;
          /* cushions: the strands stand tall in clumps and lie low between them */
          float clump = vn3(vWp*3.2 + 9.0);
          if(vBed < 0.15 || strand < 0.32 + uT*0.42 || mm < 0.3 + uT*0.55 || clump < uT*0.7 - 0.05) discard;
          vec3 mos = mossTone(tri(tMoss, vWp*mScale, Wt).rgb, vWp);
          diffuseColor.rgb *= mos*(0.55 + 0.6*uT);`);
    };
    const sh = new THREE.Mesh(rock.geometry, m);
    sh.receiveShadow = true;
    grp.add(sh);
  }
  return grp;
}

export {
  mossShells, rockMaterial, rockTime
};
