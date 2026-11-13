/**
 * An owner who has no GitHub account, and a sign-in that has ended
 * (src/editor/sign-in-ended.js). Kiln keeps this owner's site in a repository
 * of its own, and the sign-in service says so in its answer to
 * GET /auth/session (`kept: true`). "Sign in again" leads them to the Google
 * sign-in, as it does an invited editor, and where an invited editor is told
 * to ask the site's owner, they are sent to their Kiln dashboard. Everybody
 * else is told what they were always told.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  wayOf, signInUrl, onLoadFailure, endedNotice, notStartedNotice, whatSurvives,
  publishEnded, publishRefused, readRefused,
} from '../src/editor/sign-in-ended.js';

const read = (name) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'editor', name), 'utf8');
const NAMES_GITHUB = /GitHub|github|repositor|\brepo\b/;
const DASHBOARD = 'open the editor again from your Kiln dashboard at app.kilncms.com';
const staged = (over = {}) => ({ edits: 0, source: 0, structural: 0, files: 0, ...over });

test('kept owner: the editor remembers what the service said, for the page that finds the sign-in ended', () => {
  const main = read('main.js');
  assert.match(main, /rememberKept\(user\.kept === true\)/);
  assert.match(main, /state\.kept = !!stored\?\.session && wasKept\(\);/);
  // A sign-in that ran out by the browser's own clock is dropped by the boot shim before the editor starts: still known.
  const known = main.indexOf("state.kept = mode === 'admin' && wasKept();");
  assert.ok(known > main.indexOf('async function init()') && known < main.indexOf('if (window.__KILN_OVER)'));
  assert.match(main, /function keptKey\(\) \{ return `kiln_kept:\$\{cfg\.repo\}`; \}/);
  assert.match(main, /function signInWay\(\) \{ return wayOf\(\{ mode, kept: state\.kept \}\); \}/);
});

test('kept owner: the way is theirs alone, and everybody else signs in as before', () => {
  assert.equal(wayOf({ mode: 'admin', kept: true }), 'kept');
  assert.equal(wayOf({ mode: 'admin', kept: false }), 'github');
  assert.equal(wayOf({ mode: 'admin' }), 'github');
  assert.equal(wayOf({ mode: 'admin', kept: 'yes' }), 'github');
  assert.equal(wayOf({ mode: 'editor' }), 'google');
  assert.equal(wayOf({ mode: 'editor', kept: true }), 'google');   // only an owner is ever kept
  assert.equal(wayOf(), 'google');
});

test('kept owner: "Sign in again" leads to the Google sign-in, at the address an invited editor gets', () => {
  const at = { worker: 'https://auth.example', origin: 'https://site.example', path: '/about/?x=1', repo: 'kiln-sites/rosa' };
  assert.equal(signInUrl({ ...at, way: 'kept' }), signInUrl({ ...at, way: 'google' }));
  const url = new URL(signInUrl({ ...at, way: 'kept' }));
  assert.equal(url.origin + url.pathname, 'https://auth.example/google/login');
  assert.equal(url.searchParams.get('return_to'), '/about/?x=1');
  assert.equal(url.searchParams.get('repo'), 'kiln-sites/rosa');
  assert.equal(new URL(signInUrl({ ...at, way: 'github' })).pathname, '/auth/login');
});

test('kept owner: a sign-in that has ended says what an invited editor is told', () => {
  for (const draft of [false, true]) {
    assert.deepEqual(endedNotice({ way: 'kept', draft }), endedNotice({ way: 'google', draft }));
    assert.match(endedNotice({ way: 'kept', draft }).text, /please sign in again with Google/);
  }
  for (const counts of [staged(), staged({ edits: 2 }), staged({ edits: 1, files: 1 })]) {
    for (const saved of [false, true]) {
      const survives = whatSurvives(counts, { saved });
      assert.deepEqual(publishEnded({ way: 'kept', counts, survives }), publishEnded({ way: 'google', counts, survives }));
    }
  }
  // The page that loads with the sign-in ended knows it from what was remembered.
  const over = onLoadFailure({ status: 401 }, { mode: 'admin', kept: true, draft: true });
  assert.equal(over.drop, true);
  assert.equal(over.action, 'signin');
  assert.deepEqual(over.notice, endedNotice({ way: 'google', draft: true }));
  assert.match(onLoadFailure({ status: 401 }, { mode: 'admin' }).notice.text, /please sign in again with GitHub/);
  assert.match(onLoadFailure({ status: 401 }, { mode: 'editor' }).notice.text, /please sign in again with Google/);
});

test('kept owner: where an invited editor is told to ask the site’s owner, they are sent to their dashboard', () => {
  const same = (kept, google) => {
    assert.match(google, /ask the site’s owner/);
    assert.equal(kept, google.replaceAll('ask the site’s owner', DASHBOARD));
  };
  const f = { kind: 'refused', reason: 'Resource not accessible' };
  same(notStartedNotice({ way: 'kept', f }).text, notStartedNotice({ way: 'google', f }).text);
  assert.equal(notStartedNotice({ way: 'kept', f }).detail, notStartedNotice({ way: 'google', f }).detail);
  same(readRefused({ way: 'kept' }), readRefused({ way: 'google' }));
  same(readRefused({ way: 'kept', reason: 'no' }), readRefused({ way: 'google', reason: 'no' }));
  for (const counts of [staged(), staged({ edits: 2 })]) {
    same(publishRefused({ way: 'kept', counts }).text, publishRefused({ way: 'google', counts }).text);
  }
  same(publishRefused({ way: 'kept', counts: staged(), typed: { name: 'your note' } }).text,
    publishRefused({ way: 'google', counts: staged(), typed: { name: 'your note' } }).text);
  assert.equal(onLoadFailure({ status: 403 }, { mode: 'admin', kept: true }).notice.text,
    `Editing could not start on this page because the site did not allow it. You are still signed in, so please ${DASHBOARD}.`);
  // The owner with GitHub is told what they were always told.
  assert.match(readRefused({ way: 'github' }), /check that you can still read the repository on GitHub/);
  assert.match(publishRefused({ way: 'github', counts: staged() }).text, /check that you can still write to the repository on GitHub/);
});

test('kept owner: when something has to be corrected first, they are not told to ask the owner, who they are', () => {
  const ended = endedNotice({ way: 'kept', ownerMust: true, draft: true });
  assert.equal(ended.text, `Your sign-in to edit this site has ended, and something has to be corrected before anyone can sign in again, so please ${DASHBOARD}.`
    + ' The edits you had not published are saved in this browser for a week.');
  assert.equal(ended.button, '');
  const counts = staged({ edits: 1 });
  const pub = publishEnded({ way: 'kept', ownerMust: true, counts, survives: whatSurvives(counts, { saved: true }) });
  assert.match(pub.text, new RegExp(`Something has to be corrected before anyone can sign in again, so please ${DASHBOARD.replaceAll('.', '\\.')}\\.`));
  assert.equal(pub.signIn, false);
  for (const way of ['google', 'github']) {
    assert.match(endedNotice({ way, ownerMust: true }).text, /the site’s owner has something to correct before anyone can sign in again, so please ask them\./);
    assert.match(publishEnded({ way, ownerMust: true, counts, survives: whatSurvives(counts, { saved: true }) }).text, /The site’s owner has something to correct/);
  }
});

test('kept owner: nothing they are told about their sign-in names GitHub, a repository or another owner', () => {
  const counts = staged({ edits: 2 });
  const survives = whatSurvives(counts, { saved: true });
  const f = { kind: 'refused', reason: '' };
  const told = [
    endedNotice({ way: 'kept' }), endedNotice({ way: 'kept', draft: true }), endedNotice({ way: 'kept', ownerMust: true }),
    notStartedNotice({ way: 'kept', f }),
    publishEnded({ way: 'kept', counts, survives }), publishEnded({ way: 'kept', ownerMust: true, counts, survives }),
    publishRefused({ way: 'kept', counts }), publishRefused({ way: 'kept', counts: staged() }),
    readRefused({ way: 'kept' }),
  ];
  for (const t of told) {
    assert.doesNotMatch(JSON.stringify(t), NAMES_GITHUB);
    assert.doesNotMatch(JSON.stringify(t), /site’s owner|—/);
  }
});
