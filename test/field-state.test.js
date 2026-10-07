/**
 * A field is published as the page FILE would hold it, and what Undo puts
 * back can be seen (src/editor/file-state.js, keep-inside.js, baselines.js,
 * and where main.js uses them).
 *
 * The editor used to copy each field's markup when it started, while the site
 * was still animating in. Undo put that copy back: on a site whose headline
 * slides in, the START of the slide, which is invisible. The same markup,
 * with whatever the site's scripts had put on it, was what a publish wrote
 * into the page file. These hold that neither happens.
 *
 * The headline below is the public demo's, read off the page three times: as
 * the file has it, 131 ms after the page opened (when the editor starts), and
 * once its entrance animation had finished.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { page, all, setStyle } from './tiny-dom.js';
import { insideAttrs, styleDecls, noteInside, noteList, noteAs, beginInside, settleInside, insideAsFile, fileTrue, asFileHtml,
  beginOn, endOn, ownStyle, settleOn, showStyle } from '../src/editor/file-state.js';
import { writeInside, rememberInside } from '../src/editor/keep-inside.js';
import { takeBase, readAttrs } from '../src/editor/baselines.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, 'src', 'editor', f), 'utf8');
const main = read('main.js');

const FILE = '<span class="hero-line block">Soft shirts.</span><span class="hero-line block">Strong opinions.</span>';
const AT_START = '<span class="hero-line block" style="translate: none; rotate: none; scale: none; opacity: 0.0538; transform: translate3d(0px, 56.7718px, 0px);">Soft shirts.</span>'
  + '<span class="hero-line block" style="translate: none; rotate: none; scale: none; opacity: 0; transform: translate(0px, 60px);">Strong opinions.</span>';
const SETTLED_STYLE = 'translate: none; rotate: none; scale: none; opacity: 1; transform: translate(0px, 0px);';
const SETTLED = `<span class="hero-line block" style="${SETTLED_STYLE}">Soft shirts.</span><span class="hero-line block" style="${SETTLED_STYLE}">Strong opinions.</span>`;
const H1 = (inner) => page(`<h1 class="display" data-cms="hero_headline">${inner}</h1>`);

/** What publishing the field would write. */
const asFile = (field) => { const copy = field.cloneNode(true); insideAsFile(copy, field); return copy.innerHTML; };
/** The site's animation library finishing its work on an element, attached or not. */
const settle = (el) => el.setAttribute('style', SETTLED_STYLE);
const seen = (field) => all(field).every(el => !/opacity:\s*0(\.\d+)?\s*(;|$)/.test(el.getAttribute('style') || '') || /opacity:\s*1/.test(el.getAttribute('style')));
/** Typing over everything in the headline: a browser keeps the first line's element and drops the second. */
const typeOver = (field, words) => {
  const [first, ...rest] = field.children;
  first.innerHTML = words;
  for (const r of rest) r.remove();
};

// ─── Which class and style an element inside a field is published with ───────

test('inside a field: what an animation put on an element is not published', () => {
  const file = { class: 'hero-line block', style: null };
  // while it slides in, and when it has arrived
  assert.deepEqual(insideAttrs({ class: 'hero-line block', style: 'translate: none; rotate: none; scale: none; opacity: 0.0538; transform: translate3d(0px, 56.7718px, 0px);' }, file), file);
  assert.deepEqual(insideAttrs({ class: 'hero-line block', style: SETTLED_STYLE }, file), file);
  // a fade-in's class, and the editor's own
  assert.deepEqual(insideAttrs({ class: 'reveal is-inview kiln-flash', style: null }, { class: 'reveal', style: null }), { class: 'reveal', style: null });
  assert.deepEqual(insideAttrs({ class: 'is-inview', style: 'opacity: 1;' }, { class: null, style: null }), { class: null, style: null });
});

test('inside a field: what the file has is not lost, byte for byte', () => {
  // the file's own style, which the browser wrote out again its own way once a script touched the element
  assert.deepEqual(insideAttrs({ class: 'lead', style: 'color: rgb(255, 0, 0); opacity: 1; transform: none;' }, { class: 'lead', style: 'color:#f00' }), { class: 'lead', style: 'color:#f00' });
  // a class a script took away to let the element show (a common fade-in) is still the file's
  assert.deepEqual(insideAttrs({ class: 'transition', style: null }, { class: 'opacity-0  translate-y-4 transition', style: null }), { class: 'opacity-0  translate-y-4 transition', style: null });
  // and a style a script removed
  assert.deepEqual(insideAttrs({ class: null, style: null }, { class: null, style: 'visibility:hidden' }), { class: null, style: 'visibility:hidden' });
});

