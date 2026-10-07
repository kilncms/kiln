/**
 * A list is published as the page FILE says it, plus what the editor changed
 * (src/editor/file-state.js, and where main.js and keep-blocks.js use it).
 *
 * A list's HTML used to be read off the live page. Whatever the site's own
 * scripts had done to its blocks while the page was open went into the file
 * with it: the class a fade-in adds ("is-inview"), the display:none of a
 * filter, a slider's aria-hidden. These hold that it no longer does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedAttrs, pairTrees, sameWords } from '../src/editor/file-state.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, 'src', 'editor', f), 'utf8');
const main = read('main.js');
const A = (o) => Object.entries(o);
const O = (pairs) => Object.fromEntries(pairs);

// ─── Which attributes an element is published with ───────────────────────────

test('attributes: outside an editable field, an element is published with the attributes the file has', () => {
  // the class a fade-in script added, and the style a filter set
  assert.deepEqual(O(publishedAttrs(A({ class: 'card reveal is-inview', style: 'display: none;', href: '/a' }), A({ class: 'card reveal', href: '/a' }))),
    { class: 'card reveal', href: '/a' });
  // anything a script adds: a slider's state, a lazy loader's picture, an observer's mark, an id
  assert.deepEqual(O(publishedAttrs(
    A({ class: 'slide swiper-slide-active', 'aria-hidden': 'false', tabindex: '0', role: 'group', 'data-ll-status': 'loaded', id: 'sw-1', style: 'width: 320px;' }),
    A({ class: 'slide' }))), { class: 'slide' });
  assert.deepEqual(O(publishedAttrs(A({ src: '/real.jpg', class: 'lazy loaded', 'data-src': '/real.jpg' }), A({ src: '/dot.gif', 'data-src': '/real.jpg', class: 'lazy' }))),
    { src: '/dot.gif', 'data-src': '/real.jpg', class: 'lazy' });
  // an attribute a script took away is back
  assert.deepEqual(O(publishedAttrs(A({ class: 'faq' }), A({ class: 'faq', hidden: '' }))), { class: 'faq', hidden: '' });
  // the file's own order is kept, so a publish that changed nothing changes no byte
  assert.deepEqual(publishedAttrs(A({ style: 'x', href: '/a', class: 'b a' }), A({ class: 'a', href: '/a' })).map(([n]) => n), ['class', 'href']);
});

test('attributes: what the editor itself sets on a block is published as it is on the page', () => {
  // a block's tags, changed, added and removed in the editor
  assert.deepEqual(O(publishedAttrs(A({ class: 'card is-inview', 'data-kiln-tags': 'tee,new' }), A({ class: 'card', 'data-kiln-tags': 'tee' }))),
    { class: 'card', 'data-kiln-tags': 'tee,new' });
  assert.deepEqual(O(publishedAttrs(A({ class: 'card', 'data-kiln-tags': 'tee' }), A({ class: 'card' }))), { class: 'card', 'data-kiln-tags': 'tee' });
  assert.deepEqual(O(publishedAttrs(A({ class: 'card' }), A({ class: 'card', 'data-kiln-tags': 'tee' }))), { class: 'card' });
  // what marks a part as editable, and a picture waiting to be uploaded
  assert.deepEqual(O(publishedAttrs(A({ 'data-cms-repeat': 'cards', 'data-kiln-src': '/assets/uploads/a.png', src: 'blob:x' }), A({ src: '/old.png' }))),
    { src: '/old.png', 'data-cms-repeat': 'cards', 'data-kiln-src': '/assets/uploads/a.png' });
});

test('attributes: an editable field keeps what the editor can change on it, and loses what a script added', () => {
  // a heading that is a field: its class and style are the file's
  assert.deepEqual(O(publishedAttrs(A({ 'data-cms': 'title', class: 'reveal is-inview kiln-field', style: 'opacity: 1; transform: none;' }), A({ 'data-cms': 'title', class: 'reveal' }), { field: true })),
    { 'data-cms': 'title', class: 'reveal' });
  assert.deepEqual(O(publishedAttrs(A({ 'data-cms': 'title', class: 'is-inview' }), A({ 'data-cms': 'title' }), { field: true })), { 'data-cms': 'title' });
  // a link field: the address the editor set stays
  assert.deepEqual(O(publishedAttrs(A({ 'data-cms': 'cta', href: '/new', class: 'btn is-inview' }), A({ 'data-cms': 'cta', href: '/old', class: 'btn' }), { field: true })),
    { 'data-cms': 'cta', href: '/new', class: 'btn' });
  // a picture field: the picture, its description and the size it was dragged to stay
  assert.deepEqual(O(publishedAttrs(
    A({ 'data-cms': 'photo', src: '/new.jpg', alt: 'New', style: 'width: 240px; height: auto;', class: 'lazy loaded' }),
    A({ 'data-cms': 'photo', src: '/old.jpg', alt: '', class: 'lazy' }), { field: true, media: true })),
    { 'data-cms': 'photo', src: '/new.jpg', alt: 'New', style: 'width: 240px; height: auto;', class: 'lazy' });
});

// ─── Which element of the page is which element of the file ──────────────────

const el = (tagName, children = [], attrs = {}, text = '') => ({
  tagName, children, textContent: text || children.map(c => c.textContent).join(''),
  hasAttribute: (n) => n in attrs, getAttribute: (n) => attrs[n] ?? null, matches: () => false,
});

test('pairing: an element is paired with the one at the same place in the file, as deep as the two agree', () => {
  const title = el('H3', [], { 'data-cms': 'title' }, 'Tee');
  const live = el('A', [el('FIGURE', [el('IMG')]), title, el('P', [], {}, '$28')]);
  const fTitle = el('H3', [], { 'data-cms': 'title' }, 'Tee');
  const file = el('A', [el('FIGURE', [el('IMG')]), fTitle, el('P', [], {}, '$28')]);
  const pairs = pairTrees(live, file);
  assert.equal(pairs.length, 5);
  assert.deepEqual(pairs[0], [live, file]);
  assert.ok(pairs.some(([l, f]) => l === title && f === fTitle));
  // not below a field: what is inside it is the editor's
  const rich = el('DIV', [el('STRONG', [], {}, 'x')], { 'data-cms': 'body' });
  assert.equal(pairTrees(el('LI', [rich]), el('LI', [el('DIV', [el('STRONG', [], {}, 'x')], { 'data-cms': 'body' })])).length, 2);
  // a script added an element inside: the block itself is still paired, what is below it is not
  const grown = el('A', [el('SPAN'), el('FIGURE', [el('IMG')]), el('H3')]);
  assert.deepEqual(pairTrees(grown, file), [[grown, file]]);
  // a different tag at the same place pairs nothing from there down
  assert.deepEqual(pairTrees(el('DIV'), el('A')), []);
  const mixed = el('A', [el('DIV', [el('IMG')]), el('H3'), el('P')]);
  assert.deepEqual(pairTrees(mixed, file), [[mixed, file]]);
});

test('pairing: a block is paired only when it says what the file\'s block says', () => {
  assert.equal(sameWords(el('A', [], {}, ' Tee \n  $28 '), el('A', [], {}, 'Tee $28')), true);
  assert.equal(sameWords(el('A', [], {}, 'Tee $28'), el('A', [], {}, 'Hoodie $64')), false);
  assert.equal(sameWords(el('A', [], {}, 'Tee'), el('LI', [], {}, 'Tee')), false);
});

// ─── Where it is used ────────────────────────────────────────────────────────

test('wired: every list is published through what the file says', () => {
  // the one function every list's HTML comes from
  const clean = main.slice(main.indexOf('function containerCleanHtml('), main.indexOf('function cleanBlocks('));
  assert.match(clean, /const copy = container\.cloneNode\(true\);\s*\n\s*fileTrue\(copy, container\);\s*\n\s*return cleanBlocks\(copy\);/);
  // noted when the page's file is read (at the start, and again after every publish and undo), before a list is set up
  const load = main.slice(main.indexOf('async function loadPageSource('), main.indexOf('/** Auth headers for worker endpoints'));
  assert.match(load, /noteFileLists\(\);/);
  // a copy of a block is published as its original is
  const setup = main.slice(main.indexOf('function setupRepeat('), main.indexOf('function stageContainer('));
  assert.equal((setup.match(/noteCopy\(/g) || []).length, 2, '"+ Add block" and Duplicate');
  // a block written back from staged HTML (Undo, Redo, a draft) is what that HTML says
  const keep = read('keep-blocks.js');
  assert.match(keep, /noteAsWritten\(node\);/);
  // and blocks are told apart by what the file says of them, whatever a script has added since
  assert.match(keep, /fileTrue\(copy, n\);/);
});
