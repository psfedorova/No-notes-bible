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
const SIGNED_KEY = 'liber-arcanum.signedin';
const GUEST_KEY = 'liber-arcanum.guestname';
const JOIN_KEY = 'liber-arcanum.join';
const bookKey = id => `liber-arcanum.book.${id}`;
const inkKey = id => `liber-arcanum.ink.${id}`;
const pageKey = (id, n) => `liber-arcanum.ink.${id}.${n}`;
const WRITE_MS = 1500;
const MAX_BOOKS = 3;            // firestore.rules holds each person to the same number

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
  let books = [], offBooks = null, made = 0, offMade = null;
  let offInk = null, offMembers = null, offBook = null, firstSnap = true;
  let names = new Map();
  let ink = new Map(), pending = new Set(), merged = new Map(), deferred = new Set();
  let upTm = 0, joinWant = null, dirtyInk = new Set(), link = null;
  let guestName = typeof lsGet(GUEST_KEY) === 'string' ? lsGet(GUEST_KEY) : '';

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
  /* a Google member is called by the first word of the account name, exactly
     as firestore.rules checks it; a guest by the name they typed */
  const googleName = u => (u.displayName || '').split(' ')[0] || 'Friend';
  const myName = ()=> user.isAnonymous ? guestName || 'Guest' : googleName(user);
  const real = ()=> !!user && !user.isAnonymous;

  let booksFor = null;
  function onUser(u){
    const was = booksFor, gone = books.map(b => b.id);
    user = u;
    booksFor = u ? u.uid : null;
    if(u) lsSet(SIGNED_KEY, 1); else lsDel(SIGNED_KEY);
    if(offBooks && was !== booksFor){ offBooks(); offMade(); offBooks = offMade = null; books = []; made = 0; }
    if(u && !offBooks){
      offMade = F.onSnapshot(ref('users', u.uid), s=>{
        made = s.exists() ? s.data().made|0 : 0;
        if(!view.hidden) render();
      }, ()=>{});
      offBooks = F.onSnapshot(F.collection(F.db, 'users', u.uid, 'books'), s=>{
        books = s.docs.map(d => ({ id: d.id, name: d.data().name || 'Our book', at: d.data().at }));
        books.sort((x, y)=> x.name.localeCompare(y.name));
        if(!view.hidden) render();
      }, ()=>{});
    }
    if(cur && (!u || u.uid !== cur.uid)){
      leaveBook();
      api.usePersonal();
      api.toast(u ? 'YOUR PRIVATE BOOK' : 'SIGNED OUT · YOUR PRIVATE BOOK', 2200);
    }
    /* signed out: the shared books leave this device with the account */
    if(was && !u) gone.forEach(forget);
    if(u && joinWant && joinWant.vowed) join();
    if(was !== booksFor && !view.hidden) render();
    api.refresh();
  }

  /* a guest who signs in with Google keeps their writing: the guest account
     is linked to Google rather than replaced */
  async function signIn(){
    await firebase();
    const p = new F.GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    const guest = F.au.currentUser && F.au.currentUser.isAnonymous ? F.au.currentUser : null;
    try{
      if(guest){
        try{ await F.linkWithPopup(guest, p); await guest.getIdToken(true); }
        catch(e){
          if(!e || e.code !== 'auth/credential-already-in-use') throw e;
          const cred = F.GoogleAuthProvider.credentialFromError(e);
          if(cred) await F.signInWithCredential(F.au, cred);
        }
      }else await F.signInWithPopup(F.au, p);
      onUser(F.au.currentUser);
      if(guest && cur && user.uid === guest.uid) F.updateDoc(ref('books', cur.id, 'members', user.uid), { name: googleName(user), guest: false }).catch(()=>{});
    }catch(e){
      if(e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) await (guest ? F.linkWithRedirect(guest, p) : F.signInWithRedirect(F.au, p));
      else if(!(e && /cancelled|closed/.test(e.code || ''))) api.toast('COULD NOT SIGN IN', 2200);
    }
  }
  function forget(id){
    lsDel(bookKey(id)); lsDel(inkKey(id));
    for(let n=1;n<2*api.N;n++) lsDel(pageKey(id, n));
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
    cur = { id: c.id, name: c.name || 'Our book', owner: c.owner || null, uid: c.uid };
    const ic = lsGet(inkKey(c.id));
    ink = new Map(); pending = new Set(ic && Array.isArray(ic.pending) ? ic.pending : []); dirtyInk = new Set(); link = null;
    const take = (n, hands, old)=>{
      const m = new Map();
      Object.entries(hands || {}).forEach(([h, e])=>{ const x = e && { ...e, k: splitKeys(e.k) }; if(goodEntry(x)) m.set(h, x); });
      if(m.size){ ink.set(n, m); if(old) dirtyInk.add(n); }
    };
    if(ic && ic.pages) Object.entries(ic.pages).forEach(([n, hands])=> take(n|0, hands, true));
    else for(let n=1;n<2*api.N;n++) take(n, lsGet(pageKey(c.id, n)), false);
    if(ic && ic.names) names = new Map(Object.entries(ic.names));
    merged = new Map();
    for(let n=1;n<2*api.N;n++) merged.set(n, mergePage(n));
    sync();
    lsSet(CUR_KEY, { id: cur.id, uid: cur.uid, name: cur.name, owner: cur.owner });
    api.refresh();
  }
  function openLive(){
    if(!cur || !user || !F || offInk) return;
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
      names = new Map(s.docs.map(d => [d.id, d.data().guest ? `${d.data().name} (guest)` : d.data().name]));
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
    openCached({ id, uid: user.uid, name: b ? b.name : 'Our book' });
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
  /* keys travel as one comma-joined string, so the rules can bound their size */
  const splitKeys = k => typeof k === 'string' ? (k ? k.split(',') : []) : k;
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
        pending.add(n); dirtyInk.add(n);
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
      const e = { s: d.s, k: splitKeys(d.k), f: d.f || null, c: !!d.c };
      if(!goodEntry(e)) return;
      let m = ink.get(n);
      if(!m){ m = new Map(); ink.set(n, m); }
      if(e.s) m.set(d.uid, e); else m.delete(d.uid);
      touched.add(n); dirtyInk.add(n);
    });
    touched.forEach(n=>{ merged.set(n, mergePage(n)); showMerged(n, firstSnap); });
    firstSnap = false;
    saveInk();
  }
  /* only the pages that changed are written, each under a key of its own */
  function saveInk(){
    if(!cur) return;
    dirtyInk.forEach(n=>{
      const m = ink.get(n);
      if(!m || !m.size){ lsDel(pageKey(cur.id, n)); return; }
      const o = {};
      m.forEach((e, h)=>{ o[h] = { s: e.s, k: e.k.join(','), f: e.f, c: e.c }; });
      lsSet(pageKey(cur.id, n), o);
    });
    dirtyInk.clear();
    lsSet(inkKey(cur.id), { pending: [...pending], names: Object.fromEntries(names) });
  }
  /* keys that grew long from much writing in one spot are spaced out again;
     only this hand's letters move, each run between the same neighbours */
  function rekey(n){
    const me = cur.uid, M = mergePage(n), k = M.k.slice();
    for(let i=0;i<M.t.length;){
      if(M.a[i] !== me){ i++; continue; }
      let j = i;
      while(j < M.t.length && M.a[j] === me) j++;
      const fresh = keysBetween(i > 0 ? k[i - 1] : '', j < M.t.length ? k[j] : null, j - i);
      for(let q=i;q<j;q++) k[q] = fresh[q - i];
      i = j;
    }
    ink.get(n).get(me).k = k.filter((_, i)=> M.a[i] === me);
    merged.set(n, mergePage(n));
    dirtyInk.add(n);
  }
  function queueUp(){ clearTimeout(upTm); upTm = setTimeout(upload, WRITE_MS); }
  function upload(){
    clearTimeout(upTm);
    if(!cur || !user || !F || !pending.size) return Promise.resolve();
    const me = cur.uid, id = cur.id, list = [...pending].slice(0, 400);
    const batch = F.writeBatch(F.db);
    list.forEach(n=>{
      let e = (ink.get(n) || new Map()).get(me);
      if(e && e.k.join(',').length > Array.from(e.s).length*24){ rekey(n); e = ink.get(n).get(me); }
      e = e || { s: '', k: [], f: null, c: false };
      batch.set(ref('books', id, 'ink', `${n}_${me}`), { uid: me, dev: DEV, n, s: e.s, k: e.k.join(','), f: e.f || null, c: !!e.c, at: F.serverTimestamp() });
    });
    list.forEach(n => pending.delete(n));
    saveInk();
    if(pending.size) queueUp();
    return batch.commit().catch(()=>{
      if(!cur || cur.id !== id) return;
      list.forEach(n => pending.add(n));
      saveInk();
      clearTimeout(upTm); upTm = setTimeout(upload, 10000);
    });
  }
  function flush(){ if(!cur) return Promise.resolve(); sync(); return upload(); }

  /* ---------- making, sharing and joining books ---------- */
  async function createBook(name, bring){
    await firebase();
    if(!real()) await signIn();
    if(!real()) return;
    const me = user.uid, id = F.doc(F.collection(F.db, 'books')).id, code = randomId(32);
    const carry = bring ? api.personalPages() : [];
    try{
      const count = await F.getDoc(ref('users', me));
      const n = count.exists() ? count.data().made|0 : 0;
      if(n >= MAX_BOOKS){ made = n; render(); return; }
      const batch = F.writeBatch(F.db);
      batch.set(ref('books', id), { name, owner: me, at: F.serverTimestamp() });
      batch.set(ref('users', me), { made: n + 1 });
      batch.set(ref('books', id, 'members', me), { name: googleName(user), code: '', guest: false, at: F.serverTimestamp() });
      batch.set(ref('books', id, 'invite', 'code'), { code });
      batch.set(ref('users', me, 'books', id), { name, at: F.serverTimestamp() });
      await batch.commit();
    }catch(e){ api.toast('COULD NOT MAKE THE BOOK', 2400); return; }
    if(cur) leaveBook();
    lsSet(inkKey(id), { pending: [] });
    openCached({ id, uid: me, name, owner: me });
    carry.forEach(p=>{
      let s = '';
      for(let i=0;i<p.t.length;i++) if(p.a[i] === api.personalHand) s += p.t[i];
      if(!s) return;
      ink.set(p.n, new Map([[me, { s, k: keysBetween('', null, s.length), f: p.f || null, c: !!p.c }]]));
      pending.add(p.n); dirtyInk.add(p.n);
      merged.set(p.n, mergePage(p.n));
      showMerged(p.n, true);
    });
    saveInk();
    openLive();
    upload();
    link = { id, url: `${location.origin}${location.pathname}#join=${id}.${code}` };
    show('share');
  }
  /* the link is fetched once per book and kept, so the card can redraw freely */
  async function inviteLink(rotate){
    await firebase();
    if(!cur) return null;
    const id = cur.id;
    if(!rotate && link && link.id === id) return link.url;
    try{
      let code = null;
      if(!rotate){ const s = await F.getDoc(ref('books', id, 'invite', 'code')); code = s.exists() ? s.data().code : null; }
      if(!code && cur.owner === user.uid){ code = randomId(32); await F.setDoc(ref('books', id, 'invite', 'code'), { code }); }
      if(!code) return null;
      link = { id, url: `${location.origin}${location.pathname}#join=${id}.${code}` };
      return link.url;
    }catch(e){ return null; }
  }
  function wantJoin(w){
    joinWant = w;
    try{ w ? sessionStorage.setItem(JOIN_KEY, JSON.stringify(w)) : sessionStorage.removeItem(JOIN_KEY); }catch(e){}
  }
  /* a guest needs no Google account: the browser gets a quiet account of its
     own, so the rules still know whose ink is whose */
  async function joinAsGuest(name){
    guestName = name.trim().slice(0, 24);
    lsSet(GUEST_KEY, guestName);
    await firebase();
    if(!user){
      try{ await F.signInAnonymously(F.au); }catch(e){ api.toast('NO CONNECTION. TRY AGAIN LATER', 2400); return; }
      onUser(F.au.currentUser);
    }
    if(joinWant) await join();
  }
  async function join(){
    const want = joinWant;
    if(!want || !user) return;
    wantJoin(null);
    const me = user.uid;
    try{
      const mine = await F.getDoc(ref('books', want.id, 'members', me)).catch(()=>null);
      const back = !!(mine && mine.exists());
      if(!back) await F.setDoc(ref('books', want.id, 'members', me), { name: myName(), code: want.code, guest: user.isAnonymous, at: F.serverTimestamp() });
      const b = await F.getDoc(ref('books', want.id));
      const name = b.exists() ? b.data().name : 'Our book';
      await F.setDoc(ref('users', me, 'books', want.id), { name, at: F.serverTimestamp() });
      if(cur) leaveBook();
      openCached({ id: want.id, uid: me, name, owner: b.exists() ? b.data().owner : null });
      openLive();
      close();
      api.toast(back ? `BACK IN ${name.toUpperCase()}` : 'AMEN. NO NOTES', 2600);
    }catch(e){
      show('badInvite');
    }
  }

  /* ---------- the Share card: share the open book, switch between books ---------- */
  const view = document.getElementById('shelf');
  const body = view.querySelector('.body');
  let mode = 'share';
  view.addEventListener('pointerdown', e=>{ if(e.target === view) close(); });
  view.querySelector('.close').addEventListener('click', ()=> close());
  view.addEventListener('keydown', e=>{ e.stopPropagation(); if(e.key === 'Escape'){ e.preventDefault(); close(); } });
  function show(m){ if(m !== 'vow') hush(); mode = m; view.hidden = false; api.blurQuill(); render(); }
  function close(){ hush(); vow = freshVow(); view.hidden = true; mode = 'share'; api.focusQuill(); }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if(cls) e.className = cls; if(text !== undefined) e.textContent = text; return e; };
  function btn(text, cls, fn){
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text);
    b.addEventListener('click', async ()=>{ b.disabled = true; try{ await fn(); }finally{ b.disabled = false; } });
    return b;
  }
  function others(){
    if(!cur || !user) return '';
    const n = [...names.entries()].filter(([u]) => u !== user.uid).map(([, v]) => v);
    return n.length ? `with ${n.join(', ')}` : 'waiting for a friend';
  }
  const TITLES = { share: 'SHARE THE BOOK', join: 'YOU’VE BEEN INVITED', vow: 'THE VOW', badInvite: 'AN INVITATION' };
  function render(){
    body.textContent = '';
    body.dataset.mode = mode;
    body.appendChild(el('h2', null, TITLES[mode]));
    if(!F && mode !== 'join' && mode !== 'vow'){ body.appendChild(el('p', 'sub', 'Loading…')); firebase().then(()=>{ if(!view.hidden) render(); }).catch(()=>{ body.lastChild.textContent = 'No connection. Try again later'; }); return; }
    ({ share: renderShare, join: renderJoin, vow: renderVow, badInvite: renderBad })[mode]();
  }
  function bookRow(title, sub, on, fn){
    const b = el('button', 'book' + (on ? ' on' : ''));
    const t = el('span'); t.appendChild(el('span', null, title)); t.appendChild(el('small', null, sub));
    b.appendChild(t);
    if(on) b.appendChild(el('span', 'tick', '✓'));
    b.addEventListener('click', async ()=>{ await fn(); render(); });
    return b;
  }
  /* the private book is shared by making a shared copy of it, which opens */
  function renderShare(){
    const acts = el('div', 'acts');
    if(!user || (!cur && !real())){
      body.appendChild(el('p', 'sub', 'Your friend gets a link, takes the vow and writes in the book with you. Each of you can erase only your own writing'));
      acts.appendChild(btn('Sign in with Google to share', 'main', signIn));
      body.appendChild(acts);
      if(!user) return;
    }
    else if(cur) renderLink(acts);
    else if(made >= MAX_BOOKS){
      body.appendChild(el('p', 'sub', `You have made ${MAX_BOOKS} shared books, the most there can be. Open one of them below to share it`));
    }else{
      body.appendChild(el('p', 'sub', 'Your friend gets a link, takes the vow and writes in the book with you. Each of you can erase only your own writing'));
      acts.appendChild(btn('Get a link', 'main', ()=> createBook(`${googleName(user)}’s book`, true)));
      body.appendChild(acts);
    }
    if(books.length){
      body.appendChild(el('h3', null, 'Your books'));
      const list = el('div', 'list');
      list.appendChild(bookRow('Private book', 'only you', !cur, async ()=> goPersonal()));
      books.forEach(b => list.appendChild(bookRow(b.name, cur && cur.id === b.id ? others() : 'shared', cur && cur.id === b.id, ()=> openBook(b.id))));
      body.appendChild(list);
    }
    /* a guest is offered Google instead of signing out, which would lose their ink */
    const who = el('p', 'who', real() ? `${myName()} · ` : cur ? `${myName()} (guest) · ` : `${myName()} (guest)`);
    if(!real() && !cur){ body.appendChild(who); return; }
    const out = el('button', null, real() ? 'Sign out' : 'Sign in with Google');
    out.addEventListener('click', async ()=>{
      if(!real()){ await signIn(); render(); return; }
      await Promise.race([flush(), new Promise(res => setTimeout(res, 4000))]).catch(()=>{});
      await F.signOut(F.au);
      render();
    });
    who.appendChild(out);
    body.appendChild(who);
  }
  async function renderLink(acts){
    body.appendChild(el('p', 'sub', 'Send this link to a friend. They take the vow, sign it and write with you'));
    const box = el('div', 'link', 'Making a link…');
    body.appendChild(box);
    body.appendChild(acts);
    const id = cur.id, url = await inviteLink(false);
    if(!cur || cur.id !== id) return;
    if(!url){ box.textContent = 'Only the book’s creator can make a link'; return; }
    box.textContent = url;
    if(navigator.share) acts.appendChild(btn('Send', 'main', async ()=>{ try{ await navigator.share({ title: cur.name, text: 'You’ve been invited to become a keeper of our bible. No notes', url: link.url }); }catch(e){} }));
    acts.appendChild(btn('Copy link', navigator.share ? '' : 'main', async ()=>{
      try{ await navigator.clipboard.writeText(link.url); api.toast('LINK COPIED', 1600); }catch(e){ api.toast('SELECT THE LINK AND COPY IT', 2000); }
    }));
    if(user && cur.owner === user.uid) acts.appendChild(btn('Make a new link (the old one stops working)', 'minor', async ()=>{
      const l = await inviteLink(true);
      if(l){ box.textContent = l; api.toast('NEW LINK MADE', 1600); }
    }));
  }
  /* ---------- the invitation: the rules, the vow read aloud, a signature ---------- */
  const RULES = ['What is written here is gospel', 'It is not up for discussion', 'If a page bores you, turn it'];
  const VOW = [
    'I swear that what I write is true.',
    'I swear: no notes, from me or you.',
    'I swear, if any page should bore,',
    'to turn it and to write some more.',
    'I swear by cake, I swear by wine:',
    'your word is law, and so is mine.',
    'Amen.',
  ];
  const words = s => s.toLowerCase().replace(/[’']/g, '').split(/[^a-z]+/).filter(Boolean);
  const VOW_WORDS = VOW.map(words);
  /* a word counts when it is heard one letter off: speech engines mishear accents */
  function near(a, b){
    if(a === b) return true;
    if(b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, e = 0;
    while(i < a.length && j < b.length){
      if(a[i] === b[j]){ i++; j++; continue; }
      if(++e > 1) return false;
      if(a.length >= b.length) i++;
      if(a.length <= b.length) j++;
    }
    return e + (a.length - i) + (b.length - j) <= 1;
  }
  /* how many lines of the vow have been said, in order: a line is said once
     half of its words are heard, in order, after the line before it */
  function linesSaid(heard){
    let at = 0, n = 0;
    for(const line of VOW_WORDS){
      let pos = at, got = 0;
      for(const w of line){
        for(let k = pos; k < Math.min(heard.length, pos + 12); k++) if(near(heard[k], w)){ got++; pos = k + 1; break; }
      }
      if(got < Math.ceil(line.length / 2)) break;
      n++; at = pos;
    }
    return n;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const freshVow = ()=> ({ said: 0, deaf: !SR, slow: false, heard: '', sign: '' });
  let vow = freshVow(), rec = null, slowTm = 0, vowUI = null;
  function hear(text){
    const n = linesSaid(words(text));
    if(n <= vow.said) return;
    vow.said = n;
    if(n >= VOW.length) hush();
    paintVow();
  }
  function listen(quick = 0){
    if(rec || vow.deaf || vow.said >= VOW.length) return;
    let session = '', began = Date.now();
    const r = new SR();
    r.lang = 'en-US'; r.continuous = true; r.interimResults = true;
    r.onresult = e => { session = Array.from(e.results, x => x[0].transcript).join(' '); hear(vow.heard + ' ' + session); };
    r.onerror = e => { if(e.error !== 'no-speech' && e.error !== 'aborted') vow.deaf = true; };
    /* the engine stops by itself after a pause, so it is started again until the vow is said */
    r.onend = ()=>{
      vow.heard += ' ' + session;
      rec = null;
      quick = Date.now() - began < 1000 ? quick + 1 : 0;
      if(quick >= 3) vow.deaf = true;
      if(mode === 'vow' && !view.hidden) listen(quick);
      paintVow();
    };
    rec = r;
    try{ r.start(); }catch(e){ rec = null; vow.deaf = true; }
    if(!slowTm && !vow.deaf) slowTm = setTimeout(()=>{ vow.slow = true; paintVow(); }, 25000);
    paintVow();
  }
  function hush(){
    clearTimeout(slowTm); slowTm = 0;
    if(!rec) return;
    const r = rec; rec = null;
    r.onend = r.onresult = r.onerror = null;
    try{ r.abort(); }catch(e){}
  }
  function saidAll(){ hush(); vow.said = VOW.length; paintVow(); }
  function paintVow(){
    const u = vowUI;
    if(!u || mode !== 'vow' || !u.sign.isConnected) return;
    const done = vow.said >= VOW.length;
    u.lines.forEach((p, i)=> p.classList.toggle('said', i < vow.said));
    u.sub.textContent = done ? 'The book heard you. Now sign' : vow.deaf ? 'I take your word for it. But you still have to say it aloud' : 'Read it aloud. The book is listening';
    u.mic.hidden = done;
    u.mic.textContent = vow.deaf ? 'I swear I said it' : rec ? 'Listening…' : 'Read it aloud';
    u.mic.classList.toggle('on', !!rec);
    u.help.hidden = done || vow.deaf || !vow.slow;
    if(done && u.sign.hidden){
      u.sign.hidden = false;
      const i = u.sign.querySelector('input');
      if(i) setTimeout(()=> i.focus(), 50);
    }
  }
  const decline = ()=> btn('Ask me after dessert', 'minor', async ()=>{ wantJoin(null); close(); });
  function renderJoin(){
    body.appendChild(el('p', 'sub', 'to become a keeper of this bible. Ours. No notes'));
    const list = el('ol', 'rules');
    RULES.forEach((r, i)=>{ const li = el('li'); li.appendChild(el('b', null, ['I.', 'II.', 'III.'][i])); li.appendChild(el('span', null, r)); list.appendChild(li); });
    body.appendChild(list);
    const acts = el('div', 'acts');
    acts.appendChild(btn('Agreed. No notes', 'main', async ()=> show('vow')));
    acts.appendChild(decline());
    body.appendChild(acts);
  }
  function renderVow(){
    const sub = el('p', 'sub');
    body.appendChild(sub);
    const box = el('div', 'vow');
    const lines = VOW.map(t => box.appendChild(el('p', null, t)));
    body.appendChild(box);
    const acts = el('div', 'acts');
    const mic = el('button', 'btn main');
    mic.addEventListener('click', ()=>{ if(vow.deaf) saidAll(); else listen(); });
    const help = el('button', 'btn minor', 'Can’t hear me? I swear I said it');
    help.addEventListener('click', saidAll);
    acts.appendChild(mic); acts.appendChild(help);
    body.appendChild(acts);

    const sign = el('div', 'sign');
    sign.hidden = true;
    sign.appendChild(el('p', 'by', 'Signed, sealed and slightly tipsy,'));
    const sacts = el('div', 'acts');
    const seal = async open => { wantJoin({ ...joinWant, vowed: true }); await open(); };
    if(user){
      sign.appendChild(el('p', 'name', myName()));
      sacts.appendChild(btn('Amen, let’s go', 'main', ()=> seal(join)));
    }else{
      const name = el('input'); name.type = 'text'; name.maxLength = 24; name.value = vow.sign || guestName; name.placeholder = 'your name'; name.setAttribute('aria-label', 'Your name');
      name.addEventListener('input', ()=>{ vow.sign = name.value; });
      sign.appendChild(name);
      const open = ()=>{ if(!name.value.trim()){ name.focus(); api.toast('SIGN YOUR NAME', 1600); return; } return seal(()=> joinAsGuest(name.value)); };
      name.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); open(); } });
      sacts.appendChild(btn('Amen, let’s go', 'main', open));
      sacts.appendChild(btn('Sign with Google instead', 'minor', ()=> seal(signIn)));
    }
    sign.appendChild(el('p', 'ps', 'P.S. Typos are also gospel'));
    sign.appendChild(sacts);
    body.appendChild(sign);
    const out = el('div', 'acts');
    out.appendChild(decline());
    body.appendChild(out);

    vowUI = { sub, lines, mic, help, sign };
    paintVow();
  }
  function renderBad(){
    body.appendChild(el('p', 'sub', 'This link no longer works. Ask for a new one'));
    const acts = el('div', 'acts');
    acts.appendChild(btn('Close', 'main', async ()=> close()));
    body.appendChild(acts);
  }

  /* ---------- start ---------- */
  /* the vow is said once: someone already in the book goes straight in */
  async function invite(){
    if(lsGet(SIGNED_KEY) && !joinWant.vowed){
      try{
        await firebase();
        const mine = user && await F.getDoc(ref('books', joinWant.id, 'members', user.uid));
        if(mine && mine.exists()){ wantJoin({ ...joinWant, vowed: true }); return join(); }
      }catch(e){}
    }
    /* back from a Google sign-in that left the page: the vow is already said */
    if(joinWant.vowed) vow.said = VOW.length;
    show(joinWant.vowed ? 'vow' : 'join');
    firebase().catch(()=>{});
  }
  function start(){
    if(!sharingOn) return;
    /* the invitation is kept for this tab, so a sign-in that leaves the page
       and comes back still lands in the book */
    const m = /^#join=([A-Za-z0-9]{6,40})\.([a-z0-9]{24,64})$/.exec(location.hash);
    let kept = null;
    try{ kept = JSON.parse(sessionStorage.getItem(JOIN_KEY)); }catch(e){}
    if(m || (kept && typeof kept.id === 'string' && typeof kept.code === 'string')){
      wantJoin(m ? { id: m[1], code: m[2] } : kept);
      if(m) history.replaceState(null, '', location.pathname + location.search);
      invite();
    }
    else if(lsGet(SIGNED_KEY)) firebase().catch(()=>{});
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
    open: ()=> show('share'),
    isOpen: ()=> !view.hidden,
    close,
    note: ()=> cur ? [cur.name, others()].filter(Boolean).join(', ') : 'Send the book to a friend',
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
      async joinLink(url){
        const m = /#join=([A-Za-z0-9]+)\.([a-z0-9]+)$/.exec(url);
        wantJoin({ id: m[1], code: m[2] });
        await join();
      },
      joinAsGuest,
    } } : {}),
  };
}
