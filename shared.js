/* ============================================================================
   shared books: one book written in by several people, kept in Firebase

   Each member signs in with Google. A page is the letters of every hand on it,
   each letter with a position key; a page reads them sorted by key. Every
   hand keeps its letters of a page in a doc of its own (books/{id}/ink/{n}_{uid}),
   which only that hand may write, so two people can write on one page at the
   same time and nobody can erase another's ink. The rules are firestore.rules.
   ==========================================================================*/
import { FIREBASE } from './book-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
const EMU = /[?&]emu\b/.test(location.search);
const CUR_KEY = 'liber-arcanum.current';
const DEV_KEY = 'liber-arcanum.device';
const bookKey = id => `liber-arcanum.book.${id}`;
const inkKey = id => `liber-arcanum.ink.${id}`;
const WRITE_MS = 1500;

export const sharingOn = !!FIREBASE || EMU;

const lsGet = k => { try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } };
const lsSet = (k, v) => { try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} };
const lsDel = k => { try{ localStorage.removeItem(k); }catch(e){} };
const DEV = (()=>{
  let d = lsGet(DEV_KEY);
  if(typeof d !== 'string'){ d = randomId(12); lsSet(DEV_KEY, d); }
  return d;
})();
function randomId(len){
  const A = 'abcdefghijklmnopqrstuvwxyz0123456789', b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return Array.from(b, x => A[x % 36]).join('');
}

/* ---------------- position keys ---------------- */
/* base-62 fractions written as digit strings; plain string order is their
   order. New keys lean towards the lower neighbour, so letters typed one
   after another (the usual way) keep their keys short */
const DIG = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const B62 = 62n;
function keyVal(s, L){
  let v = 0n;
  for(let i=0;i<L;i++) v = v*B62 + BigInt(i < s.length ? DIG.indexOf(s[i]) : 0);
  return v;
}
function keyStr(v, L){
  let s = '';
  for(let i=0;i<L;i++){ s = DIG[Number(v % B62)] + s; v /= B62; }
  return s.replace(/0+$/, '');
}
export function keysBetween(lo, hi, count){
  if(count <= 0) return [];
  if(hi !== null && hi <= lo) hi = null;
  for(let L = Math.max(lo.length, hi ? hi.length : 0, 3); ; L++){
    const A = keyVal(lo, L), Z = hi ? keyVal(hi, L) : B62**BigInt(L), span = Z - A;
    if(span < BigInt(count + 63)) continue;
    const step = span/BigInt(count + 63);
    return Array.from({length: count}, (_, i)=> keyStr(A + step*BigInt(i + 1), L));
  }
}

