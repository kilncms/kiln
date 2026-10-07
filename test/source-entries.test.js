// Entries on a site Astro builds: a field the file does not have yet, a new
// entry made from the collection's schema, drafts, order, and the worker's
// doors for adding, copying, removing, reading and scheduling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFrontmatterEdits, frontmatterText, validateFrontmatter } from '../src/adapters/frontmatter.js';
import astro from '../src/adapters/astro.js';
import { readFileSync } from 'node:fs';

test('a field the file does not have yet is added when the edit asks for it, and only then', () => {
  const yaml = 'title: Fair # the heading\ndate: 2026-05-02\n';
  const r = applyFrontmatterEdits('yaml', yaml, [
    { key: 'd', segs: ['draft'], value: true, type: 'boolean', add: true },
    { key: 's', segs: ['description'], value: 'A day: stalls, music', add: true },
    { key: 'x', segs: ['nope'], value: 'x' },
  ]);
  assert.equal(r.text, 'title: Fair # the heading\ndate: 2026-05-02\ndraft: true\ndescription: "A day: stalls, music"\n');
  assert.deepEqual(r.applied, ['d', 's']);
  assert.deepEqual(r.skipped, [{ key: 'x', reason: 'pointer not found in source' }]);
  // a field that is there is changed where it is, add or not
  assert.equal(applyFrontmatterEdits('yaml', 'draft: false\ntitle: A\n', [{ key: 'd', segs: ['draft'], value: true, type: 'boolean', add: true }]).text, 'draft: true\ntitle: A\n');
  // only a plain name at the top: never a nested field, never a name that is not one
  const nested = applyFrontmatterEdits('yaml', yaml, [{ key: 'n', segs: ['venue', 'name'], value: 'Hall', add: true }, { key: 'b', segs: ['a b'], value: '1', add: true }]);
  assert.deepEqual(nested.applied, []);
  // no newline at the end of the front matter: one is put before the new line
  assert.equal(applyFrontmatterEdits('yaml', 'title: A', [{ key: 'd', segs: ['draft'], value: true, type: 'boolean', add: true }]).text, 'title: A\ndraft: true\n');
});

test('TOML: a new field goes before the first table; JSON: inside the object', () => {
  const toml = 'title = "Walk" # the heading\n\n[venue]\nname = "Hall"\n';
  const t = applyFrontmatterEdits('toml', toml, [{ key: 'd', segs: ['draft'], value: true, type: 'boolean', add: true }]);
  assert.equal(t.text, 'title = "Walk" # the heading\ndraft = true\n\n[venue]\nname = "Hall"\n');
  assert.equal(validateFrontmatter('toml', t.text), null);
  const json = '{\n  "title": "Walk"\n}';
  const j = applyFrontmatterEdits('json', json, [{ key: 'd', segs: ['order'], value: '3', type: 'number', add: true }]);
  assert.equal(j.text, '{\n  "title": "Walk",\n  "order": 3\n}');
  assert.equal(applyFrontmatterEdits('json', '{}', [{ key: 'd', segs: ['draft'], value: true, type: 'boolean', add: true }]).text, '{\n  "draft": true\n}');
});

test('through the adapter: a draft mark added to an entry that never had one', () => {
  const src = '---\ntitle: Fair\n---\n\nThe text.\n';
  const r = astro.applyEdits(src, [{ pointer: '/frontmatter/draft', value: true, type: 'boolean', key: 'd', add: true }], 'src/content/posts/fair.md');
  assert.deepEqual(r.applied, ['d']);
  assert.equal(r.content, '---\ntitle: Fair\ndraft: true\n---\n\nThe text.\n');
});

test('a new entry\'s front matter, written plainly in the form asked for', () => {
  const fields = { title: 'Autumn walk: the hills', date: '2026-10-20', draft: true, order: 3, tags: ['walks', 'autumn'], summary: '' };
  assert.equal(frontmatterText('yaml', fields), 'title: "Autumn walk: the hills"\ndate: 2026-10-20\ndraft: true\norder: 3\ntags: [walks, autumn]\nsummary: ""\n');
  assert.equal(frontmatterText('toml', fields), 'title = "Autumn walk: the hills"\ndate = 2026-10-20\ndraft = true\norder = 3\ntags = ["walks", "autumn"]\nsummary = ""\n');
  for (const f of ['yaml', 'toml']) assert.equal(validateFrontmatter(f, frontmatterText(f, fields)), null, f);
  // nothing that is not a plain name or a plain value
  assert.equal(frontmatterText('yaml', { 'a b': 'x', ok: 'fine', obj: { a: 1 } }), 'ok: fine\n');
});

