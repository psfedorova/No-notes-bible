/* firestore.rules against the emulator: run `npm install` once, then `npm test` (Java must be installed) */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection, deleteDoc, updateDoc, serverTimestamp, writeBatch, Timestamp } from 'firebase/firestore';
import fs from 'node:fs';

const env = await initializeTestEnvironment({
  projectId: 'demo-liber',
  firestore: { rules: fs.readFileSync('../../firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
});
await env.clearFirestore();
const google = (uid, name) => env.authenticatedContext(uid, { name, email: uid + '@x.com', email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore();
const guest = uid => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const A = google('alice', 'Alona Fedorova'), Bo = google('bob', 'Dima Petrov'), E = google('eve', 'Eve'), C = google('carol', 'Carol'), G = guest('gina');
const anon = env.unauthenticatedContext().firestore();
const B = 'book1', CODE = 'c'.repeat(32), CODE2 = 'd'.repeat(32);
const ink = (uid, n, s, extra = {}) => ({ uid, dev: 'dev1', n, s, k: [...s].map((_, i) => 'k' + (i + 1)).join(','), f: null, c: false, at: serverTimestamp(), ...extra });
const member = (name, code, g = false) => ({ name, code, guest: g, at: serverTimestamp() });
function make(db, uid, name, id, made, code = CODE, g = false){
  const b = writeBatch(db);
  b.set(doc(db, 'books', id), { name: 'Book', owner: uid, at: serverTimestamp() });
  if(made !== null) b.set(doc(db, 'users', uid), { made, last: id });
  b.set(doc(db, 'books', id, 'members', uid), member(name, '', g));
  b.set(doc(db, 'books', id, 'invite', 'code'), { code });
  b.set(doc(db, 'users', uid, 'books', id), { name: 'Book', at: serverTimestamp() });
  return b.commit();
}
let pass = 0, fail = 0;
async function t(name, p){ try{ await p; pass++; }catch(e){ fail++; console.log('FAIL', name, e.message.split('\n')[0]); } }

await t('a book is not made without counting it', assertFails(setDoc(doc(A, 'books', 'x0'), { name: 'Book', owner: 'alice', at: serverTimestamp() })));
await t('alice makes a book in one batch', assertSucceeds(make(A, 'alice', 'Alona', B, 1)));
await t('the owner must use her account name', assertFails(make(A, 'alice', 'Queen', 'x1', 2)));
await t('the count cannot skip', assertFails(make(A, 'alice', 'Alona', 'x2', 3)));
await t('the count cannot repeat', assertFails(make(A, 'alice', 'Alona', 'x3', 1)));
await t('a second book', assertSucceeds(make(A, 'alice', 'Alona', 'a2', 2)));
await t('a third book', assertSucceeds(make(A, 'alice', 'Alona', 'a3', 3)));
await t('no fourth book', assertFails(make(A, 'alice', 'Alona', 'a4', 4)));
await t('one batch makes one book', assertFails((async ()=>{
  const b = writeBatch(Bo);
  b.set(doc(Bo, 'users', 'bob'), { made: 1, last: 'y1' });
  ['y1', 'y2', 'y3'].forEach(id => b.set(doc(Bo, 'books', id), { name: 'Book', owner: 'bob', at: serverTimestamp() }));
  await b.commit();
})()));
await t('a book is not made under a count naming another', assertFails((async ()=>{
  const b = writeBatch(Bo);
  b.set(doc(Bo, 'users', 'bob'), { made: 1, last: 'y1' });
  b.set(doc(Bo, 'books', 'y1'), { name: 'Book', owner: 'bob', at: serverTimestamp() });
  b.set(doc(Bo, 'books', 'y2'), { name: 'Book', owner: 'bob', at: serverTimestamp() });
  await b.commit();
})()));
await t('the count does not go up without a book', assertFails(setDoc(doc(Bo, 'users', 'bob'), { made: 1, last: 'y9' })));
await t('the count does not go up for a book already made', assertFails(setDoc(doc(Bo, 'users', 'bob'), { made: 1, last: B })));
await t('the count does not go up unnamed', assertFails((async ()=>{
  const b = writeBatch(Bo);
  b.set(doc(Bo, 'users', 'bob'), { made: 1 });
  b.set(doc(Bo, 'books', 'y1'), { name: 'Book', owner: 'bob', at: serverTimestamp() });
  await b.commit();
})()));
await t('the count cannot be reset', assertFails(setDoc(doc(A, 'users', 'alice'), { made: 0 })));
await t('the count takes no other fields', assertFails(setDoc(doc(A, 'users', 'alice'), { made: 4, x: 1 })));
await t('alice reads her count', assertSucceeds(getDoc(doc(A, 'users', 'alice'))));
await t('bob cannot read alice count', assertFails(getDoc(doc(Bo, 'users', 'alice'))));
await t('bob cannot bump alice count', assertFails(setDoc(doc(Bo, 'users', 'alice'), { made: 4 })));
await t('a guest cannot make a book as a Google member', assertFails(make(G, 'gina', 'Gina', 'g1', 1)));
await t('a guest makes a book under the name she typed', assertSucceeds(make(G, 'gina', 'Gina', 'g1', 1, CODE, true)));
await t('a guest makes a second book', assertSucceeds(make(G, 'gina', 'Gina', 'g2', 2, CODE, true)));
await t('a guest makes a third book', assertSucceeds(make(G, 'gina', 'Gina', 'g3', 3, CODE, true)));
await t('a guest makes no fourth book', assertFails(make(G, 'gina', 'Gina', 'g4', 4, CODE, true)));
await t('a guest owner renames her book', assertSucceeds(updateDoc(doc(G, 'books', 'g1'), { name: 'Our bible' })));
await t('a Google member cannot make a book as a guest', assertFails(make(C, 'carol', 'Carol', 'c1', 1, CODE, true)));
await t('bob cannot make a book owned by alice', assertFails(setDoc(doc(Bo, 'books', 'b3'), { name: 'x', owner: 'alice', at: serverTimestamp() })));

await t('alice writes her ink', assertSucceeds(setDoc(doc(A, 'books', B, 'ink', '1_alice'), ink('alice', 1, 'Mine'))));
await t('anon cannot read the book', assertFails(getDoc(doc(anon, 'books', B))));
await t('eve cannot read the book', assertFails(getDoc(doc(E, 'books', B))));
await t('eve cannot read the ink', assertFails(getDocs(collection(E, 'books', B, 'ink'))));
await t('eve cannot read the invite', assertFails(getDoc(doc(E, 'books', B, 'invite', 'code'))));
await t('eve cannot write ink', assertFails(setDoc(doc(E, 'books', B, 'ink', '1_eve'), ink('eve', 1, 'x'))));
await t('eve cannot join without the code', assertFails(setDoc(doc(E, 'books', B, 'members', 'eve'), member('Eve', ''))));
await t('eve cannot join with a wrong code', assertFails(setDoc(doc(E, 'books', B, 'members', 'eve'), member('Eve', 'z'.repeat(32)))));
await t('eve cannot add bob', assertFails(setDoc(doc(E, 'books', B, 'members', 'bob'), member('Dima', CODE))));
await t('bob cannot join under another name', assertFails(setDoc(doc(Bo, 'books', B, 'members', 'bob'), member('Alona', CODE))));
await t('bob cannot join as a guest', assertFails(setDoc(doc(Bo, 'books', B, 'members', 'bob'), member('Dima', CODE, true))));
await t('bob joins with the code', assertSucceeds(setDoc(doc(Bo, 'books', B, 'members', 'bob'), member('Dima', CODE))));
await t('a guest cannot pass as a Google member', assertFails(setDoc(doc(G, 'books', B, 'members', 'gina'), member('Gina', CODE, false))));
await t('a guest joins with the code', assertSucceeds(setDoc(doc(G, 'books', B, 'members', 'gina'), member('Gina', CODE, true))));
await t('a guest writes her ink', assertSucceeds(setDoc(doc(G, 'books', B, 'ink', '1_gina'), ink('gina', 1, 'Hi'))));
await t('a guest cannot write alice ink as her own', assertFails(setDoc(doc(G, 'books', B, 'ink', '1_alice'), ink('gina', 1, ''))));
await t('bob reads the book', assertSucceeds(getDoc(doc(Bo, 'books', B))));
await t('bob reads the ink', assertSucceeds(getDocs(collection(Bo, 'books', B, 'ink'))));
await t('bob reads the invite', assertSucceeds(getDoc(doc(Bo, 'books', B, 'invite', 'code'))));

await t('bob writes his ink', assertSucceeds(setDoc(doc(Bo, 'books', B, 'ink', '1_bob'), ink('bob', 1, 'His'))));
await t('bob cannot pass his doc off as alice ink', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '1_alice'), ink('bob', 1, ''))));
await t('bob cannot change alice ink unmarked', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '1_alice'), ink('alice', 1, 'Mi'))));
await t('bob cannot mark his change as alice', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '1_alice'), ink('alice', 1, 'Mi', { by: 'alice' }))));
const past = (n, t, by, extra = {}) => ({ n, t, a: '0:' + t.length, h: ['alice'], f: null, c: false, by, at: serverTimestamp(), ...extra });
const change = (db, id, w, keep) => { const b = writeBatch(db); if(keep) b.set(doc(db, 'books', B, 'past', keep.id), keep.d); b.set(doc(db, 'books', B, 'ink', id), w); return b.commit(); };
await t('bob cannot change alice ink without keeping the page', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '1_alice'), ink('alice', 1, 'Mi', { by: 'bob' }))));
await t('bob cannot name a page he did not keep', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '1_alice'), ink('alice', 1, 'Mi', { by: 'bob', p: 'nothing' }))));
await t('bob changes alice ink, marked as his, keeping the page', assertSucceeds(change(Bo, '1_alice', ink('alice', 1, 'Mi', { by: 'bob', p: 'bk1' }), { id: 'bk1', d: past(1, 'Mine', 'bob') })));
await t('bob changes it again under the page he kept just now', assertSucceeds(setDoc(doc(Bo, 'books', B, 'ink', '1_alice'), ink('alice', 1, 'M', { by: 'bob', p: 'bk1' }))));
await t('the page kept must be the same page', assertFails(change(Bo, '1_alice', ink('alice', 1, 'Mi', { by: 'bob', p: 'bk2' }), { id: 'bk2', d: past(2, 'Mine', 'bob') })));
await t('a guest cannot change ink under a page bob kept', assertFails(setDoc(doc(G, 'books', B, 'ink', '1_bob'), ink('bob', 1, 'Hi', { by: 'gina', p: 'bk1' }))));
await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'books', B, 'past', 'bold'), past(1, 'Mine', 'bob', { at: Timestamp.fromMillis(Date.now() - 11*60000) })));
await t('a page kept long ago does not cover a change', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '1_alice'), ink('alice', 1, 'Mi', { by: 'bob', p: 'bold' }))));
await t('a guest changes bob ink, marked as hers, keeping the page', assertSucceeds(change(G, '1_bob', ink('bob', 1, 'Hi', { by: 'gina', p: 'gk1' }), { id: 'gk1', d: past(1, 'His', 'gina') })));
await t('bob changes alice ink on eight pages in one batch', assertSucceeds((async ()=>{
  const b = writeBatch(Bo);
  for(let n=10;n<18;n++){
    b.set(doc(Bo, 'books', B, 'past', 'bm' + n), past(n, 'Old', 'bob'));
    b.set(doc(Bo, 'books', B, 'ink', `${n}_alice`), ink('alice', n, 'New', { by: 'bob', p: 'bm' + n }));
  }
  await b.commit();
})()));
await t('bob cannot delete alice ink', assertFails(deleteDoc(doc(Bo, 'books', B, 'ink', '1_alice'))));
await t('bob keeps a page as it was', assertSucceeds(setDoc(doc(Bo, 'books', B, 'past', 'p1'), past(1, 'Mine', 'bob'))));
await t('the past is signed by its writer', assertFails(setDoc(doc(Bo, 'books', B, 'past', 'p2'), past(1, 'Mine', 'alice'))));
await t('the past is never rewritten', assertFails(setDoc(doc(Bo, 'books', B, 'past', 'p1'), past(1, 'Other', 'bob'))));
await t('the past cannot be deleted by a keeper', assertFails(deleteDoc(doc(Bo, 'books', B, 'past', 'p1'))));
await t('a guest reads the past', assertSucceeds(getDocs(collection(G, 'books', B, 'past'))));
await t('eve cannot read the past', assertFails(getDocs(collection(E, 'books', B, 'past'))));
await t('eve cannot keep a past', assertFails(setDoc(doc(E, 'books', B, 'past', 'p3'), past(1, 'x', 'eve'))));
await t('bob cannot hide his doc under another page id', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '2_bob'), ink('bob', 1, 'x'))));
await t('no page past 99', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '100_bob'), ink('bob', 100, 'x'))));
await t('keys cannot outgrow the letters', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '3_bob'), ink('bob', 3, 'ab', { k: 'x'.repeat(100) }))));
await t('the hand name of a font stays short', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '3_bob'), ink('bob', 3, 'ab', { f: 'f'.repeat(100) }))));
await t('the device mark stays short', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '3_bob'), ink('bob', 3, 'ab', { dev: 'd'.repeat(100) }))));
await t('keys must be one string', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '3_bob'), ink('bob', 3, 'ab', { k: ['k1', 'k2'] }))));
await t('a guest cannot delete her own ink doc (it is emptied instead)', assertFails(deleteDoc(doc(G, 'books', B, 'ink', '1_gina'))));
await t('alice empties her own ink', assertSucceeds(setDoc(doc(A, 'books', B, 'ink', '1_alice'), ink('alice', 1, ''))));

