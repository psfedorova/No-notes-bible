/* ============================================================================
   Liber Arcanum — a WebGL grimoire
   ---------------------------------------------------------------------------
   Everything (leather, gilt tooling, parchment, page edges, the sky) is painted
   procedurally onto <canvas> at boot; no external image ever loads.
   ==========================================================================*/
import * as THREE from 'three';

const T0 = performance.now();
let BOOT_MS = 0;

/* ============================== world units ==============================
   1 unit ~= 1 decimetre.  The old CSS build measured a page 340x470 px, so
   every number here is that build divided by 100 — the proportions carry over
   exactly.                                                                  */
const PW   = 3.40;              // page width
const PH   = 4.70;              // page height
const OV   = 0.09;              // cover overhang
const CW   = PW + OV;           // cover width
const CH   = PH + OV * 2;       // cover height
const BLK  = 0.26;              // half page-block thickness
const CVR  = 0.13;              // cover board thickness
const HALF = 0.43;              // half of the closed tome
const COVER_Z0 = 0.04 + BLK + 0.02;   // inner face of the front board (closed)
const COVER_Z1 = COVER_Z0 + CVR;      // ...and its outer face
const SHEETS = 7;               // turnable sheets -> 14 writable pages

/* page canvases: 2 px per old CSS px */
const SC = 2;
const PAGE_W = 340 * SC, PAGE_H = 470 * SC;

const INK = '#43301a';
const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV'];
const FIRST_PAGE_HTML =
  `<div style="text-align:center;font-family:'IM Fell English SC',serif;font-size:26px;line-height:1.3;">Booke of Shadowes</div>` +
  `<div style="text-align:center;font-size:19px;opacity:.75;">~ herein are bound the words of power ~</div><br>` +
  `Whosoever holds this tome,<br>let thy quill speak true…`;

const LS = 'liber-arcanum';
const clamp = (v,a,b)=> v<a?a:(v>b?b:v);
const lerp  = (a,b,t)=> a+(b-a)*t;
const smooth= t => t*t*(3-2*t);
const easeIO= t => t<.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
const easeOut= t => 1-Math.pow(1-t,3);

/* A backgrounded/collapsed pane reports a 0x0 viewport. Keep the last good
   size instead: NaN or a 1x1 buffer would poison every matrix and every pick. */
let VW = 1280, VH = 720;
function measureViewport(){
  const w = innerWidth || document.documentElement.clientWidth || 0;
  const h = innerHeight || document.documentElement.clientHeight || 0;
  if(w >= 2 && h >= 2){ VW = w; VH = h; return true; }
  return false;
}
measureViewport();
function vw(){ return VW; }
function vh(){ return VH; }

/* ============================================================================
   1.  noise & canvas helpers
   ==========================================================================*/
