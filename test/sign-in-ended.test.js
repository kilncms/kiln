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
import {
  readFailure, onLoadFailure, endedNotice, notStartedNotice, signInUrl,
  whatSurvives, publishEnded, publishRefused, publishTrouble, editsAsText, backAfterSignIn,
} from '../src/editor/sign-in-ended.js';

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

/** Whether the editor is told to remove the stored sign-in. */
const dropped = (over) => !!over && over.drop === true;

test('sign-in ended: on page load nothing but a 401 drops an invited editor\'s sign-in', () => {
  for (const answer of NOT_ENDED) assert.equal(dropped(onLoadFailure(answer, { mode: 'editor' })), false, String(answer.status || answer));
});

test('sign-in ended: the owner is told to sign in with GitHub, when the token could not be renewed or GitHub refuses it', () => {
  const renewalRefused = Object.assign(new Error('GitHub 401: Bad credentials'), { status: 401, data: { message: 'Bad credentials' }, signIn: 'ended' });
  for (const err of [renewalRefused, { status: 401, data: { message: 'Bad credentials' } }, { status: 403, data: { message: 'Forbidden' } }]) {
    const over = onLoadFailure(err, { mode: 'admin', asking: 'who' });
    assert.equal(over.drop, true);
    assert.equal(over.notice.text, 'Your sign-in to edit this site has ended, so please sign in again with GitHub.');
    assert.equal(over.notice.button, 'Sign in again');
  }
  assert.equal(dropped(onLoadFailure(new TypeError('Failed to fetch'), { mode: 'admin', asking: 'who' })), false, 'no answer at all is not a sign-out');
  assert.equal(dropped(onLoadFailure({ status: 500 }, { mode: 'admin', asking: 'who' })), false);
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

// ─── At Publish ──────────────────────────────────────────────────────────────

const staged = (over = {}) => ({ edits: 0, source: 0, structural: 0, files: 0, ...over });
const ended = (counts, kept, more = {}) => publishEnded({ way: 'google', counts, survives: whatSurvives(counts, kept), ...more });

test('publish, sign-in ended: text edits saved in the browser survive signing in again, and so do the files kept with them', () => {
  assert.deepEqual(whatSurvives(staged({ edits: 2 }), { saved: true }), { text: 2, textKept: true, structuralLost: 0, filesLost: 0, all: true });
  assert.equal(whatSurvives(staged({ edits: 1, files: 2 }), { saved: true, filesKept: 2 }).all, true);
  assert.equal(whatSurvives(staged({ edits: 1, source: 1 }), { saved: true }).all, true);
});

test('publish, sign-in ended: what a page load loses is counted, never passed over', () => {
  // the browser could not write the saved copy (storage full, a private window)
  const unsaved = whatSurvives(staged({ edits: 3 }), { saved: false });
  assert.equal(unsaved.all, false);
  assert.equal(unsaved.textKept, false);
  // changes to what is editable, and added or removed sections, are not in the saved copy
  const structural = whatSurvives(staged({ edits: 1, structural: 2 }), { saved: true });
  assert.equal(structural.all, false);
  assert.equal(structural.textKept, true);
  assert.equal(structural.structuralLost, 2);
  // an upload that was not kept
  assert.equal(whatSurvives(staged({ edits: 1, files: 2 }), { saved: true, filesKept: 1 }).filesLost, 1);
  // uploads are kept beside the saved edits: without those there is nothing to bring them back with
  assert.equal(whatSurvives(staged({ files: 1 }), { saved: false, filesKept: 0 }).all, false);
  assert.equal(whatSurvives(staged({ structural: 1 }), { saved: false }).all, false);
});

test('publish, sign-in ended: the person is told nothing was published, that the edits are saved, and how to get back in', () => {
  const one = ended(staged({ edits: 1 }), { saved: true });
  assert.deepEqual(one, {
    title: 'Your sign-in has ended',
    status: 'Not published: your sign-in has ended.',
    text: 'Nothing was published. Your edit is saved in this browser and will be back on this page when you have signed in again with Google.',
    detail: '', signIn: true, copy: false, copyFirst: false,
  });
  assert.equal(ended(staged({ edits: 2, source: 1 }), { saved: true }).text,
    'Nothing was published. Your 3 edits are saved in this browser and will be back on this page when you have signed in again with Google.');
  assert.equal(publishEnded({ way: 'github', counts: staged({ edits: 1 }), survives: whatSurvives(staged({ edits: 1 }), { saved: true }) }).text,
    'Nothing was published. Your edit is saved in this browser and will be back on this page when you have signed in again with GitHub.');
});

test('publish, sign-in ended: what cannot be kept is said before the person leaves, and the text can be copied', () => {
  const unsaved = ended(staged({ edits: 2 }), { saved: false });
  assert.equal(unsaved.text, 'Nothing was published. Signing in again with Google loads this page afresh. This browser could not save your edits, so they will not be here afterwards. Copy your text first to be sure of it.');
  assert.equal(unsaved.copy, true);
  assert.equal(unsaved.copyFirst, true, 'the words would be lost: copying is the button to press first');
  assert.equal(unsaved.signIn, true);
  const structural = ended(staged({ edits: 1, structural: 1 }), { saved: true });
  assert.equal(structural.text, 'Nothing was published. Signing in again with Google loads this page afresh. Your edit is saved in this browser and will be back. Parts you made editable, added or removed cannot be saved and will need doing again. Copy your text first to be sure of it.');
  assert.equal(structural.copy, true);
  assert.equal(structural.copyFirst, false, 'the words are saved: signing in again stays the first button');
  const files = ended(staged({ edits: 1, files: 1 }), { saved: true, filesKept: 0 });
  assert.match(files.text, /The pictures or files you added could not be saved and will need adding again\./);
  // nothing with words in it: there is no text to copy, and it still says what is lost
  const only = ended(staged({ structural: 1 }), { saved: false });
  assert.equal(only.text, 'Nothing was published. Signing in again with Google loads this page afresh. Parts you made editable, added or removed cannot be saved and will need doing again.');
  assert.equal(only.copy, false);
});

test('publish, sign-in ended: when the owner has something to correct, signing in again is not offered and the text can be copied', () => {
  const d = ended(staged({ edits: 1 }), { saved: true }, { ownerMust: true, message: REPO_CHANGED });
  assert.equal(d.text, 'Nothing was published. The site’s owner has something to correct before anyone can sign in again, so please ask them. Your edit is saved in this browser for a week: copy your text to keep it longer.');
  assert.equal(d.detail, `For the owner: ${REPO_CHANGED}`);
  assert.equal(d.signIn, false);
  assert.equal(d.copy, true);
  const unsaved = ended(staged({ edits: 2 }), { saved: false }, { ownerMust: true, message: REPO_CHANGED });
  assert.equal(unsaved.text, 'Nothing was published. The site’s owner has something to correct before anyone can sign in again, so please ask them. Your 2 edits are still on this page, but only until it is closed: copy your text to keep it.');
});

test('publish, sign-in ended: found out by something other than Publish, or with nothing unpublished, it does not speak of publishing', () => {
  const idle = ended(staged(), { saved: false });
  assert.equal(idle.text, 'Please sign in again with Google to carry on.');
  assert.equal(idle.status, 'Your sign-in has ended.');
  assert.equal(idle.signIn, true);
  const elsewhere = ended(staged({ edits: 1 }), { saved: true }, { publishing: false });
  assert.equal(elsewhere.status, 'Your sign-in has ended.');
  assert.equal(elsewhere.text, 'Your edit is saved in this browser and will be back on this page when you have signed in again with Google.');
});

test('publish refused: a 403 is not a sign-out, and its reason is the answer\'s own', () => {
  const scope = readFailure({ status: 403, data: { error: 'outside your editing scope', path: 'about.html' } });
  assert.equal(scope.kind, 'refused');
  assert.equal(scope.reason, 'outside your editing scope');
  assert.equal(readFailure({ status: 403, data: { message: 'Resource not accessible by integration' } }).reason, 'Resource not accessible by integration');
  assert.equal(readFailure({ status: 403, data: {} }).reason, '');
  assert.equal(readFailure({ status: 403 }).kind, 'refused');
  // GitHub also answers 403 when it has been asked too often. That is not about the person.
  assert.notEqual(readFailure({ status: 403, data: { message: 'API rate limit exceeded for user ID 1.' } }).kind, 'refused');
  assert.notEqual(readFailure({ status: 403, data: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } }).kind, 'refused');
  // and on page load a 403 never drops an invited editor's sign-in
  assert.equal(dropped(onLoadFailure({ status: 403, data: { error: 'path not allowed' } }, { mode: 'editor' })), false);
});

test('publish refused: the person is told the edits are still there, offered a copy, and not sent to sign in', () => {
  const d = publishRefused({ way: 'google', reason: 'outside your editing scope', counts: staged({ edits: 1 }) });
  assert.deepEqual(d, {
    title: 'This was not published',
    status: 'Not published: your sign-in does not allow this change.',
    text: 'Your sign-in does not allow this change, so nothing was published. Your edit is still on this page: copy your text to keep it, and ask the site’s owner.',
    detail: 'The answer was: outside your editing scope',
    signIn: false, copy: true,
  });
  const owner = publishRefused({ way: 'github', reason: '', counts: staged({ edits: 2 }) });
  assert.equal(owner.text, 'Your sign-in does not allow this change, so nothing was published. Your 2 edits are still on this page: copy your text to keep it, and check that you can still write to the repository on GitHub.');
  assert.equal(owner.detail, '');
});

test('publish, sign-in ended: "Copy my text" gives each edit its name and its words', () => {
  assert.equal(editsAsText([
    { label: 'hero headline', text: ' Fresh bread\nevery morning ' },
    { label: 'opening note', text: '' },                // nothing to copy
    { label: '', text: 'Closed on Mondays' },
  ]), 'hero headline\nFresh bread\nevery morning\n\nClosed on Mondays');
  assert.equal(editsAsText([]), '');
  assert.equal(editsAsText(null), '');
});

test('publish, sign-in ended: after signing in again the status line says the edits are back', () => {
  assert.equal(backAfterSignIn(1), 'You are signed in again, and your edit is back on this page. Publish when ready.');
  assert.equal(backAfterSignIn(3, 2), 'You are signed in again, and your 3 edits are back on this page, with the files they added. Publish when ready.');
});

test('publish: every sentence about an ended or refused sign-in is plain', () => {
  const all = [backAfterSignIn(1), backAfterSignIn(2, 1)];
  for (const way of ['google', 'github']) {
    for (const counts of [staged(), staged({ edits: 1 }), staged({ edits: 2, source: 1, structural: 1, files: 2 }), staged({ structural: 1 })]) {
      for (const kept of [{ saved: true, filesKept: 2 }, { saved: false }]) {
        for (const more of [{}, { ownerMust: true, message: REPO_CHANGED }, { publishing: false }]) {
          const d = publishEnded({ way, counts, survives: whatSurvives(counts, kept), ...more });
          all.push(d.title, d.status, d.text);
        }
      }
      const r = publishRefused({ way, reason: 'outside your editing scope', counts });
      all.push(r.title, r.status, r.text);
    }
  }
  for (const text of all) assertPlain(text);
});

// ─── Trouble is not a sign-out ───────────────────────────────────────────────

// What fetch throws when nothing answers, as Chrome, Safari, Firefox and node word it.
const NO_ANSWER = ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'fetch failed'].map(m => new TypeError(m));
const FAILING = [500, 502, 503, 504, 408].map(status => ({ status, data: { error: 'internal error' } }));
const BUSY = [
  { status: 429, data: { error: 'rate limited, slow down' } },                                  // the worker's own limiter
  { status: 429 },
  { status: 403, data: { message: 'API rate limit exceeded for user ID 1.' } },                 // GitHub, asked too often
  { status: 403, data: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } },
];
// The owner's token ran out and the worker could not be asked for a new one: GitHub's 401 says nothing yet.
const RENEWAL_AWAY = Object.assign(new Error('GitHub 401: Bad credentials'), { status: 401, data: { message: 'Bad credentials' }, signIn: 'trouble' });
const TROUBLE = [...NO_ANSWER, ...FAILING, ...BUSY, RENEWAL_AWAY];