await t('bob cannot rename the book', assertFails(updateDoc(doc(Bo, 'books', B), { name: 'Mine' })));
await t('bob cannot take the book', assertFails(updateDoc(doc(Bo, 'books', B), { owner: 'bob' })));
await t('bob cannot change the invite', assertFails(setDoc(doc(Bo, 'books', B, 'invite', 'code'), { code: CODE2 })));
await t('bob cannot remove alice', assertFails(deleteDoc(doc(Bo, 'books', B, 'members', 'alice'))));
await t('bob cannot read alice shelf', assertFails(getDocs(collection(Bo, 'users', 'alice', 'books'))));
await t('bob cannot rename himself', assertFails(updateDoc(doc(Bo, 'books', B, 'members', 'bob'), { name: 'Alona' })));

await t('alice makes a new invite', assertSucceeds(setDoc(doc(A, 'books', B, 'invite', 'code'), { code: CODE2 })));
await t('carol cannot join with the old code', assertFails(setDoc(doc(C, 'books', B, 'members', 'carol'), member('Carol', CODE))));
await t('carol joins with the new code', assertSucceeds(setDoc(doc(C, 'books', B, 'members', 'carol'), member('Carol', CODE2))));
await t('alice removes carol', assertSucceeds(deleteDoc(doc(A, 'books', B, 'members', 'carol'))));
await t('carol can no longer read', assertFails(getDocs(collection(C, 'books', B, 'ink'))));
await t('bob leaves', assertSucceeds(deleteDoc(doc(Bo, 'books', B, 'members', 'bob'))));
await t('bob can no longer write', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '1_bob'), ink('bob', 1, 'again'))));

