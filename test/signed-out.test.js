/**
 * The page after Sign out (src/kiln.js).
 *
 * A tester chose Kiln menu > Sign out. The page reloaded with no Kiln button
 * and no message. Now signing out leaves a note in sessionStorage, and the
 * next page says one sentence for eight seconds: "You are signed out. To edit
 * again, sign in at ADDRESS/kiln." The note is read once, so the page after
 * that says nothing.
 *
 * The shim itself is run here, against a stand-in page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SHIM = readFileSync(new URL('../src/kiln.js', import.meta.url), 'utf8');
const NOTE = 'kiln_signed_out';
const words = (html) => html.replace(/<[^>]+>/g, '');

function loadShim(pathname, { local = {}, session = {}, config = {}, storage } = {}) {
  const replaced = [], timers = [], made = [];
  const body = { children: [], appendChild(c) { c.parentNode = body; body.children.push(c); }, removeChild(c) { c.parentNode = null; body.children.splice(body.children.indexOf(c), 1); } };
  const el = () => made[made.push({ style: {}, attrs: {}, children: [], innerHTML: '', setAttribute(k, v) { this.attrs[k] = v; },
    querySelector() { return el(); }, appendChild(c) { this.children.push(c); } }) - 1];
  const kept = (store) => ({ getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } });
  const window = { KILN: { repo: 'acme/site', worker: 'https://worker.example', siteName: 'Acme', ...config } };
  const location = { pathname, hash: '', search: '', origin: 'https://site.example', host: 'site.example', replace: (to) => replaced.push(to), reload() {} };
  vm.runInNewContext(SHIM, {
    window, location,
    document: { readyState: 'complete', currentScript: { src: 'https://site.example/assets/kiln.js' }, querySelector: () => null,
      createElement: () => el(), addEventListener() {}, head: { appendChild() {} }, body },
    localStorage: kept(local),
    sessionStorage: storage || kept(session),
    history: { replaceState() {} },
    fetch: () => new Promise(() => {}),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 0; },
  });
  const said = body.children.filter(c => c.id === 'kiln-signed-out');
  return { window, replaced, timers, body, said, local, session };
}

test('signed out: Sign out leaves a note, and the next page says the sentence once', () => {
  const session = {};
  const local = { kiln_editor: JSON.stringify({ session: 's1', name: 'Rosa', repo: 'acme/site', role: 'editor' }) };
  const editing = loadShim('/about', { local, session });
  assert.equal(editing.said.length, 0, 'nothing is said while signed in');
  editing.window.Kiln.logout();
  assert.equal(session[NOTE], '1');
  assert.equal('kiln_editor' in local, false);
  assert.deepEqual(editing.replaced, ['/'], 'the page that follows is the site, as before');

  const next = loadShim('/', { local, session });
  assert.equal(next.said.length, 1);
  const note = next.said[0];
  assert.equal(words(note.innerHTML), 'You are signed out. To edit again, sign in at site.example/kiln.');
  assert.match(note.innerHTML, /<a href="\/kiln" [^>]*>site\.example\/kiln<\/a>\.$/, 'the address is a link to the sign-in page');
  assert.equal(note.attrs.role, 'status');
  assert.doesNotMatch(words(note.innerHTML), /[—–]| - /);
  assert.equal(NOTE in session, false, 'the note is read once');

  // It goes away by itself after eight seconds.
  const away = next.timers.find(t => t.ms === 8000);
  assert.ok(away);
  away.fn();
  assert.equal(next.body.children.includes(note), false);

  // The page after that is the plain site.
  assert.equal(loadShim('/', { local, session }).said.length, 0);
  assert.equal(loadShim('/blog/', { local, session }).body.children.length, 0);
});

test('signed out: the sentence does not lean on the styles of the site', () => {
  const [note] = loadShim('/', { session: { [NOTE]: '1' } }).said;
  assert.match(note.style.cssText, /^all:initial;position:fixed;/);
  for (const own of ['background:', 'color:#fff', 'font:14px', 'z-index:', 'max-width:']) assert.ok(note.style.cssText.includes(own), own);
  assert.match(note.innerHTML, /<a [^>]*style="all:initial;font:inherit;color:#fff;text-decoration:underline/);
});

test('signed out: the address is the sign-in page this site has', () => {
  const own = loadShim('/', { session: { [NOTE]: '1' }, config: { entry: '/staff/kiln/' } }).said[0];
  assert.equal(words(own.innerHTML), 'You are signed out. To edit again, sign in at site.example/staff/kiln.');
  assert.match(own.innerHTML, /<a href="\/staff\/kiln" /);
  // A site that has turned its sign-in page off has no address to give.
  const none = loadShim('/', { session: { [NOTE]: '1' }, config: { entry: false } }).said[0];
  assert.equal(none.innerHTML, 'You are signed out.');
});

test('signed out: not said where it would be wrong or in the way, and forgotten all the same', () => {
  // On the sign-in page the way back in is already on the screen.
  const session = { [NOTE]: '1' };
  assert.equal(loadShim('/kiln', { session }).said.length, 0);
  assert.equal(NOTE in session, false);
  // The demo signs every visitor in again at once: nobody is signed out there.
  const demo = { [NOTE]: '1' };
  assert.equal(loadShim('/', { session: demo, config: { sandbox: true } }).said.length, 0);
  assert.equal(NOTE in demo, false);
  // Somebody signed in again in another tab before this page loaded.
  const again = { [NOTE]: '1' };
  assert.equal(loadShim('/', { session: again, local: { kiln_editor: JSON.stringify({ session: 's2', name: 'Rosa', repo: 'acme/site' }) } }).said.length, 0);
  assert.equal(NOTE in again, false);
  // An ordinary visitor: nothing, as ever.
  assert.equal(loadShim('/', {}).body.children.length, 0);
});

test('signed out: a browser that will not give its storage still shows the site, and still signs out', () => {
  const closed = { getItem() { throw new Error('no storage'); }, setItem() { throw new Error('no storage'); }, removeItem() { throw new Error('no storage'); } };
  const page = loadShim('/', { storage: closed });
  assert.equal(page.body.children.length, 0);
  page.window.Kiln.logout();
  assert.deepEqual(page.replaced, ['/']);
});