function mulberry32(a){
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
function fbm(w, h, baseX, baseY, octaves, seed){
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
function upsample(src, sw, sh, dw, dh){
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
function cv(w,h){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
/* height field -> tangent-space normal map (Sobel-ish central difference) */
function normalFromHeight(hf, w, h, strength){
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
function tex(canvas, {srgb=false, rx=1, ry=1, wrap=true} = {}){
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = MAXANISO;
  t.needsUpdate = true;
  return t;
}
let MAXANISO = 4;

/* ============================================================================
   2.  gilt ornament artwork (drawn into a canvas, used three ways)
   ==========================================================================*/
/* design space is the old CSS cover: 349 x 488 */
const DW = 349, DH = 488;

function ornCorner(ctx){
  /* mirrors CORNER_SVG from the CSS build, 72x72 */
  ctx.lineCap = 'round';
  const S = (a=1)=>{ ctx.strokeStyle = `rgba(255,255,255,${a})`; };
  S(1);   ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(3,68); ctx.bezierCurveTo(3,26,26,3,68,3); ctx.stroke();
  S(.72); ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(3,50); ctx.bezierCurveTo(3,22,22,3,50,3); ctx.stroke();
  S(.95); ctx.lineWidth = 2.0; ctx.beginPath(); ctx.moveTo(9,9); ctx.lineTo(23,23); ctx.stroke();
  S(.6);  ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(3,34); ctx.bezierCurveTo(14,32,22,24,25,12); ctx.stroke();
  S(.62); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(25,12); ctx.bezierCurveTo(31,10,34,6,34,3); ctx.stroke();
  S(.45); ctx.lineWidth = 1.0; ctx.beginPath(); ctx.moveTo(12,30); ctx.bezierCurveTo(20,30,26,24,27,16); ctx.stroke();
  const dot = (x,y,r,a)=>{ ctx.fillStyle=`rgba(255,255,255,${a})`; ctx.beginPath(); ctx.arc(x,y,r,0,7); ctx.fill(); };
  dot(7.5,7.5,3.4,1); dot(26,26,2.1,.8); dot(34,3.5,1.8,.85); dot(3.5,34,1.8,.85);
  /* a couple of extra tendrils for depth */
  S(.4); ctx.lineWidth = .9;
  ctx.beginPath(); ctx.moveTo(6,58); ctx.bezierCurveTo(16,52,20,44,20,36); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(58,6); ctx.bezierCurveTo(52,16,44,20,36,20); ctx.stroke();
}
function ornEdge(ctx){
  /* 96 x 26 leaf-pair with a central lozenge */
  ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.fillStyle = 'rgba(255,255,255,.28)';
  const leaf = (x0,x1)=>{
    ctx.beginPath();
    ctx.moveTo(x0,13); ctx.bezierCurveTo(x0+12,4, x1-14,4, x1,13);
    ctx.bezierCurveTo(x1-14,22, x0+12,22, x0,13); ctx.closePath();
    ctx.fill(); ctx.stroke();
  };
  leaf(4,44); leaf(92,52);
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.beginPath(); ctx.moveTo(48,5); ctx.lineTo(54,13); ctx.lineTo(48,21); ctx.lineTo(42,13); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.6)';
  ctx.beginPath(); ctx.moveTo(48,21); ctx.bezierCurveTo(50,25,53,25,56,26); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(48,21); ctx.bezierCurveTo(46,25,43,25,40,26); ctx.stroke();
}
/* the central filigree star: eight leaf/feather rays around an oval socket */
function ornMedallion(ctx, R, holeR){
  const rays = 8;
  for(let i=0;i<rays;i++){
    ctx.save();
    ctx.rotate(i*Math.PI/4);
    const long = (i%2===0);
    const L = long ? R*0.50 : R*0.31;
    const W = long ? R*0.148 : R*0.096;
    const gap = long ? R*0.435 : R*0.417;
    const tip = -(gap+L);
    const g = ctx.createLinearGradient(0,tip,0,-gap);
    g.addColorStop(0,'rgba(255,255,255,.95)'); g.addColorStop(.55,'rgba(255,255,255,.6)'); g.addColorStop(1,'rgba(255,255,255,.3)');
    ctx.fillStyle = g;
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0,-gap);
    ctx.bezierCurveTo( W, -gap-L*0.34,  W*0.72, -gap-L*0.76, 0, tip);
    ctx.bezierCurveTo(-W*0.72, -gap-L*0.76, -W, -gap-L*0.34, 0, -gap);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    /* midrib */
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = .8;
    ctx.beginPath(); ctx.moveTo(0,-gap-3); ctx.lineTo(0,tip+6); ctx.stroke();
    /* bead at the tip */
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath(); ctx.arc(0, tip-(long?4:3), long?3.4:2.4, 0, 7); ctx.fill();
    if(long){
      ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(-2,-gap+2); ctx.bezierCurveTo(-18,-gap-4,-24,-gap-16,-20,-gap-24); ctx.stroke();
      ctx.beginPath(); ctx.moveTo( 2,-gap+2); ctx.bezierCurveTo( 18,-gap-4, 24,-gap-16, 20,-gap-24); ctx.stroke();
    }
    ctx.restore();
  }
  /* beads between rays */
  for(let i=0;i<rays;i++){
    ctx.save(); ctx.rotate(Math.PI/8 + i*Math.PI/4);
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.beginPath(); ctx.arc(0,-R*0.487,1.9,0,7); ctx.fill();
    ctx.restore();
  }
  /* concentric rings around the gem socket */
  const ring = (r,w,a)=>{ ctx.strokeStyle=`rgba(255,255,255,${a})`; ctx.lineWidth=w; ctx.beginPath(); ctx.arc(0,0,r,0,7); ctx.stroke(); };
  ring(R*0.426,1.1,.55); ring(R*0.365,1.7,.95); ring(R*0.330,.9,.6);
  /* punch the gem socket out so no gold sits under the sapphire */
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(0,0, holeR*0.78, holeR, 0, 0, 7); ctx.fill();
  ctx.restore();
}

/* full ornament sheet in cover space; alpha = where gold lives */
function makeOrnament(W, H, big){
  const c = cv(W,H), ctx = c.getContext('2d');
  ctx.scale(W/DW, H/DH);
  ctx.lineJoin = 'round';

  /* double border frames */
  const frame = (inset, lw, a, dash)=>{
    ctx.strokeStyle = `rgba(255,255,255,${a})`;
    ctx.lineWidth = lw;
    ctx.setLineDash(dash||[]);
    ctx.strokeRect(inset, inset, DW-inset*2, DH-inset*2);
    ctx.setLineDash([]);
  };
  frame(12, 3.2, .95);
  frame(20, 1.1, .62);
  frame(25.5, 1.0, .22, [1.2,4.5]);

  /* corners */
  const corner = (x,y,sx,sy)=>{ ctx.save(); ctx.translate(x,y); ctx.scale(sx,sy); ornCorner(ctx); ctx.restore(); };
  corner(15,15,1,1); corner(DW-15,15,-1,1); corner(15,DH-15,1,-1); corner(DW-15,DH-15,-1,-1);

  /* head & tail edge ornaments */
  const edge = (y,sy)=>{ ctx.save(); ctx.translate(DW/2-48, y); ctx.scale(1,sy); ornEdge(ctx); ctx.restore(); };
  if(big){ edge(26,1); edge(DH-52,1); }

  /* centrepiece */
  ctx.save();
  ctx.translate(DW/2, DH/2);
  if(big) ornMedallion(ctx, 115, 26);
  else    ornMedallion(ctx, 66, 15);
  ctx.restore();
  return c;
}

/* ============================================================================
   3.  leather
   ==========================================================================*/
function crackCanvas(W,H,seed,density){
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
function fieldFromCanvas(c){
  const {width:W, height:H} = c;
  const d = c.getContext('2d').getImageData(0,0,W,H).data;
  const f = new Float32Array(W*H);
  for(let i=0,p=0;i<f.length;i++,p+=4) f[i] = d[p]/255;
  return f;
}

/* returns { map, normalMap, roughnessMap, ornament } for one cover face */
function makeLeatherCover(W, H, big, seed){
  const mot = upsample(fbm(W>>2, H>>2, 4, 5, 4, seed), W>>2, H>>2, W, H);
  const blo = upsample(fbm(W>>3, H>>3, 2, 2, 2, seed+31), W>>3, H>>3, W, H);
  /* pebbled grain — real leather is a field of tiny domes, not white noise.
     ~3 px cells at 1024 across a 35 cm board reads as true 1 mm grain. */
  const peb = fbm(W, H, Math.round(W/3.1), Math.round(H/3.1), 2, seed+53);
  const crk = fieldFromCanvas(crackCanvas(W, H, seed+97, 0.85));
  const orn = makeOrnament(W, H, big);
  const ornF = fieldFromCanvas((()=>{        /* alpha of the ornament as a field */
      const t = cv(W,H), tc = t.getContext('2d');
      tc.fillStyle='#000'; tc.fillRect(0,0,W,H);
      tc.drawImage(orn,0,0);
      return t;
  })());

  /* --- base colour --- */
  const col = cv(W,H), cctx = col.getContext('2d');
  const img = cctx.createImageData(W,H), d = img.data;
  const rnd = mulberry32(seed+5);
  for(let y=0;y<H;y++){
    const vy = y/H;
    for(let x=0;x<W;x++){
      const i = y*W+x, p = i*4;
      const m = mot[i], b = blo[i], k = crk[i];
      const grain = (rnd()-0.5)*0.075;
      /* deep midnight navy, colder in the hollows, a touch of steel on the ridges */
      let r = 0.082, g = 0.121, bl = 0.243;
      const lift = (m-0.5)*0.55 + (b-0.5)*0.45 + grain;
      r  += lift*0.10; g += lift*0.13; bl += lift*0.21;
      /* corner falloff — leather darkens where it is handled */
      const vg = 1 - 0.30*Math.pow(Math.max(Math.abs(x/W-0.5)*2, Math.abs(vy-0.5)*2), 3);
      r*=vg; g*=vg; bl*=vg;
      /* cracks go dark and desaturated */
      const kk = Math.min(1,k*0.95);
      r = r*(1-kk*0.62) + 0.014*kk; g = g*(1-kk*0.62) + 0.022*kk; bl = bl*(1-kk*0.62) + 0.050*kk;
      d[p]   = Math.min(255, r*255*1.0);
      d[p+1] = Math.min(255, g*255*1.0);
      d[p+2] = Math.min(255, bl*255*1.0);
      d[p+3] = 255;
    }
  }
  cctx.putImageData(img,0,0);

  /* tooled depression: a dark offset ghost of the ornament, then a warm stain */
  const off = Math.max(2, Math.round(W/300));
  cctx.save();
  cctx.globalAlpha = 0.5;
  cctx.filter = 'blur(1.5px)';
  cctx.drawImage(orn, off, off*1.3);
  cctx.filter = 'none';
  cctx.restore();
  /* warm gold stain right in the tooling */
  cctx.save();
  cctx.globalAlpha = 0.30;
  cctx.globalCompositeOperation = 'lighter';
  const stain = cv(W,H), sx = stain.getContext('2d');
  sx.drawImage(orn,0,0);
  sx.globalCompositeOperation = 'source-in';
  sx.fillStyle = '#6a4a15'; sx.fillRect(0,0,W,H);
  cctx.drawImage(stain,0,0);
  cctx.restore();

  /* --- height -> normal --- */
  const hf = new Float32Array(W*H);
  const rnd2 = mulberry32(seed+11);
  for(let i=0;i<hf.length;i++){
    hf[i] = 0.5 + (mot[i]-0.5)*0.42 + (blo[i]-0.5)*0.26
          + (peb[i]-0.5)*0.30
          + (rnd2()-0.5)*0.05
          - Math.min(1,crk[i]*1.0)*0.40
          + ornF[i]*0.68;
  }
  const nrm = normalFromHeight(hf, W, H, 5.0);

  /* --- roughness --- */
  const rg = cv(W,H), rctx = rg.getContext('2d');
  const rimg = rctx.createImageData(W,H), rd = rimg.data;
  for(let i=0,p=0;i<W*H;i++,p+=4){
    let r = 0.60 + (mot[i]-0.5)*0.26 + (peb[i]-0.5)*0.20 + Math.min(1,crk[i])*0.20 - ornF[i]*0.30;
    r = clamp(r, 0.18, 0.95);
    rd[p]=rd[p+1]=rd[p+2] = r*255; rd[p+3]=255;
  }
  rctx.putImageData(rimg,0,0);

  return { map: col, normalMap: nrm, roughnessMap: rg, ornament: orn };
}

/* plain leather for edges / spine (tileable) */
function makeLeatherPlain(S, seed){
  const mot = upsample(fbm(S>>2, S>>2, 5, 5, 4, seed), S>>2, S>>2, S, S);
  const crk = fieldFromCanvas(crackCanvas(S,S,seed+3,0.8));
  const col = cv(S,S), cctx = col.getContext('2d');
  const img = cctx.createImageData(S,S), d = img.data;
  const rnd = mulberry32(seed+9);
  const hf = new Float32Array(S*S);
  for(let i=0,p=0;i<S*S;i++,p+=4){
    const m = mot[i], k = Math.min(1,crk[i]*1.3), gr = (rnd()-0.5)*0.08;
    let r=0.070,g=0.104,b=0.186;
    const lift = (m-0.5)*0.5+gr;
    r+=lift*0.09; g+=lift*0.11; b+=lift*0.15;
    r=r*(1-k*0.8)+0.010*k; g=g*(1-k*0.8)+0.015*k; b=b*(1-k*0.8)+0.028*k;
    d[p]=r*255; d[p+1]=g*255; d[p+2]=b*255; d[p+3]=255;
    hf[i] = 0.5 + (m-0.5)*0.6 + (rnd()-0.5)*0.12 - k*0.55;
  }
  cctx.putImageData(img,0,0);
  return { map: col, normalMap: normalFromHeight(hf,S,S,4.2) };
}

/* ============================================================================
   4.  parchment & page edges
   ==========================================================================*/
let parchBase = null, parchNormalTex = null;
function makeParchmentBase(S){
  const mot = upsample(fbm(S>>2,S>>2, 3,3, 5, 404), S>>2,S>>2, S,S);
  const stain = upsample(fbm(S>>3,S>>3, 2,2, 3, 91), S>>3,S>>3, S,S);
  const fib = fbm(S,S, 10, 260, 2, 77);      /* long fibres running across */
  const c = cv(S,S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S,S), d = img.data;
  const rnd = mulberry32(1234);
  const hf = new Float32Array(S*S);
  for(let i=0,p=0;i<S*S;i++,p+=4){
    const m = mot[i], s = stain[i], f = fib[i];
    /* warm amber vellum, not office paper */
    let r=0.775,g=0.640,b=0.428;
    const lift = (m-0.5)*0.19 + (f-0.5)*0.030 + (rnd()-0.5)*0.030;
    r+=lift; g+=lift*1.04; b+=lift*1.35;
    /* foxing and old damp blotches */
    const bl = Math.pow(clamp((s-0.46)/0.54,0,1), 1.5);
    r = lerp(r, 0.612, bl*0.85); g = lerp(g, 0.462, bl*0.9); b = lerp(b, 0.262, bl*0.95);
    const bl2 = Math.pow(clamp((0.44-s)/0.44,0,1), 2.2);
    r = lerp(r, 0.845, bl2*0.5); g = lerp(g, 0.735, bl2*0.5); b = lerp(b, 0.540, bl2*0.5);
    d[p]=r*255; d[p+1]=g*255; d[p+2]=b*255; d[p+3]=255;
    hf[i] = 0.5 + (f-0.5)*0.55 + (m-0.5)*0.35 + (rnd()-0.5)*0.18;
  }
  ctx.putImageData(img,0,0);
  parchBase = c;
  parchNormalTex = tex(normalFromHeight(hf,S,S,2.4), {rx:3, ry:3});
}

/* one page canvas: aged parchment + ornate double-line ink border + numeral */
function makePageCanvas(pageNo, side, seed){
  const c = cv(PAGE_W, PAGE_H), ctx = c.getContext('2d');
  const rnd = mulberry32(seed);
  const S = parchBase.width;
  const sx = Math.floor(rnd()*(S-PAGE_W*0.5)), sy = Math.floor(rnd()*(S-PAGE_H*0.5));
  ctx.drawImage(parchBase, sx, sy, S-sx, S-sy, 0,0, PAGE_W, PAGE_H);
  /* gutter shading and burnt rim */
  const gut = ctx.createLinearGradient(0,0,PAGE_W,0);
  const gStops = side==='front'
    ? [[0,'rgba(58,32,6,.72)'],[0.045,'rgba(70,40,10,.34)'],[0.14,'rgba(78,46,12,.06)'],[0.2,'rgba(78,46,12,0)'],[0.9,'rgba(78,46,12,0)'],[1,'rgba(66,38,10,.28)']]
    : [[0,'rgba(66,38,10,.28)'],[0.1,'rgba(78,46,12,0)'],[0.8,'rgba(78,46,12,0)'],[0.86,'rgba(78,46,12,.06)'],[0.955,'rgba(70,40,10,.34)'],[1,'rgba(58,32,6,.72)']];
  gStops.forEach(([o,cl])=>gut.addColorStop(o,cl));
  ctx.fillStyle = gut; ctx.fillRect(0,0,PAGE_W,PAGE_H);
  const rim = ctx.createRadialGradient(PAGE_W/2,PAGE_H/2,PAGE_H*0.24, PAGE_W/2,PAGE_H/2,PAGE_H*0.62);
  rim.addColorStop(0,'rgba(74,40,6,0)'); rim.addColorStop(1,'rgba(74,40,6,.46)');
  ctx.fillStyle = rim; ctx.fillRect(0,0,PAGE_W,PAGE_H);
  /* a warm highlight where the light rakes across the leaf */
  const hl = ctx.createLinearGradient(0,0,PAGE_W*0.7,PAGE_H);
  hl.addColorStop(0,'rgba(255,238,196,.16)'); hl.addColorStop(0.55,'rgba(255,238,196,0)');
  ctx.fillStyle = hl; ctx.fillRect(0,0,PAGE_W,PAGE_H);
  drawPageBorder(ctx);
  if(pageNo>=0){
    ctx.fillStyle = 'rgba(104,72,30,.78)';
    ctx.font = `${14*SC}px "IM Fell English SC", serif`;
    ctx.textAlign = 'center';
    ctx.fillText('✶ ' + (ROMAN[pageNo]||'') + ' ✶', PAGE_W/2, PAGE_H - 18*SC);
    ctx.textAlign = 'left';
  }
  return c;
}
const PB_INK = 'rgba(111,79,30,';
function drawPageBorder(ctx){
  ctx.save();
  ctx.scale(SC,SC);
  const x0=14, y0=14, x1=340-14, y1=432;
  const cx=(x0+x1)/2, cy=(y0+y1)/2;
  ctx.strokeStyle = PB_INK+'.48)'; ctx.lineWidth = 1.4;
  ctx.strokeRect(x0,y0,x1-x0,y1-y0);
  ctx.strokeStyle = PB_INK+'.32)'; ctx.lineWidth = .7;
  ctx.strokeRect(x0+5,y0+5,x1-x0-10,y1-y0-10);
  const corner=(x,y,sx,sy)=>{
    ctx.save(); ctx.translate(x,y); ctx.scale(sx,sy);
    ctx.strokeStyle=PB_INK+'.38)'; ctx.lineWidth=.9;
    ctx.beginPath(); ctx.moveTo(0,38); ctx.bezierCurveTo(0,17,17,0,38,0); ctx.stroke();
    ctx.strokeStyle=PB_INK+'.26)'; ctx.lineWidth=.8;
    ctx.beginPath(); ctx.moveTo(0,13); ctx.bezierCurveTo(7,13,13,7,13,0); ctx.stroke();
    ctx.strokeStyle=PB_INK+'.38)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(7,7); ctx.lineTo(17,17); ctx.stroke();
    ctx.fillStyle=PB_INK+'.5)'; ctx.beginPath(); ctx.arc(0,0,2.6,0,7); ctx.fill();
    ctx.restore();
  };
  const mid=(x,y,r)=>{
    ctx.save(); ctx.translate(x,y); ctx.rotate(r*Math.PI/180);
    ctx.fillStyle=PB_INK+'.14)'; ctx.strokeStyle=PB_INK+'.5)'; ctx.lineWidth=.9;
    [[-20,-1],[20,1]].forEach(([ex,s])=>{
      ctx.beginPath(); ctx.moveTo(ex,0);
      ctx.bezierCurveTo(ex-6*s,-5.5, ex-13.5*s,-5, 0,0);
      ctx.bezierCurveTo(ex-13.5*s,5, ex-6*s,5.5, ex,0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    });
    ctx.fillStyle=PB_INK+'.55)';
    ctx.beginPath(); ctx.moveTo(0,-4.6); ctx.lineTo(4.4,0); ctx.lineTo(0,4.6); ctx.lineTo(-4.4,0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle=PB_INK+'.42)'; ctx.lineWidth=.9;
    ctx.beginPath(); ctx.moveTo(0,3.4); ctx.bezierCurveTo(2.6,7,5.6,8.4,7,12.4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,3.4); ctx.bezierCurveTo(-2.6,7,-5.6,8.4,-7,12.4); ctx.stroke();
    ctx.restore();
  };
  corner(x0,y0,1,1); corner(x1,y0,-1,1); corner(x0,y1,1,-1); corner(x1,y1,-1,-1);
  mid(cx,y0,0); mid(cx,y1,180); mid(x0,cy,-90); mid(x1,cy,90);
  ctx.restore();
}

/* gilt-ish page-block edge: hundreds of individual leaves */
function makeEdgeStripes(vertical){
  /* ~90 discernible leaves across the block, each 4-6 px of a 512 px span, so
     the relief survives at screen scale instead of aliasing into mush */
  const N = 512;
  const W = vertical ? N : 96, H = vertical ? 96 : N;
  const c = cv(W,H), ctx = c.getContext('2d');
  const rnd = mulberry32(555);
  const leaves = [];
  { let t = 0; while(t < N){ const w = 3 + Math.round(rnd()*3); leaves.push([t,w]); t += w; } }
  const cols = ['#f0e2b4','#dcc08a','#c29c60','#e8d59c','#cdaa6e','#b8904f','#f4e9c2'];
  leaves.forEach(([t,w],i)=>{
    ctx.fillStyle = cols[(i*3 + (rnd()*3|0)) % cols.length];
    if(vertical) ctx.fillRect(t,0,w,H); else ctx.fillRect(0,t,W,w);
    /* the shadow line between leaves */
    ctx.fillStyle = 'rgba(78,50,16,.55)';
    if(vertical) ctx.fillRect(t,0,1,H); else ctx.fillRect(0,t,W,1);
  });
  /* dirt + a little unevenness */
  const img = ctx.getImageData(0,0,W,H), d = img.data;
  const gw = Math.max(4,W>>3), gh = Math.max(4,H>>3);
  const mot = upsample(fbm(gw, gh, 3,3,3, 71), gw, gh, W, H);
  for(let i=0,p=0;i<W*H;i++,p+=4){
    const k = 0.66 + mot[i]*0.6;
    d[p]*=k; d[p+1]*=k*0.985; d[p+2]*=k*0.94;
  }
  ctx.putImageData(img,0,0);
  /* height: each leaf a rounded ridge that dips at the seam */
  const hf = new Float32Array(W*H);
  const prof = new Float32Array(N);
  leaves.forEach(([t,w])=>{
    for(let k=0;k<w;k++){
      const f = (k+0.5)/w;
      prof[(t+k)%N] = 0.15 + Math.sin(f*Math.PI)*0.85;
    }
  });
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const t = vertical ? x : y;
    hf[y*W+x] = prof[t] * (0.75 + mot[y*W+x]*0.4);
  }
  return { map:c, normalMap: normalFromHeight(hf,W,H,2.6) };
}
function makeEndpaper(S){
  const mot = upsample(fbm(S>>2,S>>2,4,4,4,808), S>>2,S>>2,S,S);
  const c = cv(S,S), ctx = c.getContext('2d');
  const img = ctx.createImageData(S,S), d = img.data;
  const rnd = mulberry32(9);
  const hf = new Float32Array(S*S);
  for(let i=0,p=0;i<S*S;i++,p+=4){
    const m = mot[i], gr=(rnd()-0.5)*0.05;
    let r=0.706,g=0.556,b=0.376;
    const lift=(m-0.5)*0.22+gr; r+=lift; g+=lift; b+=lift*1.1;
    d[p]=r*255; d[p+1]=g*255; d[p+2]=b*255; d[p+3]=255;
    hf[i]=0.5+(m-0.5)*0.5+gr*2;
  }
  ctx.putImageData(img,0,0);
  /* a marbled swirl or two */
  ctx.globalAlpha=.18;
  for(let i=0;i<40;i++){
    ctx.strokeStyle = i%2 ? '#6b4a1c' : '#c9a468';
    ctx.lineWidth = 1+Math.random()*3;
    ctx.beginPath();
    let x=Math.random()*S, y=Math.random()*S, a=Math.random()*7;
    ctx.moveTo(x,y);
    for(let s=0;s<20;s++){ a+=(Math.random()-.5)*.9; x+=Math.cos(a)*14; y+=Math.sin(a)*14; ctx.lineTo(x,y); }
    ctx.stroke();
  }
  ctx.globalAlpha=1;
  return { map:c, normalMap: normalFromHeight(hf,S,S,2.0) };
}

/* ============================================================================
   5.  environment / sky canvases
   ==========================================================================*/
function makeEnvCanvas(W,H,forBackground){
  const c = cv(W,H), ctx = c.getContext('2d');
  /* vertical bands: canopy -> golden haze -> mossy floor */
  const g = ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0.00,'#04070a');
  g.addColorStop(0.20,'#0a1512');
  g.addColorStop(0.42,'#1c2415');
  g.addColorStop(0.55,'#2c2a14');
  g.addColorStop(0.72,'#100e07');
  g.addColorStop(1.00,'#030402');
  ctx.fillStyle = g; ctx.fillRect(0,0,W,H);

  const blob = (u,v,r,col,a)=>{
    const rg = ctx.createRadialGradient(u*W, v*H, 0, u*W, v*H, r);
    rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = a; ctx.globalCompositeOperation='lighter';
    ctx.fillStyle = rg; ctx.fillRect(0,0,W,H);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation='source-over';
  };
  /* the sun, up and to the right — small and hot so gold gets a real highlight */
  blob(0.63, 0.24, W*0.26, 'rgba(255,214,140,1)', forBackground?0.28:0.55);
  blob(0.63, 0.24, W*0.055,'rgba(255,248,226,1)', forBackground?0.35:1.0);
  /* cool sky bounce so the navy leather can read as blue */
  blob(0.18, 0.14, W*0.30, 'rgba(96,140,210,1)',  forBackground?0.12:0.30);
  blob(0.86, 0.16, W*0.24, 'rgba(70,110,190,1)',  forBackground?0.08:0.20);
  /* moss & umber */
  blob(0.30, 0.52, W*0.22, 'rgba(96,124,62,1)',   forBackground?0.16:0.24);
  blob(0.92, 0.58, W*0.18, 'rgba(150,110,52,1)',  forBackground?0.12:0.18);

  /* trunk silhouettes for reflection interest */
  const rnd = mulberry32(17);
  ctx.globalAlpha = forBackground ? 0.85 : 0.5;
  for(let i=0;i<30;i++){
    const x = rnd()*W, w = W*(0.006+rnd()*0.026);
    const top = H*(0.10+rnd()*0.24), bot = H*(0.74+rnd()*0.24);
    const lg = ctx.createLinearGradient(0,top,0,bot);
    lg.addColorStop(0,'rgba(4,7,5,0)'); lg.addColorStop(0.28,'rgba(4,6,4,.92)'); lg.addColorStop(1,'rgba(2,3,2,1)');
    ctx.fillStyle = lg;
    ctx.fillRect(x, top, w, bot-top);
  }
  /* leafy canopy clutter along the top */
  ctx.globalAlpha = forBackground ? 0.9 : 0.55;
  for(let i=0;i<420;i++){
    const x = rnd()*W, y = H*(0.02+Math.pow(rnd(),1.7)*0.34);
    const r = W*(0.004+rnd()*0.016);
    ctx.fillStyle = `rgba(${5+rnd()*14|0},${9+rnd()*20|0},${5+rnd()*10|0},${0.5+rnd()*0.5})`;
    ctx.beginPath(); ctx.ellipse(x,y,r,r*0.6,rnd()*3,0,7); ctx.fill();
  }
  ctx.globalAlpha = 1;

  if(forBackground){
    /* blur the backdrop so the sun is a haze, not a disc */
    const b = cv(W,H), bx = b.getContext('2d');
    bx.filter = 'blur(' + Math.round(W/110) + 'px)';
    bx.drawImage(c,0,0);
    bx.filter='none';
    /* the ground is deep in shadow, and the whole thing sits well below key */
    const dg = bx.createLinearGradient(0,0,0,H);
    dg.addColorStop(0,'rgba(0,0,0,.55)'); dg.addColorStop(0.42,'rgba(0,0,0,.18)');
    dg.addColorStop(0.62,'rgba(0,0,0,.42)'); dg.addColorStop(1,'rgba(0,0,0,.88)');
    bx.fillStyle = dg; bx.fillRect(0,0,W,H);
    return b;
  }
  return c;
}
function makeSpriteCanvas(S){
  const c = cv(S,S), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S/2,S/2,0,S/2,S/2,S/2);
  g.addColorStop(0,'rgba(255,240,200,1)');
  g.addColorStop(0.25,'rgba(255,224,150,.75)');
  g.addColorStop(1,'rgba(255,200,90,0)');
  ctx.fillStyle=g; ctx.fillRect(0,0,S,S);
  return c;
}
function makeRayAlpha(){
  const c = cv(8,256), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0,0,0,256);
  g.addColorStop(0.00,'rgba(0,0,0,0)');
  g.addColorStop(0.18,'rgba(255,255,255,.95)');
  g.addColorStop(0.55,'rgba(255,255,255,.45)');
  g.addColorStop(1.00,'rgba(0,0,0,0)');
  ctx.fillStyle=g; ctx.fillRect(0,0,8,256);
  return c;
}

/* ============================================================================
   6.  renderer / scene / lights
   ==========================================================================*/
const canvasEl = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({
  canvas: canvasEl, antialias: true, alpha: false,
  preserveDrawingBuffer: true, powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(vw(), vh(), false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
/* the page-edge stripes are the highest-frequency thing in the scene and they
   are always seen at a grazing angle — give every texture the hardware maximum */
MAXANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0d1310, 0.0065);

const camera = new THREE.PerspectiveCamera(32, vw()/vh(), 0.1, 200);
camera.position.set(0, 0.5, 12);
camera.lookAt(0,0,0);

/* ---- environment (PMREM from a procedural forest equirect) ---- */
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
{
  const envT = new THREE.CanvasTexture(makeEnvCanvas(1024,512,false));
  envT.mapping = THREE.EquirectangularReflectionMapping;
  envT.colorSpace = THREE.SRGBColorSpace;
  scene.environment = pmrem.fromEquirectangular(envT).texture;
  scene.environmentIntensity = 1.05;
  envT.dispose();
}
/* ---- backdrop sphere ---- */
{
  const bgT = new THREE.CanvasTexture(makeEnvCanvas(1024,512,true));
  bgT.colorSpace = THREE.SRGBColorSpace;
  bgT.wrapS = THREE.RepeatWrapping;
  bgT.offset.x = 0.22;
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(60, 48, 32),
    new THREE.MeshBasicMaterial({ map:bgT, side:THREE.BackSide, fog:false, depthWrite:false })
  );
  sky.name = 'sky';
  scene.add(sky);
}

/* ---- lights ---- */
const key = new THREE.DirectionalLight(0xffd2a0, 4.1);
key.position.set(5.6, 7.4, 5.2);
key.castShadow = true;
key.shadow.mapSize.set(2048,2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 30;
key.shadow.camera.left = -5.2; key.shadow.camera.right = 5.2;
key.shadow.camera.top = 5.6;  key.shadow.camera.bottom = -5.6;
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.022;
key.shadow.radius = 5.5;
scene.add(key);

/* cool sky fill from the front-left: this is what makes navy read as navy */
const fill = new THREE.DirectionalLight(0x8fb2ee, 0.9);
fill.position.set(-5.5, 2.6, 6.0);
scene.add(fill);

/* mossy bounce from below-left */
const bounce = new THREE.DirectionalLight(0x7d9a58, 0.45);
bounce.position.set(-3.5, -4.0, 2.0);
scene.add(bounce);

const rim = new THREE.DirectionalLight(0xffb066, 1.5);
rim.position.set(-2.4, 1.6, -6.5);
scene.add(rim);

/* a warm kicker from the left so the spine and its bands are never a black slab */
const kick = new THREE.DirectionalLight(0xffc98a, 0.85);
kick.position.set(-7.0, 1.0, -1.5);
scene.add(kick);

const amb = new THREE.HemisphereLight(0x7d94b8, 0x1d1509, 0.30);
scene.add(amb);

/* a small warm point light that makes the sapphire and the gilt twinkle */
const spark = new THREE.PointLight(0xffe3b0, 1.4, 12, 2);
spark.position.set(1.6, 2.0, 3.4);
scene.add(spark);
/* and a cold one inside the stone */
const gemLight = new THREE.PointLight(0x5aa0ff, 0.55, 2.2, 2);
scene.add(gemLight);

/* ---- forest floor: a mossy disc that fades out, plus the shadow catcher ---- */
{
  const S = 512;
  const c = cv(S,S), ctx = c.getContext('2d');
  const mot = upsample(fbm(S>>2,S>>2,4,4,4,1717), S>>2,S>>2, S,S);
  const img = ctx.createImageData(S,S), d = img.data;
  const rnd = mulberry32(313);
  const hf = new Float32Array(S*S);
  for(let y=0;y<S;y++) for(let x=0;x<S;x++){
    const i = y*S+x, p = i*4, m = mot[i];
    const dx = (x/S-0.5)*2, dy = (y/S-0.5)*2;
    const rr = Math.min(1, Math.sqrt(dx*dx+dy*dy));
    let r = 0.036 + m*0.055, g = 0.048 + m*0.078, b = 0.024 + m*0.036;
    const a = Math.pow(1-rr, 2.4);
    d[p]=r*255; d[p+1]=g*255; d[p+2]=b*255; d[p+3]=a*255;
    hf[i] = 0.5 + (m-0.5)*0.8 + (rnd()-0.5)*0.2;
  }
  ctx.putImageData(img,0,0);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(13, 64),
    new THREE.MeshStandardMaterial({
      map: tex(c,{srgb:true, wrap:false}),
      normalMap: tex(normalFromHeight(hf,S,S,3.0),{rx:4,ry:4}),
      normalScale: new THREE.Vector2(1.2,1.2),
      roughness: 0.95, metalness: 0,
      transparent: true, depthWrite: false, envMapIntensity: 0.7
    })
  );
  floor.rotation.x = -Math.PI/2;
  floor.position.y = -2.92;
  floor.receiveShadow = true;
  scene.add(floor);
}
const catcher = new THREE.Mesh(
  new THREE.PlaneGeometry(40,40),
  new THREE.ShadowMaterial({ color:0x070603, opacity:0.72, transparent:true })
);
catcher.rotation.x = -Math.PI/2;
catcher.position.y = -2.90;
catcher.receiveShadow = true;
scene.add(catcher);

/* ---- god rays ---- */
const rayGroup = new THREE.Group();
scene.add(rayGroup);
{
  const alpha = new THREE.CanvasTexture(makeRayAlpha());
  /* kept well behind the tome so they never wash over the cover */
  const specs = [
    { r:1.9, h:22, x: 6.0, z:-11.0, tilt: 0.30, rot:-0.16, o:0.105 },
    { r:1.2, h:19, x: 1.2, z:-13.5, tilt: 0.16, rot: 0.08, o:0.075 },
    { r:2.6, h:24, x:-5.6, z: -9.5, tilt:-0.28, rot: 0.14, o:0.085 }
  ];
  specs.forEach((s,i)=>{
    const m = new THREE.Mesh(
      new THREE.ConeGeometry(s.r, s.h, 26, 1, true),
      new THREE.MeshBasicMaterial({
        color:0xffd7a0, transparent:true, opacity:s.o, alphaMap:alpha,
        blending:THREE.AdditiveBlending, depthWrite:false,
        side:THREE.DoubleSide, fog:false, toneMapped:true
      })
    );
    m.position.set(s.x, s.h*0.42, s.z);
    m.rotation.z = s.tilt; m.rotation.x = s.rot;
    m.userData.base = s.o; m.userData.ph = i*2.1;
    rayGroup.add(m);
  });
}

/* ---- dust motes ---- */
let dust;
{
  const N = 170;
  const pos = new Float32Array(N*3), seed = new Float32Array(N), siz = new Float32Array(N);
  for(let i=0;i<N;i++){
    pos[i*3]   = (Math.random()-0.5)*15;
    pos[i*3+1] = (Math.random()-0.5)*11;
    pos[i*3+2] = (Math.random()-0.3)*9;
    seed[i] = Math.random()*100;
    siz[i]  = 0.035 + Math.random()*0.085;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('size', new THREE.BufferAttribute(siz,1));
  const sprite = new THREE.CanvasTexture(makeSpriteCanvas(64));
  sprite.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.PointsMaterial({
    map: sprite, size: 0.09, sizeAttenuation: true,
    transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, color: 0xffe0a8
  });
  dust = new THREE.Points(g, mat);
  dust.userData.seed = seed;
  dust.frustumCulled = false;
  scene.add(dust);
}

/* ============================================================================
   7.  the tome
   ==========================================================================*/
const pitchGrp = new THREE.Group();      // look-from-above
const yawGrp   = new THREE.Group();      // spin
const bobGrp   = new THREE.Group();      // idle float
const bookRoot = new THREE.Group();      // x-shift closed<->open
scene.add(pitchGrp); pitchGrp.add(yawGrp); yawGrp.add(bobGrp); bobGrp.add(bookRoot);

/* --- materials ------------------------------------------------------------*/
makeParchmentBase(1024);
const frontMaps = makeLeatherCover(1024, 1432, true,  2024);
const backMaps  = makeLeatherCover(640,  896,  false, 7311);
const plainLeather = makeLeatherPlain(512, 4242);
const edgeV = makeEdgeStripes(true);
const edgeH = makeEdgeStripes(false);
const endMaps = makeEndpaper(512);

function coverMaterial(maps, w, h){
  const opt = {srgb:true, wrap:false};
  const map = tex(maps.map, opt);
  const nrm = tex(maps.normalMap, {wrap:false});
  const rgh = tex(maps.roughnessMap, {wrap:false});
  [map,nrm,rgh].forEach(t=>{ t.repeat.set(1/w, 1/h); t.offset.set(0, 0.5); });
  return new THREE.MeshPhysicalMaterial({
    map, normalMap: nrm, roughnessMap: rgh,
    normalScale: new THREE.Vector2(1.25,1.25),
    metalness: 0.0, roughness: 1.0,
    clearcoat: 0.18, clearcoatRoughness: 0.42,
    envMapIntensity: 1.0
  });
}
const matCoverFront = coverMaterial(frontMaps, CW, CH);
const matCoverBack  = coverMaterial(backMaps,  CW, CH);
const matLeatherEdge = new THREE.MeshPhysicalMaterial({
  map: tex(plainLeather.map,{srgb:true, rx:2.5, ry:2.5}),
  normalMap: tex(plainLeather.normalMap,{rx:2.5, ry:2.5}),
  normalScale: new THREE.Vector2(1.0,1.0),
  roughness: 0.72, metalness: 0.0, clearcoat: 0.12, envMapIntensity: 0.9
});
/* every gilt stroke must dome up, or metal reads as flat yellow paint:
   blur the ornament into a height field and turn that into a normal map */
function makeGoldRelief(orn){
  const W = orn.width, H = orn.height;
  const b = cv(W,H), bx = b.getContext('2d');
  bx.fillStyle = '#000'; bx.fillRect(0,0,W,H);
  bx.filter = `blur(${Math.max(2, Math.round(W/220))}px)`;
  bx.drawImage(orn,0,0);
  bx.filter = 'none';
  const soft = fieldFromCanvas(b);
  const hard = fieldFromCanvas((()=>{ const t=cv(W,H), c=t.getContext('2d');
    c.fillStyle='#000'; c.fillRect(0,0,W,H); c.drawImage(orn,0,0); return t; })());
  const hf = new Float32Array(W*H);
  const fineU = fbm(W, H, Math.round(W/4), Math.round(H/4), 2, 616);
  for(let i=0;i<hf.length;i++){
    /* domed core plus a crisp shoulder where the punch bit down */
    hf[i] = soft[i]*0.72 + hard[i]*0.30 + (fineU[i]-0.5)*0.05*hard[i];
  }
  const nrm = normalFromHeight(hf, W, H, 6.0);
  /* worn gold: rougher on the flanks, polished on the crowns */
  const rg = cv(W,H), rc = rg.getContext('2d');
  const img = rc.createImageData(W,H), d = img.data;
  for(let i=0,p=0;i<W*H;i++,p+=4){
    const v = clamp(0.44 - hard[i]*0.20 + (fineU[i]-0.5)*0.24, 0.10, 0.62);
    d[p]=d[p+1]=d[p+2]=v*255; d[p+3]=255;
  }
  rc.putImageData(img,0,0);
  return { normalMap: nrm, roughnessMap: rg };
}
const matGold = (orn, flip)=>{
  /* the decal is a unit plane: uv already spans the whole ornament sheet */
  const rel = makeGoldRelief(orn);
  const mk = (c)=>{
    const t = tex(c, {wrap: !!flip});
    if(flip){ t.repeat.set(-1,1); t.offset.set(1,0); }
    return t;
  };
  return new THREE.MeshPhysicalMaterial({
    color: 0xd2a044, metalness: 1.0, roughness: 1.0,
    roughnessMap: mk(rel.roughnessMap),
    normalMap: mk(rel.normalMap),
    normalScale: new THREE.Vector2(1.15,1.15),
    alphaMap: mk(orn), transparent: true, alphaTest: 0.045,
    depthWrite: false, side: THREE.FrontSide,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    envMapIntensity: 1.4
  });
};
const matEndpaper = new THREE.MeshStandardMaterial({
  map: tex(endMaps.map,{srgb:true, rx:1, ry:1.4}),
  normalMap: tex(endMaps.normalMap,{rx:1,ry:1.4}),
  normalScale: new THREE.Vector2(0.5,0.5),
  roughness: 0.88, metalness: 0.0, envMapIntensity: 0.8
});
function edgeMat(vertical, rx, ry){
  return new THREE.MeshStandardMaterial({
    map: tex(vertical?edgeV.map:edgeH.map, {srgb:true, rx, ry}),
    normalMap: tex(vertical?edgeV.normalMap:edgeH.normalMap, {rx, ry}),
    normalScale: new THREE.Vector2(1.4,1.4),
    roughness: 0.78, metalness: 0.0, envMapIntensity: 0.8
  });
}
const matPlainParch = new THREE.MeshStandardMaterial({
  map: tex(parchBase, {srgb:true, rx:1, ry:1.4}),
  normalMap: parchNormalTex, normalScale: new THREE.Vector2(0.35,0.35),
  roughness: 0.92, metalness: 0.0, envMapIntensity: 0.85
});

/* --- helpers -------------------------------------------------------------*/
function roundedRectShape(w, h, rSpine, rFore){
  const s = new THREE.Shape();
  const y0 = -h/2, y1 = h/2;
  s.moveTo(rSpine, y0);
  s.lineTo(w-rFore, y0);
  s.quadraticCurveTo(w, y0, w, y0+rFore);
  s.lineTo(w, y1-rFore);
  s.quadraticCurveTo(w, y1, w-rFore, y1);
  s.lineTo(rSpine, y1);
  s.quadraticCurveTo(0, y1, 0, y1-rSpine);
  s.lineTo(0, y0+rSpine);
  s.quadraticCurveTo(0, y0, rSpine, y0);
  return s;
}
function coverBoard(matArt){
  const shape = roundedRectShape(CW, CH, 0.05, 0.13);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: CVR-0.026, bevelEnabled: true,
    bevelThickness: 0.013, bevelSize: 0.013, bevelSegments: 3,
    curveSegments: 10
  });
  const m = new THREE.Mesh(g, [matArt, matLeatherEdge]);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function goldDecal(orn, flip){
  const g = new THREE.PlaneGeometry(CW*0.998, CH*0.998, 1, 1);
  g.translate(CW/2, 0, 0);
  const m = new THREE.Mesh(g, matGold(orn, flip));
  m.renderOrder = 2;
  return m;
}
function endpaperPlane(w, h){
  const g = new THREE.PlaneGeometry(w, h);
  g.translate(w/2, 0, 0);
  const m = new THREE.Mesh(g, matEndpaper);
  m.receiveShadow = true;
  return m;
}
/* the sapphire: transmissive cabochon + gold bezel + prongs */
function sapphire(scale){
  const grp = new THREE.Group();
  const gem = new THREE.Mesh(
    new THREE.SphereGeometry(1, 40, 28),
    new THREE.MeshPhysicalMaterial({
      color: 0x3f7ae0, metalness: 0, roughness: 0.035,
      transmission: 1.0, thickness: 0.30, ior: 1.77,
      attenuationColor: new THREE.Color(0x2f6ae0), attenuationDistance: 1.6,
      clearcoat: 1.0, clearcoatRoughness: 0.03,
      specularIntensity: 1.0, envMapIntensity: 2.2,
      emissive: new THREE.Color(0x0a2a7a), emissiveIntensity: 0.55
    })
  );
  gem.scale.set(0.23, 0.32, 0.16);
  grp.add(gem);
  const bezelMat = new THREE.MeshPhysicalMaterial({
    color: 0xbe8c30, metalness: 1, roughness: 0.24, envMapIntensity: 1.2
  });
  const bez = new THREE.Mesh(new THREE.TorusGeometry(1, 0.085, 16, 60), bezelMat);
  bez.scale.set(0.245, 0.335, 1);
  bez.position.z = 0.012;
  grp.add(bez);
  for(let i=0;i<4;i++){
    const a = Math.PI/4 + i*Math.PI/2;
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.036, 12, 10), bezelMat);
    p.position.set(Math.cos(a)*0.215, Math.sin(a)*0.300, 0.035);
    grp.add(p);
  }
  grp.scale.setScalar(scale);
  grp.userData.gem = gem;
  return grp;
}

/* --- back cover + right page block (static half) -------------------------*/
const backGrp = new THREE.Group();
bookRoot.add(backGrp);
{
  const board = coverBoard(matCoverBack);
  board.position.set(0, 0, -HALF + 0.013);
  backGrp.add(board);
  const dec = goldDecal(backMaps.ornament, true);
  dec.position.set(0,0,-HALF-0.004);
  dec.rotation.y = Math.PI;
  dec.position.x = CW;              /* rotated plane spans x:[0,CW] again */
  backGrp.add(dec);
  const ep = endpaperPlane(CW*0.985, CH*0.99);
  ep.position.set(CW*0.0075, 0, -HALF + CVR + 0.002);
  backGrp.add(ep);
  const sm = sapphire(0.62);
  sm.position.set(CW/2, 0, -HALF - 0.03);
  sm.rotation.y = Math.PI;
  backGrp.add(sm);
}

/* page block builder: a bowed, edge-striped slab */
function pageBlock(topSign, topMat){
  const g = new THREE.BoxGeometry(PW, PH, BLK, 26, 26, 2);
  g.translate(PW/2, 0, 0);
  /* Organic block: a gentle bow on the outer face, plus lateral waviness on
     the three outer edges. The bow has to stay small — the sheet stack sits
     only millimetres above it — so most of the "no two leaves align" character
     comes from the sideways wander, which costs no vertical clearance. */
  const p = g.attributes.position;
  const zTop = BLK/2 * topSign;
  for(let i=0;i<p.count;i++){
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const u = x/PW, v = (y+PH/2)/PH, w = (z+BLK/2)/BLK;
    if(Math.abs(z - zTop) < 1e-4){
      const bow = Math.sin(u*Math.PI)*0.0085 + Math.sin(v*Math.PI)*0.0040;
      const wob = Math.sin(u*9.1+v*3.3)*0.0020 + Math.sin(v*13.0-u*2.0)*0.0016;
      p.setZ(i, z + topSign*(bow+wob));
    }
    if(x > PW-1e-4){                        /* fore edge wanders in and out */
      p.setX(i, x + Math.sin(v*11.0+w*7.0)*0.010 + Math.sin(w*23.0)*0.006 - 0.004);
    }
    if(Math.abs(Math.abs(y)-PH/2) < 1e-4){  /* head and tail do the same */
      const s = Math.sign(y);
      p.setY(i, y + s*(Math.sin(u*8.0+w*9.0)*0.007 + Math.sin(w*19.0)*0.004 - 0.003));
    }
  }
  g.computeVertexNormals();
  /* ~26 leaves across the visible thickness: any finer and the relief aliases */
  const mFore = edgeMat(true, 0.29, 7);      // +x fore edge
  const mSpine= edgeMat(true, 0.29, 7);      // -x (gutter side)
  const mHead = edgeMat(false, 5, 0.29);     // +y
  const mTail = edgeMat(false, 5, 0.29);     // -y
  const mats = [mFore, mSpine, mHead, mTail,
                topSign>0 ? topMat : matPlainParch,
                topSign>0 ? matPlainParch : topMat];
  const m = new THREE.Mesh(g, mats);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
/* the bare leaf that shows when nothing is turned wears the same ink border */
function borderedPageMat(side){
  const c = makePageCanvas(-1, side, 999);
  const t = tex(c, {srgb:true, wrap:false});
  return new THREE.MeshStandardMaterial({
    map: t, normalMap: parchNormalTex, normalScale: new THREE.Vector2(0.3,0.3),
    roughness: 0.92, metalness: 0, envMapIntensity: 0.85
  });
}
const rightBlock = pageBlock(+1, borderedPageMat('front'));
rightBlock.position.set(0, 0, -BLK/2);
backGrp.add(rightBlock);

/* --- spine (curved shell with four raised bands) --------------------------*/
const spineGrp = new THREE.Group();
bookRoot.add(spineGrp);
let spineMesh, spineGeo;
const SPINE_U = 40, SPINE_V = 90;
{
  spineGeo = new THREE.BufferGeometry();
  const pos = new Float32Array((SPINE_U+1)*(SPINE_V+1)*3);
  const uv  = new Float32Array((SPINE_U+1)*(SPINE_V+1)*2);
  const idx = [];
  for(let j=0;j<=SPINE_V;j++) for(let i=0;i<=SPINE_U;i++){
    const k = j*(SPINE_U+1)+i;
    uv[k*2] = i/SPINE_U; uv[k*2+1] = j/SPINE_V;
  }
  for(let j=0;j<SPINE_V;j++) for(let i=0;i<SPINE_U;i++){
    const a = j*(SPINE_U+1)+i, b = a+1, c = a+SPINE_U+1, d = c+1;
    idx.push(a,c,b, b,c,d);
  }
  spineGeo.setAttribute('position', new THREE.BufferAttribute(pos,3));
  spineGeo.setAttribute('uv', new THREE.BufferAttribute(uv,2));
  spineGeo.setIndex(idx);
  /* spine skin: leather + four gold band trims + tiny ornaments */
  const SW = 512, SH = 1024;
  const spineLeather = makeLeatherPlain(SW, 3131);
  const sc = cv(SW,SH), sctx = sc.getContext('2d');
  sctx.drawImage(spineLeather.map, 0,0, SW,SW, 0,0, SW,SH/2);
  sctx.drawImage(spineLeather.map, 0,0, SW,SW, 0,SH/2, SW,SH/2);
  const bandVs = [0.19, 0.40, 0.60, 0.81];
  bandVs.forEach(v=>{
    const y = (1-v)*SH;
    const bh = SH*0.028;
    /* darken the band body a touch, then two gold trim lines */
    sctx.fillStyle='rgba(0,0,0,.10)'; sctx.fillRect(0, y-bh/2, SW, bh);
    const sh = sctx.createLinearGradient(0,y-bh/2,0,y+bh/2);
    sh.addColorStop(0,'rgba(255,236,190,.16)'); sh.addColorStop(0.5,'rgba(255,236,190,.05)');
    sh.addColorStop(1,'rgba(0,0,0,.22)');
    sctx.fillStyle=sh; sctx.fillRect(0, y-bh/2, SW, bh);
    [ -bh/2, bh/2 ].forEach(dy=>{
      const g = sctx.createLinearGradient(0,y+dy-2,0,y+dy+2);
      g.addColorStop(0,'rgba(122,85,24,.6)'); g.addColorStop(.5,'rgba(249,232,176,1)'); g.addColorStop(1,'rgba(122,85,24,.6)');
      sctx.fillStyle=g; sctx.fillRect(0, y+dy-2.2, SW, 4.4);
    });
  });
  /* little gilt lozenges between the bands */
  for(let i=0;i<bandVs.length-1;i++){
    const v = (bandVs[i]+bandVs[i+1])/2, y=(1-v)*SH;
    sctx.save(); sctx.translate(SW/2, y); sctx.scale(1.6,1.6);
    sctx.strokeStyle='rgba(232,192,105,.95)'; sctx.fillStyle='rgba(217,172,84,.35)'; sctx.lineWidth=1.2;
    sctx.beginPath(); sctx.moveTo(0,-14); sctx.lineTo(6,0); sctx.lineTo(0,14); sctx.lineTo(-6,0); sctx.closePath();
    sctx.fill(); sctx.stroke();
    sctx.fillStyle='rgba(244,217,140,1)'; sctx.beginPath(); sctx.arc(0,0,2.6,0,7); sctx.fill();
    sctx.strokeStyle='rgba(201,155,69,.9)';
    sctx.beginPath(); sctx.moveTo(-13,0); sctx.bezierCurveTo(-9,-2,-9,2,-5,0); sctx.stroke();
    sctx.beginPath(); sctx.moveTo(13,0); sctx.bezierCurveTo(9,-2,9,2,5,0); sctx.stroke();
    sctx.restore();
  }
  const mat = new THREE.MeshPhysicalMaterial({
    map: tex(sc, {srgb:true, wrap:false}),
    normalMap: tex(spineLeather.normalMap, {rx:1.6, ry:3.2}),
    normalScale: new THREE.Vector2(1.0,1.0),
    roughness: 0.58, metalness: 0.10, side: THREE.DoubleSide,
    clearcoat: 0.24, envMapIntensity: 1.7
  });
  spineMesh = new THREE.Mesh(spineGeo, mat);
  spineMesh.castShadow = true; spineMesh.receiveShadow = true;
  spineGrp.add(spineMesh);
}
/* the raised bands are geometry, not just paint */
function bandBump(v){
  let b = 0;
  [0.19,0.40,0.60,0.81].forEach(c=>{
    const d = Math.abs(v-c)/0.030;
    if(d<1) b = Math.max(b, Math.cos(d*Math.PI/2));
  });
  return b;
}
/* Where the flattened spine has to land when the tome lies open: the two boards
   present their outer faces at slightly different depths (the front one has
   swung over the page block), so each end of the strip is aimed at its own
   board and tucked a hair beneath it to avoid coplanar z-fighting. */
const SP_Z_BACK  = -HALF;        // back board's outer face          (-0.430)
const SP_Z_FRONT = -COVER_Z1;    // front board's, once flipped over (-0.450)
const SP_HALFW   = HALF;         // half-width of the strip across the gutter
const SP_SAG     = HALF * 0.14;  // residual bow, bulging away from the boards
const SP_TUCK    = 0.0025;       // slip under the boards rather than into them

let lastSpineK = -1;
/* The spine is not a rigid part: a bound back rolls open. At k=0 it is the
   half-cylinder of the closed tome; at k=1 it has flattened into a barely
   bowed strip bridging the gutter and hugging the underside of both boards.
   Anything in between is a vertex-wise blend, which is what stops the old
   rigid quarter-turn from hanging under the open book as a cracked bowl. */
function updateSpine(k){
  const pos = spineGeo.attributes.position;
  const R = HALF;
  const t = smooth(clamp(k, 0, 1));
  for(let j=0;j<=SPINE_V;j++){
    const v = j/SPINE_V, y = (v-0.5)*CH*1.0;
    const bump = bandBump(v)*0.030;
    const taper = 1 - Math.pow(Math.abs(v-0.5)*2, 6)*0.05;
    const rr = (R + bump) * taper;
    for(let i=0;i<=SPINE_U;i++){
      const u = i/SPINE_U;
      /* closed: half-cylinder, u=0 at the back joint, u=1 at the front joint */
      const a = -Math.PI/2 + u*Math.PI;        // -90deg (-z) .. +90deg (+z)
      const xC = -Math.cos(a)*rr, zC = Math.sin(a)*rr;
      /* open: flat strip, same chord width, ends flush with the boards */
      const xO = lerp(SP_HALFW, -SP_HALFW, u);
      const zO = lerp(SP_Z_BACK, SP_Z_FRONT, u) - SP_TUCK
               - (SP_SAG*Math.sin(u*Math.PI) + bump) * taper;
      const o = j*(SPINE_U+1)+i;
      pos.setXYZ(o, lerp(xC,xO,t), y, lerp(zC,zO,t));
    }
  }
  pos.needsUpdate = true;
  spineGeo.computeVertexNormals();
  spineGeo.computeBoundingSphere();
  lastSpineK = k;
}
updateSpine(0);

/* --- front assembly: left block + front cover, hinged at the spine -------*/
const frontAsm = new THREE.Group();
bookRoot.add(frontAsm);
let frontCoverBoard, frontGem, clasp;
{
  const leftBlock = pageBlock(-1, borderedPageMat('back'));
  leftBlock.position.set(0, 0, 0.04 + BLK/2);
  frontAsm.add(leftBlock);

  const coverZ0 = COVER_Z0;
  frontCoverBoard = coverBoard(matCoverFront);
  frontCoverBoard.position.set(0, 0, coverZ0 + 0.013);
  frontAsm.add(frontCoverBoard);

  const ep = endpaperPlane(CW*0.985, CH*0.99);
  ep.position.set(CW*0.0075, 0, coverZ0 - 0.002);
  ep.rotation.y = Math.PI;
  ep.position.x = CW*(1-0.0075);
  frontAsm.add(ep);

  const dec = goldDecal(frontMaps.ornament, false);
  dec.position.set(0,0, coverZ0 + CVR + 0.004);
  frontAsm.add(dec);

  frontGem = sapphire(1.0);
  frontGem.position.set(CW/2, 0, coverZ0 + CVR + 0.035);
  frontAsm.add(frontGem);

  /* clasp on the fore edge */
  clasp = new THREE.Group();
  const cm = new THREE.MeshPhysicalMaterial({ color:0xa8792f, metalness:1, roughness:0.31, envMapIntensity:1.4 });
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.84, 0.10), cm);
  strap.castShadow = true;
  clasp.add(strap);
  const boss = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 14),
    new THREE.MeshPhysicalMaterial({ color:0x2b6fd0, metalness:0, roughness:0.06, envMapIntensity:1.8, clearcoat:1 }));
  boss.position.z = 0.06;
  clasp.add(boss);
  clasp.position.set(CW + 0.02, 0, coverZ0 + CVR*0.5);
  clasp.userData.grab = 'clasp';
  strap.userData.grab = 'clasp'; boss.userData.grab = 'clasp';
  frontAsm.add(clasp);
}

