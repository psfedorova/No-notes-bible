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
function make(db, uid, name, id, made, code = CODE){
  const b = writeBatch(db);
  b.set(doc(db, 'books', id), { name: 'Book', owner: uid, at: serverTimestamp() });
  if(made !== null) b.set(doc(db, 'users', uid), { made });
  b.set(doc(db, 'books', id, 'members', uid), member(name, ''));
  b.set(doc(db, 'books', id, 'invite', 'code'), { code });
  b.set(doc(db, 'users', uid, 'books', id), { name: 'Book', at: serverTimestamp() });
  return b.commit();
}
let pass = 0, fail = 0;
async function t(name, p){ try{ await p; pass++; }catch(e){ fail++; console.log('FAIL', name, e.message.split('\n')[0]); } }

// making books: Google only, three each, counted in the same batch
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
await t('a guest cannot make a book', assertFails(make(G, 'gina', 'Gina', 'g1', 1)));
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
await t('alice cannot delete her own ink doc (it is emptied instead)', assertFails(deleteDoc(doc(A, 'books', B, 'ink', '1_alice'))));
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

console.log(`rules: ${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