test('an entry\'s fields at a glance: the top-level values, the format, the text', () => {
  const src = '---\n# the fair\ntitle: Fair\ndate: 2026-05-02\ndraft: true\norder: 2\ntags: [a, b]\nvenue:\n  name: Hall\n---\n\nThe text.\n';
  assert.deepEqual(astro.fields(src, 'src/content/posts/fair.md'), {
    format: 'yaml', fields: { title: 'Fair', date: '2026-05-02', draft: true, order: 2, tags: ['a', 'b'] }, body: '\nThe text.\n',
  });
  const toml = '+++\ntitle = "Walk"\ndate = 2026-10-20\n[venue]\nname = "Hall"\n+++\nGo.\n';
  const t = astro.fields(toml, 'a.md');
  assert.equal(t.format, 'toml');
  assert.deepEqual(t.fields, { title: 'Walk', date: '2026-10-20' });
  assert.deepEqual(astro.fields('No front matter.\n', 'a.md'), { format: null, fields: {}, body: 'No front matter.\n' });
});

test('a new entry: its front matter, a blank line, its text; it reads back as written', () => {
  const text = astro.newEntry({ title: 'Autumn walk', date: '2026-10-20', draft: true }, 'Meet at nine.');
  assert.equal(text, '---\ntitle: Autumn walk\ndate: 2026-10-20\ndraft: true\n---\n\nMeet at nine.\n');
  assert.equal(astro.validate(text, 'src/content/posts/autumn-walk.md'), null);
  assert.deepEqual(astro.fields(text, 'a.md').fields, { title: 'Autumn walk', date: '2026-10-20', draft: true });
  assert.equal(astro.newEntry({ title: 'Empty' }, ''), '---\ntitle: Empty\n---\n');
});

// ─── What the editor decides before it asks the worker ───────────────────────

import { entrySlug, entryFileName, collectionsOn, entryForm, entryValues, cannotSentence, draftRule, isDraft, orderRule, moveEntry } from '../src/editor/source-entries.js';

const DOC = { version: 1, collections: { posts: {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 80 }, date: { type: 'string', format: 'date-time' }, summary: { type: 'string' },
    draft: { type: 'boolean' }, order: { type: 'integer' }, kind: { type: 'string', enum: ['news', 'event'], default: 'news' },
    venue: { type: 'object', properties: { name: { type: 'string' } } }, tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'date'],
}, events: { type: 'object', properties: { title: { type: 'string' }, venue: { type: 'object' } }, required: ['title', 'venue'] } } };

test('a new entry\'s file name comes from its title and never takes a name that is there', () => {
  assert.equal(entrySlug('Autumn walk: the hills'), 'autumn-walk-the-hills');
  assert.equal(entrySlug('Fête & fair 2027'), 'fete-and-fair-2027');
  assert.equal(entrySlug('!!!'), 'entry');
  const taken = new Set(['src/content/posts/autumn-walk.md', 'src/content/posts/autumn-walk-2.md']);
  assert.equal(entryFileName('Autumn walk', { folder: 'src/content/posts', ext: '.md', taken }), 'src/content/posts/autumn-walk-3.md');
  assert.equal(entryFileName('Spring', { folder: 'src/content/posts', ext: '.mdx' }), 'src/content/posts/spring.mdx');
});

test('the collections a page shows, with the folder each keeps its files in', () => {
  const c = collectionsOn([
    { path: 'src/content/posts/a.md', collection: 'posts' }, { path: 'src/content/posts/2026/b.md', collection: 'posts' },
    { path: 'src/content/posts/c.mdx', collection: 'posts' }, { path: 'src/content/posts/d.md', collection: 'posts' },
    { path: 'src/content/people/sam.md', collection: 'people' }, { path: 'src/content/x.md' },
  ]);
  assert.deepEqual([...c.keys()], ['posts', 'people']);
  assert.equal(c.get('posts').folder, 'src/content/posts');
  assert.equal(c.get('posts').ext, '.md');
  assert.equal(c.get('people').folder, 'src/content/people');
});

test('the new-entry box asks for the title and what the schema requires, as the kinds of values they are', () => {
  const form = entryForm(DOC, 'posts', { skip: ['draft'] });
  assert.deepEqual(form.fields.map(f => [f.name, f.kind, f.required]), [['title', 'text', true], ['date', 'date', true]]);
  assert.equal(form.fields[0].max, 80);
  assert.deepEqual(form.cannot, []);
  // a required group of fields cannot be typed in a box: said instead
  const events = entryForm(DOC, 'events');
  assert.deepEqual(events.cannot, ['venue']);
  assert.match(cannotSentence(events.cannot), /^This collection needs venue for every entry, which can’t be filled in here\./);
  // no schema: a title
  assert.deepEqual(entryForm(null, 'posts').fields.map(f => f.name), ['title']);
});