test('inside a field: what the person changed while editing is kept, on top of what the file has', () => {
  const file = { class: 'lead', style: 'color: red' };
  const began = { class: 'lead is-inview', style: 'color: red; opacity: 1;' };
  // "Clear" took the colour off: it is off in the file too, and the animation's leftovers still are not written
  assert.deepEqual(insideAttrs({ class: 'lead is-inview', style: 'opacity: 1;' }, file, began), { class: 'lead', style: null });
  // a width the person dragged a picture to, beside the file's own
  assert.deepEqual(insideAttrs({ class: 'lead is-inview', style: 'color: red; opacity: 1; width: 50%;' }, file, began), { class: 'lead', style: 'color: red; width: 50%;' });
  // a class added and one removed in the editor
  assert.deepEqual(insideAttrs({ class: 'is-inview text-accent', style: 'color: red; opacity: 1;' }, file, began), { class: 'text-accent', style: 'color: red' });
  // an animation still running when the edit began: its values moved on, and are still the animation's
  assert.deepEqual(insideAttrs({ class: 'hero-line', style: 'opacity: 1; transform: translate(0px, 0px);' }, { class: 'hero-line', style: null },
    { class: 'hero-line', style: 'opacity: 0.0538; transform: translate3d(0px, 56.7718px, 0px);' }), { class: 'hero-line', style: null });
});

test('inside a field: a style is read declaration by declaration', () => {
  assert.deepEqual(styleDecls('color: red; background: url("a;b.png") no-repeat;transform:translate(0px, 60px)'),
    [['color', 'red'], ['background', 'url("a;b.png") no-repeat'], ['transform', 'translate(0px, 60px)']]);
  assert.deepEqual(styleDecls(''), []);
  assert.deepEqual(styleDecls(null), []);
});

// ─── The demo's headline ─────────────────────────────────────────────────────

test('the headline: what would be published is the file\'s markup, whenever it is read', () => {
  const h1 = H1(AT_START);
  assert.equal(noteInside(h1, FILE), 2);
  assert.equal(asFile(h1), FILE, 'read as the editor starts, mid-animation');
  all(h1).forEach(settle);
  assert.equal(asFile(h1), FILE, 'read once the animation has finished');
  assert.equal(/opacity|transform/.test(asFile(h1)), false);
});

test('the headline: replaced, kept, undone and redone, the words can always be seen and nothing of the animation is published', () => {
  const h1 = H1(AT_START);
  noteInside(h1, FILE);
  const [one, two] = h1.children;
  all(h1).forEach(settle);                 // the page has finished animating in
  const base = asFile(h1);                 // what Undo goes back to: taken when the person begins
  beginInside(h1); rememberInside(h1);
  typeOver(h1, 'Big sale this Saturday.');
  settleInside(h1);
  const staged = asFile(h1);
  assert.equal(staged, '<span class="hero-line block">Big sale this Saturday.</span>');
  assert.equal(/opacity|transform/.test(staged), false, 'what Publish would write');
  writeInside(h1, staged);                 // Done
  assert.equal(h1.children[0], one, 'the element the site\'s scripts know stays');
  assert.equal(h1.children[0].getAttribute('style'), SETTLED_STYLE);

  writeInside(h1, base);                   // Undo
  assert.deepEqual(h1.children, [one, two], 'the two lines that were there, the same elements');
  assert.equal(h1.textContent, 'Soft shirts.Strong opinions.');
  assert.ok(seen(h1), h1.innerHTML);
  assert.equal(asFile(h1), FILE);

  writeInside(h1, staged);                 // Redo
  assert.deepEqual(h1.children, [one]);
  assert.equal(h1.textContent, 'Big sale this Saturday.');
  assert.ok(seen(h1));
  assert.equal(asFile(h1), staged);

  writeInside(h1, base);                   // Drop in the publish sheet, History's way back: the same write
  assert.deepEqual(h1.children, [one, two]);
  assert.ok(seen(h1));
});

