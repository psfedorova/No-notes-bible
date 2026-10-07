/* ============================================================================
   shared books: one book written in by several people, kept in Firebase

   Each member signs in with Google. A page is the letters of every hand on it,
   each letter with a position key; a page reads them sorted by key. Every
   hand's letters of a page are a doc of their own (books/{id}/ink/{n}_{uid}).
   Any keeper may erase or move any hand's letters: the doc is changed letter
   by letter in a transaction, so two people can write on one page at once, and
   the page as it was goes to books/{id}/past first, so it can be brought back.
   The rules are firestore.rules.

   A Google account also keeps a copy of the private book (users/{uid}/keep),
   so it comes back on a new device or after the browser forgets it.
   ==========================================================================*/
import { FIREBASE } from './book-config.js';
import { vanish, burnIn, calm } from './invite-magic.js?v=6';

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
const MAKE_MS = 20000;
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
  let names = new Map(), plainNames = new Map(), guests = new Set(), access = new Map(), reading = false;
  let ink = new Map(), pending = new Set(), merged = new Map(), deferred = new Set();
  let base = new Map(), pastQ = [], pastAt = new Map(), forced = new Set(), flight = null;
  let upTm = 0, joinWant = null, dirtyInk = new Set(), link = null;
  let inflight = 0, waitTm = 0, slow = false;
  let keepTm = 0, clash = null, checked = new Set(), making = false;
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
    cur = null; ink = new Map(); merged = new Map(); pending = new Set(); deferred = new Set(); names = new Map(); plainNames = new Map();
    base = new Map(); pastQ = []; pastAt = new Map(); forced = new Set();
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
    ink = new Map(); dirtyInk = new Set(); link = null;
    pending = new Set((ic && Array.isArray(ic.pending) ? ic.pending : []).map(x => typeof x === 'number' ? pid(x, c.uid) : String(x)));
    base = new Map(); pastAt = new Map(); forced = new Set();
    Object.entries(ic && ic.base || {}).forEach(([x, e])=>{
      const E = e && { s: e.s, k: splitKeys(e.k), f: e.f || null, c: !!e.c };
      if(e === null) base.set(x, null); else if(goodEntry(E)) base.set(x, E);
    });
    pastQ = ic && Array.isArray(ic.past) ? ic.past : [];
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
        access = new Map(a.docs.map(d => [d.id, { can: d.data().can, name: d.data().name, guest: d.data().guest === true }]));
        if(!view.hidden) render();
      }, ()=>{});
      const mine = books.find(b => b.id === id);
      if(mine && mine.name !== cur.name) F.setDoc(ref('users', user.uid, 'books', id), { name: cur.name, at: F.serverTimestamp() }).catch(()=>{});
      api.refresh();
      if(!view.hidden) render();
    }, e => lost(e));
    offMembers = F.onSnapshot(F.collection(F.db, 'books', id, 'members'), s=>{
      names = keeperNames(s.docs);
      plainNames = new Map(s.docs.map(d => [d.id, String(d.data().name || 'Friend').slice(0, 40)]));
      guests = new Set(s.docs.filter(d => d.data().guest).map(d => d.id));
      saveInk();
      if(!view.hidden) render();
    }, ()=>{});
    /* the creator may let this hand only read; the quill is then put down */
    offMine = F.onSnapshot(ref('books', id, 'access', user.uid), s=>{
      const was = reading;
      reading = s.exists() && s.data().can === 'read';
      if(reading === was) return;
      if(!reading && (pending.size || pastQ.length)) queueUp();
      api.refresh();
      if(!view.hidden) render();
      api.toast(reading ? 'YOU CAN ONLY READ THIS BOOK NOW' : 'YOU CAN WRITE IN THIS BOOK AGAIN', 2600);
    }, ()=>{});
    offInk = F.onSnapshot(F.collection(F.db, 'books', id, 'ink'), s => onInk(s), e => lost(e));
    if(pending.size || pastQ.length) queueUp();
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
    clearTimeout(upTm); pending.clear(); base.clear(); pastQ = [];
    try{
      const [inkS, memS, accS, pastS] = await Promise.all(['ink', 'members', 'access', 'past'].map(c => server(F.collection(F.db, 'books', id, c))));
      const refs = [...inkS.docs.map(d => ref('books', id, 'ink', d.id)), ...pastS.docs.map(d => ref('books', id, 'past', d.id)), ...memS.docs.filter(d => d.id !== me).map(d => ref('books', id, 'members', d.id)),
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
      api.toast(`THE BOOK IS NOW CALLED ${name.toUpperCase()}`, 2400);
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
    api.toast(`THE KEEPERS NOW KNOW YOU AS ${name.toUpperCase()}`, 2400);
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
    const name = plainNames.get(uid) || 'Friend';
    const batch = F.writeBatch(F.db);
    batch.delete(ref('books', id, 'members', uid));
    batch.set(ref('books', id, 'access', uid), { can: 'none', name, guest, at: F.serverTimestamp() });
    if(guest){
      const code = randomId(32);
      batch.set(ref('books', id, 'invite', 'code'), { code });
      link = { id, url: joinUrl(id, code) };
    }
    batch.commit().then(()=> api.toast(`${name.toUpperCase()} CAN NO LONGER OPEN THE BOOK${guest ? '. YOUR LINK IS NEW' : ''}`, 2600))
      .catch(e=>{ console.warn('remove keeper', e); if(guest) link = null; api.toast(`COULD NOT REMOVE. ${refused(e)}`, 3200); });
  }
  /* the server's rules turning a change down read differently from a lost connection */
  const refused = e => e && e.code === 'permission-denied' ? 'THE BOOK’S RULES DO NOT ALLOW IT' : 'TRY AGAIN LATER';
  /* the creator forgets a removed keeper: they leave the Removed list, and the
     link changes in the same batch, so only a new link brings them back */
  async function forgetKeeper(uid){
    if(!cur || !user || cur.owner !== user.uid || uid === user.uid) return;
    const id = cur.id, code = randomId(32);
    const name = String((access.get(uid) || {}).name || 'Friend').slice(0, 40);
    const batch = F.writeBatch(F.db);
    batch.delete(ref('books', id, 'access', uid));
    batch.set(ref('books', id, 'invite', 'code'), { code });
    try{ await batch.commit(); link = { id, url: joinUrl(id, code) }; api.toast(`${name.toUpperCase()} IS FORGOTTEN. YOUR LINK IS NEW`, 2800); }
    catch(e){ console.warn('forget keeper', e); api.toast(`COULD NOT FORGET THEM. ${refused(e)}`, 3200); }
  }
  /* the creator lets a keeper she sent away back in: their place returns as it was,
     so any link to the book lets them in again, the one they already have too */
  async function letBack(uid){
    if(!cur || !user || cur.owner !== user.uid) return false;
    const a = access.get(uid);
    if(!a || a.can !== 'none') return false;
    const batch = F.writeBatch(F.db);
    batch.set(ref('books', cur.id, 'members', uid), { name: String(a.name || 'Friend').slice(0, 40), code: '', guest: a.guest === true, at: F.serverTimestamp() });
    batch.delete(ref('books', cur.id, 'access', uid));
    try{ await batch.commit(); api.toast(`${String(a.name || 'Friend').toUpperCase()} IS BACK IN THE BOOK`, 2600); return true; }
    catch(e){ console.warn('let back', e); api.toast(`COULD NOT LET THEM BACK. ${refused(e)}`, 3200); return false; }
  }
  /* the creator lets a keeper only read, or write again */
  function allow(uid, can){
    if(!cur || !user || cur.owner !== user.uid || uid === user.uid) return;
    const r = ref('books', cur.id, 'access', uid);
    const name = (names.get(uid) || 'Friend').replace(/ \(guest\)$/, '').slice(0, 60);
    (can ? F.setDoc(r, { can, name, at: F.serverTimestamp() }) : F.deleteDoc(r))
      .then(()=> api.toast(can ? `${name.toUpperCase()} CAN ONLY READ NOW` : `${name.toUpperCase()} CAN WRITE AGAIN`, 2400))
      .catch(e=>{ console.warn('keeper access', e); api.toast(`COULD NOT CHANGE IT. ${refused(e)}`, 3200); });
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
  /* an ink doc is named by its page and its hand: books/{id}/ink/{n}_{uid} */
  const pid = (n, h) => `${n}|${h}`;
  const splitId = x => { const i = x.indexOf('|'); return [x.slice(0, i)|0, x.slice(i + 1)]; };
  const inkRef = (id, x) => { const [n, h] = splitId(x); return ref('books', id, 'ink', `${n}_${h}`); };
  const EMPTY = { s: '', k: [], f: null, c: false };
  const copyEntry = e => e ? { s: e.s, k: e.k.slice(), f: e.f || null, c: !!e.c } : null;
  const sameEntry = (x, y) => x.s === y.s && x.k.join() === y.k.join() && (x.f || null) === (y.f || null) && !!x.c === !!y.c;
  /* a change made here on top of what the server had (base) is carried over to what the
     server has now: letter by letter, each known by its key, so two hands changing one
     doc at once both keep their change */
  function rebase(L, B, S){
    L = L || EMPTY; B = B || EMPTY; S = S || EMPTY;
    const map = e => { const m = new Map(); for(let i=0;i<e.s.length;i++) m.set(e.k[i], e.s[i]); return m; };
    const ml = map(L), mb = map(B), out = map(S);
    mb.forEach((ch, k)=>{ if(ml.get(k) !== ch && out.get(k) === ch) out.delete(k); });
    ml.forEach((ch, k)=>{ if(mb.get(k) !== ch) out.set(k, ch); });
    const ks = [...out.keys()].sort();
    return { s: ks.map(k => out.get(k)).join(''), k: ks, f: (L.f || null) !== (B.f || null) ? L.f || null : S.f || null, c: !!L.c !== !!B.c ? !!L.c : !!S.c };
  }
  /* the page as it is here, matched letter by letter to the merged ink: the same hand and
     the same letter keep their key; a long page with much changed is not matched inside */
  function align(P, PA, M){
    const mp = new Array(P.length).fill(-1), eq = (i, q) => P[i] === M.t[q] && PA[i] === M.a[q];
    let a = 0, b = 0;
    while(a < P.length && a < M.t.length && eq(a, a)){ mp[a] = a; a++; }
    while(b < P.length - a && b < M.t.length - a && eq(P.length - 1 - b, M.t.length - 1 - b)){ mp[P.length - 1 - b] = M.t.length - 1 - b; b++; }
    const n = P.length - a - b, m = M.t.length - a - b, W = m + 1;
    if(!n || !m || n*m > 1e6) return mp;
    const D = new Uint16Array((n + 1)*W);
    for(let i=n-1;i>=0;i--) for(let q=m-1;q>=0;q--)
      D[i*W + q] = eq(a + i, a + q) ? D[(i + 1)*W + q + 1] + 1 : Math.max(D[(i + 1)*W + q], D[i*W + q + 1]);
    for(let i=0, q=0; i < n && q < m;){
      if(eq(a + i, a + q)){ mp[a + i] = a + q; i++; q++; }
      else if(D[(i + 1)*W + q] >= D[i*W + q + 1]) i++;
      else q++;
    }
    return mp;
  }
  /* a page is kept as it was before another hand's ink on it is erased or changed, so any
     keeper can bring it back; letter by letter erasing keeps it once, while every erased
     letter is still in the copy kept here in the last ten minutes */
  const PAST_MS = 600000;
  function keepPast(n, M, force, gone){
    if(!M.t || reading) return;
    const now = Date.now(), last = pastAt.get(n);
    if(!force && last && now - last.at < PAST_MS && gone.every(x => last.has.has(x))) return;
    pastAt.set(n, { at: now, has: new Set(M.k.map((k, i)=> `${M.a[i]}|${k}`)) });
    const h = [], runs = [];
    M.a.forEach(x=>{
      let i = h.indexOf(x);
      if(i < 0){ i = h.length; h.push(x); }
      const r = runs[runs.length - 1];
      if(r && r[0] === i) r[1]++; else runs.push([i, 1]);
    });
    pastQ.push({ n, t: M.t, a: runs.map(r => r.join(':')).join(','), h, f: M.f || null, c: !!M.c, when: now });
  }
  function unpackPast(p){
    const a = [];
    String(p.a || '').split(',').forEach(r=>{ const [i, c] = r.split(':').map(Number); for(let j=0;j<c;j++) a.push(p.h[i]); });
    return a.length === p.t.length ? a : null;
  }
  /* what changed on the pages goes into the ink of the hands whose letters they are: new
     letters are this hand's, and any hand's letters may be erased or moved on */
  function sync(){
    if(!cur) return;
    const me = cur.uid;
    deferred.forEach(n=>{ deferred.delete(n); showMerged(n, true); });
    for(let n=1;n<2*api.N;n++){
      const M = merged.get(n) || mergePage(n), p = api.page(n);
      if(samePage(n, M)){ forced.delete(n); continue; }
      const P = p.t, PA = api.handsOf(n), mp = align(P, PA, M), K = new Array(P.length);
      for(let i=0;i<P.length;){
        if(mp[i] >= 0){ K[i] = M.k[mp[i]]; i++; continue; }
        let j = i;
        while(j < P.length && mp[j] < 0) j++;
        const fresh = keysBetween(i > 0 ? K[i - 1] : '', j < P.length ? M.k[mp[j]] : null, j - i);
        for(let q=i;q<j;q++) K[q] = fresh[q - i];
        i = j;
      }
      let m = ink.get(n);
      if(!m){ m = new Map(); ink.set(n, m); }
      const gone = [];
      new Set([...m.keys(), ...PA]).forEach(h=>{
        let s = '';
        const k = [], e = m.get(h);
        for(let i=0;i<P.length;i++) if(PA[i] === h){ s += P[i]; k.push(K[i]); }
        const mine = h === me || !e;
        const next = { s, k, f: mine ? p.f || null : e.f || null, c: mine ? !!p.c : !!e.c };
        if(e ? sameEntry(e, next) : !s) return;
        if(e && h !== me){ const kept = new Set(k); e.k.forEach(x=>{ if(!kept.has(x)) gone.push(`${h}|${x}`); }); }
        const x = pid(n, h);
        if(!pending.has(x)){ base.set(x, copyEntry(e)); pending.add(x); }
        m.set(h, next);
        dirtyInk.add(n);
      });
      if(gone.length || forced.has(n)) keepPast(n, M, forced.has(n), gone);
      forced.delete(n);
      merged.set(n, mergePage(n));
      showMerged(n, true);
    }
    saveInk();
    if(pending.size || pastQ.length) queueUp();
  }
  function onInk(snap){
    sync();
    const touched = new Set();
    snap.docChanges().forEach(ch=>{
      const d = ch.doc.data(), n = d.n|0;
      if(!(n >= 1 && n < 2*api.N) || typeof d.uid !== 'string' || ch.type === 'removed') return;
      const E = { s: d.s, k: splitKeys(d.k), f: d.f || null, c: !!d.c };
      if(!goodEntry(E)) return;
      const x = pid(n, d.uid);
      let m = ink.get(n);
      if(!m){ m = new Map(); ink.set(n, m); }
      let next = E;
      if(pending.has(x)){
        next = base.has(x) ? rebase(m.get(d.uid), base.get(x), E) : m.get(d.uid) || EMPTY;
        base.set(x, E);
      }
      if(next.s) m.set(d.uid, next); else m.delete(d.uid);
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
    const b = {};
    base.forEach((e, x)=>{ b[x] = e && { s: e.s, k: e.k.join(','), f: e.f, c: e.c }; });
    lsSet(inkKey(cur.id), { pending: [...pending], base: b, past: pastQ, names: Object.fromEntries(names) });
  }
  /* keys that grew long from much writing in one spot are spaced out again;
     only this hand's letters move, each run between the same neighbours */
  function rekey(n, h){
    const M = mergePage(n), k = M.k.slice();
    for(let i=0;i<M.t.length;){
      if(M.a[i] !== h){ i++; continue; }
      let j = i;
      while(j < M.t.length && M.a[j] === h) j++;
      const fresh = keysBetween(i > 0 ? k[i - 1] : '', j < M.t.length ? k[j] : null, j - i);
      for(let q=i;q<j;q++) k[q] = fresh[q - i];
      i = j;
    }
    ink.get(n).get(h).k = k.filter((_, i)=> M.a[i] === h);
    merged.set(n, mergePage(n));
    dirtyInk.add(n);
  }
  function queueUp(){ clearTimeout(upTm); upTm = setTimeout(upload, WRITE_MS); }
  /* each doc is read and written in one transaction, the change made here laid over
     what the server has; a doc of another hand is marked with this hand in 'by' */
  function upload(){
    clearTimeout(upTm);
    if(flight) return flight.then(()=> upload());
    if(!cur || !user || !F || (!pending.size && !pastQ.length) || reading) return Promise.resolve();
    const me = cur.uid, id = cur.id, list = [...pending].slice(0, 100), pasts = pastQ.slice(0, 20), sent = new Map();
    list.forEach(x=>{
      const [n, h] = splitId(x);
      let e = (ink.get(n) || new Map()).get(h);
      if(e && e.k.join(',').length > Array.from(e.s).length*24){ rekey(n, h); e = ink.get(n).get(h); }
      sent.set(x, { L: copyEntry(e) || EMPTY, B: base.get(x), known: base.has(x) });
    });
    sending(1);
    flight = F.runTransaction(F.db, async tx=>{
      const docs = await Promise.all(list.map(x => tx.get(inkRef(id, x))));
      const out = new Map();
      list.forEach((x, i)=>{
        const [n, h] = splitId(x), { L, B, known } = sent.get(x), d = docs[i].exists() ? docs[i].data() : null;
        const S = d && { s: d.s, k: splitKeys(d.k), f: d.f || null, c: !!d.c };
        const R = known && goodEntry(S) ? rebase(L, B, S) : L;
        const w = { uid: h, dev: DEV, n, s: R.s, k: R.k.join(','), f: R.f || null, c: !!R.c, at: F.serverTimestamp() };
        if(h !== me) w.by = me;
        tx.set(inkRef(id, x), w);
        out.set(x, R);
      });
      pasts.forEach(p=>{
        const { when, ...keep } = p;
        tx.set(F.doc(F.collection(F.db, 'books', id, 'past')), { ...keep, by: me, at: F.serverTimestamp() });
      });
      return out;
    }).then(out=>{
      flight = null;
      sending(-1);
      if(!cur || cur.id !== id) return;
      pastQ.splice(0, pasts.length);
      const touched = new Set();
      out.forEach((R, x)=>{
        const [n, h] = splitId(x), { L } = sent.get(x);
        let m = ink.get(n);
        if(!m){ m = new Map(); ink.set(n, m); }
        const now = rebase(m.get(h), L, R);
        if(sameEntry(now, R)){ pending.delete(x); base.delete(x); }
        else base.set(x, R);
        if(now.s) m.set(h, now); else m.delete(h);
        touched.add(n); dirtyInk.add(n);
      });
      touched.forEach(n=>{ merged.set(n, mergePage(n)); showMerged(n, true); });
      saveInk();
      if(pending.size || pastQ.length) queueUp();
      if(user && user.isAnonymous) nudgeGuest();
      sending(0);
    }, e=>{
      flight = null;
      sending(-1);
      if(!cur || cur.id !== id) return;
      /* refused for good (the book is gone or closed to this hand): the ink stays here, unsent */
      if(e && e.code === 'permission-denied'){ console.warn('ink refused', e); return; }
      clearTimeout(upTm); upTm = setTimeout(upload, 10000);
    });
    return flight;
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
    if(cur && (pending.size || pastQ.length)) queueUp();
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
      pending.add(pid(p.n, me)); base.set(pid(p.n, me), null); dirtyInk.add(p.n);
      merged.set(p.n, mergePage(p.n));
      showMerged(p.n, true);
    });
    saveInk();
    openLive();
    upload();
    link = { id, url: joinUrl(id, code) };
    show('share');
  }
  /* a new book takes a few seconds (a guest is signed in first): the card says so
     meanwhile, and lets go if the connection never answers */
  async function makeBook(guest){
    if(making) return;
    making = true;
    render();
    try{
      const job = (async ()=>{
        if(guest !== undefined && !await beGuest(guest)) return;
        await createBook(`${myName()}’s book`, true);
      })();
      if(await Promise.race([job.then(()=> 'done'), wait(MAKE_MS).then(()=> 'slow')]) === 'slow') api.toast('NO CONNECTION. TRY AGAIN LATER', 2400);
    }finally{
      making = false;
      if(!view.hidden && mode === 'share') render();
    }
  }
  /* the link carries who invites and to which book, so the invitation can say it
     before the friend is let in to read either */
  const joinUrl = (id, code)=> `${location.origin}${location.pathname}#join=${id}.${code}`
    + `&book=${encodeURIComponent(cur ? cur.name : 'Our book')}`;
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
    if(await beGuest(name)) await join();
  }
  /* one join at a time: a second call (a sign-in and a tap together) waits for the first */
  let joining = null;
  function join(){
    if(!joining) joining = joinNow().finally(()=>{ joining = null; });
    return joining;
  }
  async function joinNow(){
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
      else if(mine.data().guest !== user.isAnonymous || mine.data().name !== myName()) F.updateDoc(ref('books', want.id, 'members', me), { name: myName(), guest: user.isAnonymous }).catch(()=>{});
      const b = await F.getDoc(ref('books', want.id));
      const name = b.exists() ? b.data().name : 'Our book';
      await F.setDoc(ref('users', me, 'books', want.id), { name, at: F.serverTimestamp() });
      if(cur) leaveBook();
      openCached({ id: want.id, uid: me, name, owner: b.exists() ? b.data().owner : null });
      openLive();
      close();
      /* said once the opening film is over and the book is still, or it plays unseen under the film */
      Promise.resolve(api.settled && api.settled()).then(()=> api.toast(back && !want.vowed ? `BACK IN ${name.toUpperCase()}` : 'AMEN. NO NOTES', 2600));
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
  view.addEventListener('click', e => view.querySelectorAll('details.menu-p[open]').forEach(d => { if(!d.contains(e.target)) d.open = false; }));
  view.addEventListener('keydown', e=>{ e.stopPropagation(); if(e.key === 'Escape'){ e.preventDefault(); dismiss(); } });
  function show(m){ mode = m; view.hidden = false; api.blurQuill(); render(); }
  function close(){ sign = ''; if(asking) asking.done(false); view.hidden = true; mode = 'share'; api.focusQuill(); release(); }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if(cls) e.className = cls; if(text !== undefined) e.textContent = text; return e; };
  function pill(text, fn, cls){
    const b = el('button', 'pill' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
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
  const TITLES = { share: 'SHARE THE BOOK', join: '', vow: 'THE VOW', badInvite: 'AN INVITATION', shut: 'AN INVITATION', leave: 'LEAVE THE BOOK', del: 'DELETE THE BOOK', rename: 'NAME THE BOOK', name: 'YOUR NAME', out: 'SIGN OUT', ask: '', past: 'PAGE HISTORY' };
  function render(){
    body.textContent = '';
    if(['leave', 'del', 'rename', 'past'].includes(mode) && !cur) mode = 'share';
    body.dataset.mode = mode;
    view.classList.toggle('locked', locked());
    view.classList.toggle('invite', locked());
    view.classList.toggle('over', !!invited);
    const card = view.querySelector('.card');
    card.style.backgroundImage = locked() && api.paper ? `url(${api.paper()})` : '';
    body.appendChild(el('h2', null, TITLES[mode]));
    if(mode === 'ask'){ body.firstChild.textContent = asking.title; renderAsk(); return; }
    if(!F && mode !== 'join' && mode !== 'vow'){ body.appendChild(el('p', 'sub', 'Loading…')); firebase().then(()=>{ if(!view.hidden) render(); }).catch(()=>{ body.lastChild.textContent = 'No connection. Try again later'; }); return; }
    ({ share: renderShare, join: renderJoin, vow: renderVow, badInvite: renderBad, shut: renderShut, leave: renderLeave, del: renderDelete, rename: renderRename, name: renderName, out: renderOut, past: renderPast })[mode]();
  }
  function bookRow(title, sub, on, fn, add){
    const b = el('button', 'book' + (on ? ' on' : '') + (add ? ' add' : ''));
    const t = el('span'); t.appendChild(el('span', null, title)); t.appendChild(el('small', null, sub));
    if(add) t.firstChild.prepend(el('i', 'plus'));
    b.appendChild(t);
    if(on) b.appendChild(el('span', 'tick', '✓'));
    b.addEventListener('click', async ()=>{ await fn(); render(); });
    return b;
  }
  function chev(){
    const i = el('i', 'chev');
    i.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 3.25 5 6.75 8.5 3.25"/></svg>';
    return i;
  }
  /* the title is the open book; a tap on it lists the others and a new one */
  function bookPicker(){
    const pick = el('details', 'pick');
    const sum = el('summary');
    sum.appendChild(el('h2', null, cur ? cur.name : 'Private book'));
    sum.appendChild(chev());
    pick.appendChild(sum);
    const list = el('div', 'list');
    list.appendChild(bookRow('Private book', copied() ? 'only you · a copy is in your Google account' : 'only you', !cur, async ()=> goPersonal()));
    books.forEach(b => list.appendChild(bookRow(b.name, cur && cur.id === b.id ? others() : 'shared', cur && cur.id === b.id, ()=> openBook(b.id))));
    if(cur) list.appendChild(bookRow('New shared book', 'a fresh book and its own link', false, ()=> createBook(`${myName()}’s book`, true), true));
    pick.appendChild(list);
    body.querySelector('h2').replaceWith(pick);
  }
  /* the private book is shared by making a shared copy of it, which opens */
  function renderShare(){
    const acts = el('div', 'acts');
    if(making){ body.appendChild(el('p', 'sub', 'Making the book and its link…')); return; }
    if(clash && real()) renderClash();
    if(!user){
      body.appendChild(el('p', 'sub', 'Your friend gets a link, takes the vow and writes in the book with you. No account needed. Anyone can erase or change any page, and every page keeps its history'));
      const input = el('input'); input.type = 'text'; input.maxLength = 24; input.value = guestName; input.placeholder = 'Your name'; input.setAttribute('aria-label', 'Your name');
      body.appendChild(input);
      body.appendChild(el('p', 'hint', 'the name your friend sees by your writing'));
      const go = async ()=>{
        const name = input.value.trim();
        if(!name){ input.focus(); api.toast('WRITE YOUR NAME FIRST', 1600); return; }
        await makeBook(name);
      };
      input.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); go(); } });
      acts.appendChild(btn('Get a link', 'main', go));
      acts.appendChild(btn('Sign in with Google instead', 'minor', signIn));
      body.appendChild(acts);
      return;
    }
    if(cur || books.length) bookPicker();
    if(cur) renderLink(acts);
    else if(made >= MAX_BOOKS){
      body.appendChild(el('p', 'sub', `You keep ${MAX_BOOKS} shared books, the most there can be. Open one from the list above to share it, or delete one of yours to make room`));
    }else{
      body.appendChild(el('p', 'sub', 'Your friend gets a link, takes the vow and writes in the book with you. Anyone can erase or change any page, and every page keeps its history'));
      acts.appendChild(btn('Get a link', 'main', ()=> makeBook()));
      body.appendChild(acts);
    }
    if(cur && user) renderKeepers();
    /* a guest is offered Google instead of signing out, which would lose their ink */
    const acct = el('div', 'acct');
    const who = el('div', 'who');
    who.appendChild(el('span', null, real() ? `Signed in as ${myName()}` : `${myName()}, a guest`));
    if(real()) who.appendChild(pill('Sign out', async ()=>{ if(unsent()) show('out'); else await signOut(); }));
    else{
      who.appendChild(pill('Change name', ()=> show('name')));
      who.appendChild(pill('Sign in with Google', async ()=>{ await signIn(); render(); }));
    }
    acct.appendChild(who);
    if(user && !real()) acct.appendChild(el('p', 'hint', 'Your ink is kept by this browser. Sign in with Google to keep it on any device'));
    body.appendChild(acct);
  }
  async function signOut(){
    await Promise.race([flush(), wait(4000)]).catch(()=>{});
    clearTimeout(keepTm);
    await F.signOut(F.au);
    render();
  }
  /* the creator sees who keeps the book: each can be let only read, or removed,
     and whoever was removed is let back or forgotten right in the list. A keeper can leave */
  function renderKeepers(){
    if(!cur.owner) return;
    if(cur.owner !== user.uid){
      if(reading) body.appendChild(el('p', 'sub', 'You can read this book. Its creator has not let you write in it'));
      const tools = el('div', 'acts quiet');
      tools.appendChild(btn('Leave this book', 'minor', async ()=> show('leave')));
      body.appendChild(tools);
      return;
    }
    const rest = [...names.entries()].filter(([u]) => u !== user.uid);
    const shut = [...access.entries()].filter(([u, a]) => a.can === 'none' && !names.has(u));
    const menu = items => {
      const d = el('details', 'menu-p');
      const sum = el('summary', 'pill', 'Change');
      d.appendChild(sum);
      const opts = el('div', 'opts');
      items.forEach(it => {
        if(!it){ opts.appendChild(el('hr')); return; }
        const b = el('button', (it.on ? 'on' : '') + (it.danger ? ' danger' : ''), it.text);
        b.type = 'button';
        b.addEventListener('click', ()=>{ d.open = false; if(!it.on) it.fn(); });
        opts.appendChild(b);
      });
      d.appendChild(opts);
      /* the card clips what spills past its edge. The menu opens downward, upward only when
         it does not fit below, and it stays unseen until its side is chosen, so it never
         shows on one side and jumps to the other; the card scrolls only if neither side fits */
      d.addEventListener('toggle', ()=>{
        opts.classList.remove('up', 'placed');
        if(!d.open) return;
        const c = view.querySelector('.card').getBoundingClientRect(), r = d.getBoundingClientRect(), h = opts.offsetHeight;
        const below = c.bottom - r.bottom - 8, above = r.top - c.top - 8;
        if(h > below && above > below) opts.classList.add('up');
        opts.classList.add('placed');
        if(h > Math.max(below, above)) opts.scrollIntoView({ block: 'nearest' });
      });
      return d;
    };
    const person = (name, note, ...acts) => {
      const row = el('div', 'row');
      const who = el('span', 'name', name);
      who.appendChild(el('small', null, note));
      row.appendChild(who);
      acts.forEach(a => row.appendChild(a));
      return row;
    };
    const forget = uid => pill('Forget for good', async e=>{
      const b = e.currentTarget;
      b.disabled = true;
      await forgetKeeper(uid);
      b.disabled = false;
    }, 'danger');
    if(rest.length || shut.length){
      const sec = el('div', 'people');
      if(rest.length) sec.appendChild(el('h3', null, `People · ${rest.length}`));
      rest.forEach(([uid, name])=>{
        const reads = (access.get(uid) || {}).can === 'read';
        const plain = name.replace(/ \(guest\)$/, '');
        const note = `${guests.has(uid) ? 'guest, ' : ''}${reads ? 'only reads' : 'writes'}`;
        sec.appendChild(person(plain, note, menu([
          { text: 'Can write', on: !reads, fn: ()=> allow(uid, null) },
          { text: 'Can only read', on: reads, fn: ()=> allow(uid, 'read') },
          null,
          { text: 'Remove from the book', danger: true, fn: ()=> removeKeeper(uid) }
        ])));
      });
      if(shut.length) sec.appendChild(el('h3', null, 'Removed'));
      shut.forEach(([uid, a])=>{
        const name = a.name || 'Friend';
        sec.appendChild(person(name, 'cannot open the book',
          pill('Let back in', async e=>{ const b = e.currentTarget; b.disabled = true; await letBack(uid); b.disabled = false; }),
          forget(uid)));
      });
      body.appendChild(sec);
    }
    const more = el('details', 'more');
    const sum = el('summary');
    sum.appendChild(document.createTextNode('Book settings'));
    sum.appendChild(chev());
    more.appendChild(sum);
    const tools = el('div', 'tools');
    tools.appendChild(pill('Rename', ()=> show('rename')));
    tools.appendChild(pill('New invite link', async ()=>{
      const l = await inviteLink(true);
      if(l){ api.toast('NEW LINK MADE. THE OLD ONE NO LONGER WORKS', 2600); render(); }
    }));
    tools.appendChild(pill('Delete the book', ()=> show('del'), 'danger'));
    more.appendChild(tools);
    body.appendChild(more);
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
  /* ---------- a page's history: each time another hand's ink on it was erased or changed ---------- */
  let pastPages = [], pastRows = null;
  async function openPast(list){
    if(!cur || !list.length) return;
    pastPages = list; pastRows = null;
    show('past');
    const id = cur.id;
    try{
      await firebase();
      const snaps = await Promise.all(list.map(n => F.getDocs(F.query(F.collection(F.db, 'books', id, 'past'), F.where('n', '==', n)))));
      if(!cur || cur.id !== id) return;
      const rows = snaps.flatMap(q => q.docs.map(d=>{
        const v = d.data({ serverTimestamps: 'estimate' });
        return { ...v, when: v.at && v.at.toMillis ? v.at.toMillis() : Date.now() };
      }));
      pastQ.filter(p => list.includes(p.n)).forEach(p => rows.push({ ...p, by: cur.uid }));
      pastRows = rows.filter(r => typeof r.t === 'string' && r.t && Array.isArray(r.h)).sort((x, y)=> y.when - x.when).slice(0, 40);
    }catch(e){
      console.warn('page history', e);
      pastRows = [];
      api.toast('COULD NOT OPEN THE PAGE HISTORY', 2400);
    }
    if(!view.hidden && mode === 'past') render();
  }
  function renderPast(){
    const pages = pastPages.map(n => n + 1).join(' and ');
    body.appendChild(el('p', 'sub', `Page ${pages} as it was each time someone erased or changed another hand’s ink. Bring back any of them`));
    if(!pastRows){ body.appendChild(el('p', 'hint', 'Opening the history…')); return; }
    if(!pastRows.length){ body.appendChild(el('p', 'hint', 'Nothing here has been erased or changed yet')); return; }
    const sec = el('div', 'people');
    const when = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    pastRows.forEach(r=>{
      const row = el('div', 'row');
      const by = r.by === cur.uid ? 'your' : `${(names.get(r.by) || 'a keeper').replace(/ \(guest\)$/, '')}’s`;
      const name = el('span', 'name', `“${r.t.replace(/\s+/g, ' ').trim().slice(0, 80)}”`);
      name.appendChild(el('small', null, `${pastPages.length > 1 ? `page ${r.n + 1}, ` : ''}before ${by} change, ${when(r.when)}`));
      row.appendChild(name);
      if(!reading) row.appendChild(pill('Bring back', ()=> restorePast(r)));
      sec.appendChild(row);
    });
    body.appendChild(sec);
  }
  /* the page returns as it was, every letter to the hand that wrote it; what it held
     just before goes into its history too, so bringing back can itself be undone */
  function restorePast(r){
    const a = unpackPast(r);
    if(!a || reading){ api.toast('THIS PAGE CANNOT BE BROUGHT BACK', 2200); return; }
    forced.add(r.n);
    if(!api.applyPage(r.n, r.t, a, r.f, r.c, false)){ forced.delete(r.n); api.toast('FINISH THE WORD ON THIS PAGE FIRST', 2200); return; }
    sync();
    close();
    api.toast(`PAGE ${r.n + 1} IS BACK AS IT WAS`, 2400);
  }
  function renderLeave(){
    body.appendChild(el('p', 'sub', `What you wrote stays in ${cur.name}, with the keepers. To come back, ask for the link again`));
    const acts = el('div', 'acts');
    acts.appendChild(btn('Leave the book', 'main', leaveShared));
    acts.appendChild(btn('Stay', 'minor', async ()=> show('share')));
    body.appendChild(acts);
  }
  async function renderLink(acts, sub){
    body.appendChild(el('p', 'sub', sub || 'Friends with this link take the vow and write in this book with you'));
    const box = el('div', 'linkbox');
    const url0 = el('span', 'url', 'Making a link…');
    box.appendChild(url0);
    body.appendChild(box);
    body.appendChild(acts);
    const id = cur.id, url = await inviteLink(false);
    if(!cur || cur.id !== id) return;
    if(!url){ url0.textContent = 'Only the book’s creator can make a link'; return; }
    const shown = u => u.replace(/^https?:\/\//, '');
    url0.textContent = shown(url); url0.title = url;
    const copy = el('button', 'copy', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async ()=>{
      try{ await navigator.clipboard.writeText(link.url); copy.textContent = 'Copied ✓'; copy.classList.add('done'); setTimeout(()=>{ copy.textContent = 'Copy'; copy.classList.remove('done'); copy.blur(); }, 1600); }
      catch(e){ api.toast('SELECT THE LINK AND COPY IT', 2000); }
    });
    box.appendChild(copy);
    if(navigator.share) acts.prepend(btn('Send the link', 'main', async ()=>{ try{ await navigator.share({ title: cur.name, text: 'You’ve been invited to become a keeper of our bible. No notes', url: link.url }); }catch(e){} }));
  }
  /* ---------- the invitation: a card on the book's own paper, the rules, the vow, a signature ---------- */
  const RULES = ['Any keeper writes on any page', 'No notes: if it is wrong, rewrite it', 'The book remembers every page'];
  const VOW = [
    'I swear that what I write is true,',
    'no notes from me, no notes from you.',
    'If something’s wrong, I’ll make it right',
    'and write it over, black on white.',
    'I swear by cake, I swear by wine:',
    'the book forgets no single line.',
  ];
  let sign = '', swearing = false;
  function renderJoin(){
    body.appendChild(el('p', 'script', 'You have been chosen'));
    body.appendChild(el('p', 'line', 'to become a keeper of'));
    body.appendChild(el('p', 'title', joinWant && joinWant.book || 'this bible'));
    body.appendChild(el('p', 'line', 'where our story begins'));
    body.appendChild(el('div', 'orn'));
    const list = el('ol', 'rules');
    RULES.forEach((r, i)=>{ const li = el('li'); li.appendChild(el('b', null, ['I', 'II', 'III'][i])); li.appendChild(el('span', null, r)); list.appendChild(li); });
    body.appendChild(list);
    const acts = el('div', 'acts');
    acts.appendChild(btn('Accept the invitation', 'main', accept));
    body.appendChild(acts);
  }
  /* taking the invitation works the book's own magic on the card: its words lift off
     like erased letters, and the vow burns in line by line like fresh writing */
  let accepting = false;
  async function accept(){
    if(accepting || mode !== 'join') return;
    accepting = true;
    try{
      const card = view.querySelector('.card');
      if(calm()) return show('vow');
      await vanish(card, body, ()=> api.sfx && api.sfx('vanish', true));
      body.classList.replace('leaving', 'arriving');
      show('vow');
      await burnIn(card, body, ()=> api.sfx && api.sfx('burn'));
      const name = body.querySelector('.sign input');
      if(name && !name.value) name.focus();
    }catch(e){
      body.classList.remove('ghost', 'leaving', 'arriving');
      view.querySelectorAll('canvas.magic').forEach(c => c.remove());
      show('vow');
    }finally{ accepting = false; }
  }
  function renderVow(){
    const box = el('div', 'vow');
    VOW.forEach(t => box.appendChild(el('p', null, t)));
    box.appendChild(el('p', 'amen', 'Amen'));
    body.appendChild(box);
    const sig = el('div', 'sign');
    const acts = el('div', 'acts');
    /* the vow is sealed once at a time, and a failure says so instead of leaving the card mute */
    const seal = async open => {
      if(swearing || !joinWant) return;
      swearing = true;
      try{ wantJoin({ ...joinWant, vowed: true }); await open(); }
      catch(e){ api.toast('NO CONNECTION. TRY AGAIN LATER', 2400); }
      finally{ swearing = false; }
    };
    /* a Google account signs with its own name; a guest, even one this browser has
       been before, writes a name afresh, since a new invitation starts from nothing */
    if(user && !user.isAnonymous){
      sig.appendChild(el('p', 'name', myName()));
      sig.appendChild(el('p', 'cap', 'your name'));
      body.appendChild(sig);
      acts.appendChild(btn('I swear', 'main', ()=> seal(join)));
    }else{
      const name = el('input'); name.type = 'text'; name.maxLength = 24; name.value = sign; name.placeholder = 'Your name'; name.setAttribute('aria-label', 'Your name');
      name.autocomplete = 'given-name';
      name.addEventListener('input', ()=>{ sign = name.value; });
      sig.appendChild(name);
      body.appendChild(sig);
      const open = ()=>{ if(!name.value.trim()){ name.focus(); api.toast('WRITE YOUR NAME FIRST', 1600); return; } return seal(()=> joinAsGuest(name.value)); };
      name.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); open(); } });
      acts.appendChild(btn('I swear', 'main', open));
      acts.appendChild(btn('Sign with Google instead', 'minor', ()=> seal(signIn)));
      if(!name.value && !body.classList.contains('arriving')) setTimeout(()=> name.focus(), 60);
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
  /* the opening film waits while the invitation is on the screen */
  let invited = null;
  const release = ()=>{ if(invited){ invited(); invited = null; } };
  /* an invitation opened again starts from nothing, for one of the book's keepers too:
     the card, the vow and the opening with its music, which the touches on the card let play */
  function invite(){
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
        wantJoin({ id: m[1], code: m[2], book: said('book', 60) });
      }else wantJoin(kept);
      if(m) history.replaceState(null, '', location.pathname + location.search);
      /* the invitation comes first, over the loading circle, and the film waits for it:
         the touches on the card are what let the film play with its music */
      const opening = window.__intro;
      if(opening && !opening.gone && opening.wait){ opening.wait(new Promise(r=>{ invited = r; })); invite(); }
      else Promise.resolve(api.settled && api.settled()).then(invite);
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
    history: list => openPast(list),
    readOnly: ()=> !!cur && reading,
    ...(EMU ? { test: {
      firebase, createBook, inviteLink, openBook, goPersonal, upload, keysBetween, leaveShared, removeKeeper, forgetKeeper, allow,
      deleteBook, renameBook, renameGuest, keepNow, get clash(){ return clash; },
      get user(){ return user; }, get cur(){ return cur; }, get books(){ return books; }, ink: ()=> ink, pending: ()=> pending,
      async signInAs(uid, name){
        await firebase();
        const tok = JSON.stringify({ sub: uid, email: `${uid}@example.com`, email_verified: true, name });
        await F.signInWithCredential(F.au, F.GoogleAuthProvider.credential(tok));
        onUser(F.au.currentUser);
      },
      async joinLink(url){
        const m = /#join=([A-Za-z0-9]+)\.([a-z0-9]+)/.exec(url);
        wantJoin({ id: m[1], code: m[2] });
        await join();
      },
      joinAsGuest,
    } } : {}),
  };
}
