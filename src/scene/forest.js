/* the forest all round: the Blender panorama ray-marched against its depth */
import * as THREE from 'three';
import { cv } from '../lib/textures.js';
import { GROUND_Y, HI_RES, VH, VW } from '../core/config.js';
import { camera, DPR, FOREST_YAW, renderer, SUN_DIR } from './renderer.js';
import { shed } from '../assets/loaders.js';

/* the forest all round: built in Blender (blender/build_forest.py) and rendered as a
   360 panorama from 1 m over the boulder, with its distance from that point for every
   direction. Each pixel of the dome is found where the eye's ray meets that surface,
   so the forest keeps its true shape and parallax as one walks round the rock. Where
   walking round uncovers what a near trunk or fern hid, a second render with those
   left out shows it. The water, known from its own render pass, runs the way the
   stream runs */
const FOREST_CAP = new THREE.Vector3(0, GROUND_Y + 10, 0);      // the capture point, 1 m over the floor
const FOREST_GAIN = 2.0;                                         // the picture is stored at half its light
const FOREST_EXPOSURE = 2.2;                                     // and shown a little brighter than it was rendered
const DEPTH_NEAR = 5, DEPTH_FAR = 4000;                          // its distance range, in tenths of a metre
/* how far the boulder reaches out over the floor round its foot, by bearing in the
   panorama's own frame (the rock's, before FOREST_YAW), filled once the rock is in */
const ROCK_FOOT_N = 64;
const rockFoot = new Float32Array(ROCK_FOOT_N);
function measureFoot(rock, grp){
  grp.updateMatrix();
  const p = rock.geometry.attributes.position, v = new THREE.Vector3();
  for(let i=0;i<p.count;i++){
    v.fromBufferAttribute(p, i).applyMatrix4(grp.matrix);
    if(v.y < GROUND_Y - 0.4 || v.y > GROUND_Y + 0.8) continue;
    const k = Math.floor((Math.atan2(v.z, v.x)/(2*Math.PI) + 1)*ROCK_FOOT_N) % ROCK_FOOT_N;
    rockFoot[k] = Math.max(rockFoot[k], Math.hypot(v.x, v.z));
  }
}
async function decodeDepth(url, smooth){
  const res = await fetch(url);
  if(!res.ok) throw new Error('Could not load ' + url + ' (' + res.status + ')');
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const w = bmp.width, h = bmp.height, q = new Uint16Array(w*h);
  /* read through a strip: iOS Safari refuses any canvas over 4096 x 4096 pixels, and a
     phone reads a thin one, so the strip and its pixel copy stay small */
  const band = Math.max(1, Math.min(h, ((HI_RES ? 4194304 : 1048576)/w)|0));
  const c = cv(w, band), x = c.getContext('2d', { willReadFrequently: true });
  for(let y0=0;y0<h;y0+=band){
    const rows = Math.min(band, h - y0);
    x.clearRect(0, 0, w, band);
    x.drawImage(bmp, 0, y0, w, rows, 0, 0, w, rows);
    const d = x.getImageData(0, 0, w, rows).data;
    for(let i=0, o=y0*w;i<w*rows;i++) q[o + i] = d[i*4]*256 + d[i*4 + 1];
  }
  bmp.close && bmp.close();
  const out = new Uint16Array(w*h);
  /* stored top row first; textures read bottom row first */
  for(let y=0;y<h;y++){
    const src = (h - 1 - y)*w, dst = y*w;
    for(let i=0;i<w;i++) out[dst + i] = THREE.DataUtils.toHalfFloat(q[src + i]/65535);
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RedFormat, THREE.HalfFloatType);
  /* the forest's own layer is read nearest, not filtered: a leaf against the sky must not
     blend into a surface halfway between. The layer behind only fills the strips a near
     trunk uncovers, and is read filtered, so what shows there is stretched smoothly over
     its own edges instead of breaking into blocks */
  t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter; t.needsUpdate = true;
  if(!smooth) t.userData.soft = softDepth(q, w, h, Math.max(1, Math.round(w/768)));
  return shed(t);
}
/* the canopy overhead seen as one soft surface: thousands of leaves against the sky
   leap in distance from texel to texel, and stepping aside from the capture point would
   break them into a mosaic of blocks. Averaged over a few leaves and blurred, the
   crown only bends a little as one walks round, the way a far crown does */