test('the headline: an edit begun while it was still sliding in is undone to words that can be seen', () => {
  const h1 = H1(AT_START);
  noteInside(h1, FILE);
  const [one, two] = h1.children;
  const base = asFile(h1);
  beginInside(h1); rememberInside(h1);     // a quick first tap, 131 ms in
  typeOver(h1, 'Big sale this Saturday.');
  settle(one); settle(two);                // the animation runs on, on the line still there and on the one typed away
  settleInside(h1);
  assert.equal(asFile(h1), '<span class="hero-line block">Big sale this Saturday.</span>');
  writeInside(h1, asFile(h1));
  writeInside(h1, base);                   // Undo
  assert.deepEqual(h1.children, [one, two]);
  assert.ok(seen(h1), h1.innerHTML);
  assert.equal(asFile(h1), FILE);
});

test('the headline: a publish kept in the browser is put back on a page that is still animating in', () => {
  // the demo after a reload: the stored words go on before the page's file has been read again
  const h1 = H1(AT_START);
  const [one] = h1.children;
  writeInside(h1, '<span class="hero-line block">Big sale this Saturday.</span>');
  assert.equal(h1.children.length, 1);
  assert.equal(h1.children[0], one, 'the element the animation is running on, with the new words');
  assert.match(one.getAttribute('style'), /opacity: 0\.0538/, 'and the animation\'s state left on it, to finish');
  settle(one);
  assert.ok(seen(h1));
  // what the demo's file says now is what was published there
  noteInside(h1, '<span class="hero-line block">Big sale this Saturday.</span>');
  assert.equal(asFile(h1), '<span class="hero-line block">Big sale this Saturday.</span>');
});

test('the headline: History\'s way back to words published earlier brings the second line back where it can be seen', () => {
  // a later visit: one line is published; "Undo this change" asks for the two the file first had
  const h1 = H1(`<span class="hero-line block" style="${SETTLED_STYLE}">Big sale this Saturday.</span>`);
  noteInside(h1, '<span class="hero-line block">Big sale this Saturday.</span>');
  writeInside(h1, FILE);
  assert.equal(h1.children.length, 2);
  assert.equal(h1.textContent, 'Soft shirts.Strong opinions.');
  // the new second line is given what the scripts gave the line of its kind that is there
  assert.equal(h1.children[1].getAttribute('style'), SETTLED_STYLE);
  assert.ok(seen(h1));
  assert.equal(asFile(h1), FILE, 'and is published without it');
});

test('the headline: a demo an earlier editor stored at the start of the animation is read as the file has it', () => {
  const h1 = H1(SETTLED);
  // History's "Undo this change", published by the editor that had the fault: the early copy, invisible at every visit
  const stored = AT_START.replace('opacity: 0.0538', 'opacity: 0').replace('translate3d(0px, 56.7718px, 0px)', 'translate(0px, 60px)');
  assert.equal(asFileHtml(h1, stored, FILE), FILE);
  // other words in the same lines: the lines are the file's, the words are the visitor's
  assert.equal(asFileHtml(h1, SETTLED.replace('Soft shirts.', 'Loud shirts.'), FILE), FILE.replace('Soft shirts.', 'Loud shirts.'));
  // lines the file does not have that way are left as they were stored
  const one = `<span class="hero-line block" style="${SETTLED_STYLE}">Big sale this Saturday.</span>`;
  assert.equal(asFileHtml(h1, one, FILE), one);
  assert.equal(h1.innerHTML, SETTLED, 'nothing on the page is touched');
});

// ─── A part that fades in ────────────────────────────────────────────────────

const CARD_FILE = '<p class="reveal">Made by hand.</p><p class="reveal">Shipped on Tuesdays.</p>';
const CARD_LIVE = '<p class="reveal is-inview">Made by hand.</p><p class="reveal is-inview">Shipped on Tuesdays.</p>';