/* ---------------- the shelf ---------------- */
export function createShelf(api){
  let F = null, loading = null;
  let user = null, cur = null;          // cur: { id, name, owner }
  let books = [], offBooks = null;
  let offInk = null, offMembers = null, offBook = null, firstSnap = true;
  let names = new Map();
  let ink = new Map(), pending = new Set(), merged = new Map(), deferred = new Set();
  let upTm = 0, joinWant = null;

  /* ---------- firebase, loaded only once it is wanted ---------- */
  function firebase(){
    if(F) return Promise.resolve(F);
    if(loading) return loading;
    loading = (async ()=>{
      const [app, auth, fs] = await Promise.all(['app', 'auth', 'firestore'].map(m => import(`${SDK}firebase-${m}.js`)));
      const cfg = FIREBASE || { apiKey: 'demo-key', projectId: 'demo-liber', authDomain: 'localhost' };
      const a = app.initializeApp(cfg);
      const au = auth.getAuth(a);
      let db;
      try{
        db = fs.initializeFirestore(a, EMU ? {} : { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
      }catch(e){ db = fs.getFirestore(a); }
      if(EMU){
        auth.connectAuthEmulator(au, 'http://127.0.0.1:9099', { disableWarnings: true });
        fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      }
      F = { ...fs, ...auth, au, db };
      await new Promise(res=>{ const off = auth.onAuthStateChanged(au, ()=>{ off(); res(); }); });
      user = au.currentUser;
      auth.onAuthStateChanged(au, u => onUser(u));
      return F;
    })();
    return loading;
  }
  const ref = (...p) => F.doc(F.db, ...p);
  const firstName = u => ((u.displayName || u.email || 'A hand').split(/[\s@]/)[0] || 'A hand').slice(0, 40);

  let booksFor = null;
  function onUser(u){
    const was = booksFor;
    user = u;
    booksFor = u ? u.uid : null;
    if(offBooks && was !== booksFor){ offBooks(); offBooks = null; books = []; }
    if(u && !offBooks){
      offBooks = F.onSnapshot(F.collection(F.db, 'users', u.uid, 'books'), s=>{
        books = s.docs.map(d => ({ id: d.id, name: d.data().name || 'Shared book', at: d.data().at }));
        books.sort((x, y)=> x.name.localeCompare(y.name));
        if(!view.hidden) render();
      }, ()=>{});
    }
    if(cur && (!u || u.uid !== cur.uid)){
      leaveBook();
      api.usePersonal();
      api.toast(u ? 'YOUR OWN BOOK' : 'SIGNED OUT · YOUR OWN BOOK', 2200);
    }
    if(u && joinWant) join();
    if(was !== booksFor && !view.hidden) render();
    api.refresh();
  }

  async function signIn(){
    await firebase();
    const p = new F.GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    try{ await F.signInWithPopup(F.au, p); onUser(F.au.currentUser); }
    catch(e){
      if(e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) await F.signInWithRedirect(F.au, p);
      else if(!(e && /cancelled|closed/.test(e.code || ''))) api.toast('COULD NOT SIGN IN', 2200);
    }
  }

  /* ---------- opening a shared book ---------- */
  function leaveBook(){
    flush();
    [offInk, offMembers, offBook].forEach(f => f && f());
    offInk = offMembers = offBook = null;
    cur = null; ink = new Map(); merged = new Map(); pending = new Set(); deferred = new Set(); names = new Map();
    lsDel(CUR_KEY);
  }
  /* the cached copy shows at once; the live one comes in after it */
  function openCached(c){
    api.useBook(bookKey(c.id), c.uid);
    cur = { id: c.id, name: c.name || 'Shared book', owner: c.owner || null, uid: c.uid };
    const ic = lsGet(inkKey(c.id));
    ink = new Map(); pending = new Set(ic && Array.isArray(ic.pending) ? ic.pending : []);
    if(ic && ic.pages) Object.entries(ic.pages).forEach(([n, hands])=>{
      const m = new Map();
      Object.entries(hands).forEach(([h, e])=>{ if(goodEntry(e)) m.set(h, e); });
      ink.set(n|0, m);
    });
    if(ic && ic.names) names = new Map(Object.entries(ic.names));
    merged = new Map();
    for(let n=1;n<2*api.N;n++) merged.set(n, mergePage(n));
    sync();
    lsSet(CUR_KEY, { id: cur.id, uid: cur.uid, name: cur.name, owner: cur.owner });
    api.refresh();
  }
  function openLive(){
    if(!cur || !user || !F) return;
    const id = cur.id;
    firstSnap = true;
    offBook = F.onSnapshot(ref('books', id), s=>{
      if(!s.exists() || !cur || cur.id !== id) return;
      cur.name = s.data().name; cur.owner = s.data().owner;
      lsSet(CUR_KEY, { id, uid: cur.uid, name: cur.name, owner: cur.owner });
      api.refresh();
      if(!view.hidden) render();
    }, e => lost(e));
    offMembers = F.onSnapshot(F.collection(F.db, 'books', id, 'members'), s=>{
      names = new Map(s.docs.map(d => [d.id, d.data().name]));
      saveInk();
      if(!view.hidden) render();
    }, ()=>{});
    offInk = F.onSnapshot(F.collection(F.db, 'books', id, 'ink'), s => onInk(s), e => lost(e));
    if(pending.size) queueUp();
  }
  function lost(e){
    if(!e || e.code !== 'permission-denied' || !cur) return;
    const id = cur.id;
    leaveBook();
    api.usePersonal();
    if(user) F.deleteDoc(ref('users', user.uid, 'books', id)).catch(()=>{});
    api.toast('YOU ARE NO LONGER IN THAT BOOK', 2600);
  }
  async function openBook(id){
    await firebase();
    if(!user) return;
    if(cur && cur.id === id) return;
    if(cur) leaveBook();
    const b = books.find(x => x.id === id);
    openCached({ id, uid: user.uid, name: b ? b.name : 'Shared book' });
    openLive();
  }
  function goPersonal(){
    if(!cur) return;
    leaveBook();
    api.usePersonal();
    api.refresh();
  }

  /* ---------- letters: local pages <-> ink docs ---------- */
  const goodEntry = e => e && typeof e.s === 'string' && Array.isArray(e.k) && e.k.length === e.s.length && e.k.every(x => typeof x === 'string');
  function mergePage(n){
    const m = ink.get(n), L = [];
    let f = null, c = false, fAt = null;
    if(m) m.forEach((e, h)=>{
      for(let i=0;i<e.s.length;i++) L.push([e.k[i], h, e.s[i]]);
      if(e.s && e.f && (fAt === null || (e.k[0] || '') < fAt)){ f = e.f; fAt = e.k[0] || ''; c = !!e.c; }
    });
    L.sort((x, y)=> x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0);
    return { t: L.map(x => x[2]).join(''), a: L.map(x => x[1]), k: L.map(x => x[0]), f, c };
  }
  function samePage(n, M){
    if(api.page(n).t !== M.t) return false;
    const a = api.handsOf(n);
    for(let i=0;i<a.length;i++) if(a[i] !== M.a[i]) return false;
    return true;
  }
  function showMerged(n, quiet){
    const M = merged.get(n);
    if(samePage(n, M)) return;
    if(!api.applyPage(n, M.t, M.a, M.f, M.c, quiet)) deferred.add(n);
  }
  /* what this hand changed on the pages goes into its own ink entries; the
     other hands' letters are kept as they came, they are never written here */
  function sync(){
    if(!cur) return;
    const me = cur.uid;
    deferred.forEach(n=>{ deferred.delete(n); showMerged(n, true); });
    for(let n=1;n<2*api.N;n++){
      const M = merged.get(n) || mergePage(n), p = api.page(n);
      if(samePage(n, M)) continue;
      const P = p.t, PA = api.handsOf(n);
      /* the other hands' letters on the page, matched in order to theirs in the merge */
      const anchors = [];
      let j = 0;
      for(let i=0;i<P.length;i++){
        if(PA[i] === me) continue;
        let q = j;
        while(q < M.t.length && (M.a[q] === me || M.a[q] !== PA[i] || M.t[q] !== P[i])) q++;
        if(q < M.t.length){ anchors.push([i, q]); j = q + 1; }
      }
      anchors.push([P.length, M.t.length]);
      let s = '', k = [], pi = 0, mi = 0;
      anchors.forEach(([pe, me2])=>{
        let nw = '', od = '', ok = [];
        for(let i=pi;i<pe;i++) if(PA[i] === me) nw += P[i];
        for(let i=mi;i<me2;i++) if(M.a[i] === me){ od += M.t[i]; ok.push(M.k[i]); }
        const lo = mi > 0 ? M.k[mi - 1] : '', hi = me2 < M.t.length ? M.k[me2] : null;
        let a = 0;
        const lim = Math.min(nw.length, od.length);
        while(a < lim && nw[a] === od[a]) a++;
        let b = 0;
        while(b < lim - a && nw[nw.length - 1 - b] === od[od.length - 1 - b]) b++;
        const kl = a > 0 ? ok[a - 1] : lo, kh = b > 0 ? ok[od.length - b] : hi;
        s += nw;
        k = k.concat(ok.slice(0, a), keysBetween(kl, kh, nw.length - a - b), ok.slice(od.length - b));
        pi = pe + 1; mi = me2 + 1;
      });
      let m = ink.get(n);
      if(!m){ m = new Map(); ink.set(n, m); }
      const e = m.get(me);
      if(e ? e.s !== s || e.k.join() !== k.join() || e.f !== (p.f || null) || !!e.c !== !!p.c : !!s){
        m.set(me, { s, k, f: p.f || null, c: !!p.c });
        pending.add(n);
      }
      merged.set(n, mergePage(n));
      showMerged(n, true);
    }
    saveInk();
    if(pending.size) queueUp();
  }
  function onInk(snap){
    sync();
    const me = cur.uid, touched = new Set();
    snap.docChanges().forEach(ch=>{
      const d = ch.doc.data(), n = d.n|0;
      if(!(n >= 1 && n < 2*api.N) || typeof d.uid !== 'string' || ch.type === 'removed') return;
      if(d.uid === me && (d.dev === DEV || pending.has(n))) return;
      const e = { s: d.s, k: d.k, f: d.f || null, c: !!d.c };
      if(!goodEntry(e)) return;
      let m = ink.get(n);
      if(!m){ m = new Map(); ink.set(n, m); }
      if(e.s) m.set(d.uid, e); else m.delete(d.uid);
      touched.add(n);
    });
    touched.forEach(n=>{ merged.set(n, mergePage(n)); showMerged(n, firstSnap); });
    firstSnap = false;
    saveInk();
  }
  function saveInk(){
    if(!cur) return;
    const pages = {};
    ink.forEach((m, n)=>{
      if(!m.size) return;
      pages[n] = {};
      m.forEach((e, h)=>{ pages[n][h] = e; });
    });
    lsSet(inkKey(cur.id), { pages, pending: [...pending], names: Object.fromEntries(names) });
  }
  function queueUp(){ clearTimeout(upTm); upTm = setTimeout(upload, WRITE_MS); }
  function upload(){
    clearTimeout(upTm);
    if(!cur || !user || !F || !pending.size) return;
    const me = cur.uid, id = cur.id, list = [...pending].slice(0, 400);
    const batch = F.writeBatch(F.db);
    list.forEach(n=>{
      const e = (ink.get(n) || new Map()).get(me) || { s: '', k: [], f: null, c: false };
      batch.set(ref('books', id, 'ink', `${n}_${me}`), { uid: me, dev: DEV, n, s: e.s, k: e.k, f: e.f || null, c: !!e.c, at: F.serverTimestamp() });
    });
    list.forEach(n => pending.delete(n));
    saveInk();
    batch.commit().catch(()=>{
      if(!cur || cur.id !== id) return;
      list.forEach(n => pending.add(n));
      saveInk();
      clearTimeout(upTm); upTm = setTimeout(upload, 10000);
    });
    if(pending.size) queueUp();
  }
  function flush(){ if(cur){ sync(); upload(); } }

  /* ---------- making, sharing and joining books ---------- */
  async function createBook(name, bring){
    await firebase();
    if(!user) await signIn();
    if(!user) return;
    const me = user.uid, id = F.doc(F.collection(F.db, 'books')).id, code = randomId(32);
    const carry = bring ? api.personalPages() : [];
    try{
      await F.setDoc(ref('books', id), { name, owner: me, at: F.serverTimestamp() });
      await F.setDoc(ref('books', id, 'members', me), { name: firstName(user), code: '', at: F.serverTimestamp() });
      await F.setDoc(ref('books', id, 'invite', 'code'), { code });
      await F.setDoc(ref('users', me, 'books', id), { name, at: F.serverTimestamp() });
    }catch(e){ api.toast('COULD NOT MAKE THE BOOK', 2400); return; }
    if(cur) leaveBook();
    lsSet(inkKey(id), { pages: {}, pending: [] });
    openCached({ id, uid: me, name, owner: me });
    carry.forEach(p=>{
      let s = '';
      for(let i=0;i<p.t.length;i++) if(p.a[i] === api.personalHand) s += p.t[i];
      if(!s) return;
      ink.set(p.n, new Map([[me, { s, k: keysBetween('', null, s.length), f: p.f || null, c: !!p.c }]]));
      pending.add(p.n);
      merged.set(p.n, mergePage(p.n));
      showMerged(p.n, true);
    });
    saveInk();
    openLive();
    upload();
    show('invite', { code });
  }
  async function inviteLink(rotate){
    await firebase();
    if(!cur) return null;
    try{
      let code = null;
      if(!rotate){ const s = await F.getDoc(ref('books', cur.id, 'invite', 'code')); code = s.exists() ? s.data().code : null; }
      if(!code && cur.owner === user.uid){ code = randomId(32); await F.setDoc(ref('books', cur.id, 'invite', 'code'), { code }); }
      return code ? `${location.origin}${location.pathname}#join=${cur.id}.${code}` : null;
    }catch(e){ return null; }
  }
  async function join(){
    const want = joinWant;
    if(!want || !user) return;
    joinWant = null;
    const me = user.uid;
    try{
      const mine = await F.getDoc(ref('books', want.id, 'members', me)).catch(()=>null);
      if(!(mine && mine.exists())) await F.setDoc(ref('books', want.id, 'members', me), { name: firstName(user), code: want.code, at: F.serverTimestamp() });
      const b = await F.getDoc(ref('books', want.id));
      const name = b.exists() ? b.data().name : 'Shared book';
      await F.setDoc(ref('users', me, 'books', want.id), { name, at: F.serverTimestamp() });
      if(cur) leaveBook();
      openCached({ id: want.id, uid: me, name, owner: b.exists() ? b.data().owner : null });
      openLive();
      close();
      api.toast(`YOU HAVE JOINED · ${name.toUpperCase()}`, 2600);
    }catch(e){
      show('badInvite');
    }
  }

  /* ---------- the Books card ---------- */
  const view = document.getElementById('shelf');
  const body = view.querySelector('.body');
  let mode = 'list', modeData = null;
  view.addEventListener('pointerdown', e=>{ if(e.target === view) close(); });
  view.querySelector('.close').addEventListener('click', ()=> close());
  view.addEventListener('keydown', e=>{ e.stopPropagation(); if(e.key === 'Escape'){ e.preventDefault(); close(); } });
  function show(m, data){ mode = m; modeData = data || null; view.hidden = false; api.blurQuill(); render(); }
  function close(){ view.hidden = true; mode = 'list'; api.focusQuill(); }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if(cls) e.className = cls; if(text !== undefined) e.textContent = text; return e; };
  function btn(text, cls, fn){
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text);
    b.addEventListener('click', async ()=>{ b.disabled = true; try{ await fn(); }finally{ b.disabled = false; } });
    return b;
  }
  function others(){
    if(!cur || !user) return '';
    const n = [...names.entries()].filter(([u]) => u !== user.uid).map(([, v]) => v);
    return n.length ? `with ${n.join(', ')}` : 'nobody has joined yet';
  }
  function render(){
    body.textContent = '';
    const h = el('h2', null, mode === 'join' || mode === 'badInvite' ? 'AN INVITATION' : mode === 'invite' ? 'INVITE' : mode === 'new' ? 'A NEW SHARED BOOK' : 'BOOKS');
    body.appendChild(h);
    if(!F && mode !== 'join'){ body.appendChild(el('p', 'sub', 'Opening the shelf…')); firebase().then(()=>{ if(!view.hidden) render(); }).catch(()=>{ body.lastChild.textContent = 'The shelf could not be reached. Check the connection'; }); return; }
    ({ list: renderList, new: renderNew, invite: renderInvite, join: renderJoin, badInvite: renderBad })[mode]();
  }
  function bookRow(title, sub, on, fn){
    const b = el('button', 'book' + (on ? ' on' : ''));
    const t = el('span'); t.appendChild(el('span', null, title)); t.appendChild(el('small', null, sub));
    b.appendChild(t);
    if(on) b.appendChild(el('span', 'tick', '✓'));
    b.addEventListener('click', async ()=>{ await fn(); render(); });
    return b;
  }
  function renderList(){
    const list = el('div', 'list');
    list.appendChild(bookRow('My own book', 'kept in this browser only', !cur, async ()=> goPersonal()));
    books.forEach(b => list.appendChild(bookRow(b.name, cur && cur.id === b.id ? others() : 'shared book', cur && cur.id === b.id, ()=> openBook(b.id))));
    body.appendChild(list);
    const acts = el('div', 'acts');
    if(user){
      if(cur) acts.appendChild(btn('Invite someone to this book', 'main', async ()=> show('invite')));
      acts.appendChild(btn('New shared book', cur ? '' : 'main', async ()=> show('new')));
    }else{
      body.appendChild(el('p', 'sub', 'Sign in with Google to write one book together with someone you invite'));
      acts.appendChild(btn('Sign in with Google', 'main', signIn));
    }
    body.appendChild(acts);
    if(user){
      const who = el('p', 'who', `Signed in as ${firstName(user)} · `);
      const out = el('button', null, 'Sign out');
      out.addEventListener('click', async ()=>{ flush(); await F.signOut(F.au); render(); });
      who.appendChild(out);
      body.appendChild(who);
    }
  }
  function renderNew(){
    body.appendChild(el('p', 'sub', 'Only the people you invite can open it, and each of you can erase only your own ink'));
    const name = el('input'); name.type = 'text'; name.maxLength = 60; name.value = 'Our book'; name.setAttribute('aria-label', 'Name of the book');
    body.appendChild(name);
    const mine = api.personalPages().filter(p => p.a.includes(api.personalHand));
    let bring = null;
    if(mine.length){
      const lab = el('label', 'check');
      bring = el('input'); bring.type = 'checkbox'; bring.checked = true;
      lab.appendChild(bring);
      lab.appendChild(el('span', null, `Bring the ${mine.length === 1 ? 'page' : mine.length + ' pages'} I wrote in my own book`));
      body.appendChild(lab);
    }
    const acts = el('div', 'acts');
    acts.appendChild(btn('Make the book', 'main', ()=> createBook(name.value.trim().slice(0, 60) || 'Our book', !!(bring && bring.checked))));
    acts.appendChild(btn('Back', '', async ()=> show('list')));
    body.appendChild(acts);
    setTimeout(()=> name.select(), 50);
  }
  async function renderInvite(){
    body.appendChild(el('p', 'sub', 'Send this link to the person you will write with. They open it and sign in with Google'));
    const box = el('div', 'link', 'Making the link…');
    body.appendChild(box);
    const acts = el('div', 'acts');
    body.appendChild(acts);
    const link = await inviteLink(false);
    if(!link){ box.textContent = 'Only the one who made the book can make its link'; acts.appendChild(btn('Back', '', async ()=> show('list'))); return; }
    box.textContent = link;
    if(navigator.share) acts.appendChild(btn('Send the link', 'main', async ()=>{ try{ await navigator.share({ title: cur.name, text: 'Write in our book with me', url: link }); }catch(e){} }));
    acts.appendChild(btn('Copy the link', navigator.share ? '' : 'main', async ()=>{
      try{ await navigator.clipboard.writeText(link); api.toast('LINK COPIED', 1600); }catch(e){ api.toast('SELECT THE LINK AND COPY IT', 2000); }
    }));
    if(cur && user && cur.owner === user.uid) acts.appendChild(btn('Make a new link (the old one stops working)', '', async ()=>{
      const l = await inviteLink(true);
      if(l){ box.textContent = l; api.toast('NEW LINK MADE', 1600); }
    }));
    acts.appendChild(btn('Done', '', async ()=> show('list')));
  }
  function renderJoin(){
    body.appendChild(el('p', 'sub', 'Someone has invited you to write a book together. Sign in with Google to open it'));
    const acts = el('div', 'acts');
    acts.appendChild(btn('Sign in with Google and join', 'main', async ()=>{ await firebase(); if(user) await join(); else await signIn(); }));
    acts.appendChild(btn('Not now', '', async ()=>{ joinWant = null; close(); }));
    body.appendChild(acts);
  }
  function renderBad(){
    body.appendChild(el('p', 'sub', 'This invitation no longer works. Ask for a new link'));
    const acts = el('div', 'acts');
    acts.appendChild(btn('Close', 'main', async ()=> close()));
    body.appendChild(acts);
  }

  /* ---------- start ---------- */
  function start(){
    if(!sharingOn) return;
    const m = /^#join=([A-Za-z0-9]{6,40})\.([a-z0-9]{24,64})$/.exec(location.hash);
    if(m){
      joinWant = { id: m[1], code: m[2] };
      history.replaceState(null, '', location.pathname + location.search);
      show('join');
      firebase().catch(()=>{});
    }
    const c = lsGet(CUR_KEY);
    if(c && typeof c.id === 'string' && typeof c.uid === 'string'){
      openCached(c);
      firebase().then(()=>{
        if(cur && user && user.uid === cur.uid) openLive();
      }).catch(()=>{});
    }
  }

  return {
    start, sync, flush,
    open: ()=> show('list'),
    isOpen: ()=> !view.hidden,
    close,
    label: ()=> cur ? cur.name : 'My own book',
    name: h => names.get(h) || null,
    shared: ()=> !!cur,
    ...(EMU ? { test: {
      firebase, createBook, inviteLink, openBook, goPersonal, upload, keysBetween,
      get user(){ return user; }, get cur(){ return cur; }, get books(){ return books; }, ink: ()=> ink, pending: ()=> pending,
      async signInAs(uid, name){
        await firebase();
        const tok = JSON.stringify({ sub: uid, email: `${uid}@example.com`, email_verified: true, name });
        await F.signInWithCredential(F.au, F.GoogleAuthProvider.credential(tok));
        onUser(F.au.currentUser);
      },
      async joinLink(link){
        const m = /#join=([A-Za-z0-9]+)\.([a-z0-9]+)$/.exec(link);
        joinWant = { id: m[1], code: m[2] };
        await join();
      },
    } } : {}),
  };
}
