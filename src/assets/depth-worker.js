
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

self.onmessage = async e=>{
  const { id, url, smooth, band } = e.data;
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
    const out = new Uint16Array(w*h);
    for(let y=0;y<h;y++){
      const src = (h - 1 - y)*w, dst = y*w;
      for(let i=0;i<w;i++) out[dst + i] = toHalf(q[src + i]/65535);
    }
    const soft = smooth ? null : softDepth(q, w, h, Math.max(1, Math.round(w/768)));
    self.postMessage({ id, w, h, data: out, soft }, soft ? [out.buffer, soft.data.buffer] : [out.buffer]);
  }catch(err){
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