/* --- turnable sheets ------------------------------------------------------*/
const pageTex = [], pageCanvas = [], pageHTML = [];
const sheets = [];
const MAXB = 1.0, BEND_A = 0.62;
/* Curl magnitude peaks mid-turn; its sign flips as the leaf passes vertical,
   because the sheet's own +z has by then swung round to face the other way.
   tanh keeps a broad plateau of curl instead of sin's narrow spike. */
function bendFor(t){
  return BEND_A * Math.pow(Math.sin(Math.PI*t), 0.6) * Math.tanh((0.5-t)*9);
}

function makeSheet(i){
  const g = new THREE.PlaneGeometry(PW, PH, 52, 8);
  g.translate(PW/2, 0, 0);
  const base = g.attributes.position.array.slice();
  const grp = new THREE.Group();

  const mk = (n, side, backside)=>{
    const c = makePageCanvas(n, side, 300+n*17);
    pageCanvas[n] = c;
    const t = tex(c, {srgb:true, wrap:false});
    if(backside){ t.wrapS = THREE.RepeatWrapping; t.repeat.x = -1; t.offset.x = 1; }
    pageTex[n] = t;
    const m = new THREE.MeshStandardMaterial({
      map: t, normalMap: parchNormalTex, normalScale: new THREE.Vector2(0.28,0.28),
      roughness: 0.93, metalness: 0.0, envMapIntensity: 0.9,
      side: backside ? THREE.BackSide : THREE.FrontSide
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData = { grab:'sheet', sheet:i, side: backside?'back':'front', page:n };
    grp.add(mesh);
    return mesh;
  };
  const front = mk(i*2,   'front', false);
  const back  = mk(i*2+1, 'back',  true);
  bookRoot.add(grp);
  return { grp, geo:g, base, front, back, t: 0, flat:false };
}
for(let i=0;i<SHEETS;i++) sheets.push(makeSheet(i));

function deformSheet(s, cs){
  const p = s.geo.attributes.position, base = s.base;
  const eps = 1e-4;
  for(let i=0;i<p.count;i++){
    const x0 = base[i*3], y0 = base[i*3+1];
    const u = x0/PW;
    let x, z;
    if(Math.abs(cs) < eps){ x = x0; z = 0; }
    else{
      const k = cs*MAXB, r = PW/k, phi = k*u;
      x = r*Math.sin(phi); z = r*(1-Math.cos(phi));
    }
    /* a touch of organic ripple so paper never reads as a flat quad */
    z += 0.0035*Math.sin(u*6.4 + y0*1.15)*u + 0.0020*Math.sin(y0*2.2)*u*u;
    p.setX(i, x); p.setZ(i, z);
  }
  p.needsUpdate = true;
  s.geo.computeVertexNormals();
  s.geo.computeBoundingSphere();
}
sheets.forEach(s=>deformSheet(s, 0));

/* ============================================================================
   8.  animation state
   ==========================================================================*/
const st = {
  open01: 0,
  pitch: -0.34, yaw: -0.42,
  bob: 1
};
let isOpen = false, turned = 0;
let vYaw = 0, vPitch = 0;
const tweens = [];
function tween(obj, prop, to, dur, ease, done){
  for(let i=tweens.length-1;i>=0;i--) if(tweens[i].obj===obj && tweens[i].prop===prop) tweens.splice(i,1);
  tweens.push({obj, prop, from:obj[prop], to, dur, t:0, ease:ease||easeIO, done});
}
function stopTween(obj, prop){
  for(let i=tweens.length-1;i>=0;i--) if(tweens[i].obj===obj && tweens[i].prop===prop) tweens.splice(i,1);
}
function stepTweens(dt){
  for(let i=tweens.length-1;i>=0;i--){
    const tw = tweens[i];
    tw.t += dt;
    const k = tw.dur<=0 ? 1 : Math.min(1, tw.t/tw.dur);
    tw.obj[tw.prop] = tw.from + (tw.to-tw.from)*tw.ease(k);
    if(k>=1){ tweens.splice(i,1); if(tw.done) tw.done(); }
  }
}

/* Stack heights are chosen so that no leaf ever intersects the page block it
   rests on: the right block crowns at +0.013, the left (flipped) one at -0.027. */
function sheetRest(i, t){
  const uz = 0.022 + (SHEETS-i)*0.005,  ua = -(SHEETS-i)*0.0045;
  const tz = -0.012 + i*0.005,          ta = -Math.PI + i*0.0044;
  return { z: lerp(uz,tz,t), a: lerp(ua,ta,t) };
}
function applyTransforms(){
  const k = st.open01;
  bookRoot.position.x = -PW*0.5*(1-k);
  frontAsm.rotation.y = -Math.PI*k;
  /* The spine morphs in place — no rigid swing — and the rebuild only runs when
     the open progress has actually moved, so idle frames touch no buffers. */
  if(Math.abs(k - lastSpineK) > 0.0015) updateSpine(k);

  pitchGrp.rotation.x = st.pitch;
  yawGrp.rotation.y = st.yaw;

  sheets.forEach((s,i)=>{
    const r = sheetRest(i, s.t);
    const lift = Math.sin(Math.PI*s.t)*0.13;
    s.grp.position.z = r.z + lift;
    s.grp.rotation.y = r.a;
    const want = s.flat ? 0 : bendFor(s.t);
    if(Math.abs(want - (s.lastBend===undefined?999:s.lastBend)) > 0.0015){
      deformSheet(s, want); s.lastBend = want;
    }
    /* only the visible spread is clickable */
    s.front.userData.pick = (i===turned || (i===turned-1 && s.t<0.5));
    s.back.userData.pick  = (i===turned-1 || (i===turned && s.t>0.5));
  });
}

/* ============================================================================
   9.  persistence
   ==========================================================================*/
const savedNote = document.getElementById('savedNote');
let saveTm=0, noteTm=0;
function toast(){
  savedNote.classList.add('show');
  clearTimeout(noteTm); noteTm = setTimeout(()=>savedNote.classList.remove('show'), 1200);
}
function savePage(n){
  try{ localStorage.setItem(`${LS}.page.${n}`, pageHTML[n] || ''); }catch(e){}
  toast();
}
function saveState(){
  try{ localStorage.setItem(`${LS}.state`, JSON.stringify({open:isOpen, turned})); }catch(e){}
}
function loadAll(){
  for(let n=0;n<SHEETS*2;n++){
    let v = null;
    try{ v = localStorage.getItem(`${LS}.page.${n}`); }catch(e){}
    if(v !== null) pageHTML[n] = v;
    else if(n===0)  pageHTML[n] = FIRST_PAGE_HTML;
    else            pageHTML[n] = '';
  }
  let s = null;
  try{ s = JSON.parse(localStorage.getItem(`${LS}.state`)); }catch(e){}
  if(s){
    isOpen = !!s.open;
    turned = clamp(s.turned|0, 0, SHEETS);
  }
}

/* ============================================================================
   10. ink: HTML -> canvas
   ==========================================================================*/
const TXT = {
  front: { x: 44*SC, y: 40*SC, w: (340-44-38)*SC, h: (470-40-56)*SC },
  back:  { x: 38*SC, y: 40*SC, w: (340-44-38)*SC, h: (470-40-56)*SC }
};
const BASE_SIZE = 23*SC, BASE_LH = 1.6, BASE_FAM = 'La Belle Aurore';

function parseBlocks(html){
  const host = document.createElement('div');
  host.innerHTML = html || '';
  const blocks = [];
  const DEF = { align:'left', size:BASE_SIZE, family:BASE_FAM, opacity:1, italic:false, bold:false, lh:BASE_LH };
  let cur = null;
  const push = (s)=>{ cur = { text:'', ...s }; blocks.push(cur); return cur; };
  push(DEF);
  (function walk(node, s){
    node.childNodes.forEach(n=>{
      if(n.nodeType === 3){ cur.text += n.nodeValue.replace(/ /g,' '); return; }
      if(n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if(tag === 'br'){ push(s); return; }
      const ns = {...s};
      const cs = n.style;
      if(cs){
        if(cs.textAlign) ns.align = cs.textAlign;
        if(cs.fontFamily) ns.family = cs.fontFamily.split(',')[0].replace(/['"]/g,'').trim();
        if(cs.fontSize){ const v = parseFloat(cs.fontSize); if(v) ns.size = v*SC; }
        if(cs.lineHeight){ const v = parseFloat(cs.lineHeight); if(v && v<6) ns.lh = v; }
        if(cs.opacity){ const v = parseFloat(cs.opacity); if(!isNaN(v)) ns.opacity = v; }
        if(cs.fontStyle === 'italic') ns.italic = true;
        if(cs.fontWeight && (cs.fontWeight==='bold' || +cs.fontWeight>=600)) ns.bold = true;
      }
      if(tag==='b'||tag==='strong') ns.bold = true;
      if(tag==='i'||tag==='em') ns.italic = true;
      const isBlock = /^(div|p|h1|h2|h3|h4|li|blockquote|section)$/.test(tag);
      if(isBlock){
        if(cur.text !== '') push(ns);
        else Object.assign(cur, ns, {text: cur.text});
      }
      walk(n, ns);
      if(isBlock) push(s);
    });
  })(host, DEF);
  while(blocks.length > 1 && blocks[blocks.length-1].text === '') blocks.pop();
  return blocks;
}
function fontOf(b){
  return `${b.italic?'italic ':''}${b.bold?'700 ':''}${Math.round(b.size)}px "${b.family}", 'IM Fell English', serif`;
}
function wrapText(ctx, text, maxW){
  const out = [];
  const words = text.split(' ');
  let line = '';
  for(let i=0;i<words.length;i++){
    const test = line ? line+' '+words[i] : words[i];
    if(ctx.measureText(test).width <= maxW || line===''){
      if(ctx.measureText(test).width > maxW && line===''){
        /* a single word too long — break it by characters */
        let chunk = '';
        for(const ch of words[i]){
          if(ctx.measureText(chunk+ch).width > maxW && chunk){ out.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
        continue;
      }
      line = test;
    } else {
      out.push(line); line = words[i];
    }
  }
  out.push(line);
  return out;
}
function paintPage(n){
  const c = pageCanvas[n];
  if(!c) return;
  const side = (n%2===0) ? 'front' : 'back';
  /* repaint the parchment + border, then the ink */
  const fresh = makePageCanvas(n, side, 300+n*17);
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,PAGE_W,PAGE_H);
  ctx.drawImage(fresh, 0, 0);
  const r = TXT[side];
  ctx.save();
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';
  const blocks = parseBlocks(pageHTML[n]);
  let y = r.y;
  for(const b of blocks){
    ctx.font = fontOf(b);
    const lh = b.size*b.lh;
    const lines = wrapText(ctx, b.text, r.w);
    for(const ln of lines){
      if(y > r.y + r.h) break;
      ctx.globalAlpha = b.opacity;
      const w = ctx.measureText(ln).width;
      let x = r.x;
      if(b.align === 'center') x = r.x + (r.w - w)/2;
      else if(b.align === 'right') x = r.x + r.w - w;
      ctx.fillText(ln, x, y + (lh-b.size)/2 + b.size*0.80);
      y += lh;
    }
    if(y > r.y + r.h) break;
  }
  ctx.restore();
  if(pageTex[n]) pageTex[n].needsUpdate = true;
}

/* ============================================================================
   11. writing mode
   ==========================================================================*/
const writer = document.getElementById('writer');
let writing = null;              /* { page, mesh, side, sheet } */
let camAnim = null;
const camHome = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };

function fitCamera(){
  const fov = camera.fov*Math.PI/180;
  const aspect = vw()/vh();
  const needH = PH + 2.5;
  const needW = (isOpen ? PW*2 : PW) + 2.2;
  let d = Math.max(needH/(2*Math.tan(fov/2)), needW/(2*Math.tan(fov/2)*aspect));
  if(!isFinite(d)) d = 12;
  camHome.pos.set(0, 0.35, Math.max(6.5, d));
  const m = new THREE.Matrix4().lookAt(camHome.pos, new THREE.Vector3(0,0,0), new THREE.Vector3(0,1,0));
  camHome.quat.setFromRotationMatrix(m);
  if(!writing && !camAnim){ camera.position.copy(camHome.pos); camera.quaternion.copy(camHome.quat); }
}
function glideCamera(pos, quat, dur, done){
  camAnim = {
    p0: camera.position.clone(), q0: camera.quaternion.clone(),
    p1: pos.clone(), q1: quat.clone(), t:0, dur, done
  };
}
/* canvas pixel -> sheet-local (x,y) */
function canvasToLocal(side, cx, cy){
  const u = cx/PAGE_W, v = cy/PAGE_H;
  const x = (side==='front') ? u*PW : (1-u)*PW;
  const y = (0.5 - v)*PH;
  return new THREE.Vector3(x, y, 0);
}
function pageFrame(info){
  const mesh = info.mesh;
  mesh.updateWorldMatrix(true,false);
  const m = mesh.matrixWorld;
  const nrm = new THREE.Vector3(0,0, info.side==='front'? 1 : -1).transformDirection(m).normalize();
  const up  = new THREE.Vector3(0,1,0).transformDirection(m).normalize();
  const ctr = canvasToLocal(info.side, PAGE_W/2, PAGE_H/2).applyMatrix4(m);
  return { nrm, up, ctr, m };
}
function enterWriting(info){
  if(writing && writing.page === info.page) return;
  if(writing) commitWriter();
  writing = info;
  document.body.classList.add('writing');
  sheets[info.sheet].flat = true;
  stopTween(st,'bob'); tween(st,'bob', 0, 0.5, easeOut);

  const f = pageFrame(info);
  const fov = camera.fov*Math.PI/180;
  const aspect = vw()/vh();
  const dh = (PH/0.88)/(2*Math.tan(fov/2));
  const dw = (PW/0.80)/(2*Math.tan(fov/2)*aspect);
  const d = Math.max(dh, dw, 3.2);
  const pos = f.ctr.clone().addScaledVector(f.nrm, d);
  const mm = new THREE.Matrix4().lookAt(pos, f.ctr, f.up);
  const q = new THREE.Quaternion().setFromRotationMatrix(mm);
  glideCamera(pos, q, 0.85, ()=> showWriter());
  updateHint();
}
function showWriter(){
  if(!writing) return;
  layoutWriter();
  writer.classList.add('on');
  writer.innerHTML = pageHTML[writing.page] || '';
  placeCaretEnd(writer);
  writer.focus();
}
function layoutWriter(){
  if(!writing) return;
  const info = writing;
  const f = pageFrame(info);
  const r = TXT[info.side];
  const corners = [
    canvasToLocal(info.side, r.x,        r.y       ),
    canvasToLocal(info.side, r.x + r.w,  r.y       ),
    canvasToLocal(info.side, r.x,        r.y + r.h ),
    canvasToLocal(info.side, r.x + r.w,  r.y + r.h )
  ].map(v=>{
    v.applyMatrix4(f.m).project(camera);
    return { x:(v.x*0.5+0.5)*vw(), y:(-v.y*0.5+0.5)*vh() };
  });
  const xs = corners.map(c=>c.x), ys = corners.map(c=>c.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  /* Lay the overlay out in the ORIGINAL design space (340 px page), not in
     canvas pixels: the stored HTML carries inline font-size values in that
     space, so the browser then breaks lines exactly where the canvas renderer
     does — which is the only way the invisible text's caret lands on the ink. */
  const w = r.w/SC, h = r.h/SC;
  writer.style.left = x0+'px';
  writer.style.top  = y0+'px';
  writer.style.width  = w+'px';
  writer.style.height = h+'px';
  writer.style.fontSize = (BASE_SIZE/SC)+'px';
  writer.style.lineHeight = String(BASE_LH);
  writer.style.transform = `scale(${(x1-x0)/w})`;
}
function placeCaretEnd(el){
  const r = document.createRange();
  r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function commitWriter(){
  if(!writing) return;
  const n = writing.page;
  pageHTML[n] = writer.innerHTML;
  paintPage(n);
  savePage(n);
}
function exitWriting(save){
  if(!writing) return;
  if(save !== false) commitWriter();
  sheets[writing.sheet].flat = false;
  writing = null;
  writer.classList.remove('on');
  writer.blur();
  document.body.classList.remove('writing');
  tween(st,'bob', 1, 1.0, easeIO);
  glideCamera(camHome.pos, camHome.quat, 0.8);
  updateHint();
}
writer.addEventListener('input', ()=>{
  if(!writing) return;
  const n = writing.page;
  pageHTML[n] = writer.innerHTML;
  paintPage(n);
  clearTimeout(saveTm);
  saveTm = setTimeout(()=>savePage(n), 350);
});
writer.addEventListener('keydown', e=>{
  if(e.key === 'Escape'){ e.preventDefault(); exitWriting(true); }
  e.stopPropagation();
});

/* ============================================================================
   12. picking & gestures
   ==========================================================================*/
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(cx, cy){
  ndc.set((cx/vw())*2-1, -(cy/vh())*2+1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObject(bookRoot, true);
  for(const h of hits){
    let o = h.object;
    if(o.material && o.material.transparent && o.material.alphaMap) continue;   /* gilt decal is see-through */
    while(o && o !== bookRoot){
      if(o.userData && o.userData.grab) return { obj:o, data:o.userData, point:h.point };
      o = o.parent;
    }
    /* anything else on the book still counts as "the book" */
    return { obj:h.object, data:{}, point:h.point };
  }
  return null;
}
function pickInfo(cx, cy){
  const p = pick(cx, cy);
  if(!p) return null;
  const d = p.data;
  if(d.grab === 'clasp') return { type:'clasp' };
  if(d.grab === 'sheet'){
    const i = d.sheet;
    if(!isOpen) return { type:'cover' };
    if(d.side === 'front' && i === turned && turned < SHEETS)
      return { type:'sheet', idx:i, side:'right', page:d.page, mesh:p.obj, sheet:i };
    if(d.side === 'back' && i === turned-1)
      return { type:'sheet', idx:i, side:'left', page:d.page, mesh:p.obj, sheet:i };
    return { type:'book' };
  }
  /* which half of the tome did we grab? */
  let o = p.obj, inFront = false;
  while(o){ if(o === frontAsm){ inFront = true; break; } o = o.parent; }
  if(!isOpen) return inFront ? { type:'cover' } : { type:'book' };
  if(inFront && turned === 0) return { type:'cover' };
  return { type:'book' };
}

const THRESH = 8, SHEET_SPAN = 300, COVER_SPAN = 340, FLICK = 0.6, IDLE = 90;
let mode='idle', grab=null, moved=0, sx=0, sy=0, px=0, py=0;
let vRate=0, vTime=0, dragSheet=null, dragSide=null, coverFrom=0, clickGuard=false;
let inertia = false;

function flickRate(){ return (performance.now()-vTime > IDLE) ? 0 : vRate; }

canvasEl.addEventListener('pointerdown', e=>{
  if(e.button > 0) return;
  try{ canvasEl.setPointerCapture(e.pointerId); }catch(_){}
  inertia = false;
  clickGuard = false;
  sx = px = e.clientX; sy = py = e.clientY;
  moved = 0; vRate = 0; vTime = performance.now();
  grab = pickInfo(e.clientX, e.clientY);
  if(grab && (grab.type==='sheet' || grab.type==='cover')) mode = 'pending';
  else mode = 'rot';
  if(mode==='rot') document.body.classList.add('grabbing');
});
canvasEl.addEventListener('pointermove', e=>{
  if(mode === 'idle') return;
  const dx = e.clientX-px, dy = e.clientY-py;
  px = e.clientX; py = e.clientY;
  moved += Math.abs(dx)+Math.abs(dy);
  const now = performance.now(), dt = Math.max(4, now-vTime);
  vRate = vRate*0.4 + (dx/dt)*0.6; vTime = now;
  const tx = e.clientX-sx, ty = e.clientY-sy;

  if(mode === 'pending'){
    if(moved < THRESH) return;
    if(Math.abs(tx) <= Math.abs(ty)){ mode='rot'; document.body.classList.add('grabbing'); return; }
    if(grab.type === 'sheet'){
      const wantLeft = (grab.side === 'right');
      if((wantLeft && tx>0) || (!wantLeft && tx<0)){ mode='rot'; document.body.classList.add('grabbing'); return; }
      mode = 'sheet';
      dragSheet = sheets[grab.idx]; dragSide = grab.side;
      stopTween(dragSheet,'t');
      if(writing) exitWriting(true);
    }else{
      const wantLeft = !isOpen;
      if((wantLeft && tx>0) || (!wantLeft && tx<0)){ mode='rot'; document.body.classList.add('grabbing'); return; }
      mode = 'cover';
      coverFrom = isOpen ? 1 : 0;
      stopTween(st,'open01');
      if(writing) exitWriting(true);
    }
    clickGuard = true;
    document.body.classList.add('grabbing');
  }
  if(mode === 'rot'){
    st.yaw   += dx*0.006;
    st.pitch -= dy*0.006;
    st.pitch = clamp(st.pitch, -1.35, 1.35);
    vYaw = dx*0.006; vPitch = -dy*0.006;
    if(moved >= THRESH) clickGuard = true;
    return;
  }
  if(mode === 'sheet'){
    dragSheet.t = (dragSide==='right')
      ? clamp(-tx/SHEET_SPAN, 0, 1)
      : clamp(1 - tx/SHEET_SPAN, 0, 1);
    return;
  }
  if(mode === 'cover'){
    st.open01 = clamp(coverFrom - tx/COVER_SPAN, 0, 1);
  }
});
function endGesture(e, cancelled){
  const m = mode; mode = 'idle';
  document.body.classList.remove('grabbing');
  try{ canvasEl.releasePointerCapture(e.pointerId); }catch(_){}

  if(m === 'sheet'){
    const right = (dragSide === 'right'), fr = flickRate();
    const commit = cancelled ? false
      : right ? (dragSheet.t >= 0.5 || fr < -FLICK)
              : (dragSheet.t <= 0.5 || fr >  FLICK);
    settleSheet(dragSheet, commit, right);
    dragSheet = null;
    return;
  }
  if(m === 'cover'){
    const opening = (coverFrom === 0), fr = flickRate();
    const commit = cancelled ? false
      : opening ? (st.open01 >= 0.333 || fr < -FLICK)
                : (st.open01 <= 0.5   || fr >  FLICK);
    settleCover(opening ? commit : !commit);
    return;
  }
  if(m === 'pending' && moved < THRESH){ handleClick(); return; }
  if(m === 'rot'){
    if(moved < THRESH) handleClick();
    else inertia = true;
  }
}
canvasEl.addEventListener('pointerup', e=>endGesture(e,false));
canvasEl.addEventListener('pointercancel', e=>endGesture(e,true));

function settleSheet(s, commit, wasRight){
  const to = commit ? (wasRight?1:0) : (wasRight?0:1);
  if(commit){ turned += wasRight ? 1 : -1; saveState(); }
  tween(s,'t', to, 0.85*Math.max(0.25,Math.abs(to-s.t)+0.2), easeIO);
}
function settleCover(open){
  isOpen = open;
  tween(st,'open01', open?1:0, 1.25, easeIO, ()=>fitCamera());
  /* recentre the view, but unwind whole turns so an orbited tome never spins */
  const ty = open ? -0.14 : -0.42;
  tween(st,'yaw', ty + Math.round((st.yaw-ty)/(Math.PI*2))*Math.PI*2, 1.25, easeIO);
  tween(st,'pitch', open?-0.30:-0.34, 1.25, easeIO);
  saveState(); updateHint();
  fitCameraSoon();
}
let fitTm = 0;
function fitCameraSoon(){
  clearTimeout(fitTm);
  fitTm = setTimeout(()=>{
    const prevPos = camHome.pos.clone();
    fitCamera();
    if(!writing && !prevPos.equals(camHome.pos)) glideCamera(camHome.pos, camHome.quat, 0.9);
  }, 20);
}
function handleClick(){
  if(clickGuard){ clickGuard = false; return; }
  if(!grab){ if(writing) exitWriting(true); return; }
  if(grab.type === 'clasp'){ isOpen ? closeBook() : openBook(); return; }
  if(!isOpen){ openBook(); return; }
  if(grab.type === 'sheet'){
    enterWriting({ page:grab.page, mesh:grab.mesh, side: grab.side==='right'?'front':'back', sheet:grab.sheet });
    return;
  }
  if(writing) exitWriting(true);
}
/* clicking the void exits writing */
canvasEl.addEventListener('pointerdown', e=>{
  if(!writing) return;
  const p = pickInfo(e.clientX, e.clientY);
  if(!p || p.type !== 'sheet') exitWriting(true);
}, true);

/* ============================================================================
   13. open / close / flip
   ==========================================================================*/
const hint = document.getElementById('hint');
const HINT_CLOSED = 'Drag the void to turn the tome  ·  Drag the cover open  ·  ✦ unseals it';
const HINT_OPEN   = 'Drag a page to turn it  ·  Drag the cover shut  ·  Click a page to inscribe';
const HINT_WRITE  = 'The quill is at work  ·  Esc, or click away, to rest it';
function updateHint(){ hint.textContent = writing ? HINT_WRITE : (isOpen ? HINT_OPEN : HINT_CLOSED); }

function openBook(){
  if(isOpen) return;
  settleCover(true);
}
function closeBook(){
  if(!isOpen){ if(writing) exitWriting(true); return; }
  if(writing) exitWriting(true);
  const t = turned;
  sheets.forEach((s,i)=>{ if(i<t) tween(s,'t',0, 0.5+i*0.05, easeIO); });
  turned = 0;
  setTimeout(()=>settleCover(false), t>0 ? 260 : 0);
}
function flip(dir){
  if(!isOpen) return;
  if(writing) exitWriting(true);
  if(dir==='next' && turned < SHEETS){
    const s = sheets[turned]; turned++;
    tween(s,'t',1, 0.95, easeIO);
  }else if(dir==='prev' && turned > 0){
    turned--;
    tween(sheets[turned],'t',0, 0.95, easeIO);
  }
  saveState();
}

document.getElementById('btnOpen').addEventListener('click', ()=> isOpen ? closeBook() : openBook());
document.getElementById('btnReset').addEventListener('click', ()=>{
  inertia = false;
  if(writing) exitWriting(true);
  const ty = isOpen ? -0.14 : -0.42, tp = isOpen ? -0.30 : -0.34;
  tween(st,'yaw', ty + Math.round((st.yaw-ty)/(Math.PI*2))*Math.PI*2, 0.7, easeOut);
  tween(st,'pitch', tp, 0.7, easeOut);
  glideCamera(camHome.pos, camHome.quat, 0.7);
});
document.addEventListener('keydown', e=>{
  if(writing) return;
  if(e.key === 'ArrowRight'){ flip('next'); e.preventDefault(); }
  if(e.key === 'ArrowLeft'){ flip('prev'); e.preventDefault(); }
  if(e.key === 'Escape') closeBook();
  if(e.key === 'Enter' && !isOpen){ openBook(); e.preventDefault(); }
});

/* ============================================================================
   14. resize & loop
   ==========================================================================*/
function onResize(){
  if(!measureViewport()) return;
  renderer.setSize(vw(), vh(), false);
  camera.aspect = vw()/vh();
  camera.updateProjectionMatrix();
  const wasWriting = writing;
  fitCamera();
  if(wasWriting) layoutWriter();
}
addEventListener('resize', onResize);
addEventListener('orientationchange', onResize);
/* the resize event is not always fired for pane/layout changes */
try{ new ResizeObserver(()=>onResize()).observe(document.documentElement); }catch(_){}

let last = performance.now(), clock = 0;
function update(dt){
  clock += dt;
  stepTweens(dt);

  if(inertia){
    st.yaw += vYaw; st.pitch += vPitch;
    st.pitch = clamp(st.pitch, -1.35, 1.35);
    vYaw *= 0.93; vPitch *= 0.93;
    if(Math.abs(vYaw)+Math.abs(vPitch) < 0.0004) inertia = false;
  }
  /* idle float */
  const b = st.bob;
  bobGrp.position.y = Math.sin(clock*0.78)*0.13*b;
  bobGrp.rotation.z = Math.sin(clock*0.53)*0.012*b;
  bobGrp.position.z = Math.sin(clock*0.41+1.1)*0.05*b;

  applyTransforms();

  /* camera glide */
  if(camAnim){
    camAnim.t += dt;
    const k = Math.min(1, camAnim.t/camAnim.dur), e = easeIO(k);
    camera.position.lerpVectors(camAnim.p0, camAnim.p1, e);
    camera.quaternion.slerpQuaternions(camAnim.q0, camAnim.q1, e);
    if(k>=1){ const d = camAnim.done; camAnim = null; if(d) d(); }
  }
  if(writing && !camAnim) layoutWriter();

  /* gem shimmer + rays + dust */
  const sh = 1.25 + Math.sin(clock*1.4)*0.5 + Math.sin(clock*0.53)*0.25;
  spark.intensity = 1.0 + sh*0.5;
  if(frontGem){
    frontGem.userData.gem.material.envMapIntensity = 1.9 + Math.sin(clock*0.9)*0.55;
    frontGem.getWorldPosition(gemLight.position);
    gemLight.position.z += 0.05;
    gemLight.intensity = 0.35 + 0.3*(0.5+0.5*Math.sin(clock*1.1));
  }
  rayGroup.children.forEach(m=>{
    m.material.opacity = m.userData.base * (0.72 + 0.34*Math.sin(clock*0.35 + m.userData.ph));
    m.rotation.z += Math.sin(clock*0.12 + m.userData.ph)*0.00012;
  });
  const p = dust.geometry.attributes.position, sd = dust.userData.seed;
  for(let i=0;i<p.count;i++){
    let y = p.getY(i) + dt*(0.09 + (sd[i]%10)*0.014);
    let x = p.getX(i) + Math.sin(clock*0.35 + sd[i])*dt*0.10;
    if(y > 5.6){ y = -5.6; x = (Math.random()-0.5)*15; }
    p.setY(i, y); p.setX(i, x);
  }
  p.needsUpdate = true;
}
/* The window can be resized while the tab is hidden (no resize event is
   guaranteed to reach us), so reconcile before every frame — reading
   innerWidth is cheap and never forces layout. */
function syncSize(){
  const w = innerWidth || 0, h = innerHeight || 0;
  if(w >= 2 && h >= 2 && (w !== VW || h !== VH)) onResize();
}
function frame(){
  syncSize();
  const now = performance.now();
  const dt = Math.min(0.05, (now-last)/1000);
  last = now;
  update(dt);
  renderer.render(scene, camera);
}
function rafLoop(){ frame(); requestAnimationFrame(rafLoop); }
/* rAF sleeps in a hidden tab; keep the world ticking so screenshots are real */
setInterval(()=>{ if(document.hidden) frame(); }, 250);

/* ============================================================================
   15. boot
   ==========================================================================*/
async function boot(){
  try{
    await Promise.all([
      document.fonts.load(`${BASE_SIZE}px "La Belle Aurore"`),
      document.fonts.load(`${26*SC}px "IM Fell English SC"`),
      document.fonts.load(`italic ${19*SC}px "IM Fell English"`),
      document.fonts.ready
    ]);
  }catch(e){}
  loadAll();
  for(let n=0;n<SHEETS*2;n++) paintPage(n);
  sheets.forEach((s,i)=>{ s.t = (i<turned) ? 1 : 0; });
  st.open01 = isOpen ? 1 : 0;
  st.yaw   = isOpen ? -0.14 : -0.42;
  st.pitch = isOpen ? -0.30 : -0.34;
  applyTransforms();
  onResize();
  updateHint();
  setTimeout(onResize, 60);
  setTimeout(onResize, 400);
  renderer.compile ? renderer.compile(scene, camera) : null;
  frame();
  requestAnimationFrame(rafLoop);
  BOOT_MS = Math.round(performance.now() - T0);
  const l = document.getElementById('loading');
  l.classList.add('gone');
  setTimeout(()=>l.remove(), 1300);
}
boot();

/* handy for verification from the console */
window.__book = {
  get isOpen(){ return isOpen; },
  get turned(){ return turned; },
  get writing(){ return writing && writing.page; },
  st, sheets, openBook, closeBook, flip, enterWriting, exitWriting,
  camera, renderer, scene, THREE,
  pageHTML,
  probe(x,y){ const p = pick(x,y); const i = pickInfo(x,y);
    return { hit: p && (p.obj.name||p.obj.type), ud: p && JSON.stringify(p.data), info: i && JSON.stringify(i.type ? {type:i.type, side:i.side, page:i.page, idx:i.idx} : i) }; },
  /* synthetic pointer drag, so a hidden tab can still be driven end to end */
  down(x,y){ canvasEl.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,button:0,pointerId:1,bubbles:true})); },
  move(x,y){ canvasEl.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,pointerId:1,bubbles:true})); },
  up(x,y){ canvasEl.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,button:0,pointerId:1,bubbles:true})); },
  get bootMs(){ return BOOT_MS; },
  info(){ return { isOpen, turned, writing: writing&&writing.page, open01:st.open01,
                   tris: renderer.info.render.triangles, calls: renderer.info.render.calls,
                   textures: renderer.info.memory.textures, geoms: renderer.info.memory.geometries }; }
};
