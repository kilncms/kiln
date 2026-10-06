/**
 * A sign-in the worker has ended (src/editor/sign-in-ended.js): what a failed
 * request means, what the editor does about it, and every sentence a person
 * is shown. Plus the boot shim (src/kiln.js), run here against a stand-in
 * page, to show that /kiln stops sending a person round once the editor has
 * dropped the sign-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { readFailure, onLoadFailure, endedNotice, signInUrl } from '../src/editor/sign-in-ended.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// What the worker says to a session it no longer has, word for word (worker/index.js).
const REPO_CHANGED = 'This sign-in was made for a different repository than the one that now answers to the name this site uses, so nothing was read or changed. The site owner can run kiln doctor: it says what to correct.';
const ENDED = [
  { status: 401, data: { error: 'session expired' } },
  { status: 401, data: { error: 'session expired', code: 'repo_changed', message: REPO_CHANGED } },
  { status: 401, data: { error: 'missing session' } },
  { status: 401, data: { error: 'unauthorized' } },   // the worker's own routes (source edits, comments)
  { status: 401, data: {} },                          // an answer with no readable body
  { status: 401 },
];
// Answers that say nothing about the sign-in.
const NOT_ENDED = [
  { status: 403, data: { error: 'outside your editing scope' } },
  { status: 404, data: { message: 'Not Found' } },
  { status: 409, data: { message: 'is at abc but expected def' } },
  { status: 422, data: { message: 'sha was not supplied' } },
  { status: 429, data: { error: 'rate limited, slow down' } },
  { status: 500, data: { error: 'internal error' } },
  { status: 502 },
  { status: 503, data: {} },
  new TypeError('Failed to fetch'),
];

/** Every sentence must be plain: no exclamation marks, and no dash used as punctuation. */
function assertPlain(text, where = '') {
  assert.equal(/!/.test(text), false, `an exclamation mark in: ${text} ${where}`);
  assert.equal(/[—–]|\s-\s/.test(text), false, `a dash as punctuation in: ${text} ${where}`);
}

test('sign-in ended: a 401 means the sign-in is over, whatever its body says', () => {
  for (const answer of ENDED) assert.equal(readFailure(answer).kind, 'ended', JSON.stringify(answer));
  for (const answer of NOT_ENDED) assert.notEqual(readFailure(answer).kind, 'ended', String(answer.status || answer));
});

test('sign-in ended: code "repo_changed" says the owner has something to correct, and carries the worker\'s sentence', () => {
  const f = readFailure(ENDED[1]);
  assert.equal(f.ownerMust, true);
  assert.equal(f.message, REPO_CHANGED);
  const plain = readFailure(ENDED[0]);
  assert.equal(plain.ownerMust, false);
  assert.equal(plain.message, '');
  // A message that is not text is not shown.
  assert.equal(readFailure({ status: 401, data: { error: 'session expired', code: 'repo_changed', message: { html: '<b>x</b>' } } }).message, '');
});

test('sign-in ended: on page load an invited editor\'s refused sign-in is dropped and the page says how to get back in', () => {
  for (const answer of ENDED) {
    const over = onLoadFailure(answer, { mode: 'editor' });
    assert.ok(over, JSON.stringify(answer));
    assert.equal(over.drop, true);
    assert.match(over.notice.text, /^Your sign-in to edit this site has ended/);
  }
  const over = onLoadFailure(ENDED[0], { mode: 'editor' });
  assert.deepEqual(over.notice, {
    text: 'Your sign-in to edit this site has ended, so please sign in again with Google.',
    detail: '',
    button: 'Sign in again',
  });
});

test('sign-in ended: on page load nothing but a 401 drops an invited editor\'s sign-in', () => {
  for (const answer of NOT_ENDED) assert.equal(onLoadFailure(answer, { mode: 'editor' }), null, String(answer.status || answer));
});

test('sign-in ended: the owner is told to sign in with GitHub, when the token could not be renewed or GitHub refuses it', () => {
  const renewalRefused = Object.assign(new Error('GitHub 401: Bad credentials'), { status: 401, data: { message: 'Bad credentials' }, signIn: 'ended' });
  for (const err of [renewalRefused, { status: 401, data: { message: 'Bad credentials' } }, { status: 403, data: { message: 'Forbidden' } }]) {
    const over = onLoadFailure(err, { mode: 'admin' });
    assert.equal(over.drop, true);
    assert.equal(over.notice.text, 'Your sign-in to edit this site has ended, so please sign in again with GitHub.');
    assert.equal(over.notice.button, 'Sign in again');
  }
  assert.equal(onLoadFailure(new TypeError('Failed to fetch'), { mode: 'admin' }), null, 'no answer at all is not a sign-out');
  assert.equal(onLoadFailure({ status: 500 }, { mode: 'admin' }), null);
});

test('sign-in ended: when the owner has something to correct, the sentence says to ask them and shows what the worker said', () => {
  const over = onLoadFailure(ENDED[1], { mode: 'editor' });
  assert.equal(over.drop, true);
  assert.equal(over.notice.text, 'Your sign-in to edit this site has ended, and the site’s owner has something to correct before anyone can sign in again, so please ask them.');
  assert.equal(over.notice.detail, `For the owner: ${REPO_CHANGED}`);
  assert.equal(over.notice.button, '', 'signing in again would be refused too, so it is not offered');
});

