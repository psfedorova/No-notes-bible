/* the controls: buttons, the menu, the pager and the keys */
import { sharingOn } from '../sharing/shelf.js';
import { N } from '../core/config.js';
import { st } from '../book/state.js';
import { onePage, pageStep, shownPage } from '../book/view.js';
import { copyPicker, exportFile, exportText, homeSpread, saveCopy, saveNow, shelf } from '../ink/storage.js';
import { toast } from './toast.js';
import { exitWriting, quill, readOnly, writing } from '../ink/writing.js';
import { sfx } from '../audio/sound.js';
import { writePose } from '../input/gestures.js';
import { setOpen } from '../book/turning.js';
import { eraseHere, erasePages, eraseTargets, lastErase, restoreErased } from '../ink/spells.js';
import { seekSpread } from '../book/seek.js';
import { closeSpells, openSeek, openSpells, seekIn, spellsEl } from './dialogs.js';

const pagerEl = document.getElementById('pager');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnWrite = document.getElementById('btnWrite');
const btnBook = document.getElementById('btnBook');
btnPrev.addEventListener('click', ()=> pageStep(-1));
btnNext.addEventListener('click', ()=> pageStep(1));
btnWrite.addEventListener('click', ()=> writing ? exitWriting() : writePose());
btnBook.addEventListener('click', ()=> toggleBook());

/* everything that otherwise lives on a key, for a phone */
const btnMore = document.getElementById('btnMore');
const menuEl = document.getElementById('menu');
const menuBtn = act => menuEl.querySelector(`[data-act="${act}"]`);
/* one erase line per page of the open spread that has writing on it */
const eraseLabel = n => `Erase page ${n + 1}`;
/* the pages whose history the menu opens: the one under the quill, else the open spread */
const historyPages = ()=> writing ? [writing.n] : st.open ? [2*st.k - 1, 2*st.k].filter(n => n >= 1 && n < 2*N) : [];
function menuView(name){
  menuEl.querySelectorAll('.view').forEach(v=>{ v.hidden = v.dataset.view !== name; });
}
function openMenu(){
  closeSpells();
  menuView('main');
  const share = menuBtn('share');
  share.hidden = !sharingOn;
  share.querySelector('span').textContent = shelf ? shelf.note() : 'Send the book to a friend';
  const list = readOnly() ? [] : eraseTargets();
  [menuBtn('erase'), menuBtn('erase2')].forEach((b, i)=>{
    const n = list[i];
    b.hidden = n === undefined;
    b.dataset.page = n === undefined ? '' : n;
    if(n !== undefined) b.textContent = eraseLabel(n);
  });
  menuBtn('restore').hidden = readOnly() || !lastErase || performance.now() - lastErase.at > 60000;
  menuBtn('history').hidden = !shelf || !shelf.shared() || !historyPages().length;
  menuBtn('files').querySelector('span').textContent = !shelf || shelf.kept() ? 'Download or restore the book' : 'Back it up to keep it safe';
  menuEl.querySelector('.menu-note').textContent = shelf ? shelf.status() : 'Saves automatically';
  menuEl.hidden = false;
  btnMore.setAttribute('aria-expanded', 'true');
}
function replayOpening(){
  const u = new URL(location.href);
  u.searchParams.set('intro', '');
  location.href = u;
}
function closeMenu(){
  if(menuEl.hidden) return;
  menuEl.hidden = true;
  btnMore.setAttribute('aria-expanded', 'false');
}
btnMore.addEventListener('click', ()=> menuEl.hidden ? openMenu() : closeMenu());
menuEl.addEventListener('click', e=>{
  const b = e.target.closest('button[data-act]');
  if(!b || b.disabled) return;
  if(b.dataset.act === 'files' || b.dataset.act === 'main'){
    menuView(b.dataset.act);
    menuEl.querySelector(`.view:not([hidden]) button:not([hidden])`).focus();
    return;
  }
  closeMenu();
  const page = ()=> erasePages([+b.dataset.page]);
  ({ erase: page, erase2: page, restore: restoreErased, exportText, saveCopy: ()=> saveCopy(false), openCopy: ()=> copyPicker.click(), replay: replayOpening, spells: openSpells, share: ()=> shelf && shelf.open(), history: ()=> shelf && shelf.history(historyPages()) })[b.dataset.act]();
});
addEventListener('pointerdown', e=>{
  if(!menuEl.hidden && !menuEl.contains(e.target) && !btnMore.contains(e.target)) closeMenu();
}, true);
[btnPrev, btnNext, btnWrite, btnBook, btnMore, ...menuEl.querySelectorAll('button')].forEach(b=>b.addEventListener('mousedown', e=>e.preventDefault()));

