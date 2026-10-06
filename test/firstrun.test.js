/**
 * src/editor/firstrun.js — the pure pieces behind the first minute of editing:
 * the Publish button's label, the commit message, which guide step shows,
 * the before/after snippet, and where a tip goes. The parts that need a real
 * browser are checked by scripts/ui-check.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishLabel, editCommitMessage, guideStep, diffSnippet, placeTip, sideForHeading, initGuide, guideSync, guidePublished } from '../src/editor/firstrun.js';

test('publishLabel: says how many edits will go out', () => {
  assert.equal(publishLabel(0), 'Publish');                 // an upload with no field edit still publishes
  assert.equal(publishLabel(1), 'Publish 1 edit');
  assert.equal(publishLabel(3), 'Publish 3 edits');
  assert.equal(publishLabel(12), 'Publish 12 edits');
  for (const n of [0, 1, 2, 40]) assert.ok(publishLabel(n).startsWith('Publish'), 'the accessible name starts with "Publish"');
});

test('publishLabel: a suggest-mode editor proposes, and the label says so', () => {
  assert.equal(publishLabel(2, { suggest: true }), 'Suggest changes');
  assert.equal(publishLabel(0, { suggest: true }), 'Suggest changes');
  assert.equal(publishLabel(1, { suggest: false }), 'Publish 1 edit');
});

test('editCommitMessage: the message a page publish has always had', () => {
  assert.equal(editCommitMessage('index.html', ['hero_headline']), 'Edit index.html: hero_headline (via Kiln)');
  assert.equal(editCommitMessage('blog/post.html', ['post_title', 'post_body', '+gallery_1']),
    'Edit blog/post.html: post_title, post_body, +gallery_1 (via Kiln)');
  // A field with both a text and a link change is named once per change, as before.
  assert.equal(editCommitMessage('about.html', ['cta', 'cta']), 'Edit about.html: cta, cta (via Kiln)');
});

test('guideStep: follows the page — edit, then publish, then what happened', () => {
  assert.equal(guideStep({ unpublished: 0 }), 1);
  assert.equal(guideStep({ unpublished: 1 }), 2);
  assert.equal(guideStep({ unpublished: 4 }), 2);
  assert.equal(guideStep({ unpublished: 0, published: true }), 3);
  assert.equal(guideStep({ unpublished: 2, published: true }), 3);
  // Undoing the only edit steps back: there is nothing to publish yet.
  assert.equal(guideStep({ unpublished: 0, published: false }), 1);
  assert.equal(guideStep(), 1);
});

test('guideStep: skipped or finished means nothing more is shown', () => {
  assert.equal(guideStep({ done: true, unpublished: 0 }), 0);
  assert.equal(guideStep({ done: true, unpublished: 3 }), 0);
  assert.equal(guideStep({ done: true, published: true }), 0);
});

test('diffSnippet: short texts come back whole, whitespace tidied', () => {
  assert.deepEqual(diffSnippet('Soft shirts.\nStrong opinions.', 'Soft shirts.\n  Strong opinions. Hello'),
    { before: 'Soft shirts. Strong opinions.', after: 'Soft shirts. Strong opinions. Hello' });
  assert.deepEqual(diffSnippet('', 'New'), { before: '', after: 'New' });
  assert.deepEqual(diffSnippet(undefined, null), { before: '', after: '' });
});

test('diffSnippet: in a long text, only the part that changed is kept, on whole words', () => {
  const cards = Array.from({ length: 28 }, (_, i) => `Shirt number ${i + 1} A quiet argument made in thread $26.99`).join(' ');
  const edited = cards.replace('Shirt number 14 A quiet', 'Shirt number 14 A very loud');
  const d = diffSnippet(cards, edited);
  assert.ok(d.before.length <= 92 && d.after.length <= 92, `${d.before.length}/${d.after.length}`);
  assert.match(d.before, /A quiet argument/);
  assert.match(d.after, /A very loud argument/);
  assert.ok(d.before.startsWith('…') && d.after.startsWith('…'), 'marks that text was left out before');
  assert.ok(d.before.endsWith('…') && d.after.endsWith('…'), 'and after');
  // Whole words at both ends: nothing is cut mid-word.
  for (const side of [d.before, d.after]) {
    const inner = side.replace(/^…|…$/g, '');
    assert.ok(cards.includes(inner.trim().split(' ')[0]) && !/^\S*number1/.test(inner));
    assert.equal(inner, inner.trim());
  }
  assert.notEqual(d.before, d.after);
});

test('diffSnippet: a change at the very start or end of a long text', () => {
  const long = 'word '.repeat(60).trim();
  const end = diffSnippet(long, `${long} Hello`);
  assert.match(end.after, /word Hello$/);
  assert.ok(end.before.startsWith('…') && !end.after.endsWith('…'));
  const start = diffSnippet(long, `Hello ${long}`);
  assert.match(start.after, /^Hello word/);
  assert.ok(start.after.endsWith('…') && !start.after.startsWith('…'));
});

test('diffSnippet: a very long new passage is cut off, not shown in full', () => {
  const long = 'intro '.repeat(40).trim();
  const d = diffSnippet(long, `${long} ${'added '.repeat(80).trim()}`, 60);
  assert.ok(d.after.length <= 62, String(d.after.length));
  assert.ok(d.after.endsWith('…'));
});

const VIEW = { left: 0, top: 0, width: 390, height: 844 };

test('placeTip: under the target and centred on it, when there is room', () => {
  const p = placeTip({ left: 100, top: 200, width: 120, height: 40 }, { width: 160, height: 36 }, VIEW);
  assert.deepEqual(p, { left: 80, top: 252, side: 'below', arrow: 80 });
});

test('placeTip: never leaves the view — nudged in by the margin, arrow still on the target', () => {
  // A wide heading starting at the left edge of a phone.
  const left = placeTip({ left: 14, top: 500, width: 60, height: 40 }, { width: 200, height: 36 }, VIEW);
  assert.equal(left.left, 8);
  assert.equal(left.arrow, 44 - 8);             // the target's centre (x=44), measured from the tip's edge
  // A button in the bottom-right corner (the Publish button).
  const right = placeTip({ left: 250, top: 720, width: 126, height: 44 }, { width: 190, height: 38 }, VIEW, { prefer: 'above' });
  assert.equal(right.left + 190, 390 - 8);
  assert.equal(right.side, 'above');
  assert.equal(right.top, 720 - 12 - 38);
  assert.ok(right.arrow >= 18 && right.arrow <= 190 - 18);
  // The arrow stays on the tip's rounded body even when the target's centre is beyond it.
  const far = placeTip({ left: 380, top: 400, width: 8, height: 8 }, { width: 120, height: 30 }, VIEW);
  assert.equal(far.arrow, 120 - 18);
});

test('placeTip: flips to the side that has room', () => {
  const low = placeTip({ left: 100, top: 800, width: 100, height: 30 }, { width: 150, height: 36 }, VIEW);
  assert.equal(low.side, 'above');
  const high = placeTip({ left: 100, top: 10, width: 100, height: 30 }, { width: 150, height: 36 }, VIEW, { prefer: 'above' });
  assert.equal(high.side, 'below');
  // No room either way: stay on the preferred side rather than jump around.
  const tall = placeTip({ left: 0, top: 10, width: 100, height: 830 }, { width: 150, height: 36 }, VIEW, { prefer: 'above' });
  assert.equal(tall.side, 'above');
});

test('placeTip: a tip wider than the view is pinned to the left margin, not pushed off-screen', () => {
  const p = placeTip({ left: 100, top: 100, width: 50, height: 20 }, { width: 500, height: 30 }, VIEW);
  assert.equal(p.left, 8);
});

test('sideForHeading: under the heading, unless that lands in the strip the pencil and the banner use', () => {
  // A phone: the heading sits mid-screen, the tip goes under it.
  assert.equal(sideForHeading(510, 90, 40, 844), 'below');
  // A laptop: the heading ends near the bottom of the screen, where the banner is.
  assert.equal(sideForHeading(650, 158, 38, 900), 'above');
  // Just clear of the strip is still "below"; one pixel into it is not.
  assert.equal(sideForHeading(200, 100, 40, 448), 'below');      // 200+100+12+40 = 352 ≤ 448-96
  assert.equal(sideForHeading(200, 100, 40, 447), 'above');      // 352 > 447-96 = 351
  // A heading right under the top of the page has no room above: stay below.
  assert.equal(sideForHeading(20, 700, 40, 760), 'below');
});

test('the demo guide never starts outside sandbox mode', () => {
  // No `document` exists in this test: reaching for the page would throw. On a
  // real site initGuide must return before touching anything.
  assert.equal(typeof globalThis.document, 'undefined');
  for (const cfg of [{}, { sandbox: false }, { sandbox: 'yes' }, { sandbox: 1 }, { repo: 'a/b', worker: 'https://w' }]) {
    assert.doesNotThrow(() => initGuide({ cfg, mobileMq: '(max-width: 700px)', unpublished: () => 0, publishButton: () => null }));
  }
  assert.doesNotThrow(() => initGuide(undefined));
  assert.doesNotThrow(() => initGuide({}));
  // …and with no guide running, the hooks main.js calls are no-ops.
  assert.doesNotThrow(() => guideSync());
  assert.doesNotThrow(() => guidePublished({ before: 'a', after: 'b', message: 'm' }));
});
