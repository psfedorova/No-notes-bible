/* firestore.rules against the emulator: run `npm install` once, then `npm test` (Java must be installed) */
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection, deleteDoc, updateDoc, serverTimestamp, writeBatch } from 'firebase/firestore';
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
/* a book, its count, its owner, its first code and the owner's list entry, all in one batch, as the app makes it */
function make(db, uid, name, id, made, code = CODE, g = false){
  const b = writeBatch(db);
  b.set(doc(db, 'books', id), { name: 'Book', owner: uid, at: serverTimestamp() });
  if(made !== null) b.set(doc(db, 'users', uid), { made });
  b.set(doc(db, 'books', id, 'members', uid), member(name, '', g));
  b.set(doc(db, 'books', id, 'invite', 'code'), { code });
  b.set(doc(db, 'users', uid, 'books', id), { name: 'Book', at: serverTimestamp() });
  return b.commit();
}
let pass = 0, fail = 0;
async function t(name, p){ try{ await p; pass++; }catch(e){ fail++; console.log('FAIL', name, e.message.split('\n')[0]); } }

// making books: Google or guest, three each, counted in the same batch
await t('a book is not made without counting it', assertFails(setDoc(doc(A, 'books', 'x0'), { name: 'Book', owner: 'alice', at: serverTimestamp() })));
await t('alice makes a book in one batch', assertSucceeds(make(A, 'alice', 'Alona', B, 1)));
await t('the owner must use her account name', assertFails(make(A, 'alice', 'Queen', 'x1', 2)));
await t('the count cannot skip', assertFails(make(A, 'alice', 'Alona', 'x2', 3)));
await t('the count cannot repeat', assertFails(make(A, 'alice', 'Alona', 'x3', 1)));
await t('a second book', assertSucceeds(make(A, 'alice', 'Alona', 'a2', 2)));
await t('a third book', assertSucceeds(make(A, 'alice', 'Alona', 'a3', 3)));
await t('no fourth book', assertFails(make(A, 'alice', 'Alona', 'a4', 4)));
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

// reading and joining
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
await t('a guest cannot touch alice ink', assertFails(setDoc(doc(G, 'books', B, 'ink', '1_alice'), ink('gina', 1, ''))));
await t('bob reads the book', assertSucceeds(getDoc(doc(Bo, 'books', B))));
await t('bob reads the ink', assertSucceeds(getDocs(collection(Bo, 'books', B, 'ink'))));
await t('bob reads the invite', assertSucceeds(getDoc(doc(Bo, 'books', B, 'invite', 'code'))));

// ink belongs to its hand
await t('bob writes his ink', assertSucceeds(setDoc(doc(Bo, 'books', B, 'ink', '1_bob'), ink('bob', 1, 'His'))));
await t('bob cannot overwrite alice ink', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '1_alice'), ink('bob', 1, ''))));
await t('bob cannot write ink as alice', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '1_alice'), ink('alice', 1, ''))));
await t('bob cannot update alice ink', assertFails(updateDoc(doc(Bo, 'books', B, 'ink', '1_alice'), { s: '' })));
await t('bob cannot delete alice ink', assertFails(deleteDoc(doc(Bo, 'books', B, 'ink', '1_alice'))));
await t('bob cannot hide his doc under another page id', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '2_bob'), ink('bob', 1, 'x'))));
await t('no page past 99', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '100_bob'), ink('bob', 100, 'x'))));
await t('keys cannot outgrow the letters', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '3_bob'), ink('bob', 3, 'ab', { k: 'x'.repeat(100) }))));
await t('the hand name of a font stays short', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '3_bob'), ink('bob', 3, 'ab', { f: 'f'.repeat(100) }))));
await t('the device mark stays short', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '3_bob'), ink('bob', 3, 'ab', { dev: 'd'.repeat(100) }))));
await t('keys must be one string', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '3_bob'), ink('bob', 3, 'ab', { k: ['k1', 'k2'] }))));
await t('a guest cannot delete her own ink doc (it is emptied instead)', assertFails(deleteDoc(doc(G, 'books', B, 'ink', '1_gina'))));
await t('alice empties her own ink', assertSucceeds(setDoc(doc(A, 'books', B, 'ink', '1_alice'), ink('alice', 1, ''))));

// owner only
await t('bob cannot rename the book', assertFails(updateDoc(doc(Bo, 'books', B), { name: 'Mine' })));
await t('bob cannot take the book', assertFails(updateDoc(doc(Bo, 'books', B), { owner: 'bob' })));
await t('bob cannot change the invite', assertFails(setDoc(doc(Bo, 'books', B, 'invite', 'code'), { code: CODE2 })));
await t('bob cannot remove alice', assertFails(deleteDoc(doc(Bo, 'books', B, 'members', 'alice'))));
await t('bob cannot read alice shelf', assertFails(getDocs(collection(Bo, 'users', 'alice', 'books'))));
await t('bob cannot rename himself', assertFails(updateDoc(doc(Bo, 'books', B, 'members', 'bob'), { name: 'Alona' })));

// a new link, leaving, removing
await t('alice makes a new invite', assertSucceeds(setDoc(doc(A, 'books', B, 'invite', 'code'), { code: CODE2 })));
await t('carol cannot join with the old code', assertFails(setDoc(doc(C, 'books', B, 'members', 'carol'), member('Carol', CODE))));
await t('carol joins with the new code', assertSucceeds(setDoc(doc(C, 'books', B, 'members', 'carol'), member('Carol', CODE2))));
await t('alice removes carol', assertSucceeds(deleteDoc(doc(A, 'books', B, 'members', 'carol'))));
await t('carol can no longer read', assertFails(getDocs(collection(C, 'books', B, 'ink'))));
await t('bob leaves', assertSucceeds(deleteDoc(doc(Bo, 'books', B, 'members', 'bob'))));
await t('bob can no longer write', assertFails(setDoc(doc(Bo, 'books', B, 'ink', '1_bob'), ink('bob', 1, 'again'))));

// any number of keepers with one link, and what the owner allows each of them
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
await t('alice lets k1 write again', assertSucceeds(deleteDoc(doc(A, 'books', B, 'access', 'k1'))));
await t('k1 writes again', assertSucceeds(setDoc(doc(K1, 'books', B, 'ink', '1_k1'), ink('k1', 1, 'x'))));

// deleting a book: its ink and keepers first, then the book with the count going down
const A3 = 'a3';
await t('bob joins a3', assertSucceeds((async ()=>{
  await setDoc(doc(A, 'books', A3, 'invite', 'code'), { code: CODE });
  await setDoc(doc(Bo, 'books', A3, 'members', 'bob'), member('Dima', CODE));
  await setDoc(doc(Bo, 'books', A3, 'ink', '1_bob'), ink('bob', 1, 'His'));
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

// the private book's copy
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