test('what was typed in the box is checked and becomes the entry\'s values', () => {
  const form = entryForm(DOC, 'posts', { skip: ['draft'] });
  assert.deepEqual(entryValues(form, { title: 'Autumn walk', date: '2026-10-20' }, { doc: DOC, collection: 'posts' }), { fields: { title: 'Autumn walk', date: '2026-10-20' } });
  assert.equal(entryValues(form, { title: '', date: '2026-10-20' }).problem.sentence, 'Title is needed for every entry.');
  assert.equal(entryValues(form, { title: 'A', date: '20 Oct' }).problem.sentence, 'Date needs to be a date written like 2026-09-20.');
  assert.equal(entryValues(form, { title: 'x'.repeat(81), date: '2026-10-20' }, { doc: DOC, collection: 'posts' }).problem.sentence, 'Title: The site takes at most 80 characters here.');
  assert.equal(entryValues(form, { title: 'A', date: '2026-02-30' }).problem.name, 'date');
});

test('drafts by the site\'s own convention, and nothing invented', () => {
  assert.deepEqual(draftRule({ doc: DOC, collection: 'posts' }), { name: 'draft', value: true });
  assert.equal(draftRule({ doc: DOC, collection: 'events' }), null);   // its schema has no draft field
  assert.deepEqual(draftRule({ cfg: { draftField: 'published', draftValue: false } }), { name: 'published', value: false });
  assert.equal(draftRule({}), null);
  assert.deepEqual(draftRule({ seen: ['title', 'draft'] }), { name: 'draft', value: true });   // no schema: the entries have one
  assert.equal(isDraft({ name: 'draft', value: true }, { draft: true }), true);
  assert.equal(isDraft({ name: 'published', value: false }, { published: false }), true);
  assert.equal(isDraft({ name: 'published', value: false }, {}), false);
});

test('order: the field a collection is ordered by, and the values that move an entry', () => {
  assert.equal(orderRule({ doc: DOC, collection: 'posts' }), 'order');
  assert.equal(orderRule({ doc: DOC, collection: 'events' }), null);
  assert.equal(orderRule({ cfg: { orderField: 'rank' } }), 'rank');
  assert.equal(orderRule({ seen: ['weight'] }), 'weight');
  const list = [{ file: 'a', order: 1 }, { file: 'b', order: 2 }, { file: 'c', order: 3 }];
  assert.deepEqual(moveEntry(list, 1, -1), [{ file: 'b', value: 1 }, { file: 'a', value: 2 }]);
  assert.deepEqual(moveEntry(list, 2, 1), []);
  // equal or missing values: numbered again in the new order, only those that change
  assert.deepEqual(moveEntry([{ file: 'a', order: 1 }, { file: 'b', order: 1 }, { file: 'c' }], 2, -1), [{ file: 'c', value: 2 }, { file: 'b', value: 3 }]);
});

test('History says what each version was in words', async () => {
  const { versionWords } = await import('../src/editor/source-entries.js');
  assert.equal(versionWords('Kiln: update src/content/posts/a.md'), 'Changed');
  assert.equal(versionWords('Kiln: add src/content/posts/a.md'), 'Added');
  assert.equal(versionWords('Kiln: remove src/content/posts/a.md'), 'Removed');
  assert.equal(versionWords('Kiln: revert src/content/posts/a.md to abc1234'), 'Went back to an earlier version');
  assert.equal(versionWords('Scheduled publish: src/content/posts/a.md (via Kiln)'), 'Published on a schedule');
  assert.equal(versionWords('New prices for the summer (via Kiln)'), 'New prices for the summer');
  assert.equal(versionWords('Add the spring fair'), 'Add the spring fair');
});

test('the new-entry box from the real fixture\'s schema: title and date, the description limit kept', () => {
  const doc = JSON.parse(readFileSync(new URL('./fixtures/astro-entries/built/kiln-schema.json', import.meta.url), 'utf8'));
  const form = entryForm(doc, 'posts', { skip: ['draft'] });
  assert.deepEqual(form.fields.map(f => [f.name, f.kind]), [['title', 'text'], ['date', 'date']]);
  assert.deepEqual(draftRule({ doc, collection: 'posts' }), { name: 'draft', value: true });
  assert.equal(orderRule({ doc, collection: 'posts' }), 'order');
});
