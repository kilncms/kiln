/**
 * @kilncms/astro helper tests (SOURCE-MODE-SPEC §16.1, explicit-helper v1).
 * Fake entry objects only — the helpers must work without Astro installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import kiln, { kilnSource, kilnBody } from '../integrations/astro/index.mjs';
import { parseSourceRef, SOURCE_ATTR } from '../src/adapters/pointer.js';

const layerEntry = {   // Astro 5 content layer: filePath is root-relative
  id: 'service', collection: 'events',
  filePath: 'src/content/events/service.md',
  data: { title: 'Interfaith Worship Service' },
};
const legacyEntry = {  // legacy collections: id carries the extension
  id: 'service.md', collection: 'events',
  data: { title: 'Interfaith Worship Service' },
};

test('kilnSource stamps the real attribute with path#pointer, and the collection whose schema holds it', () => {
  assert.deepEqual(kilnSource(layerEntry, 'title'),
    { [SOURCE_ATTR]: 'src/content/events/service.md#/frontmatter/title?c=events' });
  assert.deepEqual(kilnSource({ ...layerEntry, collection: 'bad name' }, 'title'),
    { [SOURCE_ATTR]: 'src/content/events/service.md#/frontmatter/title' });
});

test('legacy entries derive src/content/<collection>/<id>; extensionless ids get .md', () => {
  assert.deepEqual(kilnSource(legacyEntry, 'title'),
    { [SOURCE_ATTR]: 'src/content/events/service.md#/frontmatter/title?c=events' });
  assert.deepEqual(kilnSource({ id: 'service', collection: 'events' }, 'title'),
    { [SOURCE_ATTR]: 'src/content/events/service.md#/frontmatter/title?c=events' });
  assert.deepEqual(kilnSource({ id: 'deep-dive.mdx', collection: 'guides' }, 'title'),
    { [SOURCE_ATTR]: 'src/content/guides/deep-dive.mdx#/frontmatter/title?c=guides' });
});

test('opts.type appends the ?type= hint; junk types are dropped', () => {
  assert.equal(kilnSource(layerEntry, 'date', { type: 'date' })[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/date?type=date&c=events');
  assert.equal(kilnSource(layerEntry, 'date', { type: 'DATE!' })[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/date?c=events');
});

test('nested fields via array segments; RFC 6901 escaping applied per segment', () => {
  assert.equal(kilnSource(layerEntry, ['venue', 'name'])[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/venue/name?c=events');
  assert.equal(kilnSource(layerEntry, ['tags', 0])[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/tags/0?c=events');
  assert.equal(kilnSource(layerEntry, 'a/b~c')[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/a~1b~0c?c=events');
});

test('kilnBody points at /body', () => {
  assert.deepEqual(kilnBody(layerEntry),
    { [SOURCE_ATTR]: 'src/content/events/service.md#/body' });
});

test('every helper output round-trips through parseSourceRef', () => {
  for (const ref of [
    kilnSource(layerEntry, 'title')[SOURCE_ATTR],
    kilnSource(layerEntry, 'start', { type: 'time' })[SOURCE_ATTR],
    kilnSource(layerEntry, ['venue', 'name'])[SOURCE_ATTR],
    kilnSource(layerEntry, 'a/b~c')[SOURCE_ATTR],
    kilnBody(legacyEntry)[SOURCE_ATTR],
  ]) {
    const parsed = parseSourceRef(ref);
    assert.ok(parsed, `must parse: ${ref}`);
    assert.equal(parsed.path, 'src/content/events/service.md');
  }
  assert.deepEqual(parseSourceRef(kilnSource(layerEntry, 'a/b~c')[SOURCE_ATTR]).pointer,
    ['frontmatter', 'a/b~c']);
  assert.equal(parseSourceRef(kilnSource(layerEntry, 'start', { type: 'time' })[SOURCE_ATTR]).type, 'time');
  assert.equal(parseSourceRef(kilnSource(layerEntry, 'start', { type: 'time' })[SOURCE_ATTR]).collection, 'events');
  assert.equal(parseSourceRef(kilnBody(layerEntry)[SOURCE_ATTR]).collection, undefined);
  const pic = kilnSource(layerEntry, 'cover', { type: 'image', alt: 'coverAlt' });
  assert.equal(parseSourceRef(pic['data-kiln-source-alt']).pointer.join('/'), 'frontmatter/coverAlt');
  const link = kilnSource(layerEntry, ['cta', 'label'], { href: ['cta', 'href'] });
  assert.equal(parseSourceRef(link['data-kiln-source-href']).type, 'url');
});

test('a picture names its description field, and a link its address field', () => {
  assert.deepEqual(kilnSource(layerEntry, 'cover', { type: 'image', alt: 'coverAlt' }), {
    [SOURCE_ATTR]: 'src/content/events/service.md#/frontmatter/cover?type=image&c=events',
    'data-kiln-source-alt': 'src/content/events/service.md#/frontmatter/coverAlt?c=events',
  });
  assert.deepEqual(kilnSource(layerEntry, ['cta', 'label'], { href: ['cta', 'href'] }), {
    [SOURCE_ATTR]: 'src/content/events/service.md#/frontmatter/cta/label?c=events',
    'data-kiln-source-href': 'src/content/events/service.md#/frontmatter/cta/href?type=url&c=events',
  });
  // An unusable companion field is left out; the field itself still stands.
  assert.deepEqual(Object.keys(kilnSource(layerEntry, 'cover', { type: 'image', alt: '' })), [SOURCE_ATTR]);
  assert.deepEqual(Object.keys(kilnSource(layerEntry, 'cover', { type: 'image', alt: [null] })), [SOURCE_ATTR]);
});

test('helpers never throw: unusable entries and fields return {}', () => {
  assert.deepEqual(kilnSource(null, 'title'), {});
  assert.deepEqual(kilnSource({}, 'title'), {});
  assert.deepEqual(kilnSource({ collection: 'events' }, 'title'), {});   // no id
  assert.deepEqual(kilnSource(layerEntry, ''), {});
  assert.deepEqual(kilnSource(layerEntry, []), {});
  assert.deepEqual(kilnSource(layerEntry, [null]), {});
  assert.deepEqual(kilnBody(undefined), {});
  // Absolute filePath with no /src/ segment cannot be made repo-relative safely.
  assert.deepEqual(kilnSource({ filePath: '/etc/passwd' }, 'x'), {});
  // …but a resolvable absolute path recovers the repo-relative tail.
  assert.equal(kilnSource({ filePath: '/home/u/site/src/content/events/service.md' }, 'title')[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/title');
});

test('KILN_DISABLE strips provenance (checked per call, §16.1)', () => {
  const prev = process.env.KILN_DISABLE;
  try {
    process.env.KILN_DISABLE = '1';
    assert.deepEqual(kilnSource(layerEntry, 'title'), {});
    assert.deepEqual(kilnSource(layerEntry, 'cover', { type: 'image', alt: 'coverAlt' }), {});
    assert.deepEqual(kilnBody(layerEntry), {});
    process.env.KILN_DISABLE = '0';
    assert.ok(kilnSource(layerEntry, 'title')[SOURCE_ATTR]);
  } finally {
    if (prev === undefined) delete process.env.KILN_DISABLE;
    else process.env.KILN_DISABLE = prev;
  }
});

test('the integration announces itself once', () => {
  const integration = kiln();
  assert.equal(integration.name, '@kilncms/astro');
  const hook = integration.hooks['astro:config:setup'];
  assert.equal(typeof hook, 'function');
  const lines = [];
  hook({ logger: { info: (m) => lines.push(m) } });
  hook({ logger: { info: (m) => lines.push(m) } });   // second call: silent
  assert.equal(lines.length, 1);
  assert.match(lines[0], /kilnSource\(\)\/kilnBody\(\) helpers/);
  assert.match(lines[0], /kiln-schema\.json/);
  assert.doesNotThrow(() => kiln().hooks['astro:config:setup'](undefined));
});

test('at the end of a build, the collections\' schemas are published as /kiln-schema.json', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const root = mkdtempSync(join(tmpdir(), 'kiln-astro-'));
  try {
    mkdirSync(join(root, '.astro', 'collections'), { recursive: true });
    mkdirSync(join(root, 'dist'));
    const posts = { type: 'object', properties: { title: { type: 'string', maxLength: 80 } }, required: ['title'] };
    writeFileSync(join(root, '.astro', 'collections', 'posts.schema.json'), JSON.stringify(posts));
    writeFileSync(join(root, '.astro', 'collections', 'broken.schema.json'), '{ not json');
    writeFileSync(join(root, '.astro', 'collections', 'notes.txt'), 'x');
    const k = kiln();
    const lines = [];
    const logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
    k.hooks['astro:config:setup']({ config: { root: pathToFileURL(root + '/') }, logger });
    await k.hooks['astro:build:done']({ dir: pathToFileURL(join(root, 'dist') + '/'), logger });
    const out = JSON.parse(readFileSync(join(root, 'dist', 'kiln-schema.json'), 'utf8'));
    assert.deepEqual(out, { version: 1, collections: { posts } });
    // KILN_DISABLE: nothing is published
    rmSync(join(root, 'dist', 'kiln-schema.json'));
    const prev = process.env.KILN_DISABLE;
    process.env.KILN_DISABLE = '1';
    try { await k.hooks['astro:build:done']({ dir: pathToFileURL(join(root, 'dist') + '/'), logger }); }
    finally { if (prev === undefined) delete process.env.KILN_DISABLE; else process.env.KILN_DISABLE = prev; }
    assert.equal(existsSync(join(root, 'dist', 'kiln-schema.json')), false);
    // No schemas (an older Astro, no collections): nothing is written and the build goes on
    const bare = kiln();
    bare.hooks['astro:config:setup']({ config: { root: pathToFileURL(join(root, 'dist') + '/') }, logger });
    await assert.doesNotReject(bare.hooks['astro:build:done']({ dir: pathToFileURL(join(root, 'dist') + '/'), logger }));
    await assert.doesNotReject(kiln().hooks['astro:build:done'](undefined));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('kilnEntry marks the element that shows one entry, with its collection', async () => {
  const { kilnEntry } = await import('../integrations/astro/index.mjs');
  assert.deepEqual(kilnEntry(layerEntry), { 'data-kiln-entry': 'src/content/events/service.md?c=events' });
  assert.deepEqual(kilnEntry(legacyEntry), { 'data-kiln-entry': 'src/content/events/service.md?c=events' });
  assert.deepEqual(kilnEntry(null), {});
  assert.deepEqual(kilnEntry({ filePath: '/etc/passwd' }), {});
  const prev = process.env.KILN_DISABLE;
  process.env.KILN_DISABLE = '1';
  try { assert.deepEqual(kilnEntry(layerEntry), {}); }
  finally { if (prev === undefined) delete process.env.KILN_DISABLE; else process.env.KILN_DISABLE = prev; }
});
