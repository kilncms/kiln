/**
 * A block's buttons under a site's own bar (src/editor/under-bar.js, and
 * where main.js uses it).
 *
 * A site's header that stays at the top of the screen covers what scrolls
 * under it. Kiln's buttons on a block are stacked above everything on the
 * page, so they showed on top of that header as their block went under it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverBottom, isUnder } from '../src/editor/under-bar.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');

// What is painted at one point near the top of the screen, topmost first.
const kiln = { kiln: true, pinned: null };
const header = (bottom = 64, top = 0) => ({ kiln: false, pinned: { top, bottom, height: bottom - top } });
const content = { kiln: false, pinned: null };

test('bar: the site\'s own bar at the top of the screen covers down to its bottom edge', () => {
  assert.equal(coverBottom([header(64), content], 844), 64);
  // Kiln's own buttons are painted above it: they are looked through
  assert.equal(coverBottom([kiln, kiln, header(56), content], 844), 56);
  // nothing pinned there: the page's own content is on top
  assert.equal(coverBottom([content, content], 844), 0);
  assert.equal(coverBottom([kiln], 844), 0);
  assert.equal(coverBottom([], 844), 0);
  // a pinned thing BEHIND the content (a fixed background) covers nothing
  assert.equal(coverBottom([content, header(844)], 844), 0);
  // something pinned that fills the screen is not a bar (a site's open menu, a full-page layer)
  assert.equal(coverBottom([header(844)], 844), 0);
  assert.equal(coverBottom([header(500)], 844), 0);
  assert.equal(coverBottom([header(400)], 844), 400);
  // a bar with a small gap above it still covers
  assert.equal(coverBottom([header(72, 8)], 844), 72);
});

test('bar: a block\'s buttons are hidden while any part of them is under it', () => {
  const rect = (top, bottom) => ({ top, bottom });
  assert.equal(isUnder(rect(10, 46), 64), true);     // wholly under
  assert.equal(isUnder(rect(40, 76), 64), true);     // half under
  assert.equal(isUnder(rect(64, 100), 64), false);   // just clear of it
  assert.equal(isUnder(rect(300, 336), 64), false);
  assert.equal(isUnder(rect(10, 46), 0), false);     // no bar
  assert.equal(isUnder(rect(-80, -44), 64), false);  // off the top of the screen: nothing to hide
});

test('bar: looked at whenever the page moves', () => {
  assert.match(main, /function hideUnderBar\(\) \{/);
  const fn = main.slice(main.indexOf('function hideUnderBar('), main.indexOf('function watchBar('));
  // what is on top at the top edge, looking through Kiln's own
  assert.match(fn, /document\.elementsFromPoint\(x, y\)\.find\(el => !isKilnChrome\(el\)\)/);
  assert.match(fn, /document\.querySelectorAll\('\.kiln-item-ctl'\)/);
  assert.match(fn, /classList\.toggle\('kiln-under-bar', isUnder\(ctl\.getBoundingClientRect\(\), cover\)\)/);
  // on scroll and on resize, at most once a frame, and only on a page that has lists
  assert.match(main, /window\.addEventListener\('scroll', barSoon, \{ passive: true, capture: true \}\);/);
  assert.match(main, /window\.addEventListener\('resize', barSoon\);/);
  // hidden means neither seen nor pressed
  assert.match(main, /\.kiln-under-bar\{visibility:hidden!important;pointer-events:none!important\}/);
});
