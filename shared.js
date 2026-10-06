/* ============================================================================
   shared books: one book written in by several people, kept in Firebase

   Each member signs in with Google. A page is the letters of every hand on it,
   each letter with a position key; a page reads them sorted by key. Every
   hand keeps its letters of a page in a doc of its own (books/{id}/ink/{n}_{uid}),
   which only that hand may write, so two people can write on one page at the
   same time and nobody can erase another's ink. The rules are firestore.rules.

   A Google account also keeps a copy of the private book (users/{uid}/keep),
   so it comes back on a new device or after the browser forgets it.
   ==========================================================================*/
import { FIREBASE } from './book-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
const EMU = /[?&]emu\b/.test(location.search);
const CUR_KEY = 'liber-arcanum.current';
const DEV_KEY = 'liber-arcanum.device';
const SIGNED_KEY = 'liber-arcanum.signedin';
const GUEST_KEY = 'liber-arcanum.guestname';
const JOIN_KEY = 'liber-arcanum.join';
const KEEP_KEY = 'liber-arcanum.keep';
const NUDGE_KEY = 'liber-arcanum.nudged';
const bookKey = id => `liber-arcanum.book.${id}`;
const inkKey = id => `liber-arcanum.ink.${id}`;
const pageKey = (id, n) => `liber-arcanum.ink.${id}.${n}`;
const WRITE_MS = 1500;
const MAX_BOOKS = 3;            // firestore.rules holds each person to the same number
const KEEP_PART = 200000;       // letters in one part of the private book's copy; the rules allow 250000
const KEEP_MS = 15000;
const SLOW_MS = 6000;
const wait = ms => new Promise(res => setTimeout(res, ms));

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
  let offInk = null, offMembers = null, offBook = null, offMine = null, offAccess = null, firstSnap = true;
  let names = new Map(), guests = new Set(), access = new Map(), reading = false;
  let ink = new Map(), pending = new Set(), merged = new Map(), deferred = new Set();
  let upTm = 0, joinWant = null, dirtyInk = new Set(), link = null;
  let inflight = 0, waitTm = 0, slow = false;
  let keepTm = 0, clash = null, checked = new Set();
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
    if(offBooks && was !== booksFor){ offBooks(); offMade(); offBooks = offMade = null; books = []; made = 0; checked = new Set(); clash = null; }
    if(u && !offBooks){
      offMade = F.onSnapshot(ref('users', u.uid), s=>{
        made = s.exists() ? s.data().made|0 : 0;
        if(!view.hidden) render();
      }, ()=>{});
      offBooks = F.onSnapshot(F.collection(F.db, 'users', u.uid, 'books'), s=>{
        books = s.docs.map(d => ({ id: d.id, name: d.data().name || 'Our book', at: d.data().at }));
        books.sort((x, y)=> x.name.localeCompare(y.name));
        checkBooks();
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
    if(u && !u.isAnonymous && was !== booksFor) setTimeout(keepNow, 1500);
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
    unlisten();
    cur = null; ink = new Map(); merged = new Map(); pending = new Set(); deferred = new Set(); names = new Map();
    guests = new Set(); access = new Map(); reading = false;
    lsDel(CUR_KEY);
  }
  function unlisten(){
    [offInk, offMembers, offBook, offMine, offAccess].forEach(f => f && f());
    offInk = offMembers = offBook = offMine = offAccess = null;
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
      if(cur.owner === user.uid && !offAccess) offAccess = F.onSnapshot(F.collection(F.db, 'books', id, 'access'), a=>{
        access = new Map(a.docs.map(d => [d.id, { can: d.data().can, name: d.data().name }]));
        if(!view.hidden) render();
      }, ()=>{});
      const mine = books.find(b => b.id === id);
      if(mine && mine.name !== cur.name) F.setDoc(ref('users', user.uid, 'books', id), { name: cur.name, at: F.serverTimestamp() }).catch(()=>{});
      api.refresh();
      if(!view.hidden) render();
    }, e => lost(e));
    offMembers = F.onSnapshot(F.collection(F.db, 'books', id, 'members'), s=>{
      names = keeperNames(s.docs);
      guests = new Set(s.docs.filter(d => d.data().guest).map(d => d.id));
      saveInk();
      if(!view.hidden) render();
    }, ()=>{});
    /* the creator may let this hand only read; the quill is then put down */
    offMine = F.onSnapshot(ref('books', id, 'access', user.uid), s=>{
      const was = reading;
      reading = s.exists() && s.data().can === 'read';
      if(reading === was) return;
      if(!reading && pending.size) queueUp();
      api.refresh();
      if(!view.hidden) render();
      api.toast(reading ? 'YOU CAN ONLY READ THIS BOOK NOW' : 'YOU CAN WRITE IN THIS BOOK AGAIN', 2600);
    }, ()=>{});
    offInk = F.onSnapshot(F.collection(F.db, 'books', id, 'ink'), s => onInk(s), e => lost(e));
    if(pending.size) queueUp();
  }
  /* two keepers of one name are told apart by the order they came in: Alex, Alex II */
  const ROMAN = ['', '', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  function keeperNames(docs){
    const at = d => { const t = d.data({ serverTimestamps: 'estimate' }).at; return t && t.toMillis ? t.toMillis() : Infinity; };
    const seen = new Map(), out = new Map();
    [...docs].sort((x, y)=> at(x) - at(y) || (x.id < y.id ? -1 : 1)).forEach(d=>{
      const m = d.data(), base = String(m.name || 'Friend'), k = (seen.get(base) || 0) + 1;
      seen.set(base, k);
      const nth = k < 2 ? '' : ` ${ROMAN[k] || k}`;
      out.set(d.id, `${base}${nth}${m.guest ? ' (guest)' : ''}`);
    });
    return out;
  }
  function lost(e){
    if(!e || e.code !== 'permission-denied' || !cur) return;
    const id = cur.id;
    leaveBook();
    api.usePersonal();
    forget(id);
    if(user) F.deleteDoc(ref('users', user.uid, 'books', id)).catch(()=>{});
    api.toast('YOU ARE NO LONGER IN THAT BOOK', 2600);
  }
  /* each book on the list is looked up once: a renamed one gets its new name,
     one that is gone or closed to this person leaves the list */
  function checkBooks(){
    if(!user || !F || !navigator.onLine) return;
    const uid = user.uid, get = F.getDocFromServer || F.getDoc;
    books.forEach(b=>{
      if(checked.has(b.id)) return;
      checked.add(b.id);
      get(ref('books', b.id)).then(s=>{
        if(!user || user.uid !== uid) return;
        if(!s.exists()) return drop(b.id);
        const name = s.data().name;
        if(name && name !== b.name) F.setDoc(ref('users', uid, 'books', b.id), { name, at: F.serverTimestamp() }).catch(()=>{});
      }, e=>{
        if(e && e.code === 'permission-denied') drop(b.id);
        else checked.delete(b.id);
      });
    });
  }
  function drop(id){
    if(cur && cur.id === id) return lost({ code: 'permission-denied' });
    if(user) F.deleteDoc(ref('users', user.uid, 'books', id)).catch(()=>{});
    forget(id);
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
  /* a keeper leaves for good, the creator stays with the book; what was
     written stays in it. The last ink goes up before the membership is gone */
  async function leaveShared(){
    if(!cur || !user || !cur.owner || cur.owner === user.uid) return;
    const id = cur.id, me = user.uid, name = cur.name;
    leaveBook();
    api.usePersonal();
    forget(id);
    api.refresh();
    close();
    const batch = F.writeBatch(F.db);
    batch.delete(ref('books', id, 'members', me));
    batch.delete(ref('users', me, 'books', id));
    batch.commit().catch(()=> api.toast('COULD NOT LEAVE THE BOOK. TRY AGAIN LATER', 2600));
    api.toast(`YOU LEFT ${name.toUpperCase()}`, 2400);
  }
  /* the creator deletes the book with everyone's ink in it: the ink and the
     keepers go first, then the book in one batch with the count going down,
     which frees a place for a new book */
  async function deleteBook(){
    if(!cur || !user || cur.owner !== user.uid) return;
    if(!navigator.onLine){ api.toast('DELETING A BOOK NEEDS A CONNECTION', 2400); return; }
    const id = cur.id, me = user.uid, name = cur.name, server = F.getDocsFromServer || F.getDocs;
    unlisten();
    clearTimeout(upTm); pending.clear();
    try{
      const [inkS, memS, accS] = await Promise.all(['ink', 'members', 'access'].map(c => server(F.collection(F.db, 'books', id, c))));
      const refs = [...inkS.docs.map(d => ref('books', id, 'ink', d.id)), ...memS.docs.filter(d => d.id !== me).map(d => ref('books', id, 'members', d.id)),
        ...accS.docs.map(d => ref('books', id, 'access', d.id))];
      for(let i=0;i<refs.length;i+=450){
        const b = F.writeBatch(F.db);
        refs.slice(i, i + 450).forEach(r => b.delete(r));
        await b.commit();
      }
      const count = await F.getDoc(ref('users', me));
      const n = count.exists() ? count.data().made|0 : 0;
      const b = F.writeBatch(F.db);
      b.delete(ref('books', id, 'invite', 'code'));
      b.delete(ref('books', id, 'members', me));
      b.delete(ref('books', id));
      b.set(ref('users', me), { made: Math.max(0, n - 1), gone: id });
      b.delete(ref('users', me, 'books', id));
      await b.commit();
    }catch(e){
      if(cur && cur.id === id) openLive();
      api.toast('COULD NOT DELETE THE BOOK. TRY AGAIN LATER', 2600);
      return;
    }
    leaveBook();
    api.usePersonal();
    forget(id);
    api.refresh();
    close();
    api.toast(`${name.toUpperCase()} IS GONE`, 2400);
  }
  async function renameBook(name){
    name = name.trim().slice(0, 60);
    if(!name || !cur || !user || cur.owner !== user.uid || name === cur.name) return;
    const id = cur.id;
    cur.name = name;
    lsSet(CUR_KEY, { id, uid: cur.uid, name, owner: cur.owner });
    api.refresh();
    try{
      const b = F.writeBatch(F.db);
      b.update(ref('books', id), { name });
      b.set(ref('users', user.uid, 'books', id), { name, at: F.serverTimestamp() });
      await Promise.race([b.commit(), wait(4000)]);
    }catch(e){ api.toast('COULD NOT RENAME THE BOOK', 2400); }
  }
  /* a guest signs with any name and may change it later, in every book they keep */
  async function renameGuest(name){
    name = name.trim().slice(0, 24);
    if(!name || !user || !user.isAnonymous) return;
    guestName = name;
    lsSet(GUEST_KEY, name);
    const uid = user.uid;
    books.forEach(b => F.updateDoc(ref('books', b.id, 'members', uid), { name }).catch(()=>{}));
    api.refresh();
  }

  /* ---------- the private book's copy in the Google account ---------- */
  /* the copy is written only over the one this device last wrote or took, so
     two devices never silently overwrite each other's book */
  const hash = t => { let h = 2166136261; for(let i=0;i<t.length;i++){ h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + t.length.toString(36); };
  const plain = d => ({ pages: (d && d.pages) || {}, hands: (d && d.hands) || [], w: d ? d.w : null, font: d ? d.font : null, fv: d ? d.fv : null });
  const inkSum = d => hash(JSON.stringify(Object.entries(plain(d).pages).filter(([, v]) => v && (v.t || v.f)).map(([n, v]) => [n, v.t || '', v.f || null, !!v.c])));
  const filled = d => Object.values(plain(d).pages).filter(v => v && v.t).length;
  const copied = ()=>{ const k = lsGet(KEEP_KEY); return real() && !clash && !!k && k.uid === user.uid; };
  function keepSoon(){
    if(!real() || !F) return;
    clearTimeout(keepTm);
    keepTm = setTimeout(keepNow, KEEP_MS);
  }
  async function keepNow(){
    clearTimeout(keepTm);
    if(!real() || !F || clash || !navigator.onLine) return;
    const uid = user.uid, d = api.personalData(), text = JSON.stringify(plain(d)), sum = hash(text);
    const k = lsGet(KEEP_KEY), mine = k && k.uid === uid ? k : null;
    if(mine && mine.sum === sum) return;
    const parts = [];
    for(let i=0;i<text.length;i+=KEEP_PART) parts.push(text.slice(i, i + KEEP_PART));
    const v = randomId(16), p = filled(d);
    try{
      const res = await F.runTransaction(F.db, async tx=>{
        const head = await tx.get(ref('users', uid, 'keep', '0'));
        const hv = head.exists() ? head.data().v : null;
        if(hv && (!mine || hv !== mine.v)) return { other: head.data() };
        if(!hv && !p) return { none: true };
        parts.forEach((t, i)=> tx.set(ref('users', uid, 'keep', String(i)), { d: t, v, i, n: parts.length, p, at: F.serverTimestamp() }));
        for(let i=parts.length;i<(hv ? head.data().n|0 : 0);i++) tx.delete(ref('users', uid, 'keep', String(i)));
        return { v };
      });
      if(!user || user.uid !== uid || res.none) return;
      if(res.other) return meetCopy(uid, res.other, d);
      lsSet(KEEP_KEY, { uid, v: res.v, sum });
      api.refresh();
    }catch(e){ /* offline, or the rules are not published yet: tried again on the next save */ }
  }
  async function readCopy(uid, head){
    const s = await (F.getDocsFromServer || F.getDocs)(F.collection(F.db, 'users', uid, 'keep'));
    const parts = s.docs.map(x => x.data()).filter(x => x.v === head.v).sort((a, b)=> a.i - b.i);
    if(parts.length !== (head.n|0)) throw new Error('the copy is incomplete');
    return JSON.parse(parts.map(x => x.d).join(''));
  }
  /* another device's copy: an empty book takes it, the same words just adopt it,
     and two different books are left for the person to choose between */
  async function meetCopy(uid, head, local){
    let copy;
    try{ copy = await readCopy(uid, head); }catch(e){ return; }
    if(!user || user.uid !== uid) return;
    const at = head.at && head.at.toDate ? head.at.toDate() : null;
    if(!filled(copy) || inkSum(copy) === inkSum(local)){
      lsSet(KEEP_KEY, { uid, v: head.v, sum: '' });
      return keepNow();
    }
    if(!filled(local)){
      takeCopy(uid, head.v, copy);
      api.toast('YOUR PRIVATE BOOK CAME BACK FROM YOUR GOOGLE ACCOUNT', 3000);
      return;
    }
    clash = { uid, v: head.v, copy, p: filled(copy), at };
    api.toast('YOUR GOOGLE ACCOUNT KEEPS ANOTHER COPY OF YOUR PRIVATE BOOK. SEE SHARE', 3600);
    api.refresh();
    if(!view.hidden) render();
  }
  function takeCopy(uid, v, copy){
    if(cur) goPersonal();
    api.takePersonal(copy);
    lsSet(KEEP_KEY, { uid, v, sum: hash(JSON.stringify(plain(api.personalData()))) });
    clash = null;
    api.refresh();
  }
  function keepLocal(){
    if(!clash) return;
    lsSet(KEEP_KEY, { uid: clash.uid, v: clash.v, sum: '' });
    clash = null;
    keepNow();
  }
  function renderClash(){
    const c = clash, when = c.at ? ` from ${c.at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : '';
    const here = filled(api.personalData());
    body.appendChild(el('h3', null, 'Your private book'));
    body.appendChild(el('p', 'sub', `Your Google account keeps a copy of your private book${when} with ${c.p} written ${c.p === 1 ? 'page' : 'pages'}. This browser’s private book is different, with ${here} written ${here === 1 ? 'page' : 'pages'}. Which one should stay?`));
    const acts = el('div', 'acts');
    acts.appendChild(btn('The copy from my account', 'main', async ()=>{ takeCopy(c.uid, c.v, c.copy); api.toast('YOUR PRIVATE BOOK IS THE COPY FROM YOUR ACCOUNT', 2600); render(); }));
    acts.appendChild(btn('The book in this browser', '', async ()=>{ keepLocal(); api.toast('YOUR ACCOUNT NOW KEEPS THIS BROWSER’S BOOK', 2600); render(); }));
    acts.appendChild(btn('Back up this browser’s book to a file first', 'minor', async ()=> api.saveCopy(true)));
    body.appendChild(acts);
  }

  /* the creator sends a keeper away for good: the link no longer lets them in,
     while it still works for everyone else. A guest could come back as a new
     guest, so for a guest the link changes too */
  async function removeKeeper(uid){
    if(!cur || !user || cur.owner !== user.uid || uid === user.uid) return;
    const id = cur.id, guest = guests.has(uid);
    const name = (names.get(uid) || 'Friend').replace(/ \(guest\)$/, '').slice(0, 60);
    const batch = F.writeBatch(F.db);
    batch.delete(ref('books', id, 'members', uid));
    batch.set(ref('books', id, 'access', uid), { can: 'none', name, at: F.serverTimestamp() });
    if(guest){
      const code = randomId(32);
      batch.set(ref('books', id, 'invite', 'code'), { code });
      link = { id, url: joinUrl(id, code) };
    }
    batch.commit().catch(()=>{ if(guest) link = null; api.toast('COULD NOT REMOVE. TRY AGAIN LATER', 2600); });
  }
  /* the creator lets a keeper only read, or write again, or come back */
  function allow(uid, can){
    if(!cur || !user || cur.owner !== user.uid || uid === user.uid) return;
    const r = ref('books', cur.id, 'access', uid);
    const name = (names.get(uid) || 'Friend').replace(/ \(guest\)$/, '').slice(0, 60);
    (can ? F.setDoc(r, { can, name, at: F.serverTimestamp() }) : F.deleteDoc(r))
      .catch(()=> api.toast('COULD NOT CHANGE IT. TRY AGAIN LATER', 2600));
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
    if(!cur || !user || !F || !pending.size || reading) return Promise.resolve();
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
    sending(1);
    return batch.commit().then(()=>{
      sending(-1);
      if(user && user.isAnonymous) nudgeGuest();
    }, e=>{
      sending(-1);
      if(!cur || cur.id !== id) return;
      list.forEach(n => pending.add(n));
      saveInk();
      /* refused for good (the book is gone or closed to this hand): the ink stays here, unsent */
      if(e && e.code === 'permission-denied') return;
      clearTimeout(upTm); upTm = setTimeout(upload, 10000);
    });
  }
  /* writes that take long are waiting for the connection; the reader is told
     when they wait and again when they arrive */
  function sending(d){
    inflight = Math.max(0, inflight + d);
    if(inflight && !waitTm) waitTm = setTimeout(()=>{ waitTm = 0; if(inflight){ slow = true; api.refresh(); } }, SLOW_MS);
    if(inflight || pending.size) return;
    clearTimeout(waitTm); waitTm = 0;
    if(slow){ slow = false; api.toast('YOUR INK REACHED THE BOOK', 2200); }
    api.refresh();
  }
  const unsent = ()=> !!cur && (pending.size > 0 || inflight > 0);
  addEventListener('offline', ()=>{
    if(!cur) return;
    slow = true;
    api.toast('NO CONNECTION. YOUR INK WAITS HERE AND GOES WHEN IT’S BACK', 3200);
    api.refresh();
  });
  addEventListener('online', ()=>{
    if(cur && pending.size) queueUp();
    if(F && user) checkBooks();
    keepSoon();
  });
  /* a guest's ink lives with this browser only: once it is written, they are told how to keep it */
  function nudgeGuest(){
    if(!user || lsGet(NUDGE_KEY) === user.uid) return;
    lsSet(NUDGE_KEY, user.uid);
    setTimeout(()=> api.toast('YOUR INK LIVES IN THIS BROWSER. TO KEEP IT ANYWHERE, SIGN IN WITH GOOGLE IN SHARE', 4200), 1200);
  }
  function flush(){ if(!cur) return Promise.resolve(); sync(); return upload(); }

  /* ---------- making, sharing and joining books ---------- */
  async function createBook(name, bring){
    await firebase();
    if(!user) return;
    const me = user.uid, id = F.doc(F.collection(F.db, 'books')).id, code = randomId(32);
    const carry = bring ? api.personalPages() : [];
    try{
      const count = await F.getDoc(ref('users', me));
      const n = count.exists() ? count.data().made|0 : 0;
      if(n >= MAX_BOOKS){ made = n; render(); return; }
      const batch = F.writeBatch(F.db);
      batch.set(ref('books', id), { name, owner: me, at: F.serverTimestamp() });
      batch.set(ref('users', me), { made: n + 1 });
      batch.set(ref('books', id, 'members', me), { name: myName(), code: '', guest: user.isAnonymous, at: F.serverTimestamp() });
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
    link = { id, url: joinUrl(id, code) };
    show('share');
  }
  /* the link carries who invites and to which book, so the invitation can say it
     before the friend is let in to read either */
  const joinUrl = (id, code)=> `${location.origin}${location.pathname}#join=${id}.${code}`
    + `&from=${encodeURIComponent(myName())}&book=${encodeURIComponent(cur ? cur.name : 'Our book')}`;
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
      link = { id, url: joinUrl(id, code) };
      return link.url;
    }catch(e){ return null; }
  }
  function wantJoin(w){
    joinWant = w;
    try{ w ? sessionStorage.setItem(JOIN_KEY, JSON.stringify(w)) : sessionStorage.removeItem(JOIN_KEY); }catch(e){}
  }
  /* a guest needs no Google account: the browser gets a quiet account of its
     own, so the rules still know whose ink is whose */
  async function beGuest(name){
    guestName = name.trim().slice(0, 24);
    lsSet(GUEST_KEY, guestName);
    await firebase();
    if(!user){
      try{ await F.signInAnonymously(F.au); }catch(e){ api.toast('NO CONNECTION. TRY AGAIN LATER', 2400); return false; }
      onUser(F.au.currentUser);
    }
    return true;
  }
  async function joinAsGuest(name){
    if(await beGuest(name) && joinWant) await join();
  }
  async function join(){
    const want = joinWant;
    if(!want || !user) return;
    wantJoin(null);
    const me = user.uid;
    try{
      const mine = await F.getDoc(ref('books', want.id, 'members', me)).catch(()=>null);
      const back = !!(mine && mine.exists());
      if(!back){
        const shut = await F.getDoc(ref('books', want.id, 'access', me)).catch(()=>null);
        if(shut && shut.exists() && shut.data().can === 'none'){ show('shut'); return; }
      }
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
  /* the invitation cannot be put off: it ends only in the book */
  const locked = ()=> !view.hidden && (mode === 'join' || mode === 'vow');
  const dismiss = ()=>{ if(!locked()) close(); };
  view.addEventListener('pointerdown', e=>{ if(e.target === view) dismiss(); });
  view.querySelector('.close').addEventListener('click', dismiss);
  view.addEventListener('keydown', e=>{ e.stopPropagation(); if(e.key === 'Escape'){ e.preventDefault(); dismiss(); } });
  function show(m){ mode = m; view.hidden = false; api.blurQuill(); render(); }
  function close(){ sign = ''; if(asking) asking.done(false); view.hidden = true; mode = 'share'; api.focusQuill(); }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if(cls) e.className = cls; if(text !== undefined) e.textContent = text; return e; };
  function btn(text, cls, fn){
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text);
    b.addEventListener('click', async ()=>{ b.disabled = true; try{ await fn(); }finally{ b.disabled = false; } });
    return b;
  }
  function others(){
    if(!cur || !user) return '';
    const n = [...names.entries()].filter(([u]) => u !== user.uid).map(([, v]) => v);
    if(!n.length) return 'waiting for a friend';
    return n.length > 4 ? `with ${n.slice(0, 3).join(', ')} and ${n.length - 3} more` : `with ${n.join(', ')}`;
  }
  const TITLES = { share: 'SHARE THE BOOK', join: 'AN INVITATION', vow: 'THE VOW', badInvite: 'AN INVITATION', shut: 'AN INVITATION', leave: 'LEAVE THE BOOK', remove: 'REMOVE A KEEPER', del: 'DELETE THE BOOK', rename: 'NAME THE BOOK', name: 'YOUR NAME', out: 'SIGN OUT', ask: '' };
  function render(){
    body.textContent = '';
    if(['leave', 'remove', 'del', 'rename'].includes(mode) && !cur) mode = 'share';
    body.dataset.mode = mode;
    view.classList.toggle('locked', locked());
    view.classList.toggle('invite', locked());
    const card = view.querySelector('.card');
    card.style.backgroundImage = locked() && api.paper ? `url(${api.paper()})` : '';
    body.appendChild(el('h2', null, TITLES[mode]));
    if(mode === 'ask'){ body.firstChild.textContent = asking.title; renderAsk(); return; }
    if(!F && mode !== 'join' && mode !== 'vow'){ body.appendChild(el('p', 'sub', 'Loading…')); firebase().then(()=>{ if(!view.hidden) render(); }).catch(()=>{ body.lastChild.textContent = 'No connection. Try again later'; }); return; }
    ({ share: renderShare, join: renderJoin, vow: renderVow, badInvite: renderBad, shut: renderShut, leave: renderLeave, remove: renderRemove, del: renderDelete, rename: renderRename, name: renderName, out: renderOut })[mode]();
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
    if(clash && real()) renderClash();
    if(!user){
      body.appendChild(el('p', 'sub', 'Your friend gets a link, takes the vow and writes in the book with you. No account needed. Each of you can erase only your own writing'));
      const input = el('input'); input.type = 'text'; input.maxLength = 24; input.value = guestName; input.placeholder = 'Your name'; input.setAttribute('aria-label', 'Your name');
      body.appendChild(input);
      body.appendChild(el('p', 'hint', 'the name your friend sees by your writing'));
      const go = async ()=>{
        const name = input.value.trim();
        if(!name){ input.focus(); api.toast('WRITE YOUR NAME FIRST', 1600); return; }
        if(await beGuest(name)) await createBook(`${name}’s book`, true);
      };
      input.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); go(); } });
      acts.appendChild(btn('Get a link', 'main', go));
      acts.appendChild(btn('Sign in with Google instead', 'minor', signIn));
      body.appendChild(acts);
      return;
    }
    if(cur) renderLink(acts);
    else if(made >= MAX_BOOKS){
      body.appendChild(el('p', 'sub', `You keep ${MAX_BOOKS} shared books, the most there can be. Open one below to share it, or delete one of yours to make room`));
    }else{
      body.appendChild(el('p', 'sub', 'Your friend gets a link, takes the vow and writes in the book with you. Each of you can erase only your own writing'));
      acts.appendChild(btn('Get a link', 'main', ()=> createBook(`${myName()}’s book`, true)));
      body.appendChild(acts);
    }
    if(books.length){
      body.appendChild(el('h3', null, 'Your books'));
      const list = el('div', 'list');
      list.appendChild(bookRow('Private book', copied() ? 'only you · a copy is in your Google account' : 'only you', !cur, async ()=> goPersonal()));
      books.forEach(b => list.appendChild(bookRow(b.name, cur && cur.id === b.id ? others() : 'shared', cur && cur.id === b.id, ()=> openBook(b.id))));
      body.appendChild(list);
    }
    if(cur && user) renderKeepers();
    if(user && !real()) body.appendChild(el('p', 'sub', 'Your ink is kept by this browser. Sign in with Google to keep it on any device'));
    /* a guest is offered Google instead of signing out, which would lose their ink */
    const who = el('p', 'who', real() ? `${myName()} · ` : `${myName()} (guest) · `);
    const link2 = (text, fn) => { const b = el('button', null, text); b.addEventListener('click', fn); return b; };
    if(real()) who.appendChild(link2('Sign out', async ()=>{ if(unsent()) show('out'); else await signOut(); }));
    else{
      who.appendChild(link2('Change name', ()=> show('name')));
      who.appendChild(document.createTextNode(' · '));
      who.appendChild(link2('Sign in with Google', async ()=>{ await signIn(); render(); }));
    }
    body.appendChild(who);
  }
  async function signOut(){
    await Promise.race([flush(), wait(4000)]).catch(()=>{});
    clearTimeout(keepTm);
    await F.signOut(F.au);
    render();
  }
  /* the creator sees who keeps the book: each can be let only read, or removed,
     and whoever was removed can be let back. A keeper can leave */
  let target = null;
  function renderKeepers(){
    if(!cur.owner) return;
    if(cur.owner !== user.uid){
      if(reading) body.appendChild(el('p', 'sub', 'You can read this book. Its creator has not let you write in it'));
      const acts = el('div', 'acts');
      acts.appendChild(btn('Leave this book', 'minor', async ()=> show('leave')));
      body.appendChild(acts);
      return;
    }
    const tools = el('div', 'acts');
    tools.appendChild(btn('Rename this book', 'minor', async ()=> show('rename')));
    tools.appendChild(btn('Delete this book', 'minor', async ()=> show('del')));
    const rest = [...names.entries()].filter(([u]) => u !== user.uid);
    const shut = [...access.entries()].filter(([u, a]) => a.can === 'none' && !names.has(u));
    const link3 = (text, fn) => { const b = el('button', null, text); b.addEventListener('click', fn); return b; };
    if(rest.length){
      body.appendChild(el('h3', null, `Keepers · ${rest.length}`));
      const list = el('div', 'keepers');
      rest.forEach(([uid, name])=>{
        const reads = (access.get(uid) || {}).can === 'read';
        const row = el('div', 'row');
        const who = el('span', 'name', name);
        who.appendChild(el('small', null, reads ? 'only reads' : 'writes'));
        row.appendChild(who);
        row.appendChild(link3(reads ? 'Let write' : 'Only read', ()=> allow(uid, reads ? null : 'read')));
        row.appendChild(link3('Remove', ()=>{ target = { uid, name }; show('remove'); }));
        list.appendChild(row);
      });
      body.appendChild(list);
    }
    if(shut.length){
      body.appendChild(el('h3', null, 'Removed'));
      const list = el('div', 'keepers');
      shut.forEach(([uid, a])=>{
        const row = el('div', 'row');
        row.appendChild(el('span', 'name', a.name || 'Friend'));
        row.appendChild(link3('Let back in', ()=> allow(uid, null)));
        list.appendChild(row);
      });
      body.appendChild(list);
    }
    body.appendChild(tools);
  }
  function renderDelete(){
    body.appendChild(el('p', 'sub', `Everything written in ${cur.name}, by you and by everyone else, disappears for good. Download it first if you want to keep it`));
    const acts = el('div', 'acts');
    acts.appendChild(btn('Delete the book', 'main', deleteBook));
    acts.appendChild(btn('Download it first', '', async ()=> api.exportText()));
    acts.appendChild(btn('Keep it', 'minor', async ()=> show('share')));
    body.appendChild(acts);
  }
  function nameForm(value, max, label, save){
    const input = el('input');
    input.type = 'text'; input.maxLength = max; input.value = value; input.setAttribute('aria-label', label);
    body.appendChild(input);
    const go = async ()=>{ if(!input.value.trim()){ input.focus(); return; } await save(input.value); show('share'); };
    input.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); go(); } });
    const acts = el('div', 'acts');
    acts.appendChild(btn('Save', 'main', go));
    acts.appendChild(btn('Cancel', 'minor', async ()=> show('share')));
    body.appendChild(acts);
    setTimeout(()=>{ input.focus(); input.select(); }, 50);
  }
  function renderRename(){
    body.appendChild(el('p', 'sub', 'Everyone who keeps the book sees the new name'));
    nameForm(cur.name, 60, 'Book name', renameBook);
  }
  function renderName(){
    body.appendChild(el('p', 'sub', 'The name your friends see by your writing'));
    nameForm(guestName, 24, 'Your name', renameGuest);
  }
  function renderOut(){
    body.appendChild(el('p', 'sub', 'Some of your writing has not reached the book yet. If you sign out now, it stays behind in this browser'));
    const acts = el('div', 'acts');
    acts.appendChild(btn('Stay signed in', 'main', async ()=> show('share')));
    acts.appendChild(btn('Sign out anyway', 'minor', signOut));
    body.appendChild(acts);
  }
  /* a question from the rest of the book, answered with a button */
  let asking = null;
  function ask(q){
    if(locked()) return Promise.resolve(false);
    if(asking) asking.done(false);
    return new Promise(res=>{
      asking = { ...q, done: v => { asking = null; res(v); } };
      show('ask');
    });
  }
  function renderAsk(){
    const q = asking;
    body.appendChild(el('p', 'sub', q.text));
    const acts = el('div', 'acts');
    acts.appendChild(btn(q.yes, 'main', async ()=>{ q.done(true); close(); }));
    if(q.extra) acts.appendChild(btn(q.extra.label, '', async ()=> q.extra.fn()));
    acts.appendChild(btn(q.no, 'minor', async ()=>{ q.done(false); close(); }));
    body.appendChild(acts);
  }
  function renderLeave(){
    body.appendChild(el('p', 'sub', `What you wrote stays in ${cur.name}: it is gospel. To come back, ask for the link again`));
    const acts = el('div', 'acts');
    acts.appendChild(btn('Leave the book', 'main', leaveShared));
    acts.appendChild(btn('Stay', 'minor', async ()=> show('share')));
    body.appendChild(acts);
  }
  function renderRemove(){
    if(!target){ mode = 'share'; renderShare(); return; }
    const t = target;
    const guest = guests.has(t.uid);
    body.appendChild(el('p', 'sub', `${t.name} will no longer be able to open ${cur.name}, and the link will not let them back in. What they wrote stays. You can let them back later`
      + (guest ? '. They are a guest, so your link changes too: the old one stops working' : '')));
    const acts = el('div', 'acts');
    acts.appendChild(btn(`Remove ${t.name}`, 'main', async ()=>{ target = null; await removeKeeper(t.uid); show('share'); }));
    acts.appendChild(btn('Keep them', 'minor', async ()=>{ target = null; show('share'); }));
    body.appendChild(acts);
  }
  async function renderLink(acts){
    body.appendChild(el('p', 'sub', 'Send this link to as many friends as you like. They take the vow, sign it and write with you'));
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
  /* ---------- the invitation: a card on the book's own paper, the rules, the vow, a signature ---------- */
  const RULES = ['What is written here is gospel*', 'It is not up for discussion', 'If a page bores you, turn it'];
  const VOW = [
    'I swear that what I write is true.',
    'I swear: no notes, from me or you.',
    'I swear, if any page should bore,',
    'to turn it and to write some more.',
    'I swear by cake, I swear by wine:',
    'your word is law, and so is mine.',
  ];
  const SEAL = '<svg viewBox="0 0 80 80" aria-hidden="true"><defs><radialGradient id="wax" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#a8392c"/><stop offset=".55" stop-color="#7c2119"/><stop offset="1" stop-color="#4c110c"/></radialGradient></defs>'
    + '<path fill="url(#wax)" d="M40 3c6 0 8 3 13 4s9 1 12 6 2 8 5 12 6 7 5 13-4 8-4 13 1 9-3 13-8 3-12 6-7 6-13 6-8-4-13-5-9 0-12-4-2-8-6-11-6-6-6-12 4-8 4-13-2-9 2-13 8-3 12-6 9-9 16-9z"/>'
    + '<circle cx="40" cy="40" r="24" fill="none" stroke="#3a0b07" stroke-opacity=".55" stroke-width="2.4"/><circle cx="40" cy="40" r="24" fill="none" stroke="#e08a6a" stroke-opacity=".28" stroke-width="1" transform="translate(-.8 -.8)"/>'
    + '<path fill="none" stroke="#3a0b07" stroke-opacity=".6" stroke-width="2" stroke-linejoin="round" d="M40 22 47.8 56.2 25.9 28.8 57.5 44 22.5 44 54.1 28.8 32.2 56.2Z"/>'
    + '<path fill="none" stroke="#f0a98a" stroke-opacity=".3" stroke-width=".9" stroke-linejoin="round" transform="translate(-.7 -.7)" d="M40 22 47.8 56.2 25.9 28.8 57.5 44 22.5 44 54.1 28.8 32.2 56.2Z"/></svg>';
  let sign = '';
  function renderJoin(){
    const seal = el('div', 'seal'); seal.innerHTML = SEAL;
    body.prepend(seal);
    const from = joinWant && joinWant.from;
    body.appendChild(el('p', 'script', from ? `${from} invites you` : 'You are invited'));
    body.appendChild(el('p', 'line', 'to become a keeper of'));
    body.appendChild(el('p', 'title', joinWant && joinWant.book || 'this bible'));
    body.appendChild(el('p', 'line', 'Ours. No notes'));
    body.appendChild(el('div', 'orn'));
    const list = el('ol', 'rules');
    RULES.forEach((r, i)=>{ const li = el('li'); li.appendChild(el('b', null, ['I', 'II', 'III'][i])); li.appendChild(el('span', null, r)); list.appendChild(li); });
    body.appendChild(list);
    body.appendChild(el('p', 'note', '* typos included'));
    const acts = el('div', 'acts');
    acts.appendChild(btn('Accept the invitation', 'main', async ()=> show('vow')));
    body.appendChild(acts);
  }
  function renderVow(){
    const box = el('div', 'vow');
    VOW.forEach(t => box.appendChild(el('p', null, t)));
    box.appendChild(el('p', 'amen', 'Amen'));
    body.appendChild(box);
    const sig = el('div', 'sign');
    const acts = el('div', 'acts');
    const seal = async open => { wantJoin({ ...joinWant, vowed: true }); await open(); };
    if(user){
      sig.appendChild(el('p', 'name', myName()));
      sig.appendChild(el('p', 'cap', 'your signature'));
      body.appendChild(sig);
      acts.appendChild(btn('I swear', 'main', ()=> seal(join)));
    }else{
      const name = el('input'); name.type = 'text'; name.maxLength = 24; name.value = sign || guestName; name.placeholder = 'Your name'; name.setAttribute('aria-label', 'Your name');
      name.autocomplete = 'given-name';
      name.addEventListener('input', ()=>{ sign = name.value; });
      sig.appendChild(name);
      sig.appendChild(el('p', 'cap', 'the name your friends will see'));
      body.appendChild(sig);
      const open = ()=>{ if(!name.value.trim()){ name.focus(); api.toast('SIGN YOUR NAME FIRST', 1600); return; } return seal(()=> joinAsGuest(name.value)); };
      name.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); open(); } });
      acts.appendChild(btn('I swear', 'main', open));
      acts.appendChild(btn('Sign with Google instead', 'minor', ()=> seal(signIn)));
      if(!name.value) setTimeout(()=> name.focus(), 60);
    }
    body.appendChild(acts);
  }
  function renderShut(){
    body.appendChild(el('p', 'sub', 'The creator of this book has closed it to you'));
    const acts = el('div', 'acts');
    acts.appendChild(btn('Close', 'main', async ()=> close()));
    body.appendChild(acts);
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
    show(joinWant.vowed ? 'vow' : 'join');
    firebase().catch(()=>{});
  }
  function start(){
    if(!sharingOn) return;
    /* the invitation is kept for this tab, so a sign-in that leaves the page
       and comes back still lands in the book */
    const m = /^#join=([A-Za-z0-9]{6,40})\.([a-z0-9]{24,64})((?:&[a-z]+=[^&]*)*)$/.exec(location.hash);
    let kept = null;
    try{ kept = JSON.parse(sessionStorage.getItem(JOIN_KEY)); }catch(e){}
    if(m || (kept && typeof kept.id === 'string' && typeof kept.code === 'string')){
      if(m){
        const q = new URLSearchParams(m[3].slice(1));
        const said = (k, max)=> (q.get(k) || '').trim().slice(0, max) || null;
        wantJoin({ id: m[1], code: m[2], from: said('from', 24), book: said('book', 60) });
      }else wantJoin(kept);
      if(m) history.replaceState(null, '', location.pathname + location.search);
      /* the invitation comes once the opening is over and the book is still */
      Promise.resolve(api.settled && api.settled()).then(invite);
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
    open: ()=>{ if(!locked()) show('share'); },
    isOpen: ()=> !view.hidden,
    close: dismiss,
    note: ()=> cur ? [cur.name, others()].filter(Boolean).join(', ') : 'Send the book to a friend',
    /* one line under the menu on where the writing is kept */
    kept: ()=> !!cur || copied(),
    status: ()=>{
      if(cur){
        if(reading) return 'You can only read this book';
        if(unsent() && !navigator.onLine) return 'Not sent yet: no connection. It goes when you’re back';
        if(unsent() && slow) return 'Sending…';
        if(user && user.isAnonymous) return 'Saves automatically, in this browser for you as a guest';
        return 'Saves automatically';
      }
      if(clash && real()) return 'Your Google account keeps another copy: see Share';
      if(copied()) return 'Saves automatically, with a copy in your Google account';
      if(real()) return 'Saves automatically. A copy goes to your Google account as you write';
      return 'Saves in this browser only';
    },
    keepSoon, ask, personal: ()=> goPersonal(),
    name: h => names.get(h) || null,
    shared: ()=> !!cur,
    readOnly: ()=> !!cur && reading,
    ...(EMU ? { test: {
      firebase, createBook, inviteLink, openBook, goPersonal, upload, keysBetween, leaveShared, removeKeeper, allow,
      deleteBook, renameBook, renameGuest, keepNow, get clash(){ return clash; },
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