test('a fade-in card: the class the site\'s script added is not published, and a paragraph that comes back is not hidden', () => {
  const card = page(`<div class="card" data-cms="about">${CARD_LIVE}</div>`);
  noteInside(card, CARD_FILE);
  const [p1, p2] = card.children;
  const base = asFile(card);
  assert.equal(base, CARD_FILE);
  beginInside(card); rememberInside(card);
  p1.innerHTML = 'Made by hand, in Leeds.';
  p2.remove();                              // the person deleted the second paragraph
  settleInside(card);
  const staged = asFile(card);
  assert.equal(staged, '<p class="reveal">Made by hand, in Leeds.</p>');
  writeInside(card, staged);
  assert.equal(card.innerHTML, '<p class="reveal is-inview">Made by hand, in Leeds.</p>', 'on the page it still shows');
  writeInside(card, base);                  // Undo
  assert.deepEqual(card.children, [p1, p2]);
  assert.equal(card.innerHTML, CARD_LIVE);
  assert.equal(asFile(card), CARD_FILE);
});

test('a fade-in card: a paragraph the page never had takes the class its neighbours were given, on the page only', () => {
  const card = page(`<div class="card" data-cms="about">${CARD_LIVE}</div>`);
  noteInside(card, CARD_FILE);
  const three = `${CARD_FILE}<p class="reveal">Returns within 30 days.</p>`;   // an older version, from History
  writeInside(card, three);
  assert.equal(card.children[2].getAttribute('class'), 'reveal is-inview');
  assert.equal(asFile(card), three);
});

test('a fade-in card: a draft is put back on a part that has not faded in yet, and still fades in', () => {
  // below the fold after a reload: the script has not added its class yet, and is still watching these elements
  const card = page(`<div class="card" data-cms="about">${CARD_FILE}</div>`);
  noteInside(card, CARD_FILE);
  const [p1, p2] = card.children;
  writeInside(card, '<p class="reveal">Made by hand, in Leeds.</p><p class="reveal">Shipped on Tuesdays.</p>');
  assert.deepEqual(card.children, [p1, p2], 'the elements the script is watching');
  p1.setAttribute('class', 'reveal is-inview');   // scrolled into view
  assert.equal(asFile(card), '<p class="reveal">Made by hand, in Leeds.</p><p class="reveal">Shipped on Tuesdays.</p>');
});

test('a line a browser made by copying another (Enter in the middle of a line) is published as its original is', () => {
  const h1 = H1(SETTLED);
  noteInside(h1, FILE);
  beginInside(h1);
  const copy = h1.children[0].cloneNode(false);    // what a browser does when a line is split
  copy.innerHTML = 'New line.';
  h1.insertBefore(copy, h1.children[1]);
  settleInside(h1);
  assert.equal(asFile(h1), '<span class="hero-line block">Soft shirts.</span><span class="hero-line block">New line.</span><span class="hero-line block">Strong opinions.</span>');
});

test('words typed with formatting the file never had are published as typed', () => {
  const p = page('<p data-cms="intro">Plain words.</p>');
  noteInside(p, 'Plain words.');
  beginInside(p);
  p.innerHTML = 'Plain <b>bold</b> <span class="text-accent" style="font-size: 2em;">big</span> words.';
  settleInside(p);
  assert.equal(asFile(p), 'Plain <b>bold</b> <span class="text-accent" style="font-size: 2em;">big</span> words.');
});

test('a page that does not read as its file does is paired only where an element is plainly the file\'s', () => {
  // the page is older than the file: other words, and one line has another class
  const h1 = H1('<span class="hero-line block is-inview">Old words.</span><span class="tagline is-inview">Older still.</span>');
  assert.equal(noteInside(h1, FILE), 1);
  assert.equal(asFile(h1), '<span class="hero-line block">Old words.</span><span class="tagline is-inview">Older still.</span>');
});

// ─── A list: the inside of a block's fields ──────────────────────────────────

test('a list: what a script put inside a block\'s field is not published either', () => {
  const FILE_LIST = '<a class="card reveal" href="/a"><h3 data-cms="name"><span class="word">Mend</span></h3></a>';
  const list = page('<div data-cms-repeat="products"><a class="card reveal is-inview" href="/a"><h3 data-cms="name" class="kiln-field"><span class="word" style="opacity: 1; transform: none;">Mend</span></h3></a></div>');
  assert.equal(noteList(list, FILE_LIST), 1);
  const copy = list.cloneNode(true);
  fileTrue(copy, list);
  assert.equal(copy.innerHTML, FILE_LIST);
  // the words changed in the editor, the scripts' leftovers still there
  const h3 = list.children[0].children[0];
  beginInside(h3);
  h3.children[0].innerHTML = 'Mend (Patch)';
  settleInside(h3);
  const after = list.cloneNode(true);
  fileTrue(after, list);
  assert.equal(after.innerHTML, FILE_LIST.replace('Mend', 'Mend (Patch)'));
});

