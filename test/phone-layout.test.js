/**
 * The editor on a phone, where four things lay on top of other things: the
 * first tip on the page's own buttons, the pencil on the last item of the
 * menu, a block's buttons on the next block's words, and the top bar on the
 * first lines of the page. The measuring is done in a browser by
 * scripts/ui-check.mjs; this holds the rule behind each.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sideForHeading } from '../src/editor/firstrun.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, 'src', 'editor', f), 'utf8');
const main = read('main.js');
const guide = read('firstrun.js');

test('phone: the first tip goes above the heading when the page has a button right under it', () => {
  // the demo on a 390x844 phone: the heading at 516 to 593, a 52 px tip, "Shop all 28" right below
  const at = [516, 77, 52, 844];
  assert.equal(sideForHeading(...at), 'below', 'with nothing in the way it goes under the heading, as before');
  assert.equal(sideForHeading(...at, { blocked: { below: true, above: false } }), 'above');
  // something to press on both sides, or no room above: under the heading, as before
  assert.equal(sideForHeading(...at, { blocked: { below: true, above: true } }), 'below');
  assert.equal(sideForHeading(90, 77, 52, 844, { blocked: { below: true, above: false } }), 'below');
  // a heading low on the screen still goes above, whatever is there
  assert.equal(sideForHeading(700, 77, 52, 844, { blocked: { below: false, above: true } }), 'above');
  assert.equal(sideForHeading(700, 77, 52, 844), 'above');
});

test('phone: the tip is looked at again while the page settles', () => {
  // a button that slides up as it fades in is not under the tip yet when the tip is first placed
  assert.match(guide, /blocked: pressable\(r\)/);
  const settle = guide.slice(guide.indexOf('function settleTip()'), guide.indexOf('function showCard()'));
  assert.match(settle, /setTimeout\(placeGuideTip, ms\)/);
  assert.match(guide, /document\.addEventListener\('transitionend', settleTip, true\);/);
  // what counts as in the way is the page's own, never the editor's
  const press = guide.slice(guide.indexOf('function pressable('), guide.indexOf('let settling'));
  assert.match(press, /a\[href\], button/);
  assert.match(press, /closest\('\[id\^="kiln-"\]/);
});

test('phone: the menu\'s foot is a strip as tall as the pencil, kept at the bottom of the sheet', () => {
  const phone = main.slice(main.indexOf('@media ${MOBILE_MQ}{\n/* No double-tap zoom'));
  // the pencil is 56 px with 16 px under it; the foot is 10 + 44 + 22 px and holds it, clear of it on the right
  assert.match(phone, /#kiln-fab-menu\{padding-bottom:0;scroll-padding-bottom:calc\(84px \+ env\(safe-area-inset-bottom,0px\)\)\}/);
  assert.match(phone, /\.kiln-fab-foot\{margin:4px -14px 0;border-radius:0;align-items:center;\s*\n\s*padding:10px 86px calc\(22px \+ env\(safe-area-inset-bottom,0px\)\) 14px\}/);
  assert.match(phone, /\.kiln-fab-foot button\{min-height:44px/);
  // and it stays there while the items scroll behind it, on any screen
  assert.match(main, /\.kiln-fab-foot\{[^}]*position:sticky;bottom:0;background:rgb\(20,20,31\)/);
  // the menu has no padding of its own under the foot, where a scrolled item would show through
  assert.match(main, /border-radius:16px;padding:8px 8px 0;/);
  assert.match(main, /\.kiln-fab-foot\{[^}]*margin:4px -8px 0;padding:6px 8px 8px;/);
});

test('phone: a block\'s buttons open in a row of their own, under the block\'s words', () => {
  assert.match(main, /\.kiln-item-ctl\.kiln-ctl-open\.kiln-ctl-flow\{position:static;flex:0 0 100%;grid-column:1\/-1;/);
  // the "more" button keeps its corner: the bar sat 8 px in from the block's top right
  assert.match(main, /\.kiln-item-ctl\.kiln-ctl-open\.kiln-ctl-flow \.kiln-ctl-more\{top:8px;right:8px\}/);
  const more = main.slice(main.indexOf('more.onclick = (e) => {'), main.indexOf('ctl.prepend(more);'));
  // not in a block that lays its children out on one line (a full-width row would crush them), and not in a table row
  assert.match(more, /const oneLine = \/flex\/\.test\(cs\.display\) && !cs\.flexDirection\.startsWith\('column'\) && cs\.flexWrap === 'nowrap';/);
  assert.match(more, /ctl\.classList\.toggle\('kiln-ctl-flow', open && item\.tagName !== 'TR' && !oneLine\);/);
  assert.match(main, /c\.classList\.remove\('kiln-ctl-open', 'kiln-ctl-flow'\);/);
});

test('phone and laptop: choosing the top bar does not slide the top of the page under it', () => {
  const bar = main.slice(main.indexOf('function renderTopBar()'), main.indexOf('function discardEdits()'));
  assert.ok(bar.indexOf('const atTop = window.scrollY < 2;') !== -1 && bar.indexOf('const atTop = window.scrollY < 2;') < bar.indexOf('document.body.prepend(bar);'), 'measured before the bar is put in');
  assert.match(bar, /if \(window\.scrollY <= bar\.offsetHeight \+ 2\) window\.scrollTo\(0, 0\);/);
});

test('laptop: a full menu takes the room on its side of the pencil and scrolls inside itself', () => {
  assert.match(main, /menu\.style\.maxHeight = `\$\{Math\.max\(220, \(above \? br\.top : window\.innerHeight - br\.bottom\) - 18\)\}px`;/);
  assert.match(main, /max-height:calc\(100vh - 16px\);overflow-y:auto;box-sizing:border-box;overscroll-behavior:contain;scroll-padding-bottom:48px\}/);
});