const many = Array.from({ length: 30 }, (_, i) => 'k' + i);
await t('thirty guests join with one link', assertSucceeds(Promise.all(many.map(u => setDoc(doc(guest(u), 'books', B, 'members', u), member('Guest', CODE2, true))))));
const K1 = guest('k1'), K2 = guest('k2'), K3 = guest('k3');
const access = (can, name = 'Guest') => ({ can, name, at: serverTimestamp() });
await t('a keeper cannot limit another', assertFails(setDoc(doc(K3, 'books', B, 'access', 'k1'), access('read'))));
await t('a keeper cannot read what the owner allows', assertFails(getDocs(collection(K3, 'books', B, 'access'))));
await t('alice cannot limit herself', assertFails(setDoc(doc(A, 'books', B, 'access', 'alice'), access('read'))));
await t('no other kind of access', assertFails(setDoc(doc(A, 'books', B, 'access', 'k1'), access('write'))));
await t('alice lets k1 only read', assertSucceeds(setDoc(doc(A, 'books', B, 'access', 'k1'), access('read'))));
await t('alice reads what she allows', assertSucceeds(getDocs(collection(A, 'books', B, 'access'))));
await t('k1 sees she only reads', assertSucceeds(getDoc(doc(K1, 'books', B, 'access', 'k1'))));
await t('k2 cannot see it', assertFails(getDoc(doc(K2, 'books', B, 'access', 'k1'))));
await t('k1 still reads the book', assertSucceeds(getDocs(collection(K1, 'books', B, 'ink'))));
await t('k1 cannot write', assertFails(setDoc(doc(K1, 'books', B, 'ink', '1_k1'), ink('k1', 1, 'x'))));
await t('k1 cannot change alice ink', assertFails(change(K1, '1_alice', ink('alice', 1, '', { by: 'k1', p: 'k1p0' }), { id: 'k1p0', d: past(1, 'x', 'k1') })));
await t('k1 cannot keep a past', assertFails(setDoc(doc(K1, 'books', B, 'past', 'k1p'), past(1, 'x', 'k1'))));
await t('k1 cannot let herself write', assertFails(deleteDoc(doc(K1, 'books', B, 'access', 'k1'))));
await t('k1 cannot change it either', assertFails(setDoc(doc(K1, 'books', B, 'access', 'k1'), access('read', 'Other'))));
await t('k1 still changes her name', assertSucceeds(updateDoc(doc(K1, 'books', B, 'members', 'k1'), { name: 'Kira' })));
await t('k2 writes', assertSucceeds(setDoc(doc(K2, 'books', B, 'ink', '1_k2'), ink('k2', 1, 'x'))));
await t('k2 is not sent away while still in the book', assertFails(setDoc(doc(A, 'books', B, 'access', 'k2'), access('none'))));
await t('alice sends k2 away for good', assertSucceeds((async ()=>{
  const b = writeBatch(A);
  b.delete(doc(A, 'books', B, 'members', 'k2'));
  b.set(doc(A, 'books', B, 'access', 'k2'), access('none'));
  await b.commit();
})()));
await t('k2 can no longer read', assertFails(getDocs(collection(K2, 'books', B, 'ink'))));
await t('k2 cannot come back with the link', assertFails(setDoc(doc(K2, 'books', B, 'members', 'k2'), member('Guest', CODE2, true))));
await t('k2 sees why', assertSucceeds(getDoc(doc(K2, 'books', B, 'access', 'k2'))));
await t('alice lets k2 back', assertSucceeds(deleteDoc(doc(A, 'books', B, 'access', 'k2'))));
await t('k2 comes back with the link', assertSucceeds(setDoc(doc(K2, 'books', B, 'members', 'k2'), member('Guest', CODE2, true))));
await t('k3 is in the book', assertSucceeds(getDocs(collection(K3, 'books', B, 'ink'))));
await t('alice sends k3 away, saying she is a guest', assertSucceeds((async ()=>{
  const b = writeBatch(A);
  b.delete(doc(A, 'books', B, 'members', 'k3'));
  b.set(doc(A, 'books', B, 'access', 'k3'), { ...access('none', 'Kate'), guest: true });
  await b.commit();
})()));
await t('access says guest only as true or false', assertFails(setDoc(doc(A, 'books', B, 'access', 'k4'), { ...access('read'), guest: 'yes' })));
const back = (name = 'Kate', extra = {}) => ({ name, code: '', guest: true, at: serverTimestamp(), ...extra });
await t('alice cannot put k3 back and leave her shut out', assertFails(setDoc(doc(A, 'books', B, 'members', 'k3'), back())));
await t('a keeper cannot let k3 back in', assertFails((async ()=>{
  const b = writeBatch(K1);
  b.set(doc(K1, 'books', B, 'members', 'k3'), back());
  b.delete(doc(K1, 'books', B, 'access', 'k3'));
  await b.commit();
})()));
await t('alice cannot let back in with a code', assertFails((async ()=>{
  const b = writeBatch(A);
  b.set(doc(A, 'books', B, 'members', 'k3'), back('Kate', { code: CODE2 }));
  b.delete(doc(A, 'books', B, 'access', 'k3'));
  await b.commit();
})()));
await t('alice lets k3 back in', assertSucceeds((async ()=>{
  const b = writeBatch(A);
  b.set(doc(A, 'books', B, 'members', 'k3'), back());
  b.delete(doc(A, 'books', B, 'access', 'k3'));
  await b.commit();
})()));
await t('k3 reads the book again', assertSucceeds(getDocs(collection(K3, 'books', B, 'ink'))));
await t('k3 writes again', assertSucceeds(setDoc(doc(K3, 'books', B, 'ink', '1_k3'), ink('k3', 1, 'back'))));
await t('k3 still changes her name', assertSucceeds(updateDoc(doc(K3, 'books', B, 'members', 'k3'), { name: 'Kat' })));
await t('alice cannot make a member of someone never sent away', assertFails((async ()=>{
  const b = writeBatch(A);
  b.set(doc(A, 'books', B, 'members', 'stranger'), back('Stranger'));
  await b.commit();
})()));
await t('alice lets k1 write again', assertSucceeds(deleteDoc(doc(A, 'books', B, 'access', 'k1'))));
await t('k1 writes again', assertSucceeds(setDoc(doc(K1, 'books', B, 'ink', '1_k1'), ink('k1', 1, 'x'))));

