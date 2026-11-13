/**
 * A button of the Kiln menu that is marked hidden is not drawn.
 *
 * "Entries & drafts" is written with the `hidden` attribute on a site that has
 * no collections of entries, and it was drawn in everyone's menu anyway: the
 * style for `.kiln-fab-item` sets `display`, and a class that sets `display`
 * wins over the attribute. On a plain site it was a button that did nothing.
 *
 * One rule now makes `hidden` mean hidden for every item of the menu. It is
 * pinned here, with the two things that depend on it: the button is still
 * written hidden where there is nothing for it to open, and it is still shown
 * by taking the attribute away once the site's collections are known.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const RULE = '.kiln-fab-item[hidden]{display:none!important}';

test('a menu item marked hidden is not drawn, whatever display its class sets', () => {
  assert.ok(main.includes(RULE), 'the rule that hides a hidden menu item is gone');
  // The item's own style sets display, on a wide screen and again on a phone:
  // that is why the attribute alone was not enough, and why the rule is marked important.
  const sets = main.match(/^\.kiln-fab-item\{display:(block|flex)/gm) || [];
  assert.equal(sets.length, 2, 'the styles that set display on a menu item are not the two this rule was written against');
  assert.ok(main.indexOf(RULE) > main.indexOf('.kiln-fab-item{display:block'), 'the rule comes after the style it overrides');
});

test('"Entries & drafts" is written hidden on a site with no collections of entries, and shown once there are some', () => {
  assert.match(main, /<button id="kiln-entries" class="kiln-fab-item"\$\{sourceEntriesOn && state\.sourceCollections\?\.size \? '' : ' hidden'\}>Entries &amp; drafts<\/button>/);
  assert.match(main, /const menuItem = document\.getElementById\('kiln-entries'\);\s*\n\s*if \(menuItem && state\.sourceCollections\.size\) menuItem\.hidden = false;/);
});

test('no menu item is written hidden and expected to show all the same', () => {
  // Every item the menu is written with that carries the attribute from the start.
  const written = [...main.matchAll(/<button id="(kiln-[a-z-]+)" class="kiln-fab-item[^"]*"([^>]*)>/g)]
    .filter(m => /hidden/.test(m[2])).map(m => m[1]).sort();
  // "Entries & drafts" is shown by taking the attribute away (above). "My
  // suggestions" already had a rule of its own that hid it while marked hidden.
  assert.deepEqual(written, ['kiln-entries', 'kiln-mysuggestions']);
  assert.ok(main.includes('#kiln-mysuggestions[hidden]{display:none!important}'));
});
