/**
 * Which pages have a saved draft (src/editor/draft-state.js, used by the
 * Drafts tool in main.js).
 *
 * A tester was told "There's a saved draft of this page" on three pages
 * nobody had saved a draft of. The drafts branch is made from the published
 * one the first time anyone saves a draft, so it holds a copy of every page
 * as it was that day; each page published afterwards differed from its copy,
 * and the copy was offered as a draft, with "Publish it now" beside it. These
 * tests hold the editor to the rule: a page has a draft only if someone saved
 * a draft of that page and it has not been published or deleted since.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  DRAFT_BRANCH, draftSaveMessage, draftDeleteMessage, draftPublishedMessage, lastChangeUrl, blobSha,
  readDraftSave, olderThanPage, draftOfPage, draftWords, DRAFT_DELETE_REFUSED,
} from '../src/editor/draft-state.js';
import { commitsPageUrl } from '../src/editor/older-versions.js';
import { editorEnv, withFetch, call, jsonRes, b64, REPO } from './worker-harness.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const PAGE = 'about.html';
const LIVE = '<!doctype html>\n<html><body>\n<h1 data-cms="title">Opening hours for the winter</h1>\n</body></html>\n';
const OLD = LIVE.replace('for the winter', 'for the summer');
const row = (message, { name = 'Rosa', date = '2026-11-03T10:00:00Z' } = {}) =>
  ({ sha: 'c'.repeat(40), commit: { message, author: { name, date }, committer: { name: 'GitHub', date } } });

/** GitHub as the editor's requests see it: the last change to the page on each branch. */
function fakeGh({ drafts, published, fail = () => false }) {
  const calls = [];
  return {
    calls,
    async request(method, path) {
      calls.push(`${method} ${path}`);
      if (fail(calls.length)) throw Object.assign(new Error('GitHub 429: '), { status: 429 });
      if (path === lastChangeUrl(REPO, PAGE, DRAFT_BRANCH)) return drafts ? [drafts] : [];
      if (path === lastChangeUrl(REPO, PAGE, 'main')) return published ? [published] : [];
      throw Object.assign(new Error('GitHub 404: Not Found'), { status: 404 });
    },
  };
}
const ask = (gh, pageText = LIVE, extra = {}) => draftOfPage({ gh, repo: REPO, path: PAGE, branch: 'main', pageText, ...extra });

