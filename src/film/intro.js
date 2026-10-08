(()=>{
  const box = document.getElementById('intro');
  if(/[?&]film\b/.test(location.search)){ document.documentElement.classList.add('film'); box.remove(); return; }
  const svg = box.querySelector('svg.draw');
  const ticks = box.querySelector('.ticks'), core = svg.querySelector('.core');
  const V = [...Array(7)].map((_, k)=>{ const a = -Math.PI/2 + k*2*Math.PI/7; return [78*Math.cos(a), 78*Math.sin(a)]; });
  const star = svg.querySelector('.star');
  V.forEach((p, k)=>{
    const q = V[(k + 3)%7], l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    [['x1', p[0]], ['y1', p[1]], ['x2', q[0]], ['y2', q[1]]].forEach(([n, x])=>l.setAttribute(n, x.toFixed(2)));
    l.setAttribute('class', 'ln'); l.setAttribute('pathLength', '1');
    star.appendChild(l);
  });
  const [outer, inner, ...rest] = [...svg.querySelectorAll('.ln')], small = rest.pop();
  const PARTS = [[outer, 0, .22], [inner, .2, .4], ...rest.map(l=>[l, .4, .82]), [small, .82, 1]];
  const draw = p=>{
    PARTS.forEach(([l, a, b])=>{
      const f = Math.min(1, Math.max(0, (p - a)/(b - a)));
      if(l.tagName === 'line'){ l.style.strokeDasharray = `${f/2} ${1 - f} ${f/2}`; l.style.strokeDashoffset = 0; }
      else l.style.strokeDashoffset = 1 - f;
      l.style.opacity = f > 0.002 ? 1 : 0;
    });
    ticks.setAttribute('opacity', Math.min(1, Math.max(0, (p - .1)/.2)).toFixed(2));
    core.setAttribute('opacity', (.35 + .65*p).toFixed(2));
  };
  let goal = 0, shown = 0, rush = false, prev = performance.now();
  const aim = p=>{ goal = Math.max(goal, Math.min(1, p)); };
  const step = now=>{
    const dt = Math.min(0.1, (now - prev)/1000);
    prev = now;
    const to = rush ? 1 : shown < goal ? goal : Math.min(.97, goal + .1);
    const k = rush ? 7 : shown < goal ? 2.2 : 0.06;
    shown += (to - shown)*(1 - Math.exp(-k*dt));
    if(rush && shown > .995) shown = 1;
    draw(shown);
    if(!I.gone && shown < 1) requestAnimationFrame(step);
  };
  for(let i=0;i<7;i++){
    const m = document.createElement('i');
    m.className = 'mote';
    m.style.cssText = `left:${30 + Math.random()*40}%;top:${42 + Math.random()*22}%;--dx:${(Math.random() - .5)*60}px;animation-delay:${(i*1.1 + Math.random()).toFixed(2)}s;animation-duration:${(6 + Math.random()*3).toFixed(2)}s`;
    box.querySelector('#veil').appendChild(m);
  }
  Promise.race([document.fonts.load('600 16px "Cormorant SC"', 'LIBER ARCANUM'), new Promise(r=>setTimeout(r, 1500))])
    .then(()=>box.classList.add('named'), ()=>box.classList.add('named'));

  const kind = innerWidth/innerHeight < 0.9 ? 'tall' : 'wide';
  const I = window.__intro = { kind, fit: 'cover', take: null, gone: false, live: false };
  I.stage = aim;
  draw(0);
  requestAnimationFrame(step);
  const EXPECT = matchMedia('(pointer: coarse)').matches ? 15e6 : 16e6;
  setInterval(()=>{
    if(I.gone || lifting) return;
    let got = 0;
    for(const e of performance.getEntriesByType('resource')) got += e.encodedBodySize || e.transferSize || 0;
    aim(.8*Math.min(1, got/EXPECT));
    check();
  }, 300);

  const SEEN = 'liber-arcanum.film-seen';
  let seen = false;
  try{ seen = !!localStorage.getItem(SEEN); }catch(e){}
  if(/[?&]intro\b/.test(location.search)){
    seen = false;
    const u = new URL(location.href);
    u.searchParams.delete('intro');
    history.replaceState(null, '', u);
  }
  let invited = /^#join=[A-Za-z0-9]{6,40}\.[a-z0-9]{24,64}/.test(location.hash);
  try{ invited = invited || !!sessionStorage.getItem('liber-arcanum.join'); }catch(e){}
  if(invited) seen = false;
  I.live = !seen && !matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* browsers block audio before the first user activation */
  let quiet = false;
  try{ quiet = localStorage.getItem('liber-arcanum.muted') === '1'; }catch(e){}
  const score = I.live && !quiet ? new Audio('assets/intro/score_' + kind + '.m4a') : null;
  if(score) score.preload = 'auto';

  const finish = mode=>{
    if(I.gone) return;
    I.gone = true;
    I.take(mode);
    if(!story) end();
  };
  let lifting = false;
  const lift = ()=>{
    if(lifting || I.gone) return;
    lifting = true;
    rush = true;
    box.classList.add('done');
    setTimeout(()=>finish(I.live ? 'live' : 'closed'), 700);
  };
  const check = ()=>{
    if(I.gone || lifting || !I.take || I.holding) return;
    lift();
  };
  I.ready = take=>{ I.take = take; check(); };
  I.wait = p=>{ I.holding = true; p.then(()=>{ I.holding = false; check(); }); };

  let story = null, hush = false;
  I.started = L=>{
    story = L;
    try{ localStorage.setItem(SEEN, '1'); }catch(e){}
    box.classList.add('live');
    if(score){
      const p = score.play();
      if(p && p.catch) p.catch(()=>{ hush = true; box.classList.add('hush'); });
    }
  };
  const end = ()=>{
    story = null;
    box.classList.add('gone');
    if(score && !score.paused){ const fade = setInterval(()=>{ score.volume = Math.max(0, score.volume - 0.05); if(score.volume <= 0){ clearInterval(fade); score.pause(); } }, 60); }
    setTimeout(()=>box.remove(), 1200);
  };
  I.end = end;
  const touch = e=>{
    if(!story) return;
    if(e.type === 'keydown' && (e.metaKey || e.ctrlKey || (I.holding && e.target.closest && e.target.closest('#shelf')))) return;
    e.stopPropagation();
    if(e.cancelable) e.preventDefault();
    if(e.type === 'wheel') return;
    if(hush){
      hush = false;
      box.classList.remove('hush');
      score.currentTime = story.t;
      score.play().catch(()=>{});
      return;
    }
    story.skip();
  };
  ['pointerdown', 'keydown', 'wheel'].forEach(t=>addEventListener(t, touch, { capture: true, passive: false }));
})();
