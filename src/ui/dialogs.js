/* the little windows: a page to turn to, the list of spells */
import { ALT, MOD, N } from '../core/config.js';
import { st } from '../book/state.js';
import { quill, writing } from '../ink/writing.js';
import { turnToPage } from '../book/seek.js';
import { closeMenu, refreshUI, toggleBook } from './controls.js';

/* ---------------- the little windows: a page to turn to, the list of spells ---------------- */
const spellsEl = document.getElementById('spells');
/* the page field in the pager: tap it, type a number, Go */
const seekIn = document.getElementById('pageIn');
function openSeek(first){
  closeSpells(); closeMenu();
  if(!st.open) toggleBook();
  seekIn.value = first || '';
  seekIn.focus({ preventScroll: true });
}
function closeSeek(){
  if(document.activeElement !== seekIn) return;
  if(writing) quill.focus({ preventScroll: true });
  else seekIn.blur();
}
seekIn.addEventListener('focus', ()=>{ seekIn.value = ''; });
seekIn.addEventListener('blur', ()=> refreshUI());
seekIn.addEventListener('input', ()=>{ seekIn.value = seekIn.value.replace(/\D/g, '').slice(0, 3); });
seekIn.addEventListener('keydown', e=>{
  e.stopPropagation();
  if(e.key === 'Escape'){ e.preventDefault(); closeSeek(); }
  else if(e.key === 'Enter'){
    e.preventDefault();
    const P = parseInt(seekIn.value, 10);
    closeSeek();
    if(P >= 1) turnToPage(Math.min(P, 2*N));
  }
});

const SPELLS = [
  ['The book', [
    ['O', 'Open or close the book'],
    ['Enter', 'Lay it open and take up the quill'],
    ['← →', 'Turn a leaf'],
    ['Shift ← →', 'Riffle five leaves'],
    ['Home  End', 'First or last page'],
    ['G  0–9', 'Turn to a page'],
    ['E', 'Erase your writing on the open page'],
  ]],
  ['By hand', [
    ['Swipe', 'Sweep a page sideways to turn it'],
    ['Edge', 'Click by a page\'s outer edge to turn it'],
    ['Click', 'Write where you click on the page'],
    ['Drag', 'Off the pages: look round the glade'],
    ['Right-drag', 'Look round the glade, the book stays in hand'],
  ]],
  ['With the quill', [
    [`${MOD}E`, 'Erase your writing on this page'],
    [`${MOD}Z`, 'Undo erase'],
    [`${MOD}G`, 'Turn to a page'],
    [`${MOD}Enter`, 'Carry on at the next page'],
    ['PgUp  PgDn', 'Quill to the page before or after'],
    ['⌫', 'At the start of a page: back to the page before'],
    ['Esc', 'Set the quill down, again to close'],
  ]],
  ['Always', [
    ['M', 'Sound on or off'],
    [`${MOD}S`, 'Save now (it saves itself anyway)'],
    [`${MOD}Shift S`, 'Back up the book to a file'],
    ['?', 'This list'],
    [`${ALT}5`, 'Frame rate on this device'],
  ]],
];
(()=>{
  const card = spellsEl.querySelector('.card');
  SPELLS.forEach(([title, rows])=>{
    const h = document.createElement('h3'); h.textContent = title; card.appendChild(h);
    rows.forEach(([k, what])=>{
      const r = document.createElement('div'); r.className = 'row';
      const d = document.createElement('span'); d.textContent = what;
      const kk = document.createElement('span'); kk.className = 'keys';
      k.split('  ').forEach(part=>{ const kb = document.createElement('kbd'); kb.textContent = part; kk.appendChild(kb); });
      r.append(d, kk); card.appendChild(r);
    });
  });
  const foot = document.createElement('p'); foot.className = 'foot';
  foot.textContent = 'When a page is full, the words run on to the next page by themselves';
  card.appendChild(foot);
  const foot2 = document.createElement('p'); foot2.className = 'foot';
  foot2.textContent = 'In a shared book anyone can erase or change any page. Each page keeps its history in the ⋯ menu, so whatever was erased can be brought back';
  card.appendChild(foot2);
})();
function openSpells(){ closeSeek(); closeMenu(); spellsEl.hidden = false; if(writing) quill.blur(); }
function closeSpells(){
  if(spellsEl.hidden) return;
  spellsEl.hidden = true;
  if(writing) quill.focus({ preventScroll: true });
}
spellsEl.addEventListener('pointerdown', e=>{ if(e.target === spellsEl) closeSpells(); });
spellsEl.querySelector('.close').addEventListener('click', closeSpells);

export {
  closeSpells, openSeek, openSpells, seekIn, spellsEl
};
