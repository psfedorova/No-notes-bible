import { renderer } from '../scene/renderer.js';

let el = null, times = [], cpu = [], gpu = [], shownAt = 0, mode = null;
let gl = null, ext = null, open = null;
const pending = [];
function dropQueries(){
  if(open){ gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(open); open = null; }
  pending.forEach(q => gl.deleteQuery(q));
  pending.length = 0;
}
function toggleMeter(){
  if(el){ el.remove(); el = null; if(ext) dropQueries(); return; }
  el = document.createElement('div');
  el.className = 'fps';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  times = []; cpu = []; gpu = []; shownAt = 0; mode = null;
  if(!gl){ gl = renderer.getContext(); ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); }
}
function meterBegin(){
  if(!el || !ext || open) return;
  open = gl.createQuery();
  gl.beginQuery(ext.TIME_ELAPSED_EXT, open);
}
function meterEnd(){
  if(!open) return;
  gl.endQuery(ext.TIME_ELAPSED_EXT);
  pending.push(open);
  open = null;
}
function pollGpu(now){
  while(pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)){
    const q = pending.shift();
    if(!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push([now, gl.getQueryParameter(q, gl.QUERY_RESULT)/1e6]);
    gl.deleteQuery(q);
  }
}
const trim = (a, now)=>{ while(a.length && now - a[0][0] > 1000) a.shift(); };
const avg = a => a.reduce((s, x)=> s + x[1], 0)/a.length;
function meterTick(now, resting, cpuMs){
  if(!el) return;
  if(resting !== mode){ mode = resting; times = []; cpu = []; gpu = []; if(ext) dropQueries(); }
  times.push(now);
  cpu.push([now, cpuMs]);
  if(ext) pollGpu(now);
  while(times.length > 2 && now - times[0] > 1000) times.shift();
  trim(cpu, now); trim(gpu, now);
  if(now - shownAt < 250 || times.length < 3) return;
  shownAt = now;
  const fps = Math.round((times.length - 1)*1000/(now - times[0]));
  const c = avg(cpu), g = gpu.length ? avg(gpu) : null;
  const [tone, word] = resting ? ['rest', 'resting'] : fps >= 50 ? ['good', 'smooth'] : fps >= 30 ? ['ok', 'okay'] : ['bad', 'slow'];
  const parts = [`${fps} fps`, `cpu ${c.toFixed(1)} ms`];
  if(g !== null) parts.push(`gpu ${g.toFixed(1)} ms`, `up to ${Math.round(1000/Math.max(c, g, 0.1))}`);
  else if(ext) parts.push('gpu …');
  else parts.push('gpu n/a');
  parts.push(word);
  el.dataset.tone = tone;
  el.textContent = parts.join(' · ');
}
addEventListener('keydown', e=>{
  if(e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'Digit5'){ e.preventDefault(); e.stopPropagation(); toggleMeter(); }
}, true);
if(/[?&]fps\b/.test(location.search)) toggleMeter();

export {
  meterBegin, meterEnd, meterTick
};