const A3 = 'a3';
await t('bob joins a3', assertSucceeds((async ()=>{
  await setDoc(doc(A, 'books', A3, 'invite', 'code'), { code: CODE });
  await setDoc(doc(Bo, 'books', A3, 'members', 'bob'), member('Dima', CODE));
  await setDoc(doc(Bo, 'books', A3, 'ink', '1_bob'), ink('bob', 1, 'His'));
  await setDoc(doc(Bo, 'books', A3, 'past', 'bp'), past(1, 'His', 'bob'));
})()));
await t('bob cannot delete the book', assertFails(deleteDoc(doc(Bo, 'books', A3))));
await t('bob cannot delete the invite', assertFails(deleteDoc(doc(Bo, 'books', A3, 'invite', 'code'))));
await t('alice cannot delete the book without counting down', assertFails(deleteDoc(doc(A, 'books', A3))));
await t('alice cannot count down without deleting a book', assertFails(setDoc(doc(A, 'users', 'alice'), { made: 2, gone: A3 })));
await t('alice cannot count down for a book she does not own', assertFails((async ()=>{
  await make(Bo, 'bob', 'Dima', 'bb', 1);
  const b = writeBatch(A);
  b.set(doc(A, 'users', 'alice'), { made: 2, gone: 'bb' });
  b.delete(doc(A, 'books', 'bb'));
  await b.commit();
})()));
await t('alice deletes the ink in her book', assertSucceeds(deleteDoc(doc(A, 'books', A3, 'ink', '1_bob'))));
await t('alice deletes the past of her book', assertSucceeds(deleteDoc(doc(A, 'books', A3, 'past', 'bp'))));
await t('alice deletes the book in one batch', assertSucceeds((async ()=>{
  const b = writeBatch(A);
  b.delete(doc(A, 'books', A3, 'members', 'bob'));
  b.delete(doc(A, 'books', A3, 'members', 'alice'));
  b.delete(doc(A, 'books', A3, 'invite', 'code'));
  b.delete(doc(A, 'books', A3));
  b.set(doc(A, 'users', 'alice'), { made: 2, gone: A3 });
  await b.commit();
})()));
await t('the count cannot go down twice for one book', assertFails(setDoc(doc(A, 'users', 'alice'), { made: 1, gone: A3 })));
await t('the freed place makes a new book', assertSucceeds(make(A, 'alice', 'Alona', 'a5', 3)));
await t('still no fourth book', assertFails(make(A, 'alice', 'Alona', 'a6', 4)));
await t('one step down deletes one book', assertFails((async ()=>{
  const b = writeBatch(A);
  b.delete(doc(A, 'books', 'a2'));
  b.delete(doc(A, 'books', 'a5'));
  b.set(doc(A, 'users', 'alice'), { made: 2, gone: 'a2' });
  await b.commit();
})()));
await t('a book is not deleted under a step down naming another', assertFails((async ()=>{
  const b = writeBatch(A);
  b.delete(doc(A, 'books', 'a2'));
  b.delete(doc(A, 'books', 'a5'));
  b.set(doc(A, 'users', 'alice'), { made: 2, gone: 'a5' });
  await b.commit();
})()));
await env.withSecurityRulesDisabled(async c=>{
  const db = c.firestore();
  await setDoc(doc(db, 'users', 'dora'), { made: 0 });
  for(const id of ['d1', 'd2']) await setDoc(doc(db, 'books', id), { name: 'Old', owner: 'dora', at: serverTimestamp() });
});
const D = google('dora', 'Dora');
await t('the count cannot go below nought', assertFails((async ()=>{
  const b = writeBatch(D);
  b.delete(doc(D, 'books', 'd1'));
  b.set(doc(D, 'users', 'dora'), { made: 0, gone: 'd1' });
  await b.commit();
})()));
await t('at nought a book left over is still deleted', assertSucceeds(deleteDoc(doc(D, 'books', 'd1'))));
await t('at nought nobody else deletes it', assertFails(deleteDoc(doc(A, 'books', 'd2'))));