const spreadLabel = c => c === 0 ? '1' : c === N ? `${2*N}` : `${2*c}–${2*c+1}`;
const btnSound = document.getElementById('btnSound');
function showSound(){
  btnSound.classList.toggle('muted', sfx.muted);
  btnSound.setAttribute('aria-pressed', String(!sfx.muted));
  btnSound.title = sfx.muted ? 'Sound off (M)' : 'Sound on (M)';
}
function toggleSound(){
  sfx.setMuted(!sfx.muted); showSound();
  toast(sfx.muted ? 'SOUND OFF' : 'SOUND ON', 1000);
}
btnSound.addEventListener('mousedown', e=>e.preventDefault());
btnSound.addEventListener('click', toggleSound);
showSound();

function refreshUI(){
  pagerEl.hidden = !st.open;
  const one = onePage(), n = one ? shownPage() : 0;
  btnPrev.disabled = one ? n === 0 : st.k === 0;
  btnNext.disabled = one ? n === 2*N - 1 : st.k === N;
  btnWrite.classList.toggle('on', !!writing);
  document.body.classList.toggle('quill-up', !!writing);
  btnBook.classList.toggle('open', st.open);
  const bookAct = st.open ? 'Close the book' : 'Open the book';
  btnBook.title = `${bookAct} (O)`;
  btnBook.setAttribute('aria-label', bookAct);
  if(document.activeElement !== seekIn) seekIn.value = one ? `${n + 1}` : spreadLabel(st.k);
  btnWrite.title = writing ? 'Set the quill down' : readOnly() ? 'You can only read this book' : 'Lay the book open and write';
}

/* keys instead of buttons, read by position so a Cyrillic layout works the
   same; SPELLS lists them */
function toggleBook(){
  if(!st.open){ seekSpread(homeSpread(), { flourish: false }); return; }
  if(!st.flight && !st.riffle) setOpen(false);
}
document.addEventListener('keydown', e=>{
  if(e.target === quill || e.target === seekIn) return;
  if(shelf && shelf.isOpen()){ if(e.key === 'Escape'){ e.preventDefault(); shelf.close(); } return; }
  const mod = e.metaKey || e.ctrlKey, code = e.code;
  if(!menuEl.hidden && e.key === 'Escape'){ e.preventDefault(); closeMenu(); return; }
  if(!spellsEl.hidden){
    if(e.key === 'Escape' || e.key === '?' || code === 'Slash'){ e.preventDefault(); closeSpells(); }
    return;
  }
  if(e.key === '?' || (mod && code === 'Slash')){ e.preventDefault(); openSpells(); }
  else if(e.key === 'ArrowRight' || e.key === 'PageDown'){
    e.preventDefault();
    if(!st.open) seekSpread(homeSpread(), { flourish: false });
    else if(e.shiftKey) seekSpread(st.k + 5);
    else pageStep(1);
  }
  else if(e.key === 'ArrowLeft' || e.key === 'PageUp'){
    e.preventDefault();
    if(st.open) e.shiftKey ? seekSpread(st.k - 5) : pageStep(-1);
  }
  else if(e.key === 'Home'){ e.preventDefault(); seekSpread(0); }
  else if(e.key === 'End'){ e.preventDefault(); seekSpread(N); }
  else if(e.key === 'Escape'){ if(st.open && !st.flight && !st.riffle) setOpen(false); }
  else if(e.key === 'Enter' && !mod){ e.preventDefault(); writePose(); }
  else if(mod && code === 'KeyZ' && !e.shiftKey){ if(restoreErased()) e.preventDefault(); }
  else if(code === 'KeyG' && !e.altKey){ e.preventDefault(); openSeek(); }
  else if(/^(Digit|Numpad)[0-9]$/.test(code) && !mod && !e.altKey && !e.shiftKey){ e.preventDefault(); openSeek(code.slice(-1)); }
  else if(code === 'KeyE' && !e.altKey && !e.shiftKey){ e.preventDefault(); eraseHere(); }
  else if(code === 'KeyO' && !mod && !e.altKey){ e.preventDefault(); toggleBook(); }
  else if(code === 'KeyM' && !mod){ toggleSound(); }
  else if(mod && code === 'KeyS'){
    e.preventDefault();
    if(e.shiftKey) exportFile(); else saveNow();
  }
});
addEventListener('beforeunload', ()=>saveNow(true));
addEventListener('pagehide', ()=>{ saveNow(true); if(shelf) shelf.flush(); });
document.addEventListener('visibilitychange', ()=>{ if(document.hidden){ saveNow(true); if(shelf) shelf.flush(); } });
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) saveNow(true); });

export {
  closeMenu, menuEl, refreshUI, spreadLabel, toggleBook
};
