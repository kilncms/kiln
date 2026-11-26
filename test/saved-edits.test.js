/**
 * Unpublished edits saved in the browser (src/editor/saved-edits.js): what is
 * written, what is offered back, and that it covers the content-file edits of
 * a generated (source mode) page as well as the page's own fields. This is
 * the copy that brings the words back after signing in again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftRecord, readDraft, draftHolds, pageRecord, savedPage, savedMore, savedSourceWas } from '../src/editor/saved-edits.js';
import { groupSourceEdits } from '../src/editor/source-fields.js';
import { readFailure, whatSurvives, publishEnded } from '../src/editor/sign-in-ended.js';

const NOW = Date.UTC(2026, 9, 6, 12);
const DAY = 24 * 3600 * 1000;
const TITLE = 'src/content/events/service.md#/frontmatter/title';
const WHEN = 'src/content/events/service.md#/frontmatter/date?type=date';

const page = () => new Map([['hero', { html: 'Fresh bread <em>every</em> morning' }], ['cta', { attrs: { href: '/order' } }]]);
const files = () => new Map([[TITLE, { value: 'Harvest service' }], [WHEN, { value: '2026-10-11', type: 'date' }]]);
/** Through the browser's storage and back, as on a page load. */
const stored = (record) => JSON.parse(JSON.stringify(record));

test('saved edits: a page without content-file fields is saved exactly as it always was', () => {
  assert.deepEqual(draftRecord(page(), new Map(), NOW), { ts: NOW, edits: { hero: { html: 'Fresh bread <em>every</em> morning' }, cta: { attrs: { href: '/order' } } } });
  assert.equal(draftRecord(new Map(), new Map(), NOW), null, 'nothing staged, nothing saved');
});

test('saved edits: source mode — edits to content files are saved, alone or beside page edits', () => {
  const only = draftRecord(new Map(), files(), NOW);
  assert.deepEqual(only, { ts: NOW, edits: {}, source: { [TITLE]: { value: 'Harvest service' }, [WHEN]: { value: '2026-10-11', type: 'date' } } });
  const both = draftRecord(page(), files(), NOW);
  assert.deepEqual(Object.keys(both.edits), ['hero', 'cta']);
  assert.deepEqual(Object.keys(both.source), [TITLE, WHEN]);
});

test('saved edits: source mode — what is read back is what was staged, and Publish would send the same edits', () => {
  const back = readDraft(stored(draftRecord(new Map(), files(), NOW)), { now: NOW + 5 * 60 * 1000 });
  assert.equal(back.count, 2);
  assert.deepEqual(back.source, Object.fromEntries(files()));
  const at = { repo: 'acme/site', branch: 'main', adapter: 'astro' };
  assert.deepEqual(groupSourceEdits(new Map(Object.entries(back.source)), at), groupSourceEdits(files(), at));
});

test('saved edits: page edits and content-file edits are counted together and both come back', () => {
  const back = readDraft(stored(draftRecord(page(), files(), NOW)), { now: NOW });
  assert.equal(back.count, 4);
  assert.deepEqual(back.edits, Object.fromEntries(page()));
  assert.deepEqual(Object.keys(back.source), [TITLE, WHEN]);
});

test('saved edits: a content-file edit comes back only to a field that is on the page and can be edited now', () => {
  const record = stored(draftRecord(new Map(), files(), NOW));
  const back = readDraft(record, { now: NOW, known: (ref) => ref === TITLE });
  assert.deepEqual(back.source, { [TITLE]: { value: 'Harvest service' } });
  assert.equal(back.count, 1);
  assert.equal(readDraft(record, { now: NOW, known: () => false }), null, 'none of them is there: nothing to offer');
});

test('saved edits: a copy older than a week, an empty one or an unreadable one offers nothing', () => {
  const record = stored(draftRecord(page(), files(), NOW));
  assert.ok(readDraft(record, { now: NOW + 7 * DAY }));
  assert.equal(readDraft(record, { now: NOW + 7 * DAY + 1 }), null);
  assert.equal(readDraft({ ts: NOW, edits: {} }, { now: NOW }), null);
  assert.equal(readDraft({ ts: NOW }, { now: NOW }), null);
  assert.equal(readDraft(null, { now: NOW }), null);
  assert.equal(readDraft('nonsense', { now: NOW }), null);
  // a value that is not text is never staged
  assert.equal(readDraft({ ts: NOW, edits: {}, source: { [TITLE]: { value: { html: '<b>x</b>' } }, [WHEN]: null } }, { now: NOW }), null);
});

test('saved edits: a copy written before source mode was saved is read as before', () => {
  const old = { ts: NOW, edits: { hero: { html: 'Fresh bread' } } };
  assert.deepEqual(readDraft(old, { now: NOW }), { edits: { hero: { html: 'Fresh bread' } }, source: {}, count: 1 });
});