test('trouble: a failed request, a 5xx and a 429 are trouble, each told apart', () => {
  for (const err of NO_ANSWER) assert.deepEqual([readFailure(err).kind, readFailure(err).trouble], ['trouble', 'unreachable'], err.message);
  for (const err of FAILING) assert.deepEqual([readFailure(err).kind, readFailure(err).trouble], ['trouble', 'failing'], String(err.status));
  for (const err of BUSY) assert.deepEqual([readFailure(err).kind, readFailure(err).trouble], ['trouble', 'busy'], JSON.stringify(err));
  assert.equal(readFailure(RENEWAL_AWAY).kind, 'trouble');
  // A mistake in the editor's own code is not "the site could not be reached".
  assert.equal(readFailure(new TypeError("Cannot read properties of undefined (reading 'path')")).kind, 'other');
  assert.equal(readFailure(new Error('This page isn’t UTF-8 encoded')).kind, 'other');
});

test('trouble: on page load the sign-in is kept, for an invited editor and for the owner, and the page says so', () => {
  for (const mode of ['editor', 'admin']) {
    for (const asking of ['who', 'page']) {
      for (const err of TROUBLE) {
        const over = onLoadFailure(err, { mode, asking, draft: true });
        assert.equal(over.drop, false, `${mode} ${asking} ${err.status || err.message}`);
        assert.equal(over.action, 'reload');
        assert.deepEqual(over.notice, {
          text: 'Editing could not start just now. You are still signed in, so please reload the page to try again.',
          detail: '',
          button: 'Reload',
        });
      }
    }
  }
});

