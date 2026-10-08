import * as THREE from 'three';
import { clamp, lerp, mulberry32, fbm, upsample, cv, normalFromHeight, tex } from '../lib/textures.js';
import { CH, CW, PAGE_H, PAGE_W, PH } from '../core/config.js';
import { shed } from '../assets/loaders.js';

function makeVellum(S){
  const mot = upsample(fbm(S>>2,S>>2, 3,3, 5, 404), S>>2,S>>2, S,S);
  const stain = upsample(fbm(S>>3,S>>3, 2,2, 3, 91), S>>3,S>>3, S,S);
  const crin = fbm(S, S, 64, 64, 3, 515);
  const fib = fbm(S, S, 8, 220, 2, 77);
  const c = cv(S,S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S,S), d = img.data;
  const rnd = mulberry32(1234);
  const hf = new Float32Array(S*S);
  for(let i=0,p=0;i<S*S;i++,p+=4){
    const ridged = 1 - Math.abs(crin[i]*2 - 1);
    let r=0.82, g=0.70, b=0.51;
    const lift = (mot[i]-0.5)*0.22 + (ridged-0.62)*0.12 + (fib[i]-0.5)*0.045 + (rnd()-0.5)*0.05;
    r += lift*0.8; g += lift*0.85; b += lift*1.0;
    const bl = Math.pow(clamp((stain[i]-0.48)/0.52,0,1), 1.4);
    r = lerp(r, 0.70, bl*0.65); g = lerp(g, 0.56, bl*0.7); b = lerp(b, 0.37, bl*0.75);
    d[p]=clamp(r,0,1)*255; d[p+1]=clamp(g,0,1)*255; d[p+2]=clamp(b,0,1)*255; d[p+3]=255;
    hf[i] = 0.5 + (ridged-0.6)*0.55 + (fib[i]-0.5)*0.15 + (mot[i]-0.5)*0.2 + (rnd()-0.5)*0.12;
  }
  ctx.putImageData(img,0,0);
  for(let i=0;i<2600;i++){
    const x = rnd()*S, y = rnd()*S, a = (rnd()-0.5)*0.7, L = 6 + rnd()*22;
    ctx.strokeStyle = rnd() < 0.5 ? `rgba(255,240,205,${0.05+rnd()*0.07})` : `rgba(90,60,25,${0.04+rnd()*0.06})`;
    ctx.lineWidth = 0.5 + rnd()*0.9;
    ctx.beginPath(); ctx.moveTo(x,y);
    ctx.quadraticCurveTo(x + Math.cos(a)*L*0.5, y + Math.sin(a)*L*0.5 + (rnd()-0.5)*4, x + Math.cos(a)*L, y + Math.sin(a)*L);
    ctx.stroke();
  }
  for(let i=0;i<9000;i++){
    const x = rnd()*S, y = rnd()*S, r = 0.4 + rnd()*0.9;
    ctx.fillStyle = rnd() < 0.8 ? `rgba(90,70,45,${0.05+rnd()*0.12})` : `rgba(255,246,225,${0.06+rnd()*0.1})`;
    ctx.fillRect(x, y, r, r*(0.6+rnd()*0.9));
  }
  for(let i=0;i<110;i++){
    const x = rnd()*S, y = rnd()*S, r = 1 + rnd()*5;
    const gr = ctx.createRadialGradient(x,y,0,x,y,r);
    gr.addColorStop(0, `rgba(130,92,50,${0.06+rnd()*0.12})`); gr.addColorStop(1,'rgba(130,92,50,0)');
    ctx.fillStyle = gr; ctx.fillRect(x-r,y-r,r*2,r*2);
  }
  return { base: c, normalTex: shed(tex(normalFromHeight(hf,S,S,3.0), {rx:2.5, ry:2.5})) };
}
const parch = makeVellum(1024);
const edgeTone = (()=>{
  const W = PAGE_W >> 1, H = PAGE_H >> 1;
  const n1 = upsample(fbm(W>>3, H>>3, 4, 5, 4, 808), W>>3, H>>3, W, H);
  const n2 = fbm(W, H, 40, 52, 2, 909);
  const c = cv(W, H), ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H), d = img.data;
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const i = y*W + x, u = x/W, v = y/H;
    const e = Math.min(u, 1-u, v*0.72, (1-v)*0.72);
    const corner = Math.max(0, 0.16 - Math.hypot(Math.min(u,1-u), Math.min(v,1-v)*0.72))/0.16;
    let a = Math.exp(-e/0.035)*0.75 + Math.exp(-e/0.12)*0.28 + corner*0.35;
    a *= 0.55 + 0.9*n1[i] + (n2[i]-0.5)*0.3;
    d[i*4] = 112; d[i*4+1] = 84; d[i*4+2] = 52; d[i*4+3] = clamp(a*0.8, 0, 0.6)*255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
})();
const EP_X0 = 0.14, EP_X1 = CW - 0.07, EP_H = CH - 0.14, EP_HINGE = 0.45, JOINT_H = PH - 0.02;
const HINGE_U = EP_HINGE/(EP_X1 - EP_X0 + EP_HINGE);
const matEndpaper = new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.7, metalness: 0, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });

export {
  edgeTone, EP_H, EP_HINGE, EP_X0, EP_X1, HINGE_U, JOINT_H, matEndpaper, parch
};
