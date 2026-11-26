// "Waiting on other pages": the sheet's words and sorting (src/editor/set-sheet.js),
// the set's commit message and History line (src/editor/firstrun.js), and the
// one reader of a saved copy in publish-set.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITOR_SET_PAGES_MAX, waitingItemLabel, editedAgo, setLabel, dropPageCopy, HELD_TEXT, editorLimitText, firstPagesLabel,
  overText, blockedText, setDoneText, holdBack, withoutKeys, copyPath, canJoinSet, firstPages,
} from '../src/editor/set-sheet.js';
import { setCommitMessage, setCommitLine, editCommitMessage } from '../src/editor/firstrun.js';
import { planSet } from '../src/editor/publish-set.js';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const SHA = 'a'.repeat(40);

test('the menu item counts pages', () => {
  assert.equal(waitingItemLabel(4), 'Waiting on other pages (4)');
  assert.equal(waitingItemLabel(1), 'Waiting on other pages (1)');
});

test('how long ago a page was edited', () => {
  assert.equal(editedAgo(10 * 1000), 'edited just now');
  assert.equal(editedAgo(MIN), 'edited 1 minute ago');
  assert.equal(editedAgo(5 * MIN), 'edited 5 minutes ago');
  assert.equal(editedAgo(3 * HOUR), 'edited 3 hours ago');
  assert.equal(editedAgo(DAY + HOUR), 'edited yesterday');
  assert.equal(editedAgo(2 * DAY + 1), 'edited 2 days ago');
  assert.equal(editedAgo(null), '');
  assert.equal(editedAgo(-5), '');
});

test('the main button carries edits and pages', () => {
  assert.equal(setLabel({ edits: 7, pages: 3 }), 'Publish 7 edits on 3 pages');
  assert.equal(setLabel({ edits: 1, pages: 2 }), 'Publish 1 edit on 2 pages');
  assert.equal(setLabel({ edits: 2, pages: 1 }), 'Publish 2 edits');
});

test('dropping a page asks first, in plain words', () => {
  const c = dropPageCopy(2, 'About us');
  assert.equal(c.body, 'Discard the 2 waiting changes on About us? They have not been published.');
  assert.equal(c.cancel, 'Keep them');
  assert.equal(c.go, 'Discard');
  assert.equal(dropPageCopy(1, '').body, 'Discard the waiting change on this page? It has not been published.');
});

test('limits and blocks are said in full sentences, with no dash as punctuation', () => {
  assert.equal(EDITOR_SET_PAGES_MAX, 20);
  assert.equal(editorLimitText(), 'Kiln publishes 20 pages at a time for an invited editor. Publish these 20 first, then the rest.');
  assert.equal(firstPagesLabel(100), 'Publish these 100 first');
  assert.match(overText({ what: 'files', count: 130, max: 100 }), /Publish these 100 first/);
  assert.match(overText({ what: 'pictures', count: 25, max: 20 }), /20 new pictures/);
  assert.equal(overText(null), '');
  assert.match(blockedText([{ path: 'a.html', key: 'menu', reason: 'list' }], () => 'Our menu'), /A list on Our menu cannot/);
  assert.match(blockedText([{ path: 'img/x.png', key: null, reason: 'picture' }]), /x\.png/);
  for (const t of [editorLimitText(), HELD_TEXT, setDoneText({ pages: 3, left: [{ reason: 'part_gone' }] })]) assert.doesNotMatch(t, / [-–—] /);
});

test('the done line says what went and what is still waiting', () => {
  assert.equal(setDoneText({ pages: 3 }), 'Published 3 pages as one change. The site is rebuilding once.');
  assert.equal(setDoneText({ pages: 3, left: [{ path: 'a.html', key: 'x', reason: 'part_gone' }] }),
    'Published 3 pages as one change. 1 edit is still waiting: the part it changed is no longer on the page.');
  assert.equal(setDoneText({ pages: 1, left: [{ reason: 'part_gone' }, { reason: 'page_gone' }] }), 'Published 1 page as one change. 2 edits are still waiting.');
  assert.match(setDoneText({ pages: 0 }), /already read that way/);
});

test('a value that fails the check is held back and stays waiting; the rest goes', () => {
  const saved = { ts: 1, edits: { a: { html: 'Hello' }, b: { html: '<img src=x onerror=alert(1)>' }, c: { attrs: { href: 'javascript:alert(1)' } }, d: { attrs: { href: '/about' } } },
    source: { 'x.md#title': { value: 'T' } }, page: { path: 'a.html' } };
  const safe = (html) => !/onerror|<script/i.test(String(html ?? ''));
  const { copy, held } = holdBack(saved, safe);
  assert.deepEqual(held.sort(), ['b', 'c']);
  assert.deepEqual(Object.keys(copy.edits).sort(), ['a', 'd']);
  assert.equal(copy.source, undefined, 'a content-file edit is never in a set in this step');
  assert.equal(saved.edits.b.html.includes('onerror'), true, 'the saved copy itself is not changed');
  assert.equal(holdBack({ ts: 1, edits: { b: { html: '<script>x</script>' } } }, safe).copy, null);
  assert.equal(holdBack({ edits: { a: { html: 'x' } } }, () => { throw new Error('no'); }).held[0], 'a', 'a check that throws holds the value back');
  assert.equal(holdBack(null, safe).copy, null);
});

