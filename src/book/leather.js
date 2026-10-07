/* the leather scans dyed and tooled onto the boards, the spine and the doublures */
import { clamp, lerp, smooth, fbm, upsample, cv, tex, crackCanvas, fieldFromCanvas } from '../lib/textures.js';
import { CH, CW } from '../core/config.js';
import { matCoverBack, matCoverFront, matLeatherEdge } from './materials.js';
import { EP_H, EP_HINGE, EP_X0, EP_X1, HINGE_U, matEndpaper } from './paper.js';
import { spiralPath } from './print.js';
import { paintSpine } from './spine.js';
import { shed } from '../assets/loaders.js';

/* navy-dyed leather from the scan's luminance, so the grain and creases survive */
function dyeLeather(img, size, pal){
  const c = cv(size, size), x = c.getContext('2d');
  x.drawImage(img, 0, 0, size, size);
  const d = x.getImageData(0, 0, size, size), p = d.data;
  const hist = new Uint32Array(256);
  for(let i=0;i<p.length;i+=4) hist[(p[i]*0.3 + p[i+1]*0.59 + p[i+2]*0.11)|0]++;
  const pct = q=>{ let acc = 0, tot = p.length/4; for(let i=0;i<256;i++){ acc += hist[i]; if(acc >= tot*q) return i/255; } return 1; };
  const lo = pct(0.02), hi = pct(0.98);
  const [D, Mv, Hl] = pal || [[3, 8, 14], [12, 30, 54], [50, 80, 108]];
  for(let i=0;i<p.length;i+=4){
    const l = clamp(((p[i]*0.3 + p[i+1]*0.59 + p[i+2]*0.11)/255 - lo)/((hi-lo)||1), 0, 1);
    const t = Math.pow(l, 1.15);
    for(let k=0;k<3;k++) p[i+k] = t < 0.7 ? lerp(D[k], Mv[k], t/0.7) : lerp(Mv[k], Hl[k], (t-0.7)/0.3);
  }
  x.putImageData(d, 0, 0);
  return c;
}
function tiled(src, W, H, tile){
  const c = cv(W, H), x = c.getContext('2d');
  for(let y=0;y<H;y+=tile) for(let xx=0;xx<W;xx+=tile) x.drawImage(src, xx, y, tile, tile);
  return c;
}
/* one board's maps: tiled grain, worn edges, and the leather pressed down and
   darkened where the tool bit around the gilt */
function composeBoard(dyed, norImg, roughImg, mask, flipY){
  const W = 1024, H = Math.round(W*CH/CW), tile = 560;
  const col = tiled(dyed, W, H, tile);
  const nor = tiled(norImg, W, H, tile);
  const rgh = tiled(roughImg, W, H, tile);
  const mk = (blur)=>{
    const c = cv(W, H), x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0,0,W,H);
    if(blur) x.filter = `blur(${blur}px)`;
    if(flipY){ x.translate(0, H); x.scale(1, -1); }
    x.drawImage(mask, 0, 0, W, H);
    return x.getImageData(0,0,W,H).data;
  };
  const sharp = mk(0), wide = mk(5), tight = mk(1.5);
  const cd = col.getContext('2d').getImageData(0,0,W,H), cp = cd.data;
  const nd = nor.getContext('2d').getImageData(0,0,W,H), np = nd.data;
  const rd = rgh.getContext('2d').getImageData(0,0,W,H), rp = rd.data;
  const wear = upsample(fbm(W>>3, H>>3, 3, 4, 3, 77), W>>3, H>>3, W, H);
  const crk = fieldFromCanvas(crackCanvas(W, H, flipY ? 4111 : 2024, 1.15));
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const i = y*W + x, p = i*4;
      const pressed = wide[p]/255, s = sharp[p]/255;
      const ex = Math.min(x, W-1-x)/W, ey = Math.min(y, H-1-y)/H;
      const edge = 1 - smooth(clamp(Math.min(ex, ey)/0.06, 0, 1));
      const rub = clamp((wear[i]-0.48)*2.2, 0, 1)*0.6 + edge*0.65;
      for(let k=0;k<3;k++){
        let v = cp[p+k]*(1 - pressed*0.45)*(1 - Math.min(1, crk[i]*1.6)*0.72);
        v = lerp(v, v*1.55 + 10, rub*0.6);
        v = lerp(v, [120, 86, 34][k], s*0.35);
        cp[p+k] = clamp(v, 0, 255);
      }
      /* emboss: the tooled groove around each line of gilt */
      const xm = Math.max(0,x-1), xp = Math.min(W-1,x+1), ym = Math.max(0,y-1), yp = Math.min(H-1,y+1);
      const dx = (tight[(y*W+xp)*4] - tight[(y*W+xm)*4])/255;
      const dy = (tight[(yp*W+x)*4] - tight[(ym*W+x)*4])/255;
      const cdx = (crk[y*W+xp] - crk[y*W+xm]), cdy = (crk[yp*W+x] - crk[ym*W+x]);
      let nx = (np[p]/255*2-1) + dx*1.6 + cdx*1.1, ny = (np[p+1]/255*2-1) - dy*1.6 - cdy*1.1, nz = np[p+2]/255*2-1;
      const l = Math.hypot(nx, ny, nz) || 1;
      np[p] = (nx/l*0.5+0.5)*255; np[p+1] = (ny/l*0.5+0.5)*255; np[p+2] = (nz/l*0.5+0.5)*255;
      rp[p] = rp[p+1] = rp[p+2] = clamp(100 + rp[p]*0.55 - pressed*30 - rub*20 + Math.min(1, crk[i]*1.6)*40, 40, 240);
    }
  }
  col.getContext('2d').putImageData(cd, 0, 0);
  nor.getContext('2d').putImageData(nd, 0, 0);
  rgh.getContext('2d').putImageData(rd, 0, 0);
  return { col, nor, rgh };
}
function setBoardMaps(mat, maps){
  const map = shed(tex(maps.col, {srgb:true, wrap:false}));
  const nrm = shed(tex(maps.nor, {wrap:false}));
  const rgh = shed(tex(maps.rgh, {wrap:false}));
  [map, nrm, rgh].forEach(t=>{ t.repeat.set(1/CW, 1/CH); t.offset.set(0, 0.5); });
  mat.map = map; mat.normalMap = nrm; mat.roughnessMap = rgh;
  mat.color.set(0xffffff); mat.roughness = 1;
  mat.needsUpdate = true;
}
/* gilt tooling of the doublure, drawn in book units from the panel's top left */
/* an open-work leaf: outline, midrib and a few side veins, the way a tooled
   leaf reads in gold, instead of a solid blot */