test('trouble: at Publish the status line says nothing was lost and to try again, each kind in its own words', () => {
  const one = { edits: 1, source: 0 };
  assert.equal(publishTrouble(readFailure(NO_ANSWER[0]), one), 'Not published: the site could not be reached. Your edit is still here, so please check your connection and try again.');
  assert.equal(publishTrouble(readFailure(FAILING[0]), { edits: 2, source: 1 }), 'Not published: the site had a problem just now. Your 3 edits are still here, so please try again in a moment.');
  assert.equal(publishTrouble(readFailure(BUSY[0]), one), 'Not published: too much was asked of the site just now. Your edit is still here, so please try again in a minute.');
  assert.equal(publishTrouble(readFailure(BUSY[2]), { edits: 0, source: 0 }), 'Not published: too much was asked of the site just now. Nothing was lost, so please try again in a minute.');
  for (const err of TROUBLE) assertPlain(publishTrouble(readFailure(err), one));
});

test('trouble: none of it reads as an ended or a refused sign-in, so nothing offers to sign in again or says the edit is not allowed', () => {
  for (const err of TROUBLE) {
    const f = readFailure(err);
    assert.notEqual(f.kind, 'ended', String(err.status || err.message));
    assert.notEqual(f.kind, 'refused', String(err.status || err.message));
  }
});

