/**
 * Sign out says so. After "Sign out" the page used to come back with no Kiln
 * button and not a word. Now the person lands on the site's own sign-in page,
 * whose card reads "You are signed out" and "Sign in again to edit <site>",
 * once. It is said there, and not by a notice of its own on the site's pages,
 * because the script that would have to carry such a notice is the one every
 * visitor of every site downloads (see the size check in sign-in-clock.test.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

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
  // The sign-in card, when this page drew one: its words without the markup.
  const card = made.find(c => /<h1/.test(c.innerHTML));
  return { window, replaced, timers, body, local, session, card: card ? words(card.innerHTML) : null };
}

test('signed out: Sign out leaves a note and goes to the sign-in page, which says so once', () => {
  const session = {};
  const local = { kiln_editor: JSON.stringify({ session: 's1', name: 'Rosa', repo: 'acme/site', role: 'editor' }) };
  const editing = loadShim('/about', { local, session });
  editing.window.Kiln.logout();
  assert.equal(session[NOTE], '1');
  assert.equal('kiln_editor' in local, false);
  assert.deepEqual(editing.replaced, ['/kiln'], 'the page that follows is the site\'s sign-in page');

  const next = loadShim('/kiln', { local, session });
  assert.match(next.card, /^KilnYou are signed outSign in again to edit Acme/);
  assert.doesNotMatch(next.card, /[—–]/);
  assert.equal(NOTE in session, false, 'the note is read once');

  // Opened again, or by anyone who did not just sign out, it is the plain sign-in page.
  assert.match(loadShim('/kiln', { local, session }).card, /^KilnSign in to editAcme/);
  // And the site's own pages get nothing added at all.
  assert.equal(loadShim('/', { local, session }).body.children.length, 0);
});

test('signed out: the page that follows is the sign-in page this site has', () => {
  const at = (config) => { const p = loadShim('/about', { local: { kiln_editor: JSON.stringify({ session: 's1', name: 'Rosa', repo: 'acme/site' }) }, config }); p.window.Kiln.logout(); return p.replaced; };
  assert.deepEqual(at({ entry: '/staff/kiln/' }), ['/staff/kiln/']);
  // A site that has turned its sign-in page off goes home, as before.
  assert.deepEqual(at({ entry: false }), ['/']);
  assert.deepEqual(at({ entry: false, home: '/welcome' }), ['/welcome']);
  // The demo signs every visitor in again at once: nobody is signed out there.
  assert.deepEqual(at({ sandbox: true }), ['/']);
});

test('signed out: the note is forgotten wherever the next page is, and nothing is added to a page of the site', () => {
  for (const [pathname, extra] of [['/', {}], ['/blog/', {}], ['/', { config: { sandbox: true } }], ['/', { local: { kiln_editor: JSON.stringify({ session: 's2', name: 'Rosa', repo: 'acme/site' }) } }]]) {
    const session = { [NOTE]: '1' };
    const page = loadShim(pathname, { session, ...extra });
    assert.equal(NOTE in session, false, pathname);
    assert.equal(page.body.children.some(c => c.id === 'kiln-signed-out'), false);
  }
  // An ordinary visitor: nothing, as ever.
  assert.equal(loadShim('/', {}).body.children.length, 0);
});

test('signed out: a browser that will not give its storage still shows the site, and still signs out', () => {
  const closed = { getItem() { throw new Error('no storage'); }, setItem() { throw new Error('no storage'); }, removeItem() { throw new Error('no storage'); } };
  const page = loadShim('/', { storage: closed });
  assert.equal(page.body.children.length, 0);
  page.window.Kiln.logout();
  assert.deepEqual(page.replaced, ['/kiln']);
});
