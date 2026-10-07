/* Procedural helpers for Liber Arcanum: noise fields, normal maps, leather cracks,
   marbled endpaper and the small sprites. Painted onto <canvas> at boot. */
import * as THREE from 'three';

export const clamp = (v,a,b)=> v<a?a:(v>b?b:v);
export const lerp  = (a,b,t)=> a+(b-a)*t;
export const smooth= t => t*t*(3-2*t);

export function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function grid(gw, gh, rnd){
  const g = new Float32Array(gw*gh);
  for(let i=0;i<g.length;i++) g[i] = rnd();
  return g;
}
/* tileable smoothed bilinear lookup */
function gsample(g, gw, gh, u, v){
  const x = u*gw, y = v*gh;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const sx = smooth(x-x0), sy = smooth(y-y0);
  const j0 = ((x0%gw)+gw)%gw, j1 = ((x0+1)%gw+gw)%gw;
  const i0 = ((y0%gh)+gh)%gh, i1 = ((y0+1)%gh+gh)%gh;
  const a = g[i0*gw+j0], b = g[i0*gw+j1], c = g[i1*gw+j0], d = g[i1*gw+j1];
  return (a+(b-a)*sx)*(1-sy) + (c+(d-c)*sx)*sy;
}
/* fractal brownian motion field, 0..1, tileable */
export function fbm(w, h, baseX, baseY, octaves, seed){
  const out = new Float32Array(w*h);
  let amp = 1, tot = 0;
  for(let o=0;o<octaves;o++){
    const m = 1<<o;
    const gw = Math.max(2, Math.round(baseX*m)), gh = Math.max(2, Math.round(baseY*m));
    const g = grid(gw, gh, mulberry32(seed + o*7919));
    for(let y=0;y<h;y++){
      const v = y/h, row = y*w;
      for(let x=0;x<w;x++) out[row+x] += amp * gsample(g, gw, gh, x/w, v);
    }
    tot += amp; amp *= 0.5;
  }
  for(let i=0;i<out.length;i++) out[i] /= tot;
  return out;
}
/* bilinear upsample of a Float32 field */
export function upsample(src, sw, sh, dw, dh){
  const out = new Float32Array(dw*dh);
  for(let y=0;y<dh;y++){
    const fy = (y/dh)*sh, y0 = Math.min(sh-1,Math.floor(fy)), y1 = Math.min(sh-1,y0+1), ty = fy-y0;
    for(let x=0;x<dw;x++){
      const fx = (x/dw)*sw, x0 = Math.min(sw-1,Math.floor(fx)), x1 = Math.min(sw-1,x0+1), tx = fx-x0;
      const a = src[y0*sw+x0], b = src[y0*sw+x1], c = src[y1*sw+x0], d = src[y1*sw+x1];
      out[y*dw+x] = (a+(b-a)*tx)*(1-ty) + (c+(d-c)*tx)*ty;
    }
  }
  return out;
}
export function cv(w,h){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
/* height field -> tangent-space normal map (Sobel-ish central difference) */
export function normalFromHeight(hf, w, h, strength){
  const c = cv(w,h), ctx = c.getContext('2d');
  const img = ctx.createImageData(w,h), d = img.data;
  for(let y=0;y<h;y++){
    const ym = ((y-1)+h)%h, yp = (y+1)%h;
    for(let x=0;x<w;x++){
      const xm = ((x-1)+w)%w, xp = (x+1)%w;
      const dx = (hf[y*w+xp]  - hf[y*w+xm])  * strength;
      const dy = (hf[yp*w+x]  - hf[ym*w+x])  * strength;
      let nx = -dx, ny = dy, nz = 1;      /* +dy: canvas y grows down, uv v grows up */
      const l = Math.sqrt(nx*nx+ny*ny+nz*nz);
      const i = (y*w+x)*4;
      d[i]   = (nx/l*0.5+0.5)*255;
      d[i+1] = (ny/l*0.5+0.5)*255;
      d[i+2] = (nz/l*0.5+0.5)*255;
      d[i+3] = 255;
    }
  }
  ctx.putImageData(img,0,0);
  return c;
}
export function tex(canvas, {srgb=false, rx=1, ry=1, wrap=true} = {}){
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = MAXANISO;
  t.needsUpdate = true;
  return t;
}
export let MAXANISO = 4;
export function setMaxAniso(v){ MAXANISO = v; }

/* a web of shrink cracks, white on black, for aged leather */
export function crackCanvas(W,H,seed,density){
  const c = cv(W,H), ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0,0,W,H);
  const rnd = mulberry32(seed);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  const n = Math.round(W*H/1400 * density);
  for(let i=0;i<n;i++){
    let x = rnd()*W, y = rnd()*H;
    let a = rnd()*Math.PI*2;
    const segs = 3 + (rnd()*7|0);
    const len  = 3 + rnd()*16;
    const wob  = 0.9;
    ctx.lineWidth = 0.7 + rnd()*1.7;
    ctx.strokeStyle = `rgba(255,255,255,${0.14+rnd()*0.5})`;
    ctx.beginPath(); ctx.moveTo(x,y);
    for(let s=0;s<segs;s++){
      a += (rnd()-0.5)*wob;
      x += Math.cos(a)*len; y += Math.sin(a)*len;
      ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  /* a handful of long cell boundaries — the big shrink cracks */
  for(let i=0;i<Math.round(26*density);i++){
    let x = rnd()*W, y = rnd()*H, a = rnd()*Math.PI*2;
    ctx.lineWidth = 1.6 + rnd()*2.2;
    ctx.strokeStyle = `rgba(255,255,255,${0.45+rnd()*0.4})`;
    ctx.beginPath(); ctx.moveTo(x,y);
    for(let s=0;s<28;s++){
      a += (rnd()-0.5)*0.55;
      x += Math.cos(a)*(10+rnd()*18); y += Math.sin(a)*(10+rnd()*18);
      ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  return c;
}
export function fieldFromCanvas(c){
  const {width:W, height:H} = c;
  const d = c.getContext('2d').getImageData(0,0,W,H).data;
  const f = new Float32Array(W*H);
  for(let i=0,p=0;i<f.length;i++,p+=4) f[i] = d[p]/255;
  return f;
}

/* soft round mote, and the vertical falloff of a light shaft */
export function makeSpriteCanvas(S){
  const c = cv(S,S), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S/2,S/2,0,S/2,S/2,S/2);
  g.addColorStop(0,'rgba(255,240,200,1)');
  g.addColorStop(0.25,'rgba(255,224,150,.75)');
  g.addColorStop(1,'rgba(255,200,90,0)');
  ctx.fillStyle=g; ctx.fillRect(0,0,S,S);
  return c;
}
export function makeRayAlpha(){
  const c = cv(8,256), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0,0,0,256);
  g.addColorStop(0.00,'rgba(0,0,0,0)');
  g.addColorStop(0.18,'rgba(255,255,255,.95)');
  g.addColorStop(0.55,'rgba(255,255,255,.45)');
  g.addColorStop(1.00,'rgba(0,0,0,0)');
  ctx.fillStyle=g; ctx.fillRect(0,0,8,256);
  return c;
}

