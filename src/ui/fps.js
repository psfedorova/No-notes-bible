let el = null, times = [], cpu = [], shownAt = 0, mode = null;
function toggleMeter(){
  if(el){ el.remove(); el = null; return; }
  el = document.createElement('div');
  el.className = 'fps';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  times = []; cpu = []; shownAt = 0; mode = null;
}
function meterTick(now, resting, cpuMs){
  if(!el) return;
  if(resting !== mode){ mode = resting; times = []; cpu = []; }
  times.push(now);
  cpu.push(cpuMs);
  while(times.length > 2 && now - times[0] > 1000){ times.shift(); cpu.shift(); }
  if(now - shownAt < 250 || times.length < 3) return;
  shownAt = now;
  const fps = Math.round((times.length - 1)*1000/(now - times[0]));
  let worst = 0;
  for(let i=1;i<times.length;i++) worst = Math.max(worst, times[i] - times[i - 1]);
  const c = cpu.reduce((s, x)=> s + x, 0)/cpu.length;
  el.dataset.tone = resting ? 'rest' : fps >= 50 ? 'good' : fps >= 30 ? 'ok' : 'bad';
  el.textContent = `${fps} fps\ncpu ${c.toFixed(1)} ms\nmax ${Math.round(worst)} ms${resting ? '\nrest' : ''}`;
}
/* Option+5 types [ { or ∞ on a Mac, so text fields keep it */
const typing = t => t instanceof Element && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
addEventListener('keydown', e=>{
  if(e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'Digit5' && !e.isComposing && !typing(e.target)){ e.preventDefault(); e.stopPropagation(); toggleMeter(); }
}, true);
if(/[?&]fps\b/.test(location.search)) toggleMeter();

export {
  meterTick
};