test('drafts: a file\'s git name is worked out from its text, as git does', async () => {
  assert.equal(await blobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(await blobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  const text = 'Café – 10 €\n';
  const git = execFileSync('git', ['hash-object', '--stdin'], { input: text }).toString().trim();
  assert.equal(await blobSha(text), git, 'letters outside ASCII are counted in bytes');
  assert.equal(await blobSha('hello\n', null), null, 'a browser that cannot work it out says so');
});

test('drafts: a save says which page it is a draft of and which version it was made from', async () => {
  const from = await blobSha(LIVE);
  assert.equal(draftSaveMessage(PAGE, from), `Draft: about.html (via Kiln)\n\nKiln-Draft-Of: ${from}`);
  assert.equal(draftSaveMessage(PAGE, null), 'Draft: about.html (via Kiln)', 'the first line is what every editor has written');
  assert.deepEqual(readDraftSave(row(draftSaveMessage(PAGE, from)), PAGE), { from, by: 'Rosa', when: '2026-11-03T10:00:00Z' });
  assert.deepEqual(readDraftSave(row('Draft: about.html (via Kiln)'), PAGE), { from: null, by: 'Rosa', when: '2026-11-03T10:00:00Z' });
  // main.js writes it, with the page it has open
  const save = main.slice(main.indexOf('async function saveDraft()'), main.indexOf('function draftDialog('));
  assert.match(save, /message: draftSaveMessage\(state\.page\.path, await blobSha\(state\.page\.text\)\)/);
});

test('drafts: nothing but a save of a draft of this page counts as one', () => {
  for (const message of [
    'Update about.html (via Kiln)',                 // a publish from before the drafts branch was made: the leftover copy
    'Replace “summer” → “winter” on 3 pages (via Kiln)',
    draftDeleteMessage(PAGE), draftPublishedMessage(PAGE),
    'Draft: contact.html (via Kiln)',               // another page's draft
    'Draft: about.html',                            // not the editor's own words
    'Merge branch main into kiln-drafts',
  ]) assert.equal(readDraftSave(row(message), PAGE), null, message);
  assert.equal(readDraftSave(undefined, PAGE), null);
  assert.equal(readDraftSave({ commit: {} }, PAGE), null);
  assert.equal(draftDeleteMessage(PAGE), 'Discard draft: about.html (via Kiln)');
  assert.equal(draftPublishedMessage(PAGE), 'Draft published: about.html (via Kiln)');
});

test('drafts: a copy left from when the drafts branch was made is not a draft, and one request says so', async () => {
  // The page was published after the branch was made, so it differs from its
  // copy there. The last change to the copy is an ordinary publish from before.
  const gh = fakeGh({ drafts: row('Update about.html (via Kiln)', { date: '2026-10-01T09:00:00Z' }) });
  assert.equal(await ask(gh), null);
  assert.deepEqual(gh.calls, [`GET /repos/${REPO}/commits?sha=kiln-drafts&path=about.html&per_page=1`]);
  // and a file with no history at all on that branch is not one either
  assert.equal(await ask(fakeGh({})), null);
});

test('drafts: a draft somebody saved is offered, as the newer of the two while the page is as it was', async () => {
  const gh = fakeGh({ drafts: row(draftSaveMessage(PAGE, await blobSha(LIVE))) });
  const draft = await ask(gh, LIVE);
  assert.equal(draft.older, false);
  assert.equal(draft.by, 'Rosa');
  assert.equal(gh.calls.length, 1, 'one request, however the draft stands');
});

test('drafts: a draft saved before somebody else published the page is the older of the two, and says so', async () => {
  // Rosa saved a draft of the summer page; Sam then published the winter one.
  const gh = fakeGh({ drafts: row(draftSaveMessage(PAGE, await blobSha(OLD))) });
  const draft = await ask(gh, LIVE);
  assert.equal(draft.older, true);
  assert.equal(gh.calls.length, 1);
  const words = draftWords(draft, { day: () => '3 November 2026' });
  assert.equal(words.title, 'This page has a draft that is older than the page');
  assert.equal(words.body, 'Rosa saved it on 3 November 2026. The page has been published since then, so the draft holds older words than the page does. Resuming it puts the draft’s words back on the page for you to look over. Nothing goes live until you publish, and you are shown every change first.');
});

test('drafts: a draft saved by an editor from before 0.6.2 is still offered, and a second request says which is newer', async () => {
  const legacy = row('Draft: about.html (via Kiln)', { date: '2026-11-03T10:00:00Z' });
  let gh = fakeGh({ drafts: legacy, published: row('Update about.html (via Kiln)', { date: '2026-11-01T10:00:00Z' }) });
  assert.equal((await ask(gh)).older, false, 'the page was last published before the draft was saved');
  assert.deepEqual(gh.calls, [
    `GET /repos/${REPO}/commits?sha=kiln-drafts&path=about.html&per_page=1`,
    `GET /repos/${REPO}/commits?sha=main&path=about.html&per_page=1`,
  ]);
  gh = fakeGh({ drafts: legacy, published: row('Update about.html (via Kiln)', { date: '2026-11-05T10:00:00Z' }) });
  assert.equal((await ask(gh)).older, true, 'the page was published after the draft was saved');
  // the second request refused: the draft is still offered, and nothing is claimed about which is newer
  gh = fakeGh({ drafts: legacy, fail: (nth) => nth === 2 });
  const unknown = await ask(gh);
  assert.equal(unknown.older, null);
  assert.match(draftWords(unknown, { day: () => '3 November 2026' }).body, /^Rosa saved it on 3 November 2026\. Kiln could not check whether the page has been published since then\. If it has, the draft holds older words than the page does\./);
  // a browser that cannot work out the page's version asks the same second question
  gh = fakeGh({ drafts: row(draftSaveMessage(PAGE, await blobSha(OLD))), published: row('Update about.html (via Kiln)', { date: '2026-11-05T10:00:00Z' }) });
  assert.equal((await ask(gh, LIVE, { subtle: null })).older, true);
  assert.equal(gh.calls.length, 2);
});

test('drafts: when GitHub cannot be asked, the caller is told, and main.js then offers nothing', async () => {
  await assert.rejects(ask(fakeGh({ fail: () => true })), /429/);
  const check = main.slice(main.indexOf('async function checkForDraft()'), main.indexOf('// ─── Scheduled publishing'));
  assert.match(check, /try \{\n    saved = await draftOfPage\(/);
  assert.match(check, /\} catch \(err\) \{ console\.warn\([^)]*\); return; \}\n  if \(!saved\) return;/);
  // asked only once the two texts differ, and before anything is shown
  const order = ['djb2(draft.text) === djb2(state.page.text)) return;', 'await draftOfPage(', 'await restoreAsked;', 'draftDialog('].map(s => check.indexOf(s));
  assert.ok(order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1])), order.join(' '));
});

test('drafts: the words are plain, and say who can delete a draft when this person cannot', () => {
  const fresh = { by: 'Rosa', when: '2026-11-03T10:00:00Z', older: false };
  const day = () => '3 November 2026';
  assert.deepEqual(draftWords(fresh, { day }), { title: "There's a saved draft of this page",
    body: 'Rosa saved it on 3 November 2026. It isn’t live. Resume editing it, publish it as it is, or leave it for later.' });
  assert.match(draftWords(fresh, { day, canDelete: false }).body, / The site’s owner can delete it, and so can anyone who has the Drafts tool\.$/);
  assert.match(draftWords({ ...fresh, by: '' }, { day }).body, /^It was saved on 3 November 2026\. /);
  assert.match(draftWords({ ...fresh, when: '' }, { day }).body, /^Rosa saved it\. /);
  for (const older of [true, false, null]) for (const canDelete of [true, false]) {
    const w = draftWords({ ...fresh, older }, { canDelete });
    assert.equal(/[—–]/.test(w.title + w.body), false, 'no dashes');
  }
  assert.equal(/[—–]/.test(DRAFT_DELETE_REFUSED), false);
});

