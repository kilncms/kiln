/**
 * Unpublished edits saved in the browser (src/editor/saved-edits.js): what is
 * written, what is offered back, and that it covers the content-file edits of
 * a generated (source mode) page as well as the page's own fields. This is
 * the copy that brings the words back after signing in again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftRecord, readDraft, draftHolds } from '../src/editor/saved-edits.js';
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