test('sign-in ended: with unpublished edits saved for the page, the sentence says they will be back', () => {
  assert.equal(endedNotice({ way: 'google', draft: true }).text,
    'Your sign-in to edit this site has ended, so please sign in again with Google and the edits you had not published will be back on this page.');
  assert.equal(endedNotice({ way: 'google', ownerMust: true, message: REPO_CHANGED, draft: true }).text,
    'Your sign-in to edit this site has ended, and the site’s owner has something to correct before anyone can sign in again, so please ask them. The edits you had not published are saved in this browser for a week.');
});

test('sign-in ended: every sentence is plain', () => {
  for (const way of ['google', 'github']) {
    for (const draft of [false, true]) {
      for (const ownerMust of [false, true]) {
        const n = endedNotice({ way, draft, ownerMust, message: ownerMust ? REPO_CHANGED : '' });
        assertPlain(n.text);
        assert.ok(n.text.length <= 240, 'short enough to read at a glance');
        if (!ownerMust) assert.equal((n.text.match(/[.?]/g) || []).length, 1, `one sentence: ${n.text}`);
      }
    }
  }
});

test('sign-in ended: "Sign in again" goes to the worker\'s own sign-in and comes back to the same page', () => {
  const at = { worker: 'https://worker.example', origin: 'https://site.example', path: '/blog/first post.html?x=1&y=2', repo: 'acme/site' };
  const google = new URL(signInUrl({ ...at, way: 'google' }));
  assert.equal(google.origin + google.pathname, 'https://worker.example/google/login');
  assert.equal(google.searchParams.get('origin'), 'https://site.example');
  assert.equal(google.searchParams.get('return_to'), '/blog/first post.html?x=1&y=2');
  assert.equal(google.searchParams.get('repo'), 'acme/site');
  const github = new URL(signInUrl({ ...at, way: 'github' }));
  assert.equal(github.origin + github.pathname, 'https://worker.example/auth/login');
  assert.equal(github.searchParams.get('return_to'), '/blog/first post.html?x=1&y=2');
  assert.equal(github.searchParams.has('repo'), false);
  // Both sign-ins refuse a return_to that does not start with "/": never send one.
  assert.equal(new URL(signInUrl({ ...at, path: 'https://elsewhere.example/', way: 'google' })).searchParams.get('return_to'), '/');
  assert.equal(new URL(signInUrl({ ...at, path: '', way: 'github' })).searchParams.get('return_to'), '/');
});

// ─── /kiln, with the boot shim itself ────────────────────────────────────────

/** Load src/kiln.js on a stand-in page at `pathname`, with `store` as the browser's localStorage. */
function loadShim(pathname, store) {
  const replaced = [], added = [];
  const el = () => ({ style: {}, children: [], innerHTML: '', querySelector() { return el(); }, appendChild(c) { this.children.push(c); } });
  const context = {
    window: { KILN: { repo: 'acme/site', worker: 'https://worker.example', siteName: 'Acme' } },
    document: {
      readyState: 'complete', currentScript: { src: 'https://site.example/assets/kiln.js' },
      querySelector: () => null, createElement: () => el(), addEventListener() {},
      head: { appendChild: (c) => added.push({ to: 'head', el: c }) },
      body: { appendChild: (c) => added.push({ to: 'body', el: c }) },
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { pathname, hash: '', search: '', origin: 'https://site.example', replace: (to) => replaced.push(to), reload() {} },
    history: { replaceState() {} },
  };
  vm.runInNewContext(readFileSync(path.join(ROOT, 'src', 'kiln.js'), 'utf8'), context);
  return {
    sentTo: replaced,
    signInShown: added.some(a => a.to === 'body' && a.el.id === 'kiln-entry'),
    editorLoaded: added.some(a => a.to === 'head' && /\/kiln-editor\.js$/.test(a.el.src || '')),
  };
}

test('sign-in ended: once the refused sign-in is dropped, /kiln shows the sign-in instead of sending the person back to the site', () => {
  const store = { kiln_editor: JSON.stringify({ session: 'c'.repeat(64), name: 'Sam', repo: 'acme/site', role: 'editor' }) };
  // With a sign-in stored, /kiln sends the person to the site and the site loads the editor. That is how
  // a refused sign-in went round: the editor did not start, kept the sign-in, and /kiln sent them back.
  assert.deepEqual(loadShim('/kiln', store).sentTo, ['/']);
  assert.equal(loadShim('/', store).editorLoaded, true);
  // The editor's first read of the page is answered 401: it drops the sign-in.
  const over = onLoadFailure({ status: 401, data: { error: 'session expired' } }, { mode: 'editor' });
  if (over.drop) delete store.kiln_editor;
  for (let visit = 0; visit < 3; visit++) {
    const kiln = loadShim('/kiln', store);
    assert.deepEqual(kiln.sentTo, [], 'no redirect');
    assert.equal(kiln.signInShown, true);
  }
  const page = loadShim('/', store);
  assert.equal(page.editorLoaded, false, 'the page is what a signed-out visitor sees');
  assert.deepEqual(page.sentTo, []);
});

test('sign-in ended: trouble reaching the worker leaves the sign-in where it is, so nothing changes at /kiln', () => {
  const store = { kiln_editor: JSON.stringify({ session: 'c'.repeat(64), name: 'Sam', repo: 'acme/site', role: 'editor' }) };
  for (const answer of NOT_ENDED) {
    const over = onLoadFailure(answer, { mode: 'editor' });
    if (over && over.drop) delete store.kiln_editor;
  }
  assert.ok(store.kiln_editor, 'still signed in');
  assert.equal(loadShim('/', store).editorLoaded, true);
});
