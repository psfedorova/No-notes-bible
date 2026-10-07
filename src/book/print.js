/* what is printed on a leaf: border, gilt, sigil watermark, the title page */
import * as THREE from 'three';
import { clamp, mulberry32, fbm, upsample, cv, tex } from '../lib/textures.js';
import { PAGE_H, PAGE_W, SC } from '../core/config.js';
import { edgeTone, parch } from './paper.js';

const PINK = a => `rgba(64,38,14,${a})`;
function spiralPath(ctx, cx, cy, r0, r1, a0, turns, cw){
  const n = Math.max(10, Math.round(turns*28));
  for(let i=0;i<=n;i++){
    const t = i/n, a = a0 + cw*turns*Math.PI*2*t, r = r0 + (r1-r0)*t;
    const x = cx + Math.cos(a)*r, y = cy + Math.sin(a)*r;
    i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
  }
}
function inkLeaf(ctx, x, y, ang, L, W){
  ctx.save(); ctx.translate(x,y); ctx.rotate(ang);
  ctx.beginPath(); ctx.moveTo(0,0);
  ctx.bezierCurveTo(W, -L*0.3, W*0.7, -L*0.75, 0, -L);
  ctx.bezierCurveTo(-W*0.7, -L*0.75, -W, -L*0.3, 0, 0);
  ctx.fill(); ctx.stroke();
  ctx.restore();
}
/* engraved border after the reference: double rules, a chain band, corner
   scrollwork and lozenge medallions at the middle of each side */