function softDepth(q, w, h, k){
  const W = w/k|0, H = h/k|0, a = new Float32Array(W*H), b = new Float32Array(W*H);
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    let s = 0;
    for(let j=0;j<k;j++){ const row = ((H - 1 - y)*k + j)*w; for(let i=0;i<k;i++) s += q[row + x*k + i]; }
    a[y*W + x] = s/(k*k*65535);
  }
  const R = 3;
  for(let pass=0;pass<2;pass++){
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){ let s = 0; for(let i=-R;i<=R;i++) s += a[y*W + ((x + i + W) % W)]; b[y*W + x] = s/(2*R + 1); }
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){ let s = 0; for(let j=-R;j<=R;j++) s += b[Math.min(H - 1, Math.max(0, y + j))*W + x]; a[y*W + x] = s/(2*R + 1); }
  }
  const out = new Uint16Array(W*H);
  for(let i=0;i<W*H;i++) out[i] = THREE.DataUtils.toHalfFloat(a[i]);
  const t = new THREE.DataTexture(out, W, H, THREE.RedFormat, THREE.HalfFloatType);
  t.wrapS = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return shed(t);
}
function makeBackdrop(pano, depth, water, back, backDepth){
  const tex = (im, srgb)=>{ const t = new THREE.Texture(im); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true; return shed(t); };
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: {
      tPano: { value: tex(pano, true) }, tDepth: { value: depth }, tWater: { value: tex(water, false) },
      tBack: { value: tex(back, true) }, tBackDepth: { value: backDepth }, tSoft: { value: depth.userData.soft },
      uCam: { value: new THREE.Vector3() }, uCap: { value: FOREST_CAP }, uYaw: { value: new THREE.Vector2(Math.cos(FOREST_YAW), Math.sin(FOREST_YAW)) }, uTime: { value: 0 }, uGain: { value: FOREST_GAIN*FOREST_EXPOSURE },
      uNear: { value: DEPTH_NEAR }, uFar: { value: DEPTH_FAR }, uSun: { value: SUN_DIR }, uFoot: { value: rockFoot } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = p.xyww; }',
    fragmentShader: `#define MARCH_STEPS ${HI_RES ? 112 : 60}
      uniform sampler2D tPano, tDepth, tWater, tBack, tBackDepth, tSoft; uniform vec2 uYaw;
      vec3 unyaw(vec3 v){ return vec3(uYaw.x*v.x - uYaw.y*v.z, v.y, uYaw.y*v.x + uYaw.x*v.z); } uniform vec3 uCam, uCap, uSun; uniform float uTime, uGain, uNear, uFar;
      uniform float uFoot[${ROCK_FOOT_N}];
      varying vec3 vDir;
      float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x*p.y); }
      float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0 - 2.0*f);
        return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y); }
      vec2 eqUv(vec3 q){ return vec2(atan(q.z, q.x)*0.15915494 + 0.5, asin(clamp(q.y, -1.0, 1.0))*0.31830989 + 0.5); }
      float unpack(float inv){ return 1.0/(inv*(1.0/uNear - 1.0/uFar) + 1.0/uFar); }
      float distF(vec3 q){ vec2 u = eqUv(q); float a = textureLod(tDepth, u, 0.0).r, w = smoothstep(0.14, 0.42, q.y);
        if(w > 0.0) a = mix(a, textureLod(tSoft, u, 0.0).r, w);
        return unpack(a); }
      float distB(vec3 q){ return unpack(textureLod(tBackDepth, eqUv(q), 0.0).r); }
      /* march the eye's ray out from the camera until it passes behind one layer's
         surface (as the capture point saw it), then close in on the crossing. Where the
         surface is the same on both sides of the crossing the ray has met it. Where it
         leaps away (the edge of a trunk) the ray has only slipped into the trunk's shadow
         as the capture point saw it, so it walks on to whatever lies beyond. gap is that
         leap, kept when nothing beyond is met: the ray then ends where the capture point
         could not see, on the far side of the edge rather than smeared along the trunk */
      #define SLIP 0.04
      #define MARCH(DIST, d, o, T, GAP) { float ta = 2.0, tb = 2.0, fa = -1.0, tS = -1.0, gS = 0.0; T = -1.0; GAP = 0.0; \
        for(int i=1;i<=MARCH_STEPS;i++){ tb = 2.0*pow(3000.0, float(i)/float(MARCH_STEPS)); vec3 P_ = o + tb*d; float L_ = length(P_), f_ = L_ - DIST(P_/L_); \
          if(f_ > 0.0 && fa <= 0.0){ float lo = ta, hi = tb; \
            for(int k=0;k<7;k++){ float tm = 0.5*(lo + hi); vec3 Q_ = o + tm*d; float Lq = length(Q_); if(Lq - DIST(Q_/Lq) > 0.0) hi = tm; else lo = tm; } \
            float dLo = DIST(normalize(o + lo*d)), dHi = DIST(normalize(o + hi*d)), jump = (dLo - dHi)/dHi; \
            if(jump < SLIP){ T = hi; GAP = 0.0; break; } \
            if(tS < 0.0){ tS = lo; gS = jump; } } \
          ta = tb; fa = f_; } \
        if(T < 0.0){ if(tS > 0.0){ T = tS; GAP = gS; } else { T = 6000.0; GAP = 0.0; } } }
      void main(){
        vec3 d = unyaw(normalize(vDir)), o = unyaw(uCam - uCap);
        float t, gap, tAlt, gapAlt;
        MARCH(distF, d, o, t, gap);
        /* the layer behind only fills what a near thing hid, never with open sky, and
           fades in rather than switching, so no hard-edged patch shows */
        float wBack = 0.0;
        if(gap > 0.04){ MARCH(distB, d, o, tAlt, gapAlt); if(gapAlt < gap && tAlt < 2500.0) wBack = smoothstep(0.04, 0.16, gap - gapAlt); }
        vec3 P = o + t*d, q = normalize(P);
        vec2 uv = eqUv(q);
        vec2 uvB = eqUv(normalize(o + (wBack > 0.0 ? tAlt : t)*d));
        /* gradients taken across the wrap as well, so the seam where the panorama
           closes on itself does not drop to the coarsest mip */
        vec2 gx = dFdx(uv), gy = dFdy(uv);
        vec2 uw = vec2(fract(uv.x + 0.5), uv.y), gxw = dFdx(uw), gyw = dFdy(uw);
        if(abs(gxw.x) + abs(gyw.x) < abs(gx.x) + abs(gy.x)){ gx = gxw; gy = gyw; }
        /* where neighbouring pixels meet different surfaces the picture's gradient leaps
           and would fetch a coarse, blocky mip: it is held near what the eye's own ray
           sweeps, grown by how much farther the surface is from the eye than from the
           capture point */
        vec2 ud = eqUv(d), hx = dFdx(ud), hy = dFdy(ud);
        vec2 udw = vec2(fract(ud.x + 0.5), ud.y), hxw = dFdx(udw), hyw = dFdy(udw);
        if(abs(hxw.x) + abs(hyw.x) < abs(hx.x) + abs(hy.x)){ hx = hxw; hy = hyw; }
        float lim = 3.0*max(length(hx), length(hy))*t/length(P);
        gx *= min(1.0, lim/max(length(gx), 1e-7)); gy *= min(1.0, lim/max(length(gy), 1e-7));
        /* past the book the lens lets the far wood go soft */
        float soft = mix(1.0, 2.6, smoothstep(150.0, 700.0, t));
        gx *= soft; gy *= soft;
        /* read with the same gradients: along the seam an implicit fetch drops to the
           coarsest mip, the whole stream averaged, and a line of sun glints ran over the grass */
        vec4 wf = textureGrad(tWater, uv, gx/soft, gy/soft);
        vec3 col;
        if(wf.r > 0.02){
          /* running water: ripples of three sizes carried downstream bend what shows
             through and tilt the surface, which mirrors the canopy more as one looks along
             it and catches glints of sun on the steeper crests. Each size calms to a mirror
             only where a pixel spans more than its own wavelength, so far off the stream
             still moves in its long swells and never boils into glitter up close. Two
             patterns slide at different speeds in each size, so the surface keeps changing
             instead of scrolling past like a belt, and slow bands of light drift down it */
          vec3 W = P + uCap;
          vec2 fl = normalize(wf.gb*2.0 - 1.0 + 1e-4), fr = vec2(-fl.y, fl.x);
          vec2 p = W.xz, s = vec2(dot(p, fl), dot(p, fr));
          float fw = min(length(fwidth(p)), 8.0);
          vec2 gs = vec2(0.0);
          const float E = 0.15;
          for(int b=0;b<3;b++){
            float k = b == 0 ? 0.22 : (b == 1 ? 0.62 : 1.7), A = b == 0 ? 0.42 : (b == 1 ? 0.13 : 0.045);
            float v = b == 0 ? 2.2 : (b == 1 ? 2.8 : 3.4), c = 1.0/(1.0 + pow(fw*k*1.4, 2.0));
            for(int l=0;l<2;l++){
              float vl = l == 0 ? v : v*0.62;
              vec2 cc = vec2((s.x - uTime*vl)*k*0.6, s.y*k) + float(b*2 + l)*7.31;
              float h0 = vn(cc);
              gs += vec2((vn(cc + vec2(E, 0.0)) - h0)*k*0.6, (vn(cc + vec2(0.0, E)) - h0)*k)/E*A*c*0.5;
            }
          }
          vec2 slope = (fl*gs.x + fr*gs.y)*wf.r;
          vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
          vec3 q2 = normalize(P + vec3(slope.x, 0.0, slope.y)*4.0);
          col = textureGrad(tPano, eqUv(q2), gx, gy).rgb;
          vec3 R = reflect(d, n); R.y = abs(R.y);
          vec3 refl = textureLod(tPano, eqUv(R), 2.5).rgb;
          float F = 0.03 + 0.97*pow(1.0 - max(dot(-d, n), 0.0), 5.0);
          col = mix(col, max(col, refl), clamp(F, 0.0, 0.6)*wf.r);
          float band = vn(vec2((s.x - uTime*2.6)*0.07, s.y*0.22) + 3.1)*0.6 + vn(vec2((s.x - uTime*1.7)*0.16, s.y*0.4) + 8.7)*0.4;
          col *= 1.0 + (band - 0.5)*0.32*wf.r;
          float sr = max(dot(R, unyaw(uSun)), 0.0), calm = 1.0/(1.0 + 2.0*fw);
          col += vec3(1.0, 0.94, 0.82)*(pow(sr, 600.0)*3.0*calm + pow(sr, 40.0)*0.06)*wf.r;
        }else{
          col = textureGrad(tPano, uv, gx, gy).rgb;
          if(wBack > 0.0) col = mix(col, textureGrad(tBack, uvB, gx*2.0, gy*2.0).rgb, wBack);
          /* the floor under the boulder's foot, black in the render, shows as a crack where
             the stone's cut meets it: there it takes the moss a step further out, deep in the
             stone's shade. Outside the foot the render's own shadow and occlusion are kept */
          vec3 Wg = P + uCap;
          float rg = length(Wg.xz);
          if(Wg.y < ${(GROUND_Y + 1.0).toFixed(2)} && rg < 9.0){
            float fa = atan(Wg.z, Wg.x)*${(ROCK_FOOT_N/(2*Math.PI)).toFixed(6)} + ${ROCK_FOOT_N.toFixed(1)};
            int f0 = int(floor(fa)) % ${ROCK_FOOT_N}, f1 = (f0 + 1) % ${ROCK_FOOT_N};
            float rf = mix(uFoot[f0], uFoot[f1], fract(fa));
            if(rf > 0.0 && rg < rf){
              vec3 Po = vec3(Wg.x*(1.0 + 1.6/rg), Wg.y, Wg.z*(1.0 + 1.6/rg)) - uCap;
              vec3 moss = textureGrad(tPano, eqUv(normalize(Po)), gx, gy).rgb;
              float shade = mix(0.3, 0.5, smoothstep(rf - 1.0, rf, rg));
              col = max(col, moss*shade);
            }
          }
        }
        gl_FragColor = vec4(col*uGain, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  /* the march is the costliest thing on screen, so it runs once per CSS pixel into a
     picture of its own, and the dome in the scene shows that picture over the frame */
  const march = new THREE.Mesh(new THREE.SphereGeometry(300, 96, 48), m);
  march.frustumCulled = false;
  const marchScene = new THREE.Scene();
  marchScene.add(march);
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const dome = new THREE.Mesh(march.geometry, new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: { tLow: { value: rt.texture } },
    vertexShader: 'varying vec4 vClip; void main(){ vClip = projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_Position = vClip.xyww; }',
    fragmentShader: 'uniform sampler2D tLow; varying vec4 vClip; void main(){ gl_FragColor = vec4(texture2D(tLow, vClip.xy/vClip.w*0.5 + 0.5).rgb, 1.0); }'
  }));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  dome.onBeforeRender = (r, sc, cam)=>dome.position.copy(cam.position);
  backdrop = {
    material: m,
    picture: rt.texture,
    draw(){
      const pr = backdropPR(), w = Math.max(1, Math.round(VW*pr)), h = Math.max(1, Math.round(VH*pr));
      if(rt.width !== w || rt.height !== h) rt.setSize(w, h);
      march.position.copy(camera.position);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.render(marchScene, camera);
      renderer.setRenderTarget(prev);
    }
  };
  return dome;
}
/* a phone marches the forest at half its frame's pixels, the picture is hazy enough to bear it */
const backdropPR = ()=> HI_RES ? Math.min(DPR, 1) : DPR*0.5;
let backdrop = null;

export {
  backdrop, decodeDepth, FOREST_CAP, makeBackdrop, measureFoot, ROCK_FOOT_N, rockFoot
};
