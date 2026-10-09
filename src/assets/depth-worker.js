
const fb = new ArrayBuffer(4), f32 = new Float32Array(fb), u32 = new Uint32Array(fb);
const base = new Uint32Array(512), shift = new Uint32Array(512);
for(let i=0;i<256;++i){
  const e = i - 127;
  if(e < -27){ base[i] = 0x0000; base[i | 0x100] = 0x8000; shift[i] = 24; shift[i | 0x100] = 24; }
  else if(e < -14){ base[i] = 0x0400 >> (-e - 14); base[i | 0x100] = (0x0400 >> (-e - 14)) | 0x8000; shift[i] = -e - 1; shift[i | 0x100] = -e - 1; }
  else if(e <= 15){ base[i] = (e + 15) << 10; base[i | 0x100] = ((e + 15) << 10) | 0x8000; shift[i] = 13; shift[i | 0x100] = 13; }
  else if(e < 128){ base[i] = 0x7c00; base[i | 0x100] = 0xfc00; shift[i] = 24; shift[i | 0x100] = 24; }
  else { base[i] = 0x7c00; base[i | 0x100] = 0xfc00; shift[i] = 13; shift[i | 0x100] = 13; }
}
function toHalf(v){ f32[0] = v; const f = u32[0], e = (f >> 23) & 0x1ff; return base[e] + ((f & 0x007fffff) >> shift[e]); }

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
  for(let i=0;i<W*H;i++) out[i] = toHalf(a[i]);
  return { W, H, data: out };
}

/* a trunk's outline in the depth map moves one whole texel sideways every few dozen rows, and
   where the eye sees that side stretched each step shows as a notch; the second channel puts the
   near/far split on a line fitted through the outline over ~50 rows, which the backdrop reads */
