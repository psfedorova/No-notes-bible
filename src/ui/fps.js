let el = null, times = [], shownAt = 0;
function toggleMeter(){
  if(el){ el.remove(); el = null; return; }
  el = document.createElement('div');
  el.className = 'fps';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  times = []; shownAt = 0;
}
function meterTick(now, resting){
  if(!el) return;
  times.push(now);
  while(times.length > 2 && now - times[0] > 1000) times.shift();
  if(now - shownAt < 250 || times.length < 3) return;
  shownAt = now;
  const fps = Math.round((times.length - 1)*1000/(now - times[0]));
  const [tone, word] = resting ? ['rest', 'resting'] : fps >= 50 ? ['good', 'smooth'] : fps >= 30 ? ['ok', 'okay'] : ['bad', 'slow'];
  el.dataset.tone = tone;
  el.textContent = `${fps} fps · ${word}`;
}
addEventListener('keydown', e=>{
  if(e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'Digit5'){ e.preventDefault(); e.stopPropagation(); toggleMeter(); }
}, true);
if(/[?&]fps\b/.test(location.search)) toggleMeter();

export {
  meterTick
};
