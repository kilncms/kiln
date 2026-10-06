/**
 * A block's buttons (move, duplicate, tags, remove) when the block is a link.
 *
 * A card is often one <a> around a picture and a title. Its buttons sit inside
 * that link, and their handlers only stopped the click on its way up the page,
 * which does not stop the browser from following the link: pressing "Move
 * down" on a product card also opened the product's page in a new tab. The
 * browser check is in scripts/ui-check.mjs; this holds the line that does it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');
const controls = main.slice(main.indexOf('function attachItemControls('), main.indexOf('function closeItemControls('));

test('block controls: a click anywhere in a block\'s control bar never follows the link the block is', () => {
  // in the capture phase, so that it runs before each button's own handler stops the click
  assert.match(controls, /ctl\.addEventListener\('click', \(e\) => e\.preventDefault\(\), true\);/);
  // and it is set up before the buttons are given their handlers
  assert.ok(controls.indexOf("ctl.addEventListener('click'") < controls.indexOf('up.onclick'), 'set before the buttons');
});

test('block controls: every button of the bar is inside it', () => {
  // the "more" button of a phone is put into the same bar, so the one listener covers it
  assert.match(controls, /ctl\.prepend\(more\);/);
  // and the bar is what is put into the block (or into a table row's own cell)
  assert.match(controls, /item\.appendChild\(ctl\);/);
  assert.match(controls, /cell\.appendChild\(ctl\);/);
});