const part = (i, n, d = 'x') => ({ d, v: 'v1', i, n, p: 1, at: serverTimestamp() });
await t('alice keeps a copy', assertSucceeds(setDoc(doc(A, 'users', 'alice', 'keep', '0'), part(0, 1))));
await t('alice reads her copy', assertSucceeds(getDocs(collection(A, 'users', 'alice', 'keep'))));
await t('bob cannot read alice copy', assertFails(getDocs(collection(Bo, 'users', 'alice', 'keep'))));
await t('bob cannot write alice copy', assertFails(setDoc(doc(Bo, 'users', 'alice', 'keep', '0'), part(0, 1))));
await t('a guest keeps no copy', assertFails(setDoc(doc(G, 'users', 'gina', 'keep', '0'), part(0, 1))));
await t('a part sits under its own number', assertFails(setDoc(doc(A, 'users', 'alice', 'keep', '1'), part(0, 2))));
await t('a part is not too big', assertFails(setDoc(doc(A, 'users', 'alice', 'keep', '0'), part(0, 1, 'x'.repeat(250001)))));
await t('a part takes no other fields', assertFails(setDoc(doc(A, 'users', 'alice', 'keep', '0'), { ...part(0, 1), x: 1 })));
await t('alice deletes a part', assertSucceeds(deleteDoc(doc(A, 'users', 'alice', 'keep', '0'))));

console.log(`rules: ${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
