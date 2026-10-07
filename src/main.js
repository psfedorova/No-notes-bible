/* ============================================================================
   Liber Arcanum: a WebGL grimoire you can turn in your hands and write in.
   The entry point: wires the modules together, boots the book and starts the loop.

   Hybrid build. Blender (blender/build_assets.py) makes the static pieces: the
   gilt filigree of both boards as raised geometry, the tooling masks and the
   boulder. Poly Haven scans supply the forest light, the moss and the leather
   grain. Everything that moves is built here.

   Every leaf is a real slab of parchment with its own thickness, sewn to its own
   station on the spine. Leaves are inextensible: their cross-section is built
   by integrating an angle along the arc, so a page never stretches, the fore
   edge of an open stack slants the way a real one does, and thickness moves
   from one side to the other as pages turn.

   Ink is painted straight into the page texture. A hidden <textarea> takes the
   keyboard (any layout, IME, undo), and the caret and selection are drawn on
   the parchment, so the book can be written in at any angle. Fresh letters
   burn in with a glow before they settle into the vellum as ink.
   ==========================================================================*/
import * as THREE from 'three';
import { createShelf } from './sharing/shelf.js';
import { FILM, intro, T0 } from './core/launch.js';
import { capFont, CH, CVR, CW, fontCss, FONTS, LS_KEY, N, OPEN, PAGE_H, PAGE_W, ROCK_TOP } from './core/config.js';
import { camera, renderer, scene } from './scene/renderer.js';
import { beam, BEAM_DIR, beamU } from './scene/sunbeam.js';
import { composer } from './scene/post.js';
import { bookRoot, floatGrp, spinGrp } from './scene/rig.js';
import { matGold } from './book/materials.js';
import { blankMat, invitePaper, MOTTO, pageBackground, TITLE } from './book/print.js';
import { pageCache, pages, paintPage } from './book/pages.js';
import { frontGem, frontGrp } from './book/boards.js';
import { matSpine } from './book/spine.js';
import { leaves, pagePointWorld } from './book/leaves.js';
import { invalidateLayout, layout, st } from './book/state.js';
import { camTarget, fitDistance, glideSpin, homeQuat, orbit, qOpenHome, spinGoal } from './book/view.js';
import { applyPage, booted, BROWSER_HAND, exportText, handsOf, loadAll, personalData, personalPages, saveCopy, setBooted, setShelf, shelf, takePersonal, useBook } from './ink/storage.js';
import { toast } from './ui/toast.js';
import { enterWriting, exitWriting, quill, readOnly, writing } from './ink/writing.js';
import { sfx } from './audio/sound.js';
import { emitOpenBurst } from './fx/magic.js';
import { fallers } from './scene/forest-life.js';
import { pickAt } from './input/gestures.js';
import { flip, setOpen } from './book/turning.js';
import { erasePages, pour, quillTo, restoreErased } from './ink/spells.js';
import { seekSpread, turnToPage } from './book/seek.js';
import { closeMenu, menuEl, menuNotes, refreshUI } from './ui/controls.js';
import { backdrop } from './scene/forest.js';
import { loadAssets, loadMore } from './assets/load.js';
import { calm, frame, onResize, rafLoop, update, warmUp } from './app/loop.js';
import { pagePuff, pageShine, playLive, settled, takeOver, titleBurn, titleBurnPlan, titleReveal } from './film/opening.js';

/* what the opening's story (film/capture.js) works the scene with */
function filmHooks(){
  return { THREE, scene, renderer, st, orbit, setOpen, beam, beamU, BEAM_DIR, pageShine, frame, update, camera, frontGem, spinGrp, spinGoal, qOpenHome, fallers, emitOpenBurst, matGold, pagePointWorld, PAGE_W, PAGE_H, bookRoot, floatGrp, OPEN, frontGrp, CW, CH, CVR, titleReveal, matSpine, titleBurn, titleBurnPlan, pagePuff,
    render(){ renderer.shadowMap.needsUpdate = true; if(backdrop){ backdrop.material.uniforms.uCam.value.copy(camera.position); backdrop.draw(); } composer.render(0); } };
}