function laceLeaf(g, x, y, ang, L, W, lw){
  g.save(); g.translate(x, y); g.rotate(ang);
  g.lineWidth = lw;
  g.beginPath(); g.moveTo(0, 0);
  g.bezierCurveTo(W, -L*0.3, W*0.7, -L*0.75, 0, -L);
  g.bezierCurveTo(-W*0.7, -L*0.75, -W, -L*0.3, 0, 0);
  g.stroke();
  g.lineWidth = lw*0.7;
  g.beginPath(); g.moveTo(0, -L*0.05); g.lineTo(0, -L*0.85);
  for(const t of [0.3, 0.5, 0.68]){ const yy = -L*t, ww = W*0.55*(1 - t*0.6); g.moveTo(0, yy); g.lineTo(ww, yy - L*0.12); g.moveTo(0, yy); g.lineTo(-ww, yy - L*0.12); }
  g.stroke();
  g.restore();
}
function doublureGilt(g, w, h){
  const rule = (i, lw)=>{ g.lineWidth = lw; g.strokeRect(i, i, w - 2*i, h - 2*i); };
  rule(0.055, 0.013); rule(0.08, 0.005);
  const dots = (i, step, r)=>{
    const run = (ax, ay, bx, by)=>{ const L = Math.hypot(bx-ax, by-ay), n = Math.round(L/step);
      for(let k=0;k<=n;k++){ g.beginPath(); g.arc(ax + (bx-ax)*k/n, ay + (by-ay)*k/n, r, 0, 7); g.fill(); } };
    run(i, i, w-i, i); run(i, h-i, w-i, h-i); run(i, i, i, h-i); run(w-i, i, w-i, h-i);
  };
  dots(0.108, 0.034, 0.0065);
  rule(0.14, 0.005); rule(0.163, 0.012);
  const ci = 0.163;
  /* a filigree corner piece: two scrolled arms running along the panel's edges,
     each budding small leaves and tendrils, an acanthus spray on the diagonal */
  const corner = (x, y, sx, sy)=>{
    g.save(); g.translate(x, y); g.scale(sx, sy); g.scale(1.9, 1.9);
    const lozenge = (cx, cy, r)=>{ g.beginPath(); g.moveTo(cx, cy-r); g.lineTo(cx+r, cy); g.lineTo(cx, cy+r); g.lineTo(cx-r, cy); g.closePath(); g.fill(); };
    const bead = (cx, cy, r)=>{ g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); };
    lozenge(0.03, 0.03, 0.02);
    for(const sw of [false, true]){
      const P = (px, py)=> sw ? [py, px] : [px, py];
      const bz = (a, b, c, d, lw)=>{ g.lineWidth = lw; g.beginPath(); g.moveTo(...P(...a)); g.bezierCurveTo(...P(...b), ...P(...c), ...P(...d)); g.stroke(); };
      const sp = (cx, cy, r0, r1, a0, turns, cw, lw)=>{ g.lineWidth = lw; const [X, Y] = P(cx, cy); g.beginPath(); spiralPath(g, X, Y, r0, r1, sw ? Math.PI/2 - a0 : a0, turns, sw ? -cw : cw); g.stroke(); };
      const leaf = (px, py, ang, L, Wd)=>{ const [X, Y] = P(px, py); laceLeaf(g, X, Y, sw ? Math.PI/2 - ang + Math.PI : ang, L, Wd, 0.0028); };
      /* the long arm with its end scroll */
      bz([0.05, 0.026], [0.14, 0.004], [0.26, 0.05], [0.36, 0.034], 0.0062);
      sp(0.385, 0.058, 0.026, 0.003, -Math.PI*0.6, 1.4, 1, 0.0052);
      /* a second, inner arm curling back toward the corner */
      bz([0.08, 0.05], [0.16, 0.05], [0.21, 0.09], [0.18, 0.13], 0.005);
      sp(0.158, 0.118, 0.02, 0.003, -Math.PI*0.05, 1.3, 1, 0.0042);
      /* tendrils off the long arm */
      bz([0.2, 0.031], [0.22, 0.055], [0.25, 0.075], [0.235, 0.092], 0.0036);
      sp(0.222, 0.085, 0.013, 0.002, 0.2, 1.2, -1, 0.0032);
      bz([0.3, 0.04], [0.31, 0.012], [0.33, 0.004], [0.345, 0.008], 0.0032);
      /* small leaves budding along the arms */
      leaf(0.12, 0.016, Math.PI*0.62, 0.05, 0.015);
      leaf(0.27, 0.046, Math.PI*0.42, 0.045, 0.013);
      leaf(0.33, 0.036, Math.PI*0.85, 0.04, 0.012);
      leaf(0.19, 0.075, Math.PI*0.95, 0.045, 0.013);
      [[0.43, 0.026, 0.0065], [0.405, 0.012, 0.004], [0.29, 0.1, 0.005], [0.245, 0.012, 0.004], [0.11, 0.095, 0.0045]].forEach(([px, py, r])=>bead(...P(px, py), r));
    }
    /* acanthus spray on the diagonal */
    laceLeaf(g, 0.05, 0.05, Math.PI*0.75, 0.17, 0.036, 0.0032);
    laceLeaf(g, 0.062, 0.062, Math.PI*0.75 - 0.66, 0.105, 0.024, 0.0028);
    laceLeaf(g, 0.062, 0.062, Math.PI*0.75 + 0.66, 0.105, 0.024, 0.0028);
    g.lineWidth = 0.004;
    [-1, 1].forEach(d=>{ g.beginPath(); spiralPath(g, d > 0 ? 0.2 : 0.13, d > 0 ? 0.13 : 0.2, 0.014, 0.002, d > 0 ? Math.PI*0.25 : Math.PI*1.25, 1.1, d); g.stroke(); });
    bead(0.205, 0.205, 0.008); bead(0.235, 0.235, 0.005);
    g.restore();
  };
  corner(ci, ci, 1, 1); corner(w-ci, ci, -1, 1); corner(ci, h-ci, 1, -1); corner(w-ci, h-ci, -1, -1);
  /* small fleurons at the middle of each side of the panel */
  const mid = (x, y, a)=>{
    g.save(); g.translate(x, y); g.rotate(a);
    laceLeaf(g, 0, 0.012, Math.PI, 0.13, 0.032, 0.0034);
    laceLeaf(g, 0, 0.012, Math.PI - 0.75, 0.085, 0.022, 0.003);
    laceLeaf(g, 0, 0.012, Math.PI + 0.75, 0.085, 0.022, 0.003);
    g.lineWidth = 0.0055;
    [-1, 1].forEach(d=>{ g.beginPath(); spiralPath(g, d*0.05, 0.03, 0.022, 0.003, d > 0 ? Math.PI : 0, 1.15, d); g.stroke(); });
    g.restore();
  };
  mid(w/2, ci, 0); mid(w/2, h-ci, Math.PI); mid(ci, h/2, -Math.PI/2); mid(w-ci, h/2, Math.PI/2);
}
function buildDoublure(img){
  const SWU = EP_X1 - EP_X0 + EP_HINGE;
  const W = 1280, H = Math.round(W*EP_H/SWU), ppu = W/SWU, x0 = HINGE_U*W;
  const tile = Math.round(ppu*1.6);
  const dyed = dyeLeather(img.leaAlbedo, 1024, [[8, 5, 3], [30, 20, 13], [84, 60, 40]]);
  const col = tiled(dyed, W, H, tile), nor = tiled(img.leaNor, W, H, tile), rgh = tiled(img.leaRough, W, H, tile);
  const mask = cv(W, H), g = mask.getContext('2d');
  g.translate(x0, 0); g.scale(ppu, ppu);
  g.fillStyle = g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
  doublureGilt(g, EP_X1 - EP_X0, EP_H);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const blurOf = px=>{ const c = cv(W, H), x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, W, H); x.filter = `blur(${px}px)`; x.drawImage(mask, 0, 0); return x.getImageData(0, 0, W, H).data; };
  const sharp = blurOf(0), tight = blurOf(1.4), wide = blurOf(4);
  const wear = fbm(W>>1, H>>1, 40, 50, 3, 3131);
  const cd = col.getContext('2d').getImageData(0, 0, W, H), cp = cd.data;
  const nd = nor.getContext('2d').getImageData(0, 0, W, H), np = nd.data;
  const rd = rgh.getContext('2d').getImageData(0, 0, W, H), rp = rd.data;
  const pbr = cv(W, H), pc = pbr.getContext('2d'), pd = pc.createImageData(W, H), pp = pd.data;
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const i = y*W + x, p = i*4;
    const wv = wear[((y>>1)*(W>>1)) + (x>>1)];
    const gm = sharp[p]/255*(wv > 0.74 ? 0.6 : 1), burn = wide[p]/255;
    const lum = 0.86 + (wv - 0.5)*0.3;
    const gold = [214*lum, 168*lum, 82*lum];
    for(let k=0;k<3;k++){
      const leather = cp[p+k]*(1 - burn*0.35);
      cp[p+k] = clamp(lerp(leather, gold[k], gm), 0, 255);
    }
    const xm = Math.max(0, x-1), xp = Math.min(W-1, x+1), ym = Math.max(0, y-1), yp = Math.min(H-1, y+1);
    const dx = (tight[(y*W+xp)*4] - tight[(y*W+xm)*4])/255, dy = (tight[(yp*W+x)*4] - tight[(ym*W+x)*4])/255;
    let nx = (np[p]/255*2-1)*(1 - gm*0.8) + dx*1.4, ny = (np[p+1]/255*2-1)*(1 - gm*0.8) - dy*1.4, nz = np[p+2]/255*2-1;
    const l = Math.hypot(nx, ny, nz) || 1;
    np[p] = (nx/l*0.5+0.5)*255; np[p+1] = (ny/l*0.5+0.5)*255; np[p+2] = (nz/l*0.5+0.5)*255;
    pp[p] = 0; pp[p+1] = lerp(clamp(90 + rp[p]*0.55, 60, 220), 70, gm); pp[p+2] = gm*255; pp[p+3] = 255;
  }
  col.getContext('2d').putImageData(cd, 0, 0);
  nor.getContext('2d').putImageData(nd, 0, 0);
  pc.putImageData(pd, 0, 0);
  const pbrTex = shed(tex(pbr, { wrap:false }));
  matEndpaper.map = shed(tex(col, { srgb:true, wrap:false }));
  matEndpaper.normalMap = shed(tex(nor, { wrap:false }));
  matEndpaper.normalScale.set(0.8, 0.8);
  matEndpaper.roughnessMap = pbrTex; matEndpaper.metalnessMap = pbrTex;
  matEndpaper.color.set(0xffffff); matEndpaper.roughness = 1; matEndpaper.metalness = 1;
  matEndpaper.envMapIntensity = 1.0;
  matEndpaper.needsUpdate = true;
}
function applyLeather(img){
  const dyed = dyeLeather(img.leaAlbedo, 1024);
  setBoardMaps(matCoverFront, composeBoard(dyed, img.leaNor, img.leaRough, img.maskFront, false));
  setBoardMaps(matCoverBack,  composeBoard(dyed, img.leaNor, img.leaRough, img.maskBack, true));
  const tileMap = t=>{ t.repeat.set(2.4, 2.4); return t; };
  matLeatherEdge.map = tileMap(shed(tex(dyed, {srgb:true})));
  matLeatherEdge.normalMap = tileMap(shed(tex(img.leaNor)));
  matLeatherEdge.roughnessMap = tileMap(shed(tex(img.leaRough)));
  matLeatherEdge.color.set(0xffffff); matLeatherEdge.roughness = 1;
  matLeatherEdge.needsUpdate = true;
  paintSpine(dyed, img.leaNor, img.leaRough);
  buildDoublure(img);
}

export {
  applyLeather
};