test('saved edits: "it is saved" is said only when the copy read back holds exactly what is staged', () => {
  const record = stored(draftRecord(page(), files(), NOW));
  assert.equal(draftHolds(record, page(), files()), true);
  // one more word typed since the copy was written (the browser refused the newer write)
  const newer = page(); newer.set('hero', { html: 'Fresh bread every morning, and rolls' });
  assert.equal(draftHolds(record, newer, files()), false);
  const moreFiles = files(); moreFiles.set(TITLE, { value: 'Harvest service at ten' });
  assert.equal(draftHolds(record, page(), moreFiles), false);
  assert.equal(draftHolds(stored(draftRecord(page(), new Map(), NOW)), page(), files()), false, 'a copy without the content-file edits does not hold them');
  assert.equal(draftHolds(null, page(), files()), false);
  assert.equal(draftHolds(stored(draftRecord(page(), new Map(), NOW)), page(), new Map()), true);
});

test('source mode, sign-in ended: the worker\'s 401 to a source commit is an ended sign-in, and the saved content-file edits survive it', () => {
  // POST /source/commit says this to a session it no longer has.
  const f = readFailure({ status: 401, data: { error: 'unauthorized' } });
  assert.equal(f.kind, 'ended');
  const pendingSource = files();
  const counts = { edits: 0, source: pendingSource.size, structural: 0, files: 0 };
  const saved = draftHolds(stored(draftRecord(new Map(), pendingSource, NOW)), new Map(), pendingSource);
  const d = publishEnded({ way: 'google', counts, survives: whatSurvives(counts, { saved }) });
  assert.equal(d.text, 'Nothing was published. Your 2 edits are saved in this browser and will be back on this page when you have signed in again with Google.');
  assert.equal(d.signIn, true);
  assert.equal(d.copy, false);
});

// ─── What lets a page's edits be published without the page open ─────────────

const SHA = '3b18e512dba79e4c8300dd08aeb37f8e728b8dad';
const LIST = '<li data-cms="menu_1">Rye</li><li data-cms="menu_2">Wheat</li>';
/** What the open page knows, as main.js pageFacts hands it over. */
const facts = () => ({
  page: { path: 'de/about.html', url: '/de/about', title: 'About us', sha: SHA },
  more: {
    hero: { was: 'Fresh bread', shared: true },
    cta: {},
    menu: { was: LIST, base: LIST },
  },
  sourceWas: { [TITLE]: 'Service', [WHEN]: '2026-10-04' },
});
const withList = () => new Map([...page(), ['menu', { html: LIST + '<li data-cms="menu_3">Spelt</li>' }]]);

test('saved edits: the page facts go beside the edits and never inside them', () => {
  const plain = draftRecord(withList(), files(), NOW, null, 5);
  const whole = pageRecord(plain, facts());
  assert.deepEqual(Object.keys(whole), ['ts', 'edits', 'source', 'n', 'page', 'more', 'sourceWas']);
  for (const k of ['ts', 'edits', 'source', 'n']) assert.equal(whole[k], plain[k], `${k} is the same object, untouched`);
  assert.deepEqual(plain, draftRecord(withList(), files(), NOW, null, 5), 'the record handed in is not changed');
  assert.deepEqual(whole.page, { path: 'de/about.html', url: '/de/about', title: 'About us', sha: SHA });
  assert.deepEqual(whole.more, { hero: { was: 'Fresh bread', shared: true }, menu: { was: LIST, base: LIST } }, 'an edit with nothing beside it is left out');
  assert.deepEqual(whole.sourceWas, { [TITLE]: 'Service', [WHEN]: '2026-10-04' });
});

test('saved edits: with nothing known of the page, the copy is written exactly as it always was', () => {
  const plain = draftRecord(page(), files(), NOW);
  for (const nothing of [undefined, {}, { page: null, more: null, sourceWas: null }, { page: { title: 'No file named' }, more: { hero: {} }, sourceWas: {} }]) {
    assert.equal(JSON.stringify(pageRecord(plain, nothing)), JSON.stringify(plain));
  }
  assert.equal(pageRecord(null, facts()), null, 'nothing staged, nothing saved');
  // only something that was being typed into a panel: there is no edit for a set to publish
  const typed = draftRecord(new Map(), new Map(), NOW, { where: 'note', text: 'Autumn menu' });
  assert.equal(pageRecord(typed, facts()), typed);
});