test('drafts: anyone who can save a draft is shown "Delete draft", and an invited editor\'s delete is a write, not a removal', () => {
  const check = main.slice(main.indexOf('async function checkForDraft()'), main.indexOf('// ─── Scheduled publishing'));
  assert.match(check, /const canDelete = hasFeature\('draft'\) && !\(mode === 'editor' && state\.scope\?\.mode === 'review'\);\n  const m = draftDialog\(canDelete, draftWords\(saved, \{ canDelete \}\)\);/);
  // the owner removes the file; an editor writes the page as it is over the draft, saying the draft was deleted
  assert.match(check, /if \(mode === 'admin'\) \{\n        await state\.gh\.request\('DELETE',[^\n]*\n          \{ message: draftDeleteMessage\(state\.page\.path\), sha: draft\.sha, branch: DRAFT_BRANCH \}\);\n      \} else \{\n        await putFile\(state\.gh, cfg\.repo, state\.page\.path,\n          \{ text: state\.page\.text, sha: draft\.sha, branch: DRAFT_BRANCH, message: draftDeleteMessage\(state\.page\.path\) \}\);/);
  // a published draft is put away the same two ways
  const retire = main.slice(main.indexOf('async function retireResumedDraft('), main.indexOf('async function checkForDraft()'));
  assert.match(retire, /\} else if \(now\.text !== state\.page\.text\) \{/);
  assert.match(retire, /\{ text: state\.page\.text, sha, branch: DRAFT_BRANCH, message: draftPublishedMessage\(state\.page\.path\) \}/);
});

test('drafts: the service passes an invited editor\'s question, which is the History tool\'s own request with the branch named', async () => {
  const url = lastChangeUrl(REPO, PAGE, DRAFT_BRANCH);
  assert.equal(url.split('?')[0], commitsPageUrl(REPO, PAGE, 1).split('?')[0]);
  const env = editorEnv({ features: ['draft'] });
  await withFetch((u) => (u.includes(`/repos/${REPO}/commits?`) ? jsonRes([row('Draft: about.html (via Kiln)')]) : undefined), async (calls) => {
    const r = await call(env, 'GET', `/gh${url}`);
    assert.equal(r.status, 200);
    assert.ok(calls.some(c => c.url === `https://api.github.com${url}`), 'passed to GitHub as it was asked');
  });
});

test('drafts: the service lets an editor with the Drafts tool write over a draft, and lets no editor remove a file', async () => {
  const env = editorEnv({ features: ['draft'] });
  const path = `/gh/repos/${REPO}/contents/${PAGE}`;
  await withFetch((u, init) => {
    if (u.endsWith('/git/blobs/draftsha')) return jsonRes({ content: b64(OLD) });
    if (u.endsWith(`/contents/${PAGE}`) && init.method === 'PUT') return jsonRes({ commit: { sha: 'd'.repeat(40) } });
    return undefined;
  }, async (calls) => {
    const over = await call(env, 'PUT', path, { body: { message: draftDeleteMessage(PAGE), content: b64(LIVE), sha: 'draftsha', branch: DRAFT_BRANCH } });
    assert.equal(over.status, 200);
    const sent = calls.find(c => c.method === 'PUT');
    assert.ok(sent && /Discard draft: about\.html \(via Kiln\)/.test(JSON.stringify(sent.body)), 'the commit says the draft was deleted');
    const gone = await call(env, 'DELETE', path, { body: { message: draftDeleteMessage(PAGE), sha: 'draftsha', branch: DRAFT_BRANCH } });
    assert.equal(gone.status, 403, 'which is why the editor does not ask for a removal');
    assert.equal(calls.some(c => c.method === 'DELETE'), false);
  });
  // without the Drafts tool, neither
  const none = editorEnv({ features: [] });
  await withFetch(() => undefined, async () => {
    const r = await call(none, 'PUT', path, { body: { message: draftDeleteMessage(PAGE), content: b64(LIVE), sha: 'draftsha', branch: DRAFT_BRANCH } });
    assert.equal(r.status, 403);
  });
});

test('drafts: the branch\'s name and the dialog are each written once, where start-up can reach them', () => {
  assert.equal(DRAFT_BRANCH, 'kiln-drafts');
  assert.equal(/const DRAFT_BRANCH/.test(main), false, 'main.js takes the name from draft-state.js, so start-up never finds it undefined');
  assert.match(main, /import \{ DRAFT_BRANCH, [^}]*\} from '\.\/draft-state\.js';/);
  assert.equal(olderThanPage({ from: null, when: '' }, {}), null);
});