/* ---------------- boot ---------------- */
async function boot(){
  try{
    await Promise.race([
      Promise.all([
        ...FONTS.map(f=>document.fonts.load(fontCss(f, 40), 'AaЯяЖж')),
        document.fonts.load('600 40px "Cormorant SC"', 'LIBER ARCANUM'),
        document.fonts.load('700 40px "Cormorant SC"', 'LIBER ARCANUM'),
        document.fonts.load('40px "UnifrakturMaguntia"', TITLE),
        ...FONTS.map(f=>document.fonts.load(capFont(f, 80), 'HIZЗЖВ')),
        document.fonts.load('italic 500 40px "Cormorant Garamond"', MOTTO.join(' '))
      ]),
      new Promise(r=>setTimeout(r, 4000))
    ]);
  }catch(e){}
  try{
    await loadAssets();
    if(intro && intro.stage) intro.stage(.88);
  }catch(e){
    const l = document.getElementById('introNote');
    if(l){ l.textContent = 'THE TOME COULD NOT BE KINDLED'; l.parentNode.classList.add('wait'); }
    throw e;
  }
  loadAll();
  setShelf(createShelf({
    N, page: n => pages[n], handsOf, personalHand: BROWSER_HAND, toast, personalPages, applyPage,
    personalData, takePersonal, exportText, saveCopy,
    useBook: (key, hand)=> useBook(key, hand, !booted),
    settled: ()=> settled ? settled.p : Promise.resolve(),
    usePersonal: ()=> useBook(LS_KEY, BROWSER_HAND, !booted),
    refresh: ()=>{ if(writing && readOnly()) exitWriting(); refreshUI(); if(!menuEl.hidden) menuNotes(); },
    blurQuill: ()=>{ closeMenu(); if(writing) quill.blur(); },
    focusQuill: ()=>{ if(writing) quill.focus({ preventScroll: true }); },
    paper: invitePaper,
    sfx: (k, arg)=>{ if(sfx[k]) sfx[k](arg); },
  }));
  shelf.start();
  /* the title page and the blanks were painted before the fonts arrived */
  blankMat[0].map.image = pageBackground(-2); blankMat[0].map.needsUpdate = true;
  blankMat[1].map.image = pageBackground(-1); blankMat[1].map.needsUpdate = true;
  pageCache.forEach((e,n)=>{ e.bg = pageBackground(n); paintPage(n); });
  if(FILM) st.open = false;
  /* the opening played live: the story's things are made and its shaders built before
     warmUp, so nothing compiles while it runs; the book waits shut on its title page */
  const live = intro && intro.live;
  if(live){
    st.open = false; st.k = 0; invalidateLayout();
    window.__book.film = { ...filmHooks(), live: true };
    try{ await import('./film/capture.js'); }catch(e){ console.warn('The opening could not be played:', e); }
  }
  await warmUp();
  if(live && window.__film && window.__film.live){
    window.__book.bootMs = Math.round(performance.now() - T0);
    await new Promise(r=>intro.ready(()=>{ playLive(window.__film.live); r(); }));
  }else if(intro){
    if(intro.stage) intro.stage(.95);
    const poses = await fetch('assets/intro/poses.json').then(r=>r.json()).catch(()=>null);
    window.__book.bootMs = Math.round(performance.now() - T0);
    await new Promise(r=>intro.ready(mode=>{ takeOver(mode, poses); r(); }));
  }else{
    st.theta = st.open ? OPEN : 0;
    spinGrp.quaternion.copy(homeQuat());
    spinGoal.copy(spinGrp.quaternion);
    layout(true);
    st.camD = fitDistance();
    camTarget.set(0, ROCK_TOP + 0.4, 0);
    onResize();
    refreshUI();
    frame();
    window.__book.bootMs = Math.round(performance.now() - T0);
  }
  setBooted(true);
  if(FILM){
    /* the film is shot with everything in, at full size */
    await loadMore();
    window.__book.film = filmHooks();
    import('./film/capture.js?v=' + Date.now());
    return;
  }
  requestAnimationFrame(rafLoop);
  /* the rest comes once the book is in the reader's hands (after the opening, if any) */
  Promise.resolve(settled && settled.p).then(()=>loadMore(calm));
}
document.fonts.addEventListener && document.fonts.addEventListener('loadingdone', ()=>{ pageCache.forEach((e,n)=>paintPage(n)); });

window.__book = { st, orbit, leaves, pages, composer, get backdrop(){ return backdrop; }, flip, setOpen, seekSpread, turnToPage, erasePages, restoreErased, quillTo, pour, enterWriting, exitWriting, pickAt, camera, scene, renderer, spinGrp, THREE, glideSpin, homeQuat,
  shelf: ()=> shelf,
  info(){ return { open:st.open, k:st.k, theta:st.theta, lift:+st.lift.toFixed(3), writing: writing && writing.n, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, cache: pageCache.size }; } };
boot();