test('saved edits: an old copy still reads the same, and a new copy is offered back exactly as an old one', () => {
  const old = stored(draftRecord(page(), files(), NOW, null, 4));
  const now = stored(pageRecord(draftRecord(page(), files(), NOW, null, 4), facts()));
  assert.ok(now.page && now.more && now.sourceWas, 'the new copy does hold the additions');
  for (const opts of [{ now: NOW }, { now: NOW + 7 * DAY }, { now: NOW + 7 * DAY + 1 }, { now: NOW, known: (ref) => ref === TITLE }, { now: NOW, known: () => false }]) {
    assert.deepEqual(readDraft(now, opts), readDraft(old, opts));
  }
  assert.deepEqual(readDraft(old, { now: NOW }), { edits: Object.fromEntries(page()), source: Object.fromEntries(files()), count: 4 });
  // and an old copy says nothing of its page, which is not an error
  assert.equal(savedPage(old), null);
  assert.deepEqual(savedMore(old), {});
  assert.deepEqual(savedSourceWas(old), {});
});

test('saved edits: a copy is offered back for a week unless a longer time is said', () => {
  const record = stored(pageRecord(draftRecord(page(), files(), NOW), facts()));
  assert.equal(readDraft(record, { now: NOW + 8 * DAY }), null);
  assert.ok(readDraft(record, { now: NOW + 8 * DAY, keep: 30 * DAY }));
  assert.equal(readDraft(record, { now: NOW + 30 * DAY + 1, keep: 30 * DAY }), null);
  for (const keep of [0, -1, NaN, 'forever', null]) assert.equal(readDraft(record, { now: NOW + 7 * DAY + 1, keep }), null, `keep ${keep} is read as a week`);
});

test('saved edits: the additions never change what "it is saved" means', () => {
  const plain = stored(draftRecord(page(), files(), NOW));
  const whole = stored(pageRecord(draftRecord(page(), files(), NOW), facts()));
  const newer = page(); newer.set('hero', { html: 'Fresh bread every morning, and rolls' });
  const moreFiles = files(); moreFiles.set(TITLE, { value: 'Harvest service at ten' });
  const typed = { where: 'note', text: 'Autumn menu' };
  for (const [pending, source, t] of [[page(), files(), null], [newer, files(), null], [page(), moreFiles, null], [page(), new Map(), null], [new Map(), new Map(), null], [page(), files(), typed]]) {
    assert.equal(draftHolds(whole, pending, source, t), draftHolds(plain, pending, source, t));
  }
  assert.equal(draftHolds(whole, page(), files()), true);
  // additions that were tampered with, or that say something else than the page does, change nothing either
  for (const tampered of [{ page: 'x', more: [1], sourceWas: 7 }, { more: { hero: { was: 'Other words' } } }, { edits2: {}, page: { path: '../x' } }]) {
    assert.equal(draftHolds({ ...whole, ...tampered }, page(), files()), true);
    assert.equal(draftHolds({ ...whole, ...tampered }, newer, files()), false);
  }
});

test('saved edits: page facts that were tampered with are ignored', () => {
  const read = (p) => savedPage({ ts: NOW, edits: {}, page: p });
  assert.deepEqual(read({ path: 'about.html', url: '/about', title: '  About us ', sha: SHA }), { path: 'about.html', url: '/about', title: 'About us', sha: SHA });
  // not a page at all, or one that names no file in the repository
  for (const p of [null, 'about.html', ['about.html'], 7, {}, { path: '' }, { path: 7 }, { path: '/about.html' }, { path: '../secrets.html' }, { path: 'a/../../b.html' },
    { path: 'a//b.html' }, { path: './a.html' }, { path: 'a\\b.html' }, { path: 'a\nb.html' }, { path: 'a/' }, { path: 'x'.repeat(1025) }]) {
    assert.equal(read(p), null, JSON.stringify(p));
  }
  // an address that would lead off the site, or run something, is not kept; the rest is
  for (const url of ['https://elsewhere.example/about', '//elsewhere.example/about', 'javascript:alert(1)', 'about', '/\\elsewhere.example', '/a\tb', '', 7, null, ['/about'], '/' + 'x'.repeat(2048)]) {
    assert.deepEqual(read({ path: 'about.html', url, title: 'About us' }), { path: 'about.html', title: 'About us' }, JSON.stringify(url));
  }
  // a title is text of a sensible length, a version is git's name for a file's text
  assert.deepEqual(read({ path: 'about.html', title: { toString: () => 'x' }, sha: 'main' }), { path: 'about.html' });
  assert.deepEqual(read({ path: 'about.html', title: '   ', sha: SHA.toUpperCase() }), { path: 'about.html' });
  assert.equal(read({ path: 'about.html', title: 'x'.repeat(5000) }).title.length, 300);
  assert.equal(read({ path: 'about.html', sha: 'a'.repeat(64) }).sha, 'a'.repeat(64));
  assert.equal(savedPage(null), null);
  assert.equal(savedPage('nonsense'), null);
});