test('page load refused: a 403 on reading the page keeps the sign-in and says to ask, with the answer\'s reason', () => {
  const over = onLoadFailure({ status: 403, data: { error: 'path not allowed', path: '/repos/acme/other/contents/index.html' } }, { mode: 'editor' });
  assert.equal(over.drop, false);
  assert.equal(over.action, '');
  assert.deepEqual(over.notice, {
    text: 'Editing could not start on this page because the site did not allow it. You are still signed in, so please ask the site’s owner.',
    detail: 'The answer was: path not allowed',
    button: '',
  });
  // The owner: GitHub refusing the page is not GitHub refusing the person.
  const owner = onLoadFailure({ status: 403, data: { message: 'Resource not accessible by integration' } }, { mode: 'admin', asking: 'page' });
  assert.equal(owner.drop, false);
  assert.equal(owner.notice.text, 'Editing could not start on this page because the site did not allow it. You are still signed in, so please check that you can still read the repository on GitHub.');
  assertPlain(over.notice.text);
  assertPlain(owner.notice.text);
  assertPlain(notStartedNotice({ way: 'google', f: readFailure(NO_ANSWER[0]) }).text);
});

test('page load: what is neither the sign-in nor trouble nor a refusal is left to the editor as before', () => {
  for (const err of [{ status: 404, data: { message: 'Not Found' } }, { status: 409 }, { status: 422 }, new Error('This page isn’t UTF-8 encoded')]) {
    assert.equal(onLoadFailure(err, { mode: 'editor' }), null);
    assert.equal(onLoadFailure(err, { mode: 'admin', asking: 'page' }), null);
  }
});
