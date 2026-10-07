/* the opening. A magic circle draws itself as the book's files and the film arrive;
   when the book is ready and the whole film is in hand, the circle flares, the veil
   lifts off the film's first frame and the film plays undisturbed (nothing else
   loads or draws meanwhile). At its last frame the live book takes over.
   On a slow line the film watches its own download and falls back to a lighter cut;
   if even that is not in soon after the book, there is no film: the veil lifts
   straight onto the live book, which opens itself. A tap or a key skips the film */
(()=>{
  const box = document.getElementById('intro');
  if(/[?&]film\b/.test(location.search)){ document.documentElement.classList.add('film'); box.remove(); return; }
  const v = box.querySelector('video'), svg = box.querySelector('svg.draw');
  const ticks = box.querySelector('.ticks'), core = svg.querySelector('.core');
  /* the seven-pointed star of the book's watermark: its seven strokes grow together
     from both ends, so its points come up first and the strokes close in the middle */
  const V = [...Array(7)].map((_, k)=>{ const a = -Math.PI/2 + k*2*Math.PI/7; return [78*Math.cos(a), 78*Math.sin(a)]; });
  const star = svg.querySelector('.star');
  V.forEach((p, k)=>{
    const q = V[(k + 3)%7], l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    [['x1', p[0]], ['y1', p[1]], ['x2', q[0]], ['y2', q[1]]].forEach(([n, x])=>l.setAttribute(n, x.toFixed(2)));
    l.setAttribute('class', 'ln'); l.setAttribute('pathLength', '1');
    star.appendChild(l);
  });
  const [outer, inner, ...rest] = [...svg.querySelectorAll('.ln')], small = rest.pop();
  /* the outer ring, the inner one, the star, the small ring at its heart: one after another */
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
  /* what has arrived sets a goal and the drawing eases toward it, so a big file landing
     never makes it leap; while nothing arrives (the page building the forest) it keeps
     creeping a little way on, slower the further it gets ahead */
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

  /* the cuts there are; a tall screen without its own cut sees the wide one whole */
  const CUTS = ['wide', 'tall'], tall = innerWidth/innerHeight < 0.9;
  const kind = tall && CUTS.includes('tall') ? 'tall' : 'wide', fit = tall && kind === 'wide' ? 'contain' : 'cover';
  const I = window.__intro = { kind, fit, take: null, film: null, gone: false };
  /* the book reports how far it has got once its files are in (src/main.js, boot) */
  I.stage = aim;
  draw(0);
  requestAnimationFrame(step);
  box.classList.add(fit);
  const OPENED = 7.3;
  /* what the book itself downloads, roughly, on this kind of device, and the film */
  const EXPECT = matchMedia('(pointer: coarse)').matches ? 35e6 : 54e6;
  const FILM_GUESS = kind === 'tall' ? 3.5e6 : 6.2e6;
  /* how long the film may keep the reader waiting once the book is ready */
  const LATE = 5000;
  let ctl = null, filmGot = 0, filmTotal = FILM_GUESS, noFilm = false, bookAt = 0, playing = false, lastT = -1, lastMove = 0;

  const finish = mode=>{
    if(I.gone) return;
    I.gone = true;
    I.take(mode);
    box.classList.add(...(mode === 'open' ? ['swift', 'gone'] : ['gone']));
    setTimeout(()=>{ v.removeAttribute('src'); v.load(); if(I.film) URL.revokeObjectURL(I.film); box.remove(); }, 1000);
  };
  /* the film has its music, unless the reader turned the sound off; a browser that
     will not let a page sound before it is touched gets the film without it */
  let quiet = false;
  try{ quiet = localStorage.getItem('liber-arcanum.muted') === '1'; }catch(e){}
  const roll = mute=>{
    v.muted = mute;
    const p = v.play();
    if(p && p.catch) p.catch(()=>{ if(!mute){ box.classList.add('hush'); roll(true); } else finish('closed'); });
  };
  /* the circle completes and flares, then the veil lifts */
  let lifting = false;
  const lift = ()=>{
    if(lifting || I.gone) return;
    lifting = true;
    rush = true;
    box.classList.add('done');
    if(!I.film || noFilm){ setTimeout(()=>finish('closed'), 700); return; }
    /* the player starts under the veil, so its first steps are never seen */
    v.addEventListener('playing', ()=>setTimeout(()=>box.classList.add('play', 'reveal'), 250), { once: true });
    setTimeout(()=>roll(quiet), 450);
    setTimeout(()=>{ if(!playing) finish('closed'); }, 4000);
  };
  const check = ()=>{
    if(I.gone || lifting || !I.take || I.holding) return;
    if(noFilm) return lift();
    if(I.film && v.readyState >= 2) return lift();
    if(performance.now() - bookAt > LATE){ noFilm = true; if(ctl) ctl.abort(); lift(); }
  };
  I.ready = take=>{ I.take = take; bookAt = performance.now(); check(); };
  /* an invitation is read over the circle first; the film waits until it is done */
  I.wait = p=>{ I.holding = true; p.then(()=>{ I.holding = false; bookAt = performance.now(); check(); }); };

  setInterval(()=>{
    if(I.gone || lifting) return;
    let got = 0;
    for(const e of performance.getEntriesByType('resource')) if(!/assets\/intro\//.test(e.name)) got += e.encodedBodySize || e.transferSize || 0;
    const film = noFilm ? 0 : filmTotal;
    aim(.8*Math.min(1, (got + (noFilm ? 0 : filmGot))/(EXPECT + film)));
    check();
  }, 300);

  v.addEventListener('playing', ()=>{ playing = true; lastMove = performance.now(); try{ localStorage.setItem(SEEN, '1'); }catch(e){} });
  v.addEventListener('timeupdate', ()=>{ if(v.currentTime !== lastT){ lastT = v.currentTime; lastMove = performance.now(); } });
  v.addEventListener('ended', ()=>finish('open'));
  v.addEventListener('error', ()=>{ if(!lifting){ noFilm = true; check(); } else finish('closed'); });
  v.addEventListener('loadeddata', check);
  /* a film that stops moving for good hands over to the book */
  setInterval(()=>{
    if(playing && !I.gone && performance.now() - lastMove > 3000) finish(v.currentTime > OPENED ? 'open' : 'closed');
  }, 500);

  /* the film comes down whole before it plays, so it never waits on the line */
  const fetchCut = async cut=>{
    ctl = new AbortController();
    const res = await fetch('assets/intro/' + kind + cut + '.mp4?v=7', { signal: ctl.signal });
    if(!res.ok) throw new Error(res.status);
    filmTotal = +res.headers.get('content-length') || filmTotal;
    filmGot = 0;
    const t0 = performance.now(), parts = [], rd = res.body.getReader();
    for(;;){
      const { done, value } = await rd.read();
      if(done) break;
      parts.push(value);
      filmGot += value.length;
      const el = (performance.now() - t0)/1000;
      /* at this pace the full cut would take too long: the lighter one instead */
      if(cut === '' && el > 2.5 && (filmTotal - filmGot)/(filmGot/el) > 9){ ctl.abort(); return fetchCut('_lite'); }
    }
    return new Blob(parts, { type: 'video/mp4' });
  };
  /* the film plays on the first visit only; ?intro shows it again */
  const SEEN = 'liber-arcanum.film-seen';
  let seen = false;
  try{ seen = !!localStorage.getItem(SEEN); }catch(e){}
  if(/[?&]intro\b/.test(location.search)){
    seen = false;
    const u = new URL(location.href);
    u.searchParams.delete('intro');
    history.replaceState(null, '', u);
  }
  /* an invitation always ends in the film, seen before or not: the vow opens the book.
     The invitation is in the address, or kept for this tab across a sign-in */
  let invited = /^#join=[A-Za-z0-9]{6,40}\.[a-z0-9]{24,64}/.test(location.hash);
  try{ invited = invited || !!sessionStorage.getItem('liber-arcanum.join'); }catch(e){}
  if(invited) seen = false;
  if(seen || matchMedia('(prefers-reduced-motion: reduce)').matches || (navigator.connection && navigator.connection.saveData)) noFilm = true;
  else fetchCut('').then(blob=>{
    if(noFilm || I.gone) return;
    I.film = URL.createObjectURL(blob);
    v.preload = 'auto';
    v.src = I.film;
    v.load();
  }).catch(()=>{ noFilm = true; check(); });

  /* a film the browser made start silent takes the first touch as a wish to hear it,
     not to skip it: the touch is what the browser was waiting for */
  const skip = ()=>{
    if(!playing || I.gone) return;
    if(box.classList.contains('hush')){ box.classList.remove('hush'); v.muted = false; return; }
    finish(v.currentTime > OPENED ? 'open' : 'closed');
  };
  box.addEventListener('pointerdown', skip);
  /* keys belong to the opening, except those typed into an invitation shown over it */
  addEventListener('keydown', e=>{ if(!I.gone && !e.metaKey && !e.ctrlKey && !(I.holding && e.target.closest && e.target.closest('#shelf'))){ e.stopPropagation(); skip(); } }, true);
})();