test('saved edits: what is kept beside an edit is read only for an edit the copy holds, and only when it is of the right kind', () => {
  const edits = { hero: { html: 'Fresh bread' }, cta: { attrs: { href: '/order' } }, menu: { html: LIST } };
  const read = (more) => savedMore(stored({ ts: NOW, edits, more }));
  assert.deepEqual(read({ hero: { was: 'Bread', shared: true }, menu: { was: LIST, base: LIST } }), { hero: { was: 'Bread', shared: true }, menu: { was: LIST, base: LIST } });
  // an edit the copy does not hold gets nothing, whatever is said of it
  assert.deepEqual(read({ footer: { was: 'x', shared: true }, constructor: { was: 'x' }, toString: { was: 'x' } }), {});
  // the wrong kind of thing
  for (const more of [null, 'x', 7, [{ was: 'x' }], { hero: 'x' }, { hero: ['x'] }, { hero: null }, { hero: { was: 7, base: {}, shared: 'yes' } }, { hero: { was: null, shared: 1 } }]) {
    assert.deepEqual(read(more), {}, JSON.stringify(more));
  }
  // a list's "before" belongs beside an edit that holds HTML, and nowhere else
  assert.deepEqual(read({ cta: { base: LIST, was: 'Order' } }), { cta: { was: 'Order' } });
  // names that are special to an object are read as plain names and change nothing else
  const odd = JSON.parse('{"ts":1,"edits":{"__proto__":{"html":"x"},"hero":{"html":"y"}},"more":{"__proto__":{"was":"w","shared":true},"hero":{"was":"h"}}}');
  const got = savedMore(odd);
  assert.deepEqual(Object.keys(got).sort(), ['__proto__', 'hero']);
  assert.equal(Object.getPrototypeOf(got), Object.prototype);
  assert.equal({}.shared, undefined);
  assert.deepEqual(savedMore({ ts: NOW, more: { hero: { was: 'x' } } }), {}, 'no edits, nothing beside them');
  assert.deepEqual(savedMore(null), {});
});

test('saved edits: what a content-file field held is read only for a field the copy edits, and only as a value a field can hold', () => {
  const source = Object.fromEntries(files());
  const read = (sourceWas) => savedSourceWas(stored({ ts: NOW, edits: {}, source, sourceWas }));
  assert.deepEqual(read({ [TITLE]: 'Service', [WHEN]: '2026-10-04' }), { [TITLE]: 'Service', [WHEN]: '2026-10-04' });
  assert.deepEqual(read({ [TITLE]: '', [WHEN]: false }), { [TITLE]: '', [WHEN]: false }, 'an empty text and a "no" are values');
  assert.deepEqual(read({ [TITLE]: 12, [WHEN]: ['a', 'b'] }), { [TITLE]: 12, [WHEN]: ['a', 'b'] });
  assert.deepEqual(read({ 'src/content/other.md#/frontmatter/title': 'x' }), {}, 'a field the copy does not edit');
  for (const sourceWas of [null, 'x', ['x'], { [TITLE]: null }, { [TITLE]: { value: 'x' } }, { [TITLE]: [['x']] }, { [TITLE]: [{}] }]) assert.deepEqual(read(sourceWas), {}, JSON.stringify(sourceWas));
  assert.deepEqual(savedSourceWas({ ts: NOW, edits: {}, sourceWas: { [TITLE]: 'x' } }), {}, 'no content-file edits, nothing known of them');
});

test('saved edits: what is written beside the edits is what would be read back, so a wrong fact is never stored', () => {
  const plain = draftRecord(page(), files(), NOW);
  const whole = pageRecord(plain, {
    page: { path: 'about.html', url: 'javascript:alert(1)', title: 7, sha: null },
    more: { hero: { was: 'Bread', base: 9, shared: 'yes' }, footer: { was: 'x' } },
    sourceWas: { [TITLE]: undefined, [WHEN]: { no: 1 } },
  });
  assert.deepEqual(whole.page, { path: 'about.html' });
  assert.deepEqual(whole.more, { hero: { was: 'Bread' } });
  assert.equal('sourceWas' in whole, false);
  const back = stored(whole);
  assert.deepEqual(savedPage(back), whole.page);
  assert.deepEqual(savedMore(back), whole.more);
  // a record that already carried facts of another page loses them: only what is handed in is written
  assert.equal(JSON.stringify(pageRecord({ ...plain, page: { path: 'other.html' }, more: { hero: { was: 'Old' } }, sourceWas: { [TITLE]: 'Old' } }, {})), JSON.stringify(plain));
});