function edgeDepth(q, w, h, out, qNear, qMid){
  const yLow = Math.floor(h*0.456), N = 24, edge = new Uint8Array(w*h), done = new Uint8Array(w*h), g = new Uint16Array(q);
  const cMx = new Uint16Array(w), cMn = new Uint16Array(w);
  for(let y=0;y<h;y++){
    const r0 = (y > 0 ? y - 1 : 0)*w, r1 = y*w, r2 = (y < h - 1 ? y + 1 : y)*w;
    for(let x=0;x<w;x++){
      const a = q[r0 + x], b = q[r1 + x], c = q[r2 + x];
      cMx[x] = a > b ? (a > c ? a : c) : (b > c ? b : c); cMn[x] = a < b ? (a < c ? a : c) : (b < c ? b : c);
    }
    for(let x=0;x<w;x++){
      const xl = x > 0 ? x - 1 : w - 1, xr = x < w - 1 ? x + 1 : 0;
      const hi = Math.max(cMx[xl], cMx[x], cMx[xr]), lo = Math.min(cMn[xl], cMn[x], cMn[xr]);
      if(hi - lo >= 0.1*hi && hi > 0) edge[r1 + x] = hi > (y >= yLow ? qMid : qNear) ? 2 : 1;
    }
  }
  let nl = 0;
  for(let i=0;i<w*h;i++) if(edge[i] === 2) nl++;
  const list = new Int32Array(nl);
  for(let i=0, j=0;i<w*h;i++) if(edge[i] === 2) list[j++] = i;
  const wx = x=> x < 0 ? x + w : x >= w ? x - w : x, cy = y=> y < 0 ? 0 : y >= h ? h - 1 : y;
  /* the jump between texel k and k+1 on a row (upright outline) or a column (lying outline), or 0 */
  const jumpR = (y, k, s)=>{ const r = y*w, a = q[r + wx(k)], b = q[r + wx(k + 1)], hi = a > b ? a : b; return hi > qNear && (b - a)*s >= 0.1*hi ? (b - a)*s : 0; };
  const jumpC = (x, k, s)=>{ const a = q[cy(k)*w + x], b = q[cy(k + 1)*w + x], hi = a > b ? a : b; return hi > qNear && (b - a)*s >= 0.1*hi ? (b - a)*s : 0; };
  const follow = (J, line, k0, s)=>{ const a = J(line, k0 - 1, s), b = J(line, k0, s), c = J(line, k0 + 1, s); return b >= a && b >= c ? (b > 0 ? k0 : -1) : a >= c ? k0 - 1 : k0 + 1; };
  /* each outline is traced once as a chain of jumps, one per row (or column), and every jump in it
     moves to the straight line fitted through its 2N+1 neighbours along the chain */
  const used = new Uint8Array(w*h), cl = new Int32Array(Math.max(w, h)*2 + 2), ck = new Int32Array(cl.length);
  const P = new Float64Array(cl.length + 1), PT = new Float64Array(cl.length + 1), TT = new Float64Array(cl.length + 1), PP = new Float64Array(cl.length + 1);
  for(let dir=0;dir<2;dir++){
    const J = dir === 0 ? jumpR : jumpC, lines = dir === 0 ? h : w, wrap = dir === 1, bit = dir + 1;
    const at = (line, k)=> dir === 0 ? line*w + wx(k) : cy(k)*w + line;
    for(const i of list){
      const y = (i/w)|0, x = i - y*w, line0 = dir === 0 ? y : x, k0 = dir === 0 ? x : y;
      if(used[i] & bit) continue;
      const nb = dir === 0 ? (x < w - 1 ? i + 1 : i + 1 - w) : (y < h - 1 ? i + w : i), qa = q[i], qb = q[nb];
      if((qa > qb ? qa - qb : qb - qa) < 0.1*(qa > qb ? qa : qb)) continue;
      const s = J(line0, k0, 1) ? 1 : J(line0, k0, -1) ? -1 : 0;
      if(!s) continue;
      used[i] |= bit;
      let n = 0, head = cl.length >> 1, tail = head;
      cl[head] = line0; ck[head] = k0; tail++;
      for(let d=-1;d<=1;d+=2){
        let line = line0, k = k0;
        for(;;){
          line += d;
          if(wrap) line = line < 0 ? line + lines : line >= lines ? line - lines : line;
          else if(line < 0 || line >= lines) break;
          const f = follow(J, line, k, s);
          if(f < 0) break;
          const t = at(line, f);
          if(used[t] & bit) break;
          used[t] |= bit; k = f;
          if(d < 0){ if(head === 0) break; head--; cl[head] = line; ck[head] = k; }
          else{ if(tail === cl.length) break; cl[tail] = line; ck[tail] = k; tail++; }
        }
      }
      n = tail - head;
      if(n < 6) continue;
      P[0] = PT[0] = TT[0] = PP[0] = 0;
      for(let j=0;j<n;j++){ const p = ck[head + j] + 0.5; P[j + 1] = P[j] + p; PT[j + 1] = PT[j] + p*j; TT[j + 1] = TT[j] + j*j; PP[j + 1] = PP[j] + j; }
      for(let j=0;j<n;j++){
        const lo0 = Math.max(0, j - N), hi0 = Math.min(n, j + N + 1), c = hi0 - lo0;
        const sp = P[hi0] - P[lo0], st = PP[hi0] - PP[lo0], stt = TT[hi0] - TT[lo0], spt = PT[hi0] - PT[lo0];
        const mt = st/c, mp = sp/c, vt = stt/c - mt*mt, fitted = mp + (vt > 1e-6 ? (spt/c - mt*mp)/vt : 0)*(j - mt);
        const line = cl[head + j], k = ck[head + j];
        const a = q[at(line, k)], b = q[at(line, k + 1)], hi = a > b ? a : b, lo = a > b ? b : a;
        for(let m=k - 1;m<=k + 2;m++){
          const t = at(line, m);
          if(edge[t] !== 2 || done[t]) continue;
          const cv = Math.min(1, Math.max(0, s*(m - fitted) + 0.5));
          g[t] = Math.round(lo + cv*(hi - lo)); done[t] = 1;
        }
      }
    }
  }
  for(let y=0;y<h;y++){
    const row = y*w, dst = (h - 1 - y)*w, rs = [cy(y - 2)*w, cy(y - 1)*w, cy(y + 1)*w, cy(y + 2)*w];
    for(let x=0;x<w;x++){
      const i = row + x, r = toHalf(q[i]/65535);
      let v = g[i];
      if(edge[i] && !done[i]){
        const x0 = wx(x - 2), x1 = wx(x - 1), x2 = wx(x + 1), x3 = wx(x + 2);
        v = 0;
        for(let j=0;j<4;j++){ const o = rs[j]; v += q[o + x0] + q[o + x1] + q[o + x2] + q[o + x3]; }
        v /= 16;
      }
      out[(dst + x)*2] = r; out[(dst + x)*2 + 1] = v === q[i] ? r : toHalf(v/65535);
    }
  }
}

self.onmessage = async e=>{
  const { id, url, smooth, band, near, far } = e.data;
  try{
    const res = await fetch(url);
    if(!res.ok) throw new Error('Could not load ' + url + ' (' + res.status + ')');
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const w = bmp.width, h = bmp.height, q = new Uint16Array(w*h);
    const rowsPer = Math.max(1, Math.min(h, (band/w)|0));
    const c = new OffscreenCanvas(w, rowsPer), x = c.getContext('2d', { willReadFrequently: true });
    for(let y0=0;y0<h;y0+=rowsPer){
      const rows = Math.min(rowsPer, h - y0);
      x.clearRect(0, 0, w, rowsPer);
      x.drawImage(bmp, 0, y0, w, rows, 0, 0, w, rows);
      const d = x.getImageData(0, 0, w, rows).data;
      for(let i=0, o=y0*w;i<w*rows;i++) q[o + i] = d[i*4]*256 + d[i*4 + 1];
    }
    bmp.close();
    const out = new Uint16Array(smooth ? w*h : w*h*2);
    if(smooth) for(let y=0;y<h;y++){
      const src = (h - 1 - y)*w, dst = y*w;
      for(let i=0;i<w;i++) out[dst + i] = toHalf(q[src + i]/65535);
    }else edgeDepth(q, w, h, out, (1/150 - 1/far)/(1/near - 1/far)*65535, (1/300 - 1/far)/(1/near - 1/far)*65535);
    const soft = smooth ? null : softDepth(q, w, h, Math.max(1, Math.round(w/768)));
    self.postMessage({ id, w, h, data: out, soft }, soft ? [out.buffer, soft.data.buffer] : [out.buffer]);
  }catch(err){
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
