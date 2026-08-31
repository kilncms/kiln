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

test('kilnSource stamps the real attribute with path#pointer', () => {
  assert.deepEqual(kilnSource(layerEntry, 'title'),
    { [SOURCE_ATTR]: 'src/content/events/service.md#/frontmatter/title' });
});

test('legacy entries derive src/content/<collection>/<id>; extensionless ids get .md', () => {
  assert.deepEqual(kilnSource(legacyEntry, 'title'),
    { [SOURCE_ATTR]: 'src/content/events/service.md#/frontmatter/title' });
  assert.deepEqual(kilnSource({ id: 'service', collection: 'events' }, 'title'),
    { [SOURCE_ATTR]: 'src/content/events/service.md#/frontmatter/title' });
  assert.deepEqual(kilnSource({ id: 'deep-dive.mdx', collection: 'guides' }, 'title'),
    { [SOURCE_ATTR]: 'src/content/guides/deep-dive.mdx#/frontmatter/title' });
});

test('opts.type appends the ?type= hint; junk types are dropped', () => {
  assert.equal(kilnSource(layerEntry, 'date', { type: 'date' })[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/date?type=date');
  assert.equal(kilnSource(layerEntry, 'date', { type: 'DATE!' })[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/date');
});

test('nested fields via array segments; RFC 6901 escaping applied per segment', () => {
  assert.equal(kilnSource(layerEntry, ['venue', 'name'])[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/venue/name');
  assert.equal(kilnSource(layerEntry, ['tags', 0])[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/tags/0');
  assert.equal(kilnSource(layerEntry, 'a/b~c')[SOURCE_ATTR],
    'src/content/events/service.md#/frontmatter/a~1b~0c');
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
    assert.deepEqual(kilnBody(layerEntry), {});
    process.env.KILN_DISABLE = '0';
    assert.ok(kilnSource(layerEntry, 'title')[SOURCE_ATTR]);
  } finally {
    if (prev === undefined) delete process.env.KILN_DISABLE;
    else process.env.KILN_DISABLE = prev;
  }
});

test('default export is a documented no-op integration that announces once', () => {
  const integration = kiln();
  assert.equal(integration.name, '@kilncms/astro');
  const hook = integration.hooks['astro:config:setup'];
  assert.equal(typeof hook, 'function');
  const lines = [];
  hook({ logger: { info: (m) => lines.push(m) } });
  hook({ logger: { info: (m) => lines.push(m) } });   // second call: silent
  assert.equal(lines.length, 1);
  assert.match(lines[0], /kilnSource\(\)\/kilnBody\(\) helpers/);
  assert.match(lines[0], /automatic stamping and schema export land later/);
  assert.doesNotThrow(() => kiln().hooks['astro:config:setup'](undefined));
});