// ─── A picture that is a field ───────────────────────────────────────────────

test('a picture: the size it was dragged to is published, and what a script put on it is not', () => {
  const img = page('<img data-cms="hero_img" data-cms-attr="src" src="/img/hero.jpg" class="lazy loaded" style="opacity: 1; transform: translate3d(0px, -34px, 0px);">');
  noteAs(img, page('<img data-cms="hero_img" data-cms-attr="src" src="/img/hero.jpg" class="lazy">'));
  assert.equal(ownStyle(img), null, 'untouched: the file has no style, so none is written');
  beginOn(img);                                         // its toolbar opens
  setStyle(img, { width: '300px', height: 'auto' });    // the corner is dragged
  setStyle(img, { transform: 'translate3d(0px, -51px, 0px)' });   // and the page's parallax moves on
  assert.equal(ownStyle(img), 'width: 300px; height: auto;');
  settleOn(img);                                        // staged
  setStyle(img, { width: '360px' });                    // dragged again, the toolbar still open
  assert.equal(ownStyle(img), 'width: 360px; height: auto;');
  settleOn(img);
  endOn(img);
  setStyle(img, { transform: 'translate3d(0px, -80px, 0px)', opacity: '0.9' });   // later, scripts only
  assert.equal(ownStyle(img), 'width: 360px; height: auto;');
  // Undo of the resize: the size goes, what the scripts put there stays on the page
  showStyle(img, '');
  assert.equal(img.getAttribute('style'), 'opacity: 0.9; transform: translate3d(0px, -80px, 0px);');
  assert.equal(ownStyle(img), null);
  // and Redo
  showStyle(img, 'width: 360px; height: auto;');
  assert.equal(img.getAttribute('style'), 'width: 360px; height: auto; opacity: 0.9; transform: translate3d(0px, -80px, 0px);');
  assert.equal(ownStyle(img), 'width: 360px; height: auto;');
});

test('a picture in a list: its size is the person\'s, on top of the file\'s style, and a script\'s fade is not published', () => {
  const FILE_LIST = '<figure><img data-cms="photo" data-cms-attr="src" src="/a.jpg" style="border-radius:8px"></figure>';
  const list = page('<div data-cms-repeat="photos"><figure><img data-cms="photo" data-cms-attr="src" src="/a.jpg" class="kiln-field" style="border-radius: 8px; opacity: 1;"></figure></div>');
  assert.equal(noteList(list, FILE_LIST), 1);
  const out = () => { const copy = list.cloneNode(true); fileTrue(copy, list); return copy.innerHTML; };
  assert.equal(out(), FILE_LIST, 'untouched: the file\'s own text');
  const img = list.children[0].children[0];
  beginOn(img);
  setStyle(img, { width: '240px', height: 'auto' });
  assert.equal(out(), FILE_LIST.replace('style="border-radius:8px"', 'style="border-radius: 8px; width: 240px; height: auto;"'));
});

// ─── What Undo goes back to is read when the person begins ───────────────────

test('a picture a lazy loader swaps: Undo of a new picture goes back to the one that was showing', () => {
  const img = page('<img data-cms="hero_img" data-cms-attr="src" src="/dot.gif" data-src="/img/hero.webp" alt="">');
  const stage = { pending: new Map(), undoBase: new Map(), undoBaseAttrs: new Map() };
  takeBase(stage, 'hero_img', { attrs: readAttrs(img) });           // as the editor starts
  assert.deepEqual(stage.undoBaseAttrs.get('hero_img'), { src: '/dot.gif', alt: '' });
  assert.deepEqual(readAttrs(img, null), { src: '/dot.gif', alt: '', style: '' }, 'its size has a baseline too, as the file would hold it');
  img.setAttribute('src', '/img/hero.webp');                         // the loader has done its work
  img.setAttribute('alt', 'A shirt on a line');
  takeBase(stage, 'hero_img', { attrs: readAttrs(img) });           // the person opens the picture
  assert.deepEqual(stage.undoBaseAttrs.get('hero_img'), { src: '/img/hero.webp', alt: 'A shirt on a line' });
  // a new picture is waiting: opening it again does not move what Undo goes back to
  stage.pending.set('hero_img', { attrs: { src: '/assets/uploads/new.webp' } });
  img.setAttribute('src', 'blob:new');
  img.setAttribute('alt', 'Changed');
  takeBase(stage, 'hero_img', { attrs: readAttrs(img) });
  assert.deepEqual(stage.undoBaseAttrs.get('hero_img'), { src: '/img/hero.webp', alt: 'Changed' }, 'the description has no change waiting, so it follows the page');
});

