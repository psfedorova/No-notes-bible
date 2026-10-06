/* ============================================================================
   The invitation card's own magic, the same the book works on its pages:
   taking the invitation is the words lifting off the card the way erased
   letters leave a page (they warm to pale gold, come apart from the top in
   a ragged drift, each grain flaring before it goes, vapour and gold motes
   rising), and the vow is then burned in line by line the way a letter is
   written (a white-gold rim along the pen's slant, embers cooling into ink).
   Works on the card's real text: every glyph is redrawn where the page set it.
   ==========================================================================*/
import { fbm } from './textures.js?v=4';

const VAPOR_T = 0.85, LINE_STEP = 0.08;
const BURN_T = 0.5, COOL_T = 0.42, CHAR = 0.04, RIM = 0.08, BURN_STEP = 0.22;
const NIB_DX = 0.972, NIB_DY = 0.235;
const SINGE = [[0, 46, 22, 10], [0.35, 120, 46, 16], [0.7, 214, 110, 40], [1, 255, 214, 150]];
const EMBER = [[0, 0, 0, 0], [0.2, 190, 62, 14], [0.5, 255, 132, 40], [1, 255, 228, 180]];
const clamp = (x, a, b)=> Math.min(b, Math.max(a, x));
const lerp = (a, b, t)=> a + (b - a)*t;
const smooth = t => t*t*(3 - 2*t);
const ramp = (h, K)=>{
  let k = 0;
  while(k < K.length - 2 && h > K[k+1][0]) k++;
  const a = K[k], b = K[k+1], t = clamp((h - a[0])/(b[0] - a[0]), 0, 1);
  return [lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
};
let noise = null;
const noiseAt = (x, y)=> noise[((y & 255) << 8) | (x & 255)];
export const calm = ()=> matchMedia('(prefers-reduced-motion: reduce)').matches;

/* two canvases laid over the card: the letters as the card shows them, and their
   light, blurred and screened over the paper */
function layers(card){
  const S = Math.min(devicePixelRatio || 1, 1.5);
  const W = card.clientWidth, H = card.scrollHeight;
  const mk = cls => {
    const c = document.createElement('canvas');
    c.className = 'magic ' + cls;
    c.width = Math.ceil(W*S); c.height = Math.ceil(H*S);
    c.style.width = W + 'px'; c.style.height = H + 'px';
    card.appendChild(c);
    return c;
  };
  return { S, W, H, paint: mk('paint'), glow: mk('glow') };
}

/* every glyph of the text under root, drawn one by one where the page put it,
   grouped in lines from the top; buttons, inputs and ornaments are left to CSS */
function glyphs(root, card, L){
  const cr = card.getBoundingClientRect(), ox = cr.left, oy = cr.top - card.scrollTop;
  const mask = document.createElement('canvas');
  mask.width = L.paint.width; mask.height = L.paint.height;
  const mx = mask.getContext('2d', { willReadFrequently: true });
  mx.scale(L.S, L.S);
  const lines = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.textContent.trim() && !n.parentElement.closest('button, input, .acts') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const range = document.createRange();
  for(let n = walk.nextNode(); n; n = walk.nextNode()){
    const cs = getComputedStyle(n.parentElement);
    mx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    mx.fillStyle = cs.color;
    const m = mx.measureText('Hg'), asc = m.fontBoundingBoxAscent || parseFloat(cs.fontSize)*0.8;
    const up = cs.textTransform === 'uppercase', t = n.textContent;
    for(let i=0;i<t.length;i++){
      if(/\s/.test(t[i])) continue;
      range.setStart(n, i); range.setEnd(n, i + 1);
      const r = range.getBoundingClientRect();
      if(!r.width) continue;
      const x = r.left - ox, y = r.top - oy;
      mx.fillText(up ? t[i].toUpperCase() : t[i], x, y + asc);
      let ln = lines.find(l => Math.abs(l.top - y) < r.height*0.5);
      if(!ln){ ln = { top: y, bot: y + r.height, x0: x, x1: x + r.width }; lines.push(ln); }
      ln.x0 = Math.min(ln.x0, x); ln.x1 = Math.max(ln.x1, x + r.width); ln.bot = Math.max(ln.bot, y + r.height);
    }
  }
  lines.sort((a, b)=> a.top - b.top);
  return { mask: mx.getImageData(0, 0, mask.width, mask.height).data, lines };
}

/* the pixels worth visiting: the strokes and a soft halo round them, each with
   its line, its colour and where it sits */
function field(G, L, halo){
  const w = L.paint.width, h = L.paint.height, d = G.mask;
  const soft = new Float32Array(w*h);
  for(let i=0;i<w*h;i++) soft[i] = d[i*4+3]/255;
  if(halo){
    const r = Math.max(1, Math.round(halo*L.S)), k = 1/(2*r + 1), tmp = new Float32Array(w*h);
    for(let pass=0; pass<2; pass++){
      for(let y=0;y<h;y++){ let acc = 0; const row = y*w;
        for(let x=-r;x<=r;x++) acc += x >= 0 && x < w ? soft[row + x] : 0;
        for(let x=0;x<w;x++){ tmp[row + x] = acc*k; if(x - r >= 0) acc -= soft[row + x - r]; if(x + r + 1 < w) acc += soft[row + x + r + 1]; } }
      for(let x=0;x<w;x++){ let acc = 0;
        for(let y=-r;y<=r;y++) acc += y >= 0 && y < h ? tmp[y*w + x] : 0;
        for(let y=0;y<h;y++){ soft[y*w + x] = acc*k; if(y - r >= 0) acc -= tmp[(y - r)*w + x]; if(y + r + 1 < h) acc += tmp[(y + r + 1)*w + x]; } }
    }
  }
  const lineOf = new Int16Array(h).fill(-1);
  G.lines.forEach((ln, k)=>{
    const pad = (ln.bot - ln.top)*0.25;
    for(let y=Math.max(0, Math.floor((ln.top - pad)*L.S)); y<Math.min(h, Math.ceil((ln.bot + pad)*L.S)); y++) if(lineOf[y] < 0) lineOf[y] = k;
  });
  const P = [];
  for(let y=0;y<h;y++){
    const ln = lineOf[y];
    if(ln < 0) continue;
    for(let x=0;x<w;x++){ const i = y*w + x; if(soft[i] > 0.004 || d[i*4+3] > 2) P.push(i); }
  }
  return { P: Int32Array.from(P), soft, lineOf, w, h };
}

function run(step, done){
  const t0 = performance.now();
  return new Promise(res=>{
    const tick = now=>{
      if(step((now - t0)/1000)){ requestAnimationFrame(tick); return; }
      done(); res();
    };
    requestAnimationFrame(tick);
  });
}

/* gold motes and pale vapour, drawn in the light layer */
function motes(){
  const list = [];
  return {
    add(x, y, kind){ list.push({ x, y, vx: (Math.random() - 0.5)*14, vy: -(16 + Math.random()*26), age: 0, life: kind ? 1.1 + Math.random()*0.6 : 0.7 + Math.random()*0.6, kind, r: kind ? 6 + Math.random()*8 : 0.9 + Math.random()*1.2 }); },
    draw(gx, dt, S, hue){
      for(let i=list.length-1;i>=0;i--){
        const m = list[i]; m.age += dt;
        if(m.age > m.life){ list.splice(i, 1); continue; }
        m.x += m.vx*dt; m.y += m.vy*dt; m.vy *= 0.985;
        const k = 1 - m.age/m.life, a = (m.age < 0.12 ? m.age/0.12 : 1)*k;
        if(m.kind){
          const r = (m.r + m.age*14)*S, g = gx.createRadialGradient(m.x*S, m.y*S, 0, m.x*S, m.y*S, r);
          g.addColorStop(0, `rgba(255,236,200,${0.16*a})`); g.addColorStop(1, 'rgba(255,236,200,0)');
          gx.fillStyle = g; gx.fillRect(m.x*S - r, m.y*S - r, r*2, r*2);
        }else{
          gx.fillStyle = hue(a); gx.beginPath(); gx.arc(m.x*S, m.y*S, m.r*S, 0, 7); gx.fill();
        }
      }
      return list.length > 0;
    },
  };
}

/* the words lift off the card; done as soon as they are gone, while their last
   motes still rise over whatever the card shows next */
export function vanish(card, root, onStart){
  if(!noise) noise = fbm(256, 256, 12, 12, 3, 4242);
  const L = layers(card), G = glyphs(root, card, L), F = field(G, L, 0);
  const { P, w, lineOf } = F, d = G.mask, S = L.S;
  root.classList.add('ghost', 'leaving');
  const px = L.paint.getContext('2d'), gx = L.glow.getContext('2d');
  const paint = px.createImageData(L.paint.width, L.paint.height), glow = gx.createImageData(L.glow.width, L.glow.height);
  const pd = new Uint32Array(paint.data.buffer), gd = new Uint32Array(glow.data.buffer);
  const M = motes(), out = new Set();
  const last = (G.lines.length - 1)*LINE_STEP + VAPOR_T;
  let prev = 0, gone;
  const words = new Promise(r => gone = r);
  if(onStart) onStart();
  run(t=>{
    pd.fill(0); gd.fill(0);
    const nk = 1/S, drift = t*40;
    if(t >= last) gone();
    else for(let j=0;j<P.length;j++){
      const i = P[j], p = i*4, a = d[p+3];
      if(a < 3) continue;
      const y = (i / w) | 0, x = i - y*w, ln = lineOf[y], tau = t - ln*LINE_STEP;
      if(tau < 0){ pd[i] = (a << 24) | (d[p+2] << 16) | (d[p+1] << 8) | d[p]; continue; }
      const L0 = G.lines[ln], fy = clamp((y*nk - L0.top)/(L0.bot - L0.top), 0, 1);
      const F2 = noiseAt((x*nk) | 0, (y*nk) | 0)*0.62 + fy*0.38 + (noiseAt((x*nk*2.2) | 0, (y*nk*2.2 + drift) | 0) - 0.5)*0.2;
      const tg = 0.2 + F2*0.5;
      if(tau >= tg + 0.07) continue;
      const warm = smooth(clamp(tau/0.2, 0, 1));
      const rem = tau < tg ? 1 : 1 - (tau - tg)/0.07;
      const rim = tau > tg - 0.09 ? clamp(1 - (tg - tau)/0.09, 0, 1) : 0;
      const g = Math.min(1, warm*0.55 + rim*0.45);
      pd[i] = ((a*rem) << 24) | (lerp(d[p+2], 160, g) << 16) | (lerp(d[p+1], 222, g) << 8) | lerp(d[p], 255, g);
      const e = (a/255)*(warm*0.28 + rim*0.95)*rem;
      gd[i] = ((Math.min(255, e*255)) << 24) | (lerp(110, 200, rim) << 16) | (lerp(196, 238, rim) << 8) | 255;
      if(rim > 0.9 && Math.random() < 0.0016) M.add(x*nk, y*nk, 0);
    }
    G.lines.forEach((L0, k)=>{
      if(out.has(k) || t < k*LINE_STEP + 0.15) return;
      out.add(k);
      for(let x=L0.x0; x<L0.x1; x+=44) M.add(x + Math.random()*30, (L0.top + L0.bot)/2, 1);
    });
    px.putImageData(paint, 0, 0); gx.putImageData(glow, 0, 0);
    const live = M.draw(gx, t - prev, S, a => `rgba(255,224,150,${a})`);
    prev = t;
    return t < last || live;
  }, ()=>{ gone(); L.paint.remove(); L.glow.remove(); });
  return words;
}

/* the vow is burned into the card, line after line along the pen's slant */
export function burnIn(card, root, onLine){
  if(!noise) noise = fbm(256, 256, 12, 12, 3, 4242);
  /* the vow is read in its own ink, then hidden before the next paint */
  root.classList.remove('ghost');
  const L = layers(card), G = glyphs(root, card, L);
  root.classList.add('ghost', 'arriving');
  const F = field(G, L, 2.4);
  const { P, w, soft, lineOf } = F, d = G.mask, S = L.S;
  const px = L.paint.getContext('2d'), gx = L.glow.getContext('2d');
  const paint = px.createImageData(L.paint.width, L.paint.height), glow = gx.createImageData(L.glow.width, L.glow.height);
  const pd = new Uint32Array(paint.data.buffer), gd = new Uint32Array(glow.data.buffer);
  const M = motes(), lit = new Set(), ign = k => k*BURN_STEP;
  const span = G.lines.map(L0 => {
    const s0 = L0.x0*NIB_DX + L0.top*NIB_DY, s1 = L0.x1*NIB_DX + L0.bot*NIB_DY;
    return { s0, ss: Math.max(1, s1 - s0), dur: BURN_T*(0.6 + 0.9*(L0.x1 - L0.x0)/L.W) };
  });
  const last = ign(G.lines.length - 1) + BURN_T*1.6 + 2*COOL_T;
  let prev = 0;
  return run(t=>{
    pd.fill(0); gd.fill(0);
    const nk = 1/S, rise = t*70;
    G.lines.forEach((L0, k)=>{ if(!lit.has(k) && t >= ign(k)){ lit.add(k); if(onLine) onLine(k); } });
    for(let j=0;j<P.length;j++){
      const i = P[j], y = (i / w) | 0, x = i - y*w, ln = lineOf[y], sp = span[ln];
      const p = i*4, a = d[p+3]/255, sa = soft[i];
      const X = x*nk, Y = y*nk;
      const Fp = clamp((X*NIB_DX + Y*NIB_DY - sp.s0)/sp.ss, -0.2, 1.2)*0.74 + noiseAt(X | 0, Y | 0)*0.42 - 0.08;
      const la = t - ign(ln) - sp.dur*Fp;
      if(la < 0){
        if(la > -BURN_T*0.4){
          const k = 1 + la/(BURN_T*0.4), q = k*k, c = la > -CHAR ? 1 + la/CHAR : 0;
          const al = Math.min(1, (a*0.55 + sa*0.1)*q + (a*0.9 + sa*0.25)*c);
          pd[i] = ((al*255) << 24) | (lerp(28, 6, c) << 16) | (lerp(66, 14, c) << 8) | lerp(120, 30, c);
        }
        continue;
      }
      const fl = noiseAt((X*1.7) | 0, (Y*1.7 + rise) | 0);
      const edge = clamp((1 - sa)*2.5, 0, 1);
      const heat = Math.min(1, Math.exp(-la/(COOL_T*(0.55 + 1.1*edge)))*(0.72 + 0.56*fl));
      const rim = la < RIM ? 1 - la/RIM : 0;
      if(a > 0.004){
        /* the stroke cools from singe into the card's own ink */
        const s = ramp(heat, SINGE), r = rim*0.8, h = Math.min(1, heat*1.6);
        const cr = lerp(lerp(d[p], s[0], h), 255, r), cg = lerp(lerp(d[p+1], s[1], h), 246, r), cb = lerp(lerp(d[p+2], s[2], h), 220, r);
        pd[i] = ((a*255) << 24) | (cb << 16) | (cg << 8) | cr;
      }
      if(heat < 0.01 && rim === 0) continue;
      const c = ramp(heat, EMBER), ea = Math.min(1, a*Math.min(1, heat*1.6) + sa*(rim*0.55 + heat*0.3));
      gd[i] = ((ea*255) << 24) | (lerp(c[2], 205, rim) << 16) | (lerp(c[1], 240, rim) << 8) | lerp(c[0], 255, rim);
      if(rim > 0.85 && a > 0.5 && Math.random() < 0.004) M.add(X, Y, 0);
    }
    px.putImageData(paint, 0, 0); gx.putImageData(glow, 0, 0);
    const live = M.draw(gx, t - prev, S, a => `rgba(255,${150 + (a*80) | 0},60,${a})`);
    prev = t;
    return t < last || live;
  }, ()=>{ root.classList.remove('ghost', 'arriving'); L.paint.remove(); L.glow.remove(); });
}
