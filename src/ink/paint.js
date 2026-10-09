import { clamp, lerp, smooth, mulberry32, fbm, upsample, cv } from '../lib/textures.js';
import { capFont, fontCss, FS, INK, PAGE_H, PAGE_W } from '../core/config.js';
import { caretXY, glyphBox, INK_DN, INK_UP } from './layout.js';
import { pages } from '../book/pages.js';
import { blinkPhase, burning } from './writing.js';
import { emitSmoke, emitSparks } from '../fx/ink-fx.js';

const GLOW_T = 3.6;
const BURN_T = 0.42, BURN_CAP = 1.2, COOL_T = 0.42, COOL_CAP = 0.65;
const CHAR = 0.04;
const lineText = (text, ln)=> text.slice(ln.start + (ln.skip||0), ln.end);
function fillLine(ctx, s, x, ln){
  if(!ln.rtl){ ctx.fillText(s, x, ln.y); return; }
  ctx.save(); ctx.direction = 'rtl'; ctx.textAlign = 'right'; ctx.fillText(s, x, ln.y); ctx.restore();
}
function eachBurning(lay, text, born, now, fn){
  if(!born) return;
  for(let i=0;i<text.length;i++){
    const age = (now - (born[i]||0))/1000;
    if(age >= GLOW_T || age < 0) continue;
    const ch = text[i]; if(ch === ' ' || ch === '\n') continue;
    const gb = glyphBox(lay, text, i); if(!gb) continue;
    if(age > (gb.cap ? BURN_CAP + 5*COOL_CAP : BURN_T + 5*COOL_T)) continue;
    fn(gb, i, age);
  }
}
function paintThroughClip(ctx, lay, text, gb){
  ctx.save();
  ctx.beginPath();
  if(gb.cap){
    const c = lay.cap;
    const l = Math.max(lay.size*0.2, c.l + lay.size*0.1);
    ctx.rect(c.x - l, c.y - c.size*0.95, c.w + l, c.size*1.2);
    ctx.clip();
    ctx.font = capFont(lay.f, c.size);
    ctx.fillText(c.ch, c.x, c.y);
  }else{
    ctx.rect(gb.x - 0.5, gb.y - lay.size*INK_UP, gb.w + 1, lay.size*(INK_UP + INK_DN));
    ctx.clip();
    ctx.font = fontCss(lay.f, lay.size);
    fillLine(ctx, lineText(text, gb.ln), gb.ln.x0, gb.ln);
  }
  ctx.restore();
}
function burnDone(born, now, i){
  const b = born[i];
  return !b || (now - b)/1000 >= BURN_T;
}
function burnRegion(lay, text, born, now, gb, i){
  const s = lay.size;
  if(gb.cap){
    const c = lay.cap, top = c.y - c.size - s*0.1, bot = c.y + c.size*0.3, l = Math.max(s*0.3, c.l + s*0.1);
    return { x0: c.x - l, y0: top, x1: c.x + c.w + s*0.1, y1: bot, rects: [[c.x - l, top, c.w + l + s*0.1, bot - top]] };
  }
  const ln = gb.ln, a0 = ln.start + (ln.skip||0);
  const open = j => j < a0 || j >= ln.end || /\s/.test(text[j]);
  const back = open(i-1) ? s*0.14 : 0.5, ahead = open(i+1) || !burnDone(born, now, i+1) ? s*0.32 : 1;
  const x0 = gb.x - (ln.rtl ? ahead : back);
  const x1 = gb.x + gb.w + (ln.rtl ? back : ahead);
  const y0 = gb.y - s*INK_UP, bh = s*(INK_UP + INK_DN);
  return { x0, y0, x1, y1: y0 + bh, rects: [[x0, y0, x1 - x0, bh]] };
}
function clipRects(ctx, R){
  ctx.beginPath();
  R.rects.forEach(q => ctx.rect(q[0], q[1], q[2], q[3]));
  ctx.clip();
}
const burnCv = {};
function burnScratch(k, w, h){
  let c = burnCv[k];
  if(!c){ c = burnCv[k] = document.createElement('canvas'); c.width = c.height = 64; }
  if(c.width < w || c.height < h){ c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
  const x = c.getContext('2d', { willReadFrequently: true });
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; x.shadowBlur = 0; x.filter = 'none';
  x.clearRect(0, 0, w, h);
  return x;
}
let burnNoise = null;
function setBurnNoise(v){ burnNoise = v; }
function noiseAt(x, y){
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const r0 = (y0 & 255) << 8, r1 = ((y0 + 1) & 255) << 8, c0 = x0 & 255, c1 = (x0 + 1) & 255;
  const a = burnNoise[r0 | c0], b = burnNoise[r0 | c1], c = burnNoise[r1 | c0], d = burnNoise[r1 | c1];
  return (a + (b - a)*fx)*(1 - fy) + (c + (d - c)*fx)*fy;
}
const NIB_DX = 0.972, NIB_DY = 0.235;
const ramp = (h, K)=>{
  let k = 0;
  while(k < K.length - 2 && h > K[k+1][0]) k++;
  const a = K[k], b = K[k+1], t = clamp((h - a[0])/(b[0] - a[0]), 0, 1);
  return [lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
};
const SINGE = [[0, 46, 22, 10], [0.35, 120, 46, 16], [0.7, 214, 110, 40], [1, 255, 214, 150]];
const EMBER = [[0, 0, 0, 0], [0.2, 190, 62, 14], [0.5, 255, 132, 40], [1, 255, 228, 180]];
function burnLetter(lay, text, born, now, gb, i, ageS){
  const T = gb.cap ? BURN_CAP : BURN_T, C = gb.cap ? COOL_CAP : COOL_T, PRE = T*(gb.cap ? 0.2 : 0.4);
  const RIM = gb.cap ? 0.045 : 0.08, CH = gb.cap ? 0.022 : CHAR, HOT = gb.cap ? 0.035 : 0.06;
  const R = burnRegion(lay, text, born, now, gb, i);
  const X0 = Math.floor(R.x0), Y0 = Math.floor(R.y0);
  const w = Math.ceil(R.x1) - X0, h = Math.ceil(R.y1) - Y0;
  if(w < 1 || h < 1) return null;
  if(!burnNoise) burnNoise = fbm(256, 256, 12, 12, 3, 4242);
  const mx = burnScratch('m', w, h);
  mx.translate(-X0, -Y0);
  mx.fillStyle = '#fff';
  paintThroughClip(mx, lay, text, gb);
  const ink = mx.getImageData(0, 0, w, h).data;
  const soft = softMask(ink, w, h, Math.max(1, Math.round(2.4*FS)));
  const s = lay.size;
  const gx0 = gb.cap ? lay.cap.x : gb.x, gx1 = gb.cap ? lay.cap.x + lay.cap.w : gb.x + gb.w;
  const gy0 = gb.cap ? lay.cap.y - lay.cap.size*0.75 : gb.y - s*0.9, gy1 = gb.cap ? lay.cap.y + lay.cap.size*0.1 : gb.y + s*0.2;
  const sMin = gx0*NIB_DX + gy0*NIB_DY, sSpan = Math.max(1, gx1*NIB_DX + gy1*NIB_DY - sMin);
  const cover = mx.createImageData(w, h), paint = mx.createImageData(w, h), glow = mx.createImageData(w, h);
  const cd = cover.data, pd = paint.data, ld = glow.data;
  const nk = 1/FS, rise = ageS*70;
  const spread = gb.cap ? capSpread(ink, w, h, X0, Y0, lay.cap.ch) : null;
  let lit = false;
  for(let y=0, p=0; y<h; y++){
    const Y = Y0 + y, ny = ((Y*nk) & 255) << 8, fy = (((Y*nk*1.7 + rise) | 0) & 255) << 8;
    for(let x=0; x<w; x++, p+=4){
      const a = ink[p+3]/255, sa = soft[p>>2];
      if(sa < 0.004) continue;
      const X = X0 + x;
      const F = spread ? spread[p>>2] :
        clamp((X*NIB_DX + Y*NIB_DY - sMin)/sSpan, -0.2, 1.2)*0.74 + burnNoise[ny | ((X*nk) & 255)]*0.42 - 0.08;
      const la = ageS - T*F;
      if(la < 0){
        cd[p+3] = Math.min(255, sa*640);
        if(la > -PRE){
          const k = 1 + la/PRE, q = k*k, c = la > -CH ? 1 + la/CH : 0;
          pd[p] = lerp(120, 30, c); pd[p+1] = lerp(66, 14, c); pd[p+2] = lerp(28, 6, c);
          pd[p+3] = Math.min(1, (a*0.55 + sa*0.1)*q + (a*0.9 + sa*0.25)*c)*255;
          if(la > -HOT){
            const e = a*(1 + la/HOT)*0.3;
            ld[p] = 210; ld[p+1] = 90; ld[p+2] = 30; ld[p+3] = e*255;
            lit = true;
          }
        }
        continue;
      }
      if(la < HOT) cd[p+3] = Math.min(255, sa*640)*(1 - la/HOT);
      const fl = burnNoise[fy | (((X*nk*1.7) | 0) & 255)];
      const edge = clamp((1 - sa)*2.5, 0, 1);
      const heat = Math.min(1, Math.exp(-la/(C*(0.55 + 1.1*edge)))*(0.72 + 0.56*fl));
      const rim = la < RIM ? 1 - la/RIM : 0;
      if(heat < 0.01 && rim === 0) continue;
      lit = true;
      if(a > 0.004){
        const c = ramp(heat, SINGE), r = rim*0.8;
        pd[p] = lerp(c[0], 255, r); pd[p+1] = lerp(c[1], 246, r); pd[p+2] = lerp(c[2], 220, r);
        pd[p+3] = a*Math.min(1, heat*3 + rim)*255;
      }
      const c = ramp(heat, EMBER);
      const ea = Math.min(1, a*Math.min(1, heat*1.6) + sa*(rim*0.55 + heat*0.3));
      ld[p] = lerp(c[0], 255, rim); ld[p+1] = lerp(c[1], 240, rim); ld[p+2] = lerp(c[2], 205, rim);
      ld[p+3] = ea*255;
    }
  }
  return { R, X0, Y0, w, h, cover, paint, glow, lit };
}
let spreadBuf = new Float32Array(0), spreadKey = '';
function capSpread(ink, w, h, X0, Y0, ch){
  const key = w + ',' + h + ',' + X0 + ',' + Y0 + ',' + ch;
  if(key === spreadKey) return spreadBuf;
  const N = w*h;
  if(spreadBuf.length < N) spreadBuf = new Float32Array(N);
  const pts = [];
  let best = Infinity, bi = -1;
  for(let i=0;i<N;i++) if(ink[i*4+3] > 128){ pts.push(i); const v = (i % w) + (i/w|0)*1.4; if(v < best){ best = v; bi = i; } }
  if(!pts.length){ spreadBuf.fill(0, 0, N); spreadKey = key; return spreadBuf; }
  const rnd = mulberry32(ch.codePointAt(0)*7919 + w);
  const seeds = [bi, pts[(rnd()*pts.length)|0], pts[(rnd()*pts.length)|0]].map(i => [i % w, i/w|0]);
  const delay = [0, 0.12, 0.24];
  let dMax = 1;
  for(let y=0, i=0; y<h; y++) for(let x=0; x<w; x++, i++){
    let d = Infinity;
    for(let k=0;k<seeds.length;k++){ const dd = Math.hypot(x - seeds[k][0], y - seeds[k][1]) + delay[k]*w; if(dd < d) d = dd; }
    spreadBuf[i] = d;
    if(ink[i*4+3] > 128 && d > dMax) dMax = d;
  }
  const nk = 1/FS;
  for(let y=0, i=0; y<h; y++){
    const Y = Y0 + y;
    for(let x=0; x<w; x++, i++){
      const X = X0 + x;
      spreadBuf[i] = spreadBuf[i]/dMax*0.8 + (noiseAt(X*nk, Y*nk) - 0.5)*0.34 + (noiseAt(X*nk*2.3 + 31, Y*nk*2.3 + 97) - 0.5)*0.16 + 0.08;
    }
  }
  spreadKey = key;
  return spreadBuf;
}
let softBuf = new Float32Array(0), softTmp = new Float32Array(0);
function softMask(ink, w, h, r){
  const N = w*h;
  if(softBuf.length < N){ softBuf = new Float32Array(N); softTmp = new Float32Array(N); }
  for(let i=0;i<N;i++) softBuf[i] = ink[i*4+3]/255;
  const k = 1/(2*r + 1);
  for(let pass=0; pass<2; pass++){
    for(let y=0; y<h; y++){
      const row = y*w;
      let acc = 0;
      for(let x=-r; x<=r; x++) acc += x >= 0 && x < w ? softBuf[row + x] : 0;
      for(let x=0; x<w; x++){
        softTmp[row + x] = acc*k;
        const a = x - r, b = x + r + 1;
        if(a >= 0) acc -= softBuf[row + a];
        if(b < w) acc += softBuf[row + b];
      }
    }
    for(let x=0; x<w; x++){
      let acc = 0;
      for(let y=-r; y<=r; y++) acc += y >= 0 && y < h ? softTmp[y*w + x] : 0;
      for(let y=0; y<h; y++){
        softBuf[y*w + x] = acc*k;
        const a = y - r, b = y + r + 1;
        if(a >= 0) acc -= softTmp[a*w + x];
        if(b < h) acc += softTmp[b*w + x];
      }
    }
  }
  return softBuf;
}
const VAPOR_T = 0.85;
function vaporRects(lay, text, a, b, pad){
  const out = [];
  if(lay.cap && a === 0){
    const c = lay.cap;
    out.push({ x0: c.x - c.l - pad, y0: c.y - c.size - pad, x1: c.x + c.w + pad, y1: c.y + c.size*0.3 + pad, a: 0, b: 1, cap: true });
  }
  lay.lines.forEach(ln=>{
    const a0 = ln.start + (ln.skip||0);
    const s = Math.max(a, a0), e = Math.min(b, ln.end);
    if(e <= s || !text.slice(s, e).trim()) return;
    const xa = ln.xs[s - ln.start], xb = ln.xs[e - ln.start];
    out.push({ x0: Math.min(xa, xb) - pad, x1: Math.max(xa, xb) + pad, y0: ln.y - lay.size*INK_UP - pad, y1: ln.y + lay.size*INK_DN + pad, a: s, b: e, ln });
  });
  return out;
}
function addVapor(n, text, lay, a, b, stagger){
  const rs = vaporRects(lay, text, a, b, Math.ceil(5*FS));
  if(!rs.length) return;
  const pg = pages[n], t0 = performance.now();
  pg.vapor = pg.vapor || [];
  rs.forEach((r, k)=>{
    const X0 = Math.max(0, Math.floor(r.x0)), Y0 = Math.max(0, Math.floor(r.y0));
    const w = Math.min(PAGE_W, Math.ceil(r.x1)) - X0, h = Math.min(PAGE_H, Math.ceil(r.y1)) - Y0;
    if(w < 1 || h < 1) return;
    const sx = burnScratch('v', w, h);
    sx.translate(-X0, -Y0);
    sx.fillStyle = '#fff';
    if(r.cap){ sx.font = capFont(lay.f, lay.cap.size); sx.fillText(lay.cap.ch, lay.cap.x, lay.cap.y); }
    else{ sx.font = fontCss(lay.f, lay.size); fillLine(sx, text.slice(r.a, r.b), r.ln.xs[r.a - r.ln.start], r.ln); }
    const ink = sx.getImageData(0, 0, w, h).data;
    const soft = softMask(ink, w, h, Math.max(1, Math.round(1.8*FS)));
    const px = new Uint8ClampedArray(w*h*4);
    for(let i=0, p=0; i<w*h; i++, p+=4){
      const ia = ink[p+3]/255*0.86, ha = Math.min(1, soft[i]*1.4)*0.26;
      const al = ia + ha*(1 - ia);
      if(al < 0.01) continue;
      const t = ia/al;
      px[p] = lerp(132, 62, t); px[p+1] = lerp(90, 40, t); px[p+2] = lerp(52, 22, t);
      px[p+3] = al*255;
    }
    pg.vapor.push({ X0, Y0, w, h, px, t0: t0 + k*stagger*1000, out: false, lay, text, a: r.a, b: r.b });
  });
  while(pg.vapor.length > 80) pg.vapor.shift();
  burning.add(n);
}
function drawVapor(ctx, n, now){
  const pg = pages[n], lights = [];
  if(!burnNoise) burnNoise = fbm(256, 256, 12, 12, 3, 4242);
  const nk = 1/FS;
  pg.vapor = pg.vapor.filter(v=>{
    const tau = (now - v.t0)/1000;
    if(tau >= VAPOR_T) return false;
    const { X0, Y0, w, h, px } = v;
    const sx = burnScratch('w', w, h);
    if(tau < 0){
      const img = sx.createImageData(w, h); img.data.set(px);
      sx.putImageData(img, 0, 0);
      ctx.drawImage(burnCv.w, 0, 0, w, h, X0, Y0, w, h);
      return true;
    }
    if(!v.out){ v.out = true; vaporRise(n, v); }
    const paint = sx.createImageData(w, h), glow = sx.createImageData(w, h);
    const pd = paint.data, ld = glow.data;
    const warm = smooth(clamp(tau/0.2, 0, 1)), drift = tau*40;
    for(let y=0, p=0; y<h; y++){
      const Y = Y0 + y, ny = ((Y*nk) & 255) << 8, my = (((Y*nk*2.2 + drift) | 0) & 255) << 8, fy = y/h;
      for(let x=0; x<w; x++, p+=4){
        const a = px[p+3];
        if(a < 2) continue;
        const X = X0 + x;
        const F = burnNoise[ny | ((X*nk) & 255)]*0.62 + fy*0.38 + (burnNoise[my | (((X*nk*2.2) | 0) & 255)] - 0.5)*0.2;
        const tg = 0.2 + F*0.5;
        if(tau >= tg + 0.07) continue;
        const rem = tau < tg ? 1 : 1 - (tau - tg)/0.07;
        const rim = tau > tg - 0.09 ? clamp(1 - (tg - tau)/0.09, 0, 1) : 0;
        const g = Math.min(1, warm*0.55 + rim*0.45);
        pd[p] = lerp(px[p], 255, g); pd[p+1] = lerp(px[p+1], 222, g); pd[p+2] = lerp(px[p+2], 160, g);
        pd[p+3] = a*rem;
        const e = (a/255)*(warm*0.28 + rim*0.95)*rem;
        ld[p] = lerp(255, 255, rim); ld[p+1] = lerp(196, 238, rim); ld[p+2] = lerp(110, 200, rim); ld[p+3] = Math.min(255, e*255);
      }
    }
    sx.putImageData(paint, 0, 0);
    ctx.drawImage(burnCv.w, 0, 0, w, h, X0, Y0, w, h);
    lights.push({ R: { rects: [[X0, Y0, w, h]] }, X0, Y0, w, h, glow, lit: true });
    return true;
  });
  return lights;
}
function vaporRise(n, v){
  const L = v.b - v.a, step = L > 12 ? 3 : 1;
  for(let i=v.a; i<v.b; i+=step){
    emitSmoke(n, v.lay, v.text, i, 1, true);
    if(Math.random() < 0.5) emitSparks(n, v.lay, v.text, i, 1, true);
  }
}
function putScratch(k, img, w, h){
  const x = burnScratch(k, w, h);
  x.putImageData(img, 0, 0);
  return burnCv[k];
}
let inkMask = null, inkTint = null, inkLayer = null, singeLayer = null, singeMask = null;
function inkTextures(){
  if(inkMask) return;
  const W = PAGE_W, H = PAGE_H;
  const fine = fbm(W>>1, H>>1, 90, 120, 2, 3131);
  const blot = upsample(fbm(W>>4, H>>4, 6, 8, 3, 717), W>>4, H>>4, W>>1, H>>1);
  const m = cv(W>>1, H>>1), mx = m.getContext('2d'), md = mx.createImageData(W>>1, H>>1);
  const t = cv(W>>1, H>>1), tx = t.getContext('2d'), td = tx.createImageData(W>>1, H>>1);
  for(let i=0,p=0;i<fine.length;i++,p+=4){
    md.data[p] = md.data[p+1] = md.data[p+2] = 0;
    md.data[p+3] = clamp(0.80 + (fine[i]-0.5)*0.5 + (blot[i]-0.5)*0.25, 0.55, 1)*255;
    const b = clamp((blot[i]-0.45)*2.2, 0, 1);
    td.data[p] = 92; td.data[p+1] = 52; td.data[p+2] = 22; td.data[p+3] = b*120;
  }
  mx.putImageData(md, 0, 0); tx.putImageData(td, 0, 0);
  inkMask = m; inkTint = t;
  inkLayer = cv(W, H);
  singeLayer = cv(W, H);
  const sw = W>>2, sh = H>>2, sn = fbm(sw, sh, 5, 7, 3, 919);
  singeMask = cv(sw, sh);
  const smx = singeMask.getContext('2d'), sd = smx.createImageData(sw, sh);
  for(let i=0,p=0;i<sn.length;i++,p+=4) sd.data[p+3] = clamp(0.3 + (sn[i]-0.5)*2.4, 0.12, 1)*255;
  smx.putImageData(sd, 0, 0);
}
function drawInitial(ctx, lay){
  const c = lay.cap;
  ctx.save();
  ctx.font = capFont(lay.f, c.size);
  ctx.fillStyle = INK; ctx.strokeStyle = INK;
  ctx.fillText(c.ch, c.x, c.y);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth = Math.max(1, c.size*0.012);
  ctx.globalAlpha = 0.85;
  ctx.translate(c.size*0.012, -c.size*0.012);
  ctx.strokeText(c.ch, c.x, c.y);
  ctx.restore();
}
function drawInkBase(ctx, text, lay, hide){
  const { lines, cap, f, size, lh } = lay;
  inkTextures();
  const ix = inkLayer.getContext('2d');
  ix.clearRect(0, 0, PAGE_W, PAGE_H);
  ix.fillStyle = INK;
  ix.font = fontCss(f, size);
  lines.forEach(ln=>{
    if(ln.y + size*0.3 > lay.box.bottom + lh) return;
    const a0 = ln.start + (ln.skip||0);
    if(!hide){ const s = text.slice(a0, ln.end); if(s) fillLine(ix, s, ln.x0, ln); return; }
    [[a0, Math.min(ln.end, hide.a)], [Math.max(a0, hide.b), ln.end]].forEach(([a, b])=>{
      if(b > a) fillLine(ix, text.slice(a, b), ln.xs[a - ln.start], ln);
    });
  });
  if(cap && !(hide && hide.a === 0)) drawInitial(ix, lay);
  ix.globalCompositeOperation = 'destination-in';
  ix.drawImage(inkMask, 0, 0, PAGE_W, PAGE_H);
  ix.globalCompositeOperation = 'source-atop';
  ix.drawImage(inkTint, 0, 0, PAGE_W, PAGE_H);
  ix.globalCompositeOperation = 'source-over';
  const sx = singeLayer.getContext('2d');
  sx.clearRect(0, 0, PAGE_W, PAGE_H);
  sx.filter = `blur(${(3.6*FS).toFixed(2)}px) brightness(2.5)`;
  sx.drawImage(inkLayer, 0, 0);
  sx.filter = 'none';
  sx.globalCompositeOperation = 'destination-in';
  sx.drawImage(singeMask, 0, 0, PAGE_W, PAGE_H);
  sx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.62;
  ctx.drawImage(singeLayer, 0, 0);
  ctx.globalAlpha = 0.3;
  ctx.filter = `blur(${(1.1*FS).toFixed(2)}px) brightness(1.6)`;
  ctx.drawImage(inkLayer, 0, 0);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(inkLayer, 0, 0);
  ctx.restore();
  const o = 1.1*FS;
  sx.clearRect(0, 0, PAGE_W, PAGE_H);
  sx.drawImage(inkLayer, 0, 0);
  sx.globalCompositeOperation = 'destination-out';
  sx.drawImage(inkLayer, -o, -o);
  sx.globalCompositeOperation = 'source-in';
  sx.fillStyle = 'rgb(214,170,112)';
  sx.fillRect(0, 0, PAGE_W, PAGE_H);
  sx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.32;
  ctx.filter = `blur(${(0.5*FS).toFixed(2)}px)`;
  ctx.drawImage(singeLayer, 0, 0);
  ctx.restore();
}
function drawInkOverlay(ctx, text, lay, sel, born, now, bg, caretA){
  const { lines, size, lh } = lay;
  if(sel && sel.a !== sel.b){
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(232,196,120,.7)';
    lines.forEach(ln=>{
      const a = Math.max(sel.a, ln.start), b = Math.min(sel.b, ln.end);
      if(a >= b) return;
      const xa = ln.xs[a-ln.start], xb = ln.xs[b-ln.start];
      ctx.fillRect(Math.min(xa, xb), ln.y - size*0.86, Math.abs(xb - xa), lh*0.98);
    });
    ctx.restore();
  }
  const burns = [];
  if(born && now && bg){
    eachBurning(lay, text, born, now, (gb, i, ageS)=>{
      const b = burnLetter(lay, text, born, now, gb, i, ageS);
      if(!b) return;
      burns.push(b);
      const { R, X0, Y0, w, h } = b;
      const sx = burnScratch('s', w, h);
      sx.drawImage(bg, X0, Y0, w, h, 0, 0, w, h);
      sx.globalCompositeOperation = 'destination-in';
      sx.drawImage(putScratch('c', b.cover, w, h), 0, 0);
      ctx.save();
      clipRects(ctx, R);
      ctx.drawImage(burnCv.s, 0, 0, w, h, X0, Y0, w, h);
      ctx.drawImage(putScratch('p', b.paint, w, h), 0, 0, w, h, X0, Y0, w, h);
      ctx.restore();
    });
  }
  if(sel && sel.caret){
    const c = caretXY(lay, sel.b);
    ctx.save();
    ctx.globalAlpha = caretA === undefined ? 1 : caretA;
    ctx.fillStyle = INK;
    caretPath(ctx, c.x, c.y, size, 2.9*FS);
    ctx.restore();
  }
  return burns;
}
function caretPath(ctx, x, y, size, w){
  const top = y - size*0.86, bot = y + size*0.2, mid = (top + bot)/2;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.quadraticCurveTo(x + w, mid, x, bot);
  ctx.quadraticCurveTo(x - w, mid, x, top);
  ctx.fill();
}
function caretBreath(){
  const t = Math.max(0, blinkPhase - 0.5);
  return 0.6 + 0.4*Math.cos(t*Math.PI*2/1.6);
}
function drawGlow(ctx, lay, burns, caret, caretA){
  const k = 0.5;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.scale(k, k);
  let any = false;
  burns.forEach(b=>{
    if(!b.lit) return;
    any = true;
    const { R, X0, Y0, w, h } = b;
    ctx.save();
    clipRects(ctx, R);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(putScratch('g', b.glow, w, h), 0, 0, w, h, X0, Y0, w, h);
    ctx.restore();
  });
  if(caret){
    ctx.save();
    ctx.globalAlpha = 0.05 + 0.08*(caretA === undefined ? 1 : caretA);
    ctx.fillStyle = 'rgb(255,170,80)';
    caretPath(ctx, caret.x, caret.y, lay.size, 1.6*FS);
    ctx.restore();
    any = true;
  }
  ctx.restore();
  return any;
}

export {
  addVapor, BURN_CAP, BURN_T, burnNoise, caretBreath, CHAR, COOL_T, drawGlow,
  drawInkBase, drawInkOverlay, drawVapor, EMBER, GLOW_T, NIB_DX, NIB_DY, ramp,
  setBurnNoise, SINGE, softMask
};
