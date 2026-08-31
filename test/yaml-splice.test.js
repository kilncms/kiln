import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyYamlEdits, locateValue, readValue, serializeScalar, validateYaml } from '../src/adapters/yaml-splice.js';

// §8.3 acceptance fixture: comments, blank lines, mixed quote styles, trailing
// comment on the edited line. Everything but the edited value must round-trip
// byte-identical.
const SRC = `# Event details — keep this comment
title: Interfaith Worship Service   # the public name
date: 2026-09-20
start: '18:00'

tags:
  - faith
  - 'memory'
venue:
  name: "Big Bethel AME"
  city: Atlanta
count: 3
published: true
desc: |
  Line one
  Line two
empty:
`;

test('plain scalar edit is byte-identical except the value (§8.3)', () => {
  const r = applyYamlEdits(SRC, [{ key: 't', segs: ['title'], value: 'Evening Worship Service' }]);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.applied, ['t']);
  assert.equal(r.text, SRC.replace('Interfaith Worship Service', 'Evening Worship Service'));
});

test('trailing comment on the edited line survives', () => {
  const r = applyYamlEdits(SRC, [{ key: 't', segs: ['title'], value: 'X' }]);
  assert.match(r.text, /title: X   # the public name\n/);
});

test('nested map value keeps its double-quoted style', () => {
  const r = applyYamlEdits(SRC, [{ key: 'v', segs: ['venue', 'name'], value: 'Ebenezer Baptist' }]);
  assert.deepEqual(r.applied, ['v']);
  assert.ok(r.text.includes('name: "Ebenezer Baptist"'));
  assert.ok(r.text.includes('# the public name'));
  assert.ok(r.text.includes("- 'memory'"));
});

test('sequence element by index; quoted style preserved', () => {
  const r = applyYamlEdits(SRC, [{ key: 'a', segs: ['tags', '1'], value: 'remembrance' }]);
  assert.deepEqual(r.applied, ['a']);
  assert.ok(r.text.includes('- "remembrance"'), r.text.match(/tags:[\s\S]*?venue/)[0]);
  assert.ok(r.text.includes('- faith'));
});

test('bad pointer among good ones: good applies, bad reported (§8.1)', () => {
  const r = applyYamlEdits(SRC, [
    { key: 'good', segs: ['count'], value: '4', type: 'number' },
    { key: 'bad', segs: ['nope'], value: 'x' },
  ]);
  assert.deepEqual(r.applied, ['good']);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].key, 'bad');
  assert.match(r.skipped[0].reason, /pointer not found/);
  assert.ok(r.text.includes('count: 4'));
});

test('empty value gets filled in place', () => {
  const r = applyYamlEdits(SRC, [{ key: 'e', segs: ['empty'], value: 'filled now' }]);
  assert.deepEqual(r.applied, ['e']);
  assert.ok(r.text.includes('empty: filled now\n'));
});

test('newline smuggling cannot create new keys', () => {
  const r = applyYamlEdits(SRC, [{ key: 'inj', segs: ['title'], value: 'x\nevil: true' }]);
  assert.deepEqual(r.applied, ['inj']);
  assert.ok(!/^evil:/m.test(r.text));
  assert.ok(r.text.includes('title: "x\\nevil: true"'));
});

test('YAML-literal lookalikes get quoted so the type cannot silently change', () => {
  for (const v of ['true', 'no', '3.14', '2026-01-01', 'null']) {
    const r = applyYamlEdits(SRC, [{ key: 'q', segs: ['title'], value: v }]);
    assert.ok(r.text.includes(`title: ${JSON.stringify(v)}`), `${v} should be quoted`);
  }
});

test('scalar edit aimed at a map is a type mismatch, not a write', () => {
  const r = applyYamlEdits(SRC, [{ key: 'm', segs: ['venue'], value: 'x' }]);
  assert.deepEqual(r.applied, []);
  assert.match(r.skipped[0].reason, /type mismatch/);
  assert.equal(r.text, SRC); // untouched
});

test('a file that does not parse is never written (§8.1)', () => {
  const r = applyYamlEdits('title: [unclosed', [{ key: 'x', segs: ['title'], value: 'y' }]);
  assert.equal(r.text, null);
  assert.match(r.skipped[0].reason, /not valid YAML/);
});

test('block scalar replacement swaps the whole value safely', () => {
  const r = applyYamlEdits(SRC, [{ key: 'd', segs: ['desc'], value: 'One line now' }]);
  assert.deepEqual(r.applied, ['d']);
  assert.ok(r.text.includes('desc: "One line now"') || r.text.includes('desc: One line now'));
  assert.ok(!r.text.includes('Line one'));
  assert.equal(validateYaml(r.text), null);
});

test('typed date/time values emit bare ISO; junk is refused', () => {
  const r = applyYamlEdits(SRC, [
    { key: 'd', segs: ['date'], value: '2026-10-01', type: 'date' },
    { key: 's', segs: ['start'], value: '19:30', type: 'time' },
  ]);
  assert.deepEqual(r.applied.sort(), ['d', 's']);
  assert.ok(r.text.includes('date: 2026-10-01'));
  assert.equal(serializeScalar('not a date\n', { type: 'date' }), null);
});

test('aliases are refused, and alias bombs cannot expand during editing', () => {
  const bomb = 'a: &a ["x","x","x"]\nb: &b [*a,*a,*a]\nc: &c [*b,*b,*b]\ntitle: *c\n';
  const loc = locateValue(bomb, ['title']);
  assert.match(loc.error, /alias/);
  const r = applyYamlEdits(bomb, [{ key: 'x', segs: ['title'], value: 'y' }]);
  assert.deepEqual(r.applied, []);
});

test('duplicate pointers in one batch: first wins, second reported', () => {
  const r = applyYamlEdits(SRC, [
    { key: 'one', segs: ['title'], value: 'A' },
    { key: 'two', segs: ['title'], value: 'B' },
  ]);
  assert.deepEqual(r.applied, ['one']);
  assert.equal(r.skipped[0].key, 'two');
});

test('readValue resolves nested values and sequence indexes', () => {
  assert.equal(readValue(SRC, ['venue', 'name']), 'Big Bethel AME');
  assert.equal(readValue(SRC, ['tags', '0']), 'faith');
  assert.equal(readValue(SRC, ['missing']), undefined);
});

test('flow map and flow sequence values are editable', () => {
  const flow = 'meta: { a: 1, b: two }\nlist: [x, y, z]\n';
  let r = applyYamlEdits(flow, [{ key: 'm', segs: ['meta', 'b'], value: 'three' }]);
  assert.deepEqual(r.applied, ['m'], JSON.stringify(r.skipped));
  assert.ok(r.text.includes('b: three'));
  r = applyYamlEdits(flow, [{ key: 'l', segs: ['list', '2'], value: 'w' }]);
  assert.deepEqual(r.applied, ['l'], JSON.stringify(r.skipped));
  assert.ok(r.text.includes('[x, y, w]'));
});