test('a link and a field\'s words: the baseline follows the page until a change is waiting', () => {
  const a = page('<a data-cms="cta" href="#">Shop</a>');
  const stage = { pending: new Map(), undoBase: new Map(), undoBaseAttrs: new Map() };
  takeBase(stage, 'cta', { html: 'Shop', attrs: readAttrs(a) });
  a.setAttribute('href', '/shop?utm=1');                             // a script rewrote the address
  takeBase(stage, 'cta', { html: 'Shop all', attrs: readAttrs(a) });
  assert.equal(stage.undoBase.get('cta'), 'Shop all');
  assert.deepEqual(stage.undoBaseAttrs.get('cta'), { href: '/shop?utm=1' });
  stage.pending.set('cta', { html: 'Shop now' });
  takeBase(stage, 'cta', { html: 'Shop now', attrs: { href: '/elsewhere' } });
  assert.equal(stage.undoBase.get('cta'), 'Shop all', 'words are waiting: their baseline stays');
  assert.deepEqual(stage.undoBaseAttrs.get('cta'), { href: '/elsewhere' }, 'the address is not: it follows');
  // nothing to read (a part with no attribute of its own)
  assert.deepEqual(readAttrs(page('<h1 data-cms="t">x</h1>')), null);
});

// ─── Where it is used ────────────────────────────────────────────────────────

test('wired: a field is published through what the file says, and written without making its elements new', () => {
  // the one function a field's published HTML comes from
  const committed = main.slice(main.indexOf('function committedHtml('), main.indexOf('// ─── Images'));
  assert.match(committed, /const clone = el\.cloneNode\(true\);\s*\n\s*insideAsFile\(clone, el\);/);
  // every place that puts a field's HTML on the page: Undo, Redo, Esc, Drop, History, a draft, the saved copy, the demo's own
  assert.equal(/\bel\.innerHTML\s*=\s*(html|value|v\.html|pendingEdit|activeOriginalHtml)/.test(main), false, 'a field is written with innerHTML');
  const apply = main.slice(main.indexOf('function applyKeyDom('), main.indexOf('function applyUndoStep('));
  assert.match(apply, /writeInside\(el, html\)/);
  const demo = main.slice(main.indexOf('function applySandboxEdits('), main.indexOf('function restoreSandboxPage('));
  assert.match(demo, /writeInside\(el, v\.html\)/);
  const esc = main.slice(main.indexOf('function cancelEditing('), main.indexOf('function stagePending('));
  assert.match(esc, /writeInside\(el, /);
  // the file's fields are noted when the page's file is read, as its lists are
  const load = main.slice(main.indexOf('async function loadPageSource('), main.indexOf('/** Auth headers for worker endpoints'));
  assert.match(load, /noteFileFields\(\);/);
});

test('wired: what Undo goes back to is taken when the person begins, never only when the editor starts', () => {
  const start = main.slice(main.indexOf('function startEditing('), main.indexOf('function cancelEditing('));
  assert.match(start, /beginKey\(key, el\);/);
  assert.ok(start.indexOf('beginKey(key, el);') < start.indexOf("el.contentEditable = 'true'"), 'before anything can be typed');
  const image = main.slice(main.indexOf('function imageToolbar('), main.indexOf('function enableImageDragResize('));
  assert.match(image, /beginKey\(key, img\);/);
  // and for a list, before any of its buttons acts
  assert.match(main, /document\.addEventListener\('pointerdown', beginUnder, true\);/);
  // the copy made as the editor starts is of what the file says, so the state of an animation is not in it
  const decorate = main.slice(main.indexOf('function decorateField('), main.indexOf('function fieldHint('));
  assert.equal(/undoBase\.set\(key, el\.innerHTML\)/.test(decorate), false);
  assert.equal(/state\.originals/.test(main), false, 'the second early copy is gone: a field is unchanged when it reads as its baseline does');
});
