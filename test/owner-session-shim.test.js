/**
 * Owner sessions, in the boot shim (src/kiln.js): the site owner's GitHub
 * token stays on the worker. The sign-in asks for that (keep=server), the
 * address the worker comes back to carries a session and no token, and the
 * browser stores { session, login, repo, exp } with no token in it. A worker
 * that keeps no owner sessions still answers with a token, which is stored
 * the old way. Signing out ends the session on the worker too.
 *
 * The shim itself is run here, against a stand-in page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHIM = readFileSync(path.join(ROOT, 'src', 'kiln.js'), 'utf8');
const SESSION = 'ab'.repeat(32);

function loadShim(pathname, store, { hash = '', answer = Promise.resolve({ ok: true }) } = {}) {
  const replaced = [], added = [], sent = [], urls = [], made = [];
  const el = () => made[made.push({ style: {}, children: [], innerHTML: '', querySelector() { return el(); }, appendChild(c) { this.children.push(c); } }) - 1];
  const window = { KILN: { repo: 'acme/site', worker: 'https://worker.example', siteName: 'Acme' } };
  const location = { pathname, hash, search: '', origin: 'https://site.example', replace: (to) => replaced.push(to), reload() {} };
  const context = {
    window,
    document: {
      readyState: 'complete', currentScript: { src: 'https://site.example/assets/kiln.js' },
      querySelector: () => null, createElement: () => el(), addEventListener() {},
      head: { appendChild: (c) => added.push({ to: 'head', el: c }) },
      body: { appendChild: (c) => added.push({ to: 'body', el: c }) },
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location,
    history: { replaceState: (a, b, url) => { urls.push(url); location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } },
    fetch: (url, init) => { sent.push({ url, ...init }); return answer; },
    setTimeout: () => 0,
  };
  vm.runInNewContext(SHIM, context);
  const buttons = made.filter(m => typeof m.onclick === 'function');
  return { window, replaced, added, sent, urls, location, buttons };
}

test('owner session: the GitHub sign-in asks the worker to keep the token, for this repository', () => {
  const page = loadShim('/kiln', {});
  // Each sign-in button sends the browser to its address.
  const hrefs = page.buttons.map(b => { b.onclick(); return page.location.href; });
  const github = new URL(hrefs.find(h => /\/auth\/login\?/.test(h)));
  assert.equal(github.searchParams.get('keep'), 'server');
  assert.equal(github.searchParams.get('repo'), 'acme/site');
  assert.equal(github.searchParams.get('origin'), 'https://site.example');
  const google = new URL(hrefs.find(h => /\/google\/login\?/.test(h)));
  assert.equal(google.searchParams.get('repo'), 'acme/site');
  assert.equal(google.searchParams.has('keep'), false, 'invited editors sign in as before');
});

test('owner session: the address the worker comes back to is read, stored with no token, and cleaned', () => {
  const store = {};
  const exp = Date.now() + 3600e3;
  const page = loadShim('/about.html', store, { hash: `#kiln-owner=${SESSION}&kiln-login=sam%2Dk&kiln-exp=${exp}&keep=me` });
  assert.deepEqual(JSON.parse(store.kiln_admin), { session: SESSION, login: 'sam-k', repo: 'acme/site', exp });
  assert.equal(/token|sid/.test(store.kiln_admin), false, 'no GitHub token and no renewal id in the browser');
  assert.equal(page.location.hash, '#keep=me', 'only Kiln\'s parts of the address are taken away');
  assert.equal(page.window.__KILN_MODE, 'admin', 'the editor starts for the owner');
});

test('owner session: a worker that keeps no owner sessions still answers with a token, stored the old way', () => {
  const store = {};
  loadShim('/', store, { hash: '#kiln-token=ghu_old&kiln-sid=s1&kiln-exp=99999999999999' });
  assert.deepEqual(JSON.parse(store.kiln_admin), { token: 'ghu_old', exp: 99999999999999, sid: 's1' });
});

test('owner session: a session past its end is dropped on the next page, and the page is told so', () => {
  const store = { kiln_admin: JSON.stringify({ session: SESSION, login: 'sam', repo: 'acme/site', exp: Date.now() - 1000 }) };
  const page = loadShim('/about.html', store);
  assert.equal('kiln_admin' in store, false);
  assert.equal(page.window.__KILN_OVER, 1);
});

test('owner session: signing out forgets it at once and ends it on the worker before the page is left', async () => {
  const store = { kiln_admin: JSON.stringify({ session: SESSION, login: 'sam', repo: 'acme/site', exp: Date.now() + 3600e3 }) };
  let answered;
  const page = loadShim('/about.html', store, { answer: new Promise(r => { answered = r; }) });
  page.window.Kiln.logout();
  assert.equal('kiln_admin' in store, false, 'nothing is left in the browser');
  assert.equal(page.sent.length, 1);
  assert.equal(page.sent[0].url, 'https://worker.example/auth/logout');
  assert.equal(page.sent[0].method, 'POST');
  assert.equal(page.sent[0].headers['X-Kiln-Session'], SESSION);
  assert.deepEqual(page.replaced, [], 'the page waits for the worker');
  answered({ ok: true });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(page.replaced, ['/kiln']);
});

test('owner session: the old way\'s sign-out still sends the renewal id, and nothing at all is sent for an invited editor', async () => {
  const old = { kiln_admin: JSON.stringify({ token: 'ghu_x', sid: 's1', exp: Date.now() + 3600e3 }) };
  const a = loadShim('/about.html', old);
  a.window.Kiln.logout();
  assert.deepEqual(JSON.parse(a.sent[0].body), { sid: 's1' });
  assert.equal('X-Kiln-Session' in a.sent[0].headers, false);
  const ed = { kiln_editor: JSON.stringify({ session: 'c'.repeat(64), name: 'Sam', repo: 'acme/site', role: 'editor' }) };
  const b = loadShim('/about.html', ed);
  b.window.Kiln.logout();
  assert.deepEqual([b.sent.length, b.replaced], [0, ['/kiln']]);
});
