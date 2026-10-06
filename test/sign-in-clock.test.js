/**
 * A sign-in that runs out by the browser's own clock. The boot shim
 * (src/kiln.js) drops it on the next page, and used to leave that page with
 * nothing on it to say why the editor was gone. It now leaves a marker and
 * loads the editor's bundle, which shows the one card a sign-in the worker
 * has ended gets. The sentence is not in the shim: every visitor downloads
 * that, and it must stay small.
 *
 * The shim itself is run here, against a stand-in page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { endedNotice } from '../src/editor/sign-in-ended.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHIM = readFileSync(path.join(ROOT, 'src', 'kiln.js'), 'utf8');
const HOUR = 3600 * 1000;

/** Load src/kiln.js on a stand-in page at `pathname`, with `store` as the browser's localStorage. */
function loadShim(pathname, store, { kiln = {}, session = {} } = {}) {
  const replaced = [], added = [];
  const el = () => ({ style: {}, children: [], innerHTML: '', querySelector() { return el(); }, appendChild(c) { this.children.push(c); } });
  const window = { KILN: { repo: 'acme/site', worker: 'https://worker.example', siteName: 'Acme', ...kiln } };
  const context = {
    window,
    document: {
      readyState: 'complete', currentScript: { src: 'https://site.example/assets/kiln.js' },
      querySelector: () => null, createElement: () => el(), addEventListener() {},
      head: { appendChild: (c) => added.push({ to: 'head', el: c }) },
      body: { appendChild: (c) => added.push({ to: 'body', el: c }) },
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: (k) => (k in session ? session[k] : null), setItem() {}, removeItem() {} },
    location: { pathname, hash: '', search: '', origin: 'https://site.example', replace: (to) => replaced.push(to), reload() {} },
    history: { replaceState() {} },
  };
  vm.runInNewContext(SHIM, context);
  return {
    sentTo: replaced,
    signInShown: added.some(a => a.to === 'body' && a.el.id === 'kiln-entry'),
    resumeShown: added.some(a => a.to === 'body' && a.el.id === 'kiln-login'),
    editorLoaded: added.some(a => a.to === 'head' && /\/kiln-editor\.js$/.test(a.el.src || '')),
    mode: window.__KILN_MODE,
    over: !!window.__KILN_OVER,
  };
}
const editor = (exp) => JSON.stringify({ session: 'c'.repeat(64), name: 'Sam', repo: 'acme/site', role: 'editor', exp });
const owner = (exp, sid) => JSON.stringify({ token: 'ghu_x', exp, sid });

test('clock: an invited editor\'s sign-in that has run out is dropped, and the page is told so that it can say so', () => {
  const store = { kiln_editor: editor(Date.now() - HOUR) };
  const page = loadShim('/about.html', store);
  assert.equal('kiln_editor' in store, false, 'the sign-in is no longer stored');
  assert.equal(page.over, true, 'the marker is left');
  assert.equal(page.editorLoaded, true, 'the editor bundle, which has the sentence, is loaded');
  assert.equal(page.mode, 'editor', 'so that the card says Google');
  assert.deepEqual(page.sentTo, []);
});

test('clock: it is said once: the next page is the plain site', () => {
  const store = { kiln_editor: editor(Date.now() - HOUR) };
  loadShim('/', store);
  for (const pathname of ['/', '/about.html']) {
    const next = loadShim(pathname, store);
    assert.equal(next.over, false);
    assert.equal(next.editorLoaded, false, 'nothing of Kiln is loaded for someone who is not signed in');
    assert.equal(next.mode, undefined);
  }
});

test('clock: the owner whose token ran out and cannot be renewed is told to sign in with GitHub', () => {
  const store = { kiln_admin: owner(Date.now() - HOUR, null) };
  const page = loadShim('/', store);
  assert.equal('kiln_admin' in store, false);
  assert.deepEqual([page.over, page.editorLoaded, page.mode], [true, true, 'admin']);
});

test('clock: an owner\'s token that can be renewed is not a sign-in that has ended', () => {
  const store = { kiln_admin: owner(Date.now() - HOUR, 'sid-1') };
  const page = loadShim('/', store);
  assert.equal('kiln_admin' in store, true, 'kept: the editor renews it');
  assert.deepEqual([page.over, page.editorLoaded, page.mode], [false, true, 'admin']);
});

test('clock: a sign-in that has not run out, or has no end, starts the editor as before', () => {
  for (const exp of [Date.now() + HOUR, null, undefined]) {
    const store = { kiln_editor: editor(exp) };
    const page = loadShim('/', store);
    assert.equal('kiln_editor' in store, true);
    assert.deepEqual([page.over, page.editorLoaded, page.mode], [false, true, 'editor']);
  }
});

test('clock: on /kiln the sign-in itself is what is shown, with no card over it', () => {
  const store = { kiln_editor: editor(Date.now() - HOUR) };
  const entry = loadShim('/kiln', store);
  assert.equal('kiln_editor' in store, false);
  assert.equal(entry.signInShown, true);
  assert.deepEqual([entry.over, entry.editorLoaded], [false, false]);
  assert.deepEqual(entry.sentTo, []);
});

test('clock: someone still signed in another way is simply editing', () => {
  // the owner is signed in; an invited editor's sign-in from long ago is also in this browser
  const store = { kiln_admin: owner(Date.now() + HOUR, 'sid-1'), kiln_editor: editor(Date.now() - HOUR) };
  const page = loadShim('/', store);
  assert.equal('kiln_editor' in store, false);
  assert.deepEqual([page.over, page.editorLoaded, page.mode], [false, true, 'admin']);
});

test('clock: nothing is said on a site with no worker to sign in at, or on the demo', () => {
  const unset = loadShim('/', { kiln_editor: editor(Date.now() - HOUR) }, { kiln: { worker: '' } });
  assert.deepEqual([unset.over, unset.editorLoaded], [false, false]);
  // the demo signs every visitor in to a private copy, as before
  const store = { kiln_editor: editor(Date.now() - HOUR) };
  const demo = loadShim('/', store, { kiln: { sandbox: true } });
  assert.deepEqual([demo.over, demo.editorLoaded, demo.mode], [false, true, 'editor']);
  assert.equal(JSON.parse(store.kiln_editor).sandbox, true);
});

test('clock: the sentence is the editor\'s, not the shim\'s, and the shim stays small', () => {
  const sentence = endedNotice({ way: 'google' }).text;
  assert.equal(sentence, 'Your sign-in to edit this site has ended, so please sign in again with Google.');
  assert.equal(/sign-in to edit this site has ended|has ended|Sign in again/.test(SHIM), false, 'no sentence about it in the script every visitor loads');
  // The editor shows that card when the shim left its marker, and nothing else.
  const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
  const init = main.slice(main.indexOf('async function init()'), main.indexOf('injectStyles();', main.indexOf('async function init()')));
  assert.match(init, /if \(window\.__KILN_OVER\) \{\s*showNotice\(endedNotice\(\{ way: signInWay\(\), draft: draftWaits\(\) \}\), signInAgain\);\s*return;/, 'before the editor draws anything');
  // What every visitor downloads: the built shim was 6,987 bytes (3,127 gzipped) before this, and may grow by at most 300 gzipped.
  const built = readFileSync(path.join(ROOT, 'dist', 'kiln.js'));
  assert.ok(gzipSync(built).length <= 3127 + 300, `dist/kiln.js is ${built.length} bytes, ${gzipSync(built).length} gzipped`);
});