test('what was published comes out of a saved copy, and nothing else', () => {
  const saved = { ts: 5, n: 3, edits: { a: { html: '1' }, b: { html: '2' } }, more: { a: { was: '0' }, b: { was: '9' } }, page: { path: 'a.html' } };
  const out = withoutKeys(saved, ['a']);
  assert.deepEqual(out.edits, { b: { html: '2' } });
  assert.deepEqual(out.more, { b: { was: '9' } });
  assert.equal(out.n, undefined, 'the old number no longer counts what is left');
  assert.deepEqual(out.page, { path: 'a.html' });
  assert.equal(withoutKeys(saved, ['a', 'b']), null);
  assert.ok(withoutKeys({ ...saved, source: { r: { value: 'x' } } }, ['a', 'b']), 'a content-file edit stays waiting');
});

test('which pages go, and whether this page can join', () => {
  assert.equal(copyPath({ edits: {}, page: { path: 'de/about.html' } }), 'de/about.html');
  assert.equal(copyPath({ edits: {}, page: { path: '../x.html' } }), null);
  assert.equal(canJoinSet({ path: 'a.html' }), true);
  assert.equal(canJoinSet({ path: 'a.html', structural: 1 }), false);
  assert.equal(canJoinSet({ path: 'a.html', restoring: true }), false);
  assert.equal(canJoinSet({ path: 'a.html', source: 2 }), false);
  assert.equal(canJoinSet({ path: null }), false);
  const pages = Array.from({ length: 25 }, (_, i) => ({ path: `p${i}.html` }));
  assert.equal(firstPages(pages, 20).length, 20);
  assert.equal(firstPages(pages, 20)[0], 'p0.html');
  assert.equal(firstPages([{ path: 'a' }, { path: 'a' }, { path: null }], null).length, 1);
});

test('the commit message: the note first, else "Publish N pages together", then a line a page', () => {
  const pages = [{ path: 'de/about.html', keys: ['hero_title', 'hero_text'] }, { path: 'index.html', keys: ['intro'] }];
  assert.equal(setCommitMessage('', pages), 'Publish 2 pages together (via Kiln)\n\nEdit de/about.html: hero_title, hero_text\nEdit index.html: intro');
  assert.equal(setCommitMessage('Spring prices (via Kiln)', pages).split('\n')[0], 'Spring prices (via Kiln)');
  assert.match(setCommitMessage('', [...pages, { path: 'c.html', keys: [] }]), /Edit c\.html: shared part$/);
});

test('History reads a set as "Published with N other pages"', () => {
  const pages = Array.from({ length: 30 }, (_, i) => ({ path: `p${i}.html`, keys: ['x'] }));
  assert.equal(setCommitLine(setCommitMessage('', pages)), 'Published with 29 other pages');
  assert.equal(setCommitLine(setCommitMessage('Spring prices (via Kiln)', pages)), 'Published with 29 other pages: Spring prices');
  assert.equal(setCommitLine('Publish 2 pages together (via Kiln)'), 'Published with 1 other page', 'the first line alone is enough');
  assert.equal(setCommitLine(editCommitMessage('a.html', ['x'])), null, 'a one-page publish reads as it did');
  assert.equal(setCommitLine('Upload 2 files (via Kiln)'), null);
  assert.equal(setCommitLine(setCommitMessage('Note (via Kiln)', pages.slice(0, 1))), null, 'one page is not a set');
});

test('a saved copy with no version of its file is compared part by part, never taken as unchanged', async () => {
  const text = '<h1 data-cms="t">Theirs now</h1>';
  const copy = { ts: 1, edits: { t: { html: 'Mine' } }, more: { t: { was: 'Before' } }, page: { path: 'a.html' } };
  const files = new Map([['a.html', SHA]]);
  const plan = await planSet({ copies: [copy], files, read: async () => text });
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.files.length, 0);
  // the same copy with a version that matches the file: the person saw this file, nothing to compare
  const same = await planSet({ copies: [{ ...copy, page: { path: 'a.html', sha: SHA } }], files, read: async () => text });
  assert.equal(same.conflicts.length, 0);
  assert.equal(same.files.length, 1);
  // a tampered version (not a sha) is not read as one
  const bad = await planSet({ copies: [{ ...copy, page: { path: 'a.html', sha: 'x' } }], files: new Map([['a.html', 'x']]), read: async () => text });
  assert.equal(bad.conflicts.length, 1);
});