function drawOrnateBorder(ctx){
  ctx.save();
  ctx.scale(SC,SC);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const X0 = 15, Y0 = 15, X1 = 325, Y1 = 443;
  const rule = (i, w, a)=>{ ctx.strokeStyle = PINK(a); ctx.lineWidth = w; ctx.strokeRect(X0+i, Y0+i, X1-X0-2*i, Y1-Y0-2*i); };
  rule(0, 1.25, .82); rule(2.6, .45, .7);
  rule(9.8, .45, .7); rule(12.2, .95, .8);
  /* chain band: alternating lozenges and pearls */
  const band = (ax, ay, bx, by)=>{
    const L = Math.hypot(bx-ax, by-ay), n = Math.floor(L/6.2);
    for(let k=1;k<n;k++){
      const t = k/n; if(Math.abs(t-0.5) < 2.2/n) continue;
      const x = ax + (bx-ax)*t, y = ay + (by-ay)*t;
      if(k%2){
        ctx.fillStyle = PINK(.75);
        ctx.beginPath(); ctx.moveTo(x, y-2.0); ctx.lineTo(x+1.5, y); ctx.lineTo(x, y+2.0); ctx.lineTo(x-1.5, y); ctx.closePath(); ctx.fill();
      }else{
        ctx.fillStyle = PINK(.6); ctx.beginPath(); ctx.arc(x, y, 0.75, 0, 7); ctx.fill();
      }
    }
  };
  const m = 6.2;
  band(X0+m, Y0+m, X1-m, Y0+m); band(X0+m, Y1-m, X1-m, Y1-m);
  band(X0+m, Y0+m, X0+m, Y1-m); band(X1-m, Y0+m, X1-m, Y1-m);
  /* medallions on the band at mid-sides */
  const medal = (x, y, rotA)=>{
    ctx.save(); ctx.translate(x,y); ctx.rotate(rotA);
    ctx.clearRect(-9,-5,18,10);
    ctx.strokeStyle = PINK(.85); ctx.lineWidth = .8; ctx.fillStyle = PINK(.18);
    ctx.beginPath(); ctx.moveTo(0,-5.4); ctx.lineTo(5,0); ctx.lineTo(0,5.4); ctx.lineTo(-5,0); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = PINK(.85); ctx.beginPath(); ctx.arc(0,0,1.3,0,7); ctx.fill();
    ctx.lineWidth = .6;
    [-1,1].forEach(s=>{ ctx.beginPath(); spiralPath(ctx, s*8.3, 0, 2.8, 0.5, s>0?Math.PI:0, 1.2, s); ctx.stroke(); });
    ctx.restore();
  };
  medal((X0+X1)/2, Y0+m, 0); medal((X0+X1)/2, Y1-m, 0);
  medal(X0+m, (Y0+Y1)/2, Math.PI/2); medal(X1-m, (Y0+Y1)/2, Math.PI/2);
  /* corner scrollwork inside the inner rule */
  const corner = (x, y, sx, sy)=>{
    ctx.save(); ctx.translate(x,y); ctx.scale(sx,sy);
    ctx.strokeStyle = PINK(.82); ctx.fillStyle = PINK(.55); ctx.lineWidth = .7;
    ctx.clearRect(-m-2.2,-m-2.2,4.4,4.4);
    ctx.fillStyle = PINK(.7);
    ctx.beginPath(); ctx.moveTo(-m,-m-2.4); ctx.lineTo(-m+2.4,-m); ctx.lineTo(-m,-m+2.4); ctx.lineTo(-m-2.4,-m); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(1.5, 30); ctx.bezierCurveTo(2, 16, 8, 8, 18, 6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(30, 1.5); ctx.bezierCurveTo(16, 2, 8, 8, 6, 18); ctx.stroke();
    ctx.beginPath(); spiralPath(ctx, 21, 9, 4.2, 0.6, Math.PI*1.1, 1.3, 1); ctx.stroke();
    ctx.beginPath(); spiralPath(ctx, 9, 21, 4.2, 0.6, Math.PI*0.4, 1.3, -1); ctx.stroke();
    ctx.lineWidth = .5; ctx.fillStyle = PINK(.45);
    inkLeaf(ctx, 7, 7, Math.PI*0.75, 11, 3.2);
    inkLeaf(ctx, 7, 7, Math.PI*0.55, 7.5, 2.2);
    inkLeaf(ctx, 7, 7, Math.PI*0.95, 7.5, 2.2);
    ctx.fillStyle = PINK(.8); ctx.beginPath(); ctx.arc(4.2, 4.2, 1.6, 0, 7); ctx.fill();
    [[26,4],[4,26],[14,15]].forEach(([px,py])=>{ ctx.beginPath(); ctx.arc(px,py,.7,0,7); ctx.fill(); });
    ctx.restore();
  };
  const ci = 13.6;
  corner(X0+ci, Y0+ci, 1, 1); corner(X1-ci, Y0+ci, -1, 1); corner(X0+ci, Y1-ci, 1, -1); corner(X1-ci, Y1-ci, -1, -1);
  ctx.restore();
}
/* the border is printed once into its own sheet and worn there: the ink is
   thinned and broken where an old impression lost it, then laid on by multiply */
let borderCanvas = null;
function borderArt(){
  if(borderCanvas) return borderCanvas;
  const c = cv(PAGE_W, PAGE_H), ctx = c.getContext('2d');
  ctx.filter = `blur(${(0.35*SC).toFixed(2)}px)`;
  drawOrnateBorder(ctx);
  ctx.filter = 'none';
  const W = PAGE_W >> 2, H = PAGE_H >> 2;
  const wear = upsample(fbm(W>>2, H>>2, 6, 8, 4, 616), W>>2, H>>2, W, H);
  const m = cv(W, H), mx = m.getContext('2d'), img = mx.createImageData(W, H), d = img.data;
  const rnd = mulberry32(4242);
  for(let i=0;i<W*H;i++){ d[i*4+3] = clamp((wear[i]-0.45)*2.2 + (rnd()-0.5)*0.5, 0, 0.9)*255; }
  mx.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(m, 0, 0, PAGE_W, PAGE_H);
  borderCanvas = c;
  return c;
}
/* gold leaf laid over the printed ornament (the inner rule, the corner fleurons,
   the lozenges at mid-side), rubbed thin in places; drawn once for every page.
   gilt().color goes on the page art, gilt().pbr is the shared roughness (G) and
   metalness (B) map that makes it shine as metal while the paper stays matte */
let giltCanvases = null;
function gilt(){
  if(giltCanvases) return giltCanvases;
  const mask = cv(PAGE_W, PAGE_H), ctx = mask.getContext('2d');
  ctx.save(); ctx.scale(SC, SC);
  ctx.fillStyle = ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const X0 = 15, Y0 = 15, X1 = 325, Y1 = 443, m = 6.2, ci = 13.6;
  ctx.lineWidth = 1.05; ctx.strokeRect(X0+12.2, Y0+12.2, X1-X0-24.4, Y1-Y0-24.4);
  const lozenge = (x, y, rx, ry)=>{ ctx.beginPath(); ctx.moveTo(x, y-ry); ctx.lineTo(x+rx, y); ctx.lineTo(x, y+ry); ctx.lineTo(x-rx, y); ctx.closePath(); ctx.fill(); };
  [[(X0+X1)/2, Y0+m, 0], [(X0+X1)/2, Y1-m, 0], [X0+m, (Y0+Y1)/2, 1], [X1-m, (Y0+Y1)/2, 1]].forEach(([x, y, v])=>{
    v ? lozenge(x, y, 5.4, 5) : lozenge(x, y, 5, 5.4);
  });
  [[X0+ci, Y0+ci, 1, 1], [X1-ci, Y0+ci, -1, 1], [X0+ci, Y1-ci, 1, -1], [X1-ci, Y1-ci, -1, -1]].forEach(([x, y, sx, sy])=>{
    ctx.save(); ctx.translate(x, y); ctx.scale(sx, sy);
    lozenge(-m, -m, 2.4, 2.4);
    ctx.lineWidth = 0.2;
    inkLeaf(ctx, 7, 7, Math.PI*0.75, 11, 3.2);
    inkLeaf(ctx, 7, 7, Math.PI*0.55, 7.5, 2.2);
    inkLeaf(ctx, 7, 7, Math.PI*0.95, 7.5, 2.2);
    ctx.beginPath(); ctx.arc(4.2, 4.2, 1.6, 0, 7); ctx.fill();
    ctx.restore();
  });
  ctx.restore();
  /* worn leaf: rubbed off in small flecks, never wholly gone */
  const W = PAGE_W >> 2, H = PAGE_H >> 2;
  const wear = fbm(W, H, 30, 40, 3, 2323);
  const wm = cv(W, H), wx = wm.getContext('2d'), wi = wx.createImageData(W, H);
  for(let i=0;i<W*H;i++) wi.data[i*4+3] = clamp((wear[i]-0.58)*2.4, 0, 0.7)*255;
  wx.putImageData(wi, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(wm, 0, 0, PAGE_W, PAGE_H);
  const tint = (fill)=>{
    const c = cv(PAGE_W, PAGE_H), x = c.getContext('2d');
    x.drawImage(mask, 0, 0); x.globalCompositeOperation = 'source-in';
    x.fillStyle = fill; x.fillRect(0, 0, PAGE_W, PAGE_H);
    return c;
  };
  const color = tint('rgb(214,172,92)');
  const pbr = cv(PAGE_W, PAGE_H), px = pbr.getContext('2d');
  px.fillStyle = 'rgb(0,235,0)'; px.fillRect(0, 0, PAGE_W, PAGE_H);
  px.drawImage(tint('rgb(0,82,255)'), 0, 0);
  giltCanvases = { color, pbr: tex(pbr, { wrap:false }) };
  return giltCanvases;
}
/* one rune from straight staves like old futhark, centred on the origin */
function runeStroke(ctx, kind, h, w){
  ctx.beginPath(); ctx.moveTo(0, -h); ctx.lineTo(0, h);
  if(kind === 0){ ctx.moveTo(0, -h); ctx.lineTo(w, -h*0.3); }
  else if(kind === 1){ ctx.moveTo(0, -h*0.4); ctx.lineTo(w, -h); ctx.moveTo(0, h*0.2); ctx.lineTo(w, -h*0.4); }
  else if(kind === 2){ ctx.moveTo(-w, -h*0.5); ctx.lineTo(w, h*0.5); }
  else if(kind === 3){ ctx.moveTo(0, -h); ctx.lineTo(w, -h*0.5); ctx.lineTo(0, 0); }
  else if(kind === 4){ ctx.moveTo(-w, -h); ctx.lineTo(0, -h*0.3); ctx.lineTo(w, -h); }
  else { ctx.moveTo(0, -h*0.2); ctx.lineTo(-w, h*0.6); ctx.moveTo(0, -h*0.2); ctx.lineTo(w, h*0.6); }
  ctx.stroke();
}
/* a magic circle pressed into the sheet like a watermark, so every leaf reads as
   part of a book of spells and the writing still sits clearly over it */
let sigilCanvas = null;
function sigilArt(){
  if(sigilCanvas) return sigilCanvas;
  const R = 118*SC, c = cv(Math.ceil(R*2.2), Math.ceil(R*2.2)), ctx = c.getContext('2d');
  ctx.translate(c.width/2, c.height/2);
  ctx.strokeStyle = PINK(1); ctx.fillStyle = PINK(1); ctx.lineCap = 'round';
  const ring = (r, w)=>{ ctx.lineWidth = w*SC; ctx.beginPath(); ctx.arc(0, 0, r*SC, 0, Math.PI*2); ctx.stroke(); };
  ring(118, 1.1); ring(112, 0.5); ring(84, 0.8); ring(80, 0.4); ring(30, 0.7);
  /* a seven-pointed star joining the inner ring */
  ctx.lineWidth = 0.7*SC; ctx.beginPath();
  for(let i=0;i<=7;i++){ const a = -Math.PI/2 + i*3*Math.PI*2/7; const x = Math.cos(a)*80*SC, y = Math.sin(a)*80*SC; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke();
  /* runes in the band between the rings, drawn from straight staves like old futhark */
  const rnd = mulberry32(777);
  const NR = 28;
  for(let i=0;i<NR;i++){
    ctx.save();
    ctx.rotate(i/NR*Math.PI*2);
    ctx.translate(0, -98*SC);
    ctx.lineWidth = 0.75*SC;
    runeStroke(ctx, Math.floor(rnd()*6), 7*SC, 3.6*SC);
    ctx.restore();
  }
  for(let i=0;i<7;i++){ const a = -Math.PI/2 + i*Math.PI*2/7; ctx.beginPath(); ctx.arc(Math.cos(a)*118*SC, Math.sin(a)*118*SC, 2.6*SC, 0, Math.PI*2); ctx.fill(); }
  ctx.beginPath(); ctx.arc(0, 0, 3*SC, 0, Math.PI*2); ctx.fill();
  /* faint, and broken like an old impression */
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = 'rgba(0,0,0,0.13)'; ctx.fillRect(0, 0, c.width, c.height);
  sigilCanvas = c;
  return c;
}
/* recto: the spine is on the left of the canvas; verso: on the right */
let titleHidden = false;
function setTitleHidden(v){ titleHidden = v; }
function pageBackground(n){
  const recto = ((n%2)+2)%2 === 0;
  const c = cv(PAGE_W, PAGE_H), ctx = c.getContext('2d');
  const rnd = mulberry32(300 + n*17);
  const S = parch.base.width;
  const sx = Math.floor(rnd()*S*0.3), sy = Math.floor(rnd()*S*0.25);
  ctx.drawImage(parch.base, sx, sy, S-sx, S-sy, 0, 0, PAGE_W, PAGE_H);
  const gut = ctx.createLinearGradient(0,0,PAGE_W,0);
  [[0,'rgba(80,60,36,.30)'],[0.05,'rgba(90,68,40,.10)'],[0.15,'rgba(90,68,40,0)'],[0.93,'rgba(90,68,40,0)'],[1,'rgba(90,68,40,.14)']]
    .forEach(([o,cl])=>gut.addColorStop(recto?o:1-o, cl));
  ctx.fillStyle = gut; ctx.fillRect(0,0,PAGE_W,PAGE_H);
  ctx.save();
  if(rnd() < 0.5){ ctx.translate(PAGE_W, 0); ctx.scale(-1, 1); }
  if(rnd() < 0.5){ ctx.translate(0, PAGE_H); ctx.scale(1, -1); }
  ctx.drawImage(edgeTone, 0, 0, PAGE_W, PAGE_H);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(borderArt(), 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(gilt().color, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  if(n !== 0){
    ctx.translate(PAGE_W/2, PAGE_H*0.48);
    ctx.rotate((rnd() - 0.5)*0.5);
    ctx.drawImage(sigilArt(), -sigilArt().width/2, -sigilArt().height/2);
  }
  ctx.restore();
  if(n > 0){
    ctx.fillStyle = PINK(.8);
    ctx.font = `italic 500 ${13*SC}px "Cormorant Garamond", serif`;
    ctx.textAlign = 'center';
    ctx.fillText(String(n+1), PAGE_W/2, 458*SC);
    ctx.textAlign = 'left';
  }
  if(n === 0 && !titleHidden) drawTitle(ctx);
  return c;
}
/* the invitation is written on a leaf of the book itself: the same vellum,
   worn border, gold leaf and watermark circle, without the gutter shadow */
let invitePaperUrl = null;
function invitePaper(){
  if(invitePaperUrl) return invitePaperUrl;
  const c = cv(PAGE_W, PAGE_H), ctx = c.getContext('2d');
  const S = parch.base.width;
  ctx.drawImage(parch.base, S*0.12, S*0.08, S*0.8, S*0.84, 0, 0, PAGE_W, PAGE_H);
  ctx.drawImage(edgeTone, 0, 0, PAGE_W, PAGE_H);
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(borderArt(), 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(gilt().color, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.55;
  ctx.drawImage(sigilArt(), (PAGE_W - sigilArt().width)/2, PAGE_H*0.5 - sigilArt().height/2);
  const out = cv(720, Math.round(720*PAGE_H/PAGE_W));
  out.getContext('2d').drawImage(c, 0, 0, out.width, out.height);
  invitePaperUrl = out.toDataURL('image/jpeg', 0.86);
  return invitePaperUrl;
}
/* engraved headpiece of the title page: tapered rules, a lance through the
   middle and scrolls curling away from the title (dir -1 turns them below) */
function titleFlourish(ctx, cx, y, w, dir){
  ctx.save(); ctx.translate(cx, y); ctx.scale(SC, SC*dir);
  ctx.strokeStyle = PINK(.9); ctx.fillStyle = PINK(.88);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  [-1,1].forEach(s=>{
    ctx.beginPath();
    ctx.moveTo(s*3, -0.8); ctx.quadraticCurveTo(s*w*0.45, -0.5, s*w, 0);
    ctx.quadraticCurveTo(s*w*0.45, 0.5, s*3, 0.8); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 0.75;
    ctx.beginPath(); ctx.moveTo(s*2.2, -1.2);
    ctx.bezierCurveTo(s*8, -1.4, s*13, -3.2, s*17.5, -3.2);
    spiralPath(ctx, s*17.5, -7.6, 4.4, 0.6, Math.PI/2, 1.2, -s); ctx.stroke();
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(s*2.4, -3.4);
    ctx.bezierCurveTo(s*3.5, -10, s*8, -13.5, s*12.6, -12.4);
    spiralPath(ctx, s*11.4, -9.9, 2.75, 0.4, -Math.PI*0.36, 1.1, -s); ctx.stroke();
    ctx.lineWidth = 0.55;
    ctx.beginPath(); ctx.moveTo(s*21.5, -1);
    ctx.bezierCurveTo(s*24, -1.4, s*26, -2.6, s*27.4, -1.6);
    spiralPath(ctx, s*27.4, -3.8, 2.2, 0.35, Math.PI/2, 1.1, -s); ctx.stroke();
    ctx.lineWidth = 0.35;
    inkLeaf(ctx, s*5.2, -1.6, s*0.55, 6.8, 1.8);
    inkLeaf(ctx, s*20.5, -11.6, s*0.9, 5.2, 1.5);
    inkLeaf(ctx, s*23.5, -1.2, s*1.15, 5.6, 1.6);
    inkLeaf(ctx, s*32, -0.6, s*1.3, 4.2, 1.2);
    [[s*15.2, -14.6, 0.75], [s*25.6, -8.2, 0.6], [s*35.4, -2.6, 0.55], [s*7, -7.4, 0.55]].forEach(([x, yy, r])=>{
      ctx.beginPath(); ctx.arc(x, yy, r, 0, 7); ctx.fill();
    });
    ctx.beginPath(); ctx.moveTo(s*w, 0); ctx.lineTo(s*(w-4.5), -1.1); ctx.lineTo(s*(w-4.5), 1.1); ctx.closePath(); ctx.fill();
  });
  ctx.beginPath();
  ctx.moveTo(0, -24); ctx.lineTo(1.5, -13); ctx.lineTo(0.55, -5); ctx.lineTo(0, -3);
  ctx.lineTo(-0.55, -5); ctx.lineTo(-1.5, -13); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 23); ctx.lineTo(2.1, 11); ctx.lineTo(0.7, 5); ctx.lineTo(0, 3);
  ctx.lineTo(-0.7, 5); ctx.lineTo(-2.1, 11); ctx.closePath(); ctx.fill();
  ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(-2.6, -15.5); ctx.lineTo(2.6, -15.5); ctx.moveTo(-3, 13.5); ctx.lineTo(3, 13.5); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 2.3, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(222,196,150,.9)'; ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, 7); ctx.fill();
  ctx.restore();
}
function titleTailpiece(ctx, cx, y){
  ctx.save(); ctx.translate(cx, y); ctx.scale(SC, SC);
  ctx.strokeStyle = PINK(.88); ctx.fillStyle = PINK(.85);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  [-1,1].forEach(s=>{
    ctx.beginPath();
    ctx.moveTo(s*3, -0.6); ctx.quadraticCurveTo(s*20, -0.35, s*40, 0);
    ctx.quadraticCurveTo(s*20, 0.35, s*3, 0.6); ctx.closePath(); ctx.fill();
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(s*1.8, -1);
    ctx.bezierCurveTo(s*4, -1.4, s*6, -2.2, s*7.2, -1.6);
    spiralPath(ctx, s*7.2, -3.6, 2, 0.35, Math.PI/2, 1.05, -s); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s*1.8, 1);
    ctx.bezierCurveTo(s*4, 1.4, s*6, 2.2, s*7.2, 1.6);
    spiralPath(ctx, s*7.2, 3.6, 2, 0.35, -Math.PI/2, 1.05, s); ctx.stroke();
  });
  ctx.lineWidth = 0.35;
  inkLeaf(ctx, 0, -2.4, 0, 5.4, 1.9);
  inkLeaf(ctx, -0.6, -2.6, -0.8, 4.2, 1.3);
  inkLeaf(ctx, 0.6, -2.6, 0.8, 4.2, 1.3);
  ctx.beginPath();
  ctx.moveTo(0, 13); ctx.lineTo(1.6, 6.5); ctx.lineTo(0.5, 3.2); ctx.lineTo(0, 2);
  ctx.lineTo(-0.5, 3.2); ctx.lineTo(-1.6, 6.5); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 1.9, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(222,196,150,.9)'; ctx.beginPath(); ctx.arc(0, 0, 0.7, 0, 7); ctx.fill();
  ctx.restore();
}
/* the blackletter is cut like an engraving: dark ink with fine light hatching */
function engravedTitle(ctx, text, cx, baseline, maxW){
  let size = 44*SC;
  const font = z => `${z}px "UnifrakturMaguntia", "Cormorant SC", serif`;
  ctx.save(); ctx.font = font(size);
  const tw = ctx.measureText(text).width;
  if(tw > maxW*SC) size *= maxW*SC/tw;
  ctx.font = font(size);
  const w = Math.ceil(ctx.measureText(text).width + size*0.4), h = Math.ceil(size*1.5);
  ctx.restore();
  const c = cv(w, h), x = c.getContext('2d');
  x.font = font(size); x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  const by = Math.round(h*0.72);
  const g = x.createLinearGradient(0, by - size*0.8, 0, by + size*0.2);
  g.addColorStop(0, 'rgba(52,30,11,.96)'); g.addColorStop(0.55, 'rgba(36,20,7,.97)'); g.addColorStop(1, 'rgba(58,34,13,.95)');
  x.fillStyle = g; x.fillText(text, w/2, by);
  x.globalCompositeOperation = 'source-atop';
  x.strokeStyle = 'rgba(214,170,104,.32)'; x.lineWidth = Math.max(1, 0.32*SC);
  const step = 1.25*SC;
  x.beginPath();
  for(let k = -h; k < w; k += step){ x.moveTo(k, h); x.lineTo(k + h*0.7, 0); }
  x.stroke();
  ctx.save();
  ctx.shadowColor = 'rgba(40,22,8,.4)'; ctx.shadowBlur = 1.5*SC; ctx.shadowOffsetY = 0.3*SC;
  ctx.drawImage(c, cx - w/2, baseline - by);
  ctx.restore();
}
const TITLE = 'No Notes Bible';
const MOTTO = ['P.S. Read mindfully.', 'The why is on you.'];
function drawTitle(ctx){
  const cx = PAGE_W/2;
  titleFlourish(ctx, cx, 162*SC, 76, 1);
  engravedTitle(ctx, TITLE, cx, 202*SC, 176);
  titleFlourish(ctx, cx, 228*SC, 76, -1);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(48,28,10,.9)';
  ctx.font = `italic 500 ${15.5*SC}px "Cormorant Garamond", serif`;
  MOTTO.forEach((line, i)=>ctx.fillText(line, cx, (270 + i*18)*SC));
  ctx.restore();
  titleTailpiece(ctx, cx, 314*SC);
}

const pageMaterial = canvas => new THREE.MeshStandardMaterial({
  map: tex(canvas, {srgb:true, wrap:false}), normalMap: parch.normalTex,
  normalScale: new THREE.Vector2(0.22,0.22), roughness: 1, metalness: 1,
  roughnessMap: gilt().pbr, metalnessMap: gilt().pbr, vertexColors: true
});
/* n = -2 / -1: an unnumbered recto / verso */
const blankMat = [pageMaterial(pageBackground(-2)), pageMaterial(pageBackground(-1))];

export {
  blankMat, borderArt, drawTitle, gilt, invitePaper, MOTTO, pageBackground, pageMaterial,
  runeStroke, setTitleHidden, spiralPath, TITLE
};
