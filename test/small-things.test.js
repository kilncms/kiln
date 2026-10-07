/**
 * Four small things that were seen and left: bars that lay on the status line
 * on a phone, the first tip lying on the paragraph under the heading, the
 * History preview's bar, and the last two questions asked in the browser's
 * own grey box.
 *
 * What can be held in node is held here: where a tip goes, what a question
 * says, and that the editor's sources no longer call the browser's boxes.
 * What these look like is looked at in a browser (scripts/ui-check.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sideForHeading, placeBeside } from '../src/editor/firstrun.js';
import { ownDialogCopy, answerOf } from '../src/editor/own-dialogs.js';

const DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'editor');
const read = (f) => readFileSync(path.join(DIR, f), 'utf8');
const main = read('main.js');

// ─── The first tip ───────────────────────────────────────────────────────────

test('first tip: with a paragraph under the heading and no room over it, it goes beside the heading\'s words', () => {
  // The Astro test page at 1280x800: the heading at 69 to 103, a 40 px tip.
  const at = [69, 34, 40, 800];
  const under = { below: true, above: false };
  assert.equal(sideForHeading(...at, { blocked: under }), 'below', 'with no room on the line it lies where it did');
  assert.equal(sideForHeading(...at, { blocked: under, beside: true }), 'beside');
  // Nothing under the heading: under it, as always, even when the line has room.
  assert.equal(sideForHeading(...at, { beside: true }), 'below');
  // Room over the heading and nothing there: over it, as before.
  assert.equal(sideForHeading(300, 60, 40, 800, { blocked: under, beside: true }), 'above');
  // Something on both sides: beside when there is room, else under as before.
  assert.equal(sideForHeading(300, 60, 40, 800, { blocked: { below: true, above: true }, beside: true }), 'beside');
  assert.equal(sideForHeading(300, 60, 40, 800, { blocked: { below: true, above: true } }), 'below');
  // A heading low on the screen with something over it.
  assert.equal(sideForHeading(700, 60, 40, 800, { blocked: { below: false, above: true }, beside: true }), 'beside');
});

test('placeBeside: after the heading\'s words, level with their middle, or nowhere when the line has no room', () => {
  const view = { left: 0, top: 0, width: 1280, height: 2000 };
  const tip = { width: 210, height: 40 };
  assert.deepEqual(placeBeside({ left: 304, top: 52, width: 344, height: 40 }, tip, view), { left: 662, top: 52 });
  // A phone: the words run nearly the width of the screen.
  assert.equal(placeBeside({ left: 16, top: 52, width: 330, height: 40 }, tip, { left: 0, top: 0, width: 390, height: 2000 }), null);
  // Words on a line shorter than the tip: still level with their middle.
  assert.deepEqual(placeBeside({ left: 304, top: 200, width: 100, height: 20 }, tip, view), { left: 418, top: 190 });
  // It would stick out over the top of the page, or there are no words to stand beside.
  assert.equal(placeBeside({ left: 304, top: 2, width: 100, height: 20 }, tip, view), null);
  assert.equal(placeBeside(null, tip, view), null);
  assert.equal(placeBeside({ left: 0, top: 0, width: 0, height: 0 }, tip, view), null);
});

test('first tip: what counts as in the way under a heading is the words there, not only what can be pressed', () => {
  const guide = read('firstrun.js');
  const press = guide.slice(guide.indexOf('function pressable('), guide.indexOf('let settling'));
  assert.match(press, /range\.getClientRects\(\)/, 'the lines of text, since a paragraph\'s box runs the width of its column');
  assert.match(press, /const READ = 'p, li, h1, h2, h3, h4, h5, h6, blockquote/);
  assert.match(guide, /\.kiln-guide--beside \.kiln-guide-arrow\{/);
});

// ─── The bars, on a phone ────────────────────────────────────────────────────

test('bars: the failed-build banner, the "not saved" box and the History preview share one column', () => {
  assert.match(main, /function noticeColumn\(\) \{/);
  assert.equal((main.match(/noticeColumn\(\)\.(appendChild|prepend)\(bar\)/g) || []).length, 3);
  // None of the three places itself any more.
  for (const id of ['kiln-srcfail', 'kiln-srcskip', 'kiln-previewbar']) {
    assert.doesNotMatch(main, new RegExp(`#${id}\\{position:fixed`), id);
  }
  assert.match(main, /#kiln-notices\{position:fixed;top:12px;left:50%;transform:translateX\(-50%\)/);
});

test('bars: on a phone the column is above the pencil and its buttons, as wide as the screen; the top is the status line\'s', () => {
  const phone = main.slice(main.lastIndexOf('@media ${MOBILE_MQ}{'));
  assert.match(phone, /#kiln-notices\{left:8px;right:8px;top:auto;bottom:calc\(140px \+ env\(safe-area-inset-bottom,0px\)\);transform:none/);
  assert.match(phone, /#kiln-fab-wrap \.kiln-status\{position:fixed;left:50%;right:auto;bottom:auto;\s*top:calc\(10px/, 'the status line is at the top there');
});

// ─── The History preview's bar ───────────────────────────────────────────────

test('History preview: the bar says what is left to do, and its button says what it does', () => {
  const fn = main.slice(main.indexOf('function previewRestore('), main.indexOf("bar.querySelector('#kiln-pv-cancel').onclick"));
  assert.match(fn, /<small>Nothing is live yet\. Keep it, then press Publish\.<\/small>/);
  assert.match(fn, /id="kiln-pv-keep"[^>]*>Keep<\/button>/);
  assert.match(fn, /`Kept\. Press Publish to make \$\{[^}]+\} live\.`/);
  assert.doesNotMatch(fn, /Keep — then Publish|hit Publish/);
});

// ─── The last two browser boxes ──────────────────────────────────────────────

test('no question in the editor is asked in the browser\'s own box any more', () => {
  for (const f of readdirSync(DIR).filter(n => n.endsWith('.js'))) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /(^|[^.\w])(window\.)?(confirm|prompt|alert)\(/, f);
  }
});

test('make editable: text that reads differently in the page\'s file is asked about in the editor\'s own dialog', () => {
  const q = ownDialogCopy('reads-differently', { onScreen: 'Open until 6pm today', inFile: 'Open today' });
  assert.deepEqual(q, {
    title: 'This text reads differently in the page’s file',
    body: 'On screen: “Open until 6pm today”. In the file: “Open today”. A script on the site may change it when the page loads. If you make it editable, edits replace the words in the file, and the script may go on changing what visitors see.',
    cancel: 'Leave it',
    go: 'Make it editable',
  });
  assert.equal(answerOf(q, ''), true);
  assert.doesNotMatch(`${q.title} ${q.body} ${q.cancel} ${q.go}`, /[!—–]| - |Heads up/);
  assert.match(main, /askFirst\(modal, ownDialogCopy\('reads-differently', \{ onScreen: domText, inFile: srcText \}\)\)/);
});

test('preview link: when the browser will not copy it, the link is shown selected in the dialog', () => {
  const suggest = read('suggest.js');
  const fn = suggest.slice(suggest.indexOf('export async function sharePreviewPanel('));
  assert.match(fn, /<label id="kiln-prev-byhand" hidden>This browser did not let Kiln copy it\. The link is selected here, to copy by hand:/);
  assert.match(fn, /m\.querySelector\('#kiln-prev-byhand'\)\.hidden = false;/);
  assert.match(fn, /box\.select\(\);/);
  assert.match(main, /\.kiln-modal-body label\[hidden\]\{display:none\}/, 'a hidden label in a dialog stays hidden');
  // A box in a dialog is as wide as the dialog, on a site whose own styles do not say how boxes are measured.
  assert.match(main, /\.kiln-modal-body input\[type=text\][^{]*\{\s*width:100%;box-sizing:border-box;/);
});
