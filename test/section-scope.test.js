/**
 * worker/section-scope.js: the server's own hold on an editor limited to some
 * parts of a page. Pure comparisons of the page's current file with the one
 * being saved; the handler-level tests are in test/worker-section-scope.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSectionWrite, keyInScope, hasSectionLimit, strictUtf8, strictUtf8FromB64, SECTION_CODE } from '../worker/section-scope.js';
import { applyEdits } from '../src/engine.js';

const PAGE = `<!doctype html>
<html><head><title>Bakery</title><meta name="description" content="Fresh bread"></head>
<body>
  <nav data-cms-menu="nav"><a href="/">Home</a> <a href="/menu/">Menu</a></nav>
  <h1 data-cms="hero_title">Fresh every day</h1>
  <p data-cms="hero_body">Since <b>1982</b>.</p>
  <picture><source srcset="/a.webp" type="image/webp"><img data-cms="hero_img" data-cms-attr="src" src="/a.jpg" alt="Bread"></picture>
  <a data-cms="cta" href="/order/">Order</a>
  <p data-cms="price">From $4</p>
  <ul data-cms-repeat="events">
    <li><h3 data-cms="event_title">Open day</h3><p data-cms="event_when">May 1</p></li>
  </ul>
  <ul data-cms-repeat="team">
    <li><h3 data-cms="hero_member">Ana</h3></li>
  </ul>
  <footer><p data-cms="footer_note">© Bakery</p></footer>
</body></html>
`;
const HERO = ['hero_'];
const edit = (edits, src = PAGE) => applyEdits(src, edits).html;
const refused = (r, part) => {
  assert.ok(r, 'refused');
  assert.equal(r.code, SECTION_CODE);
  assert.match(r.error, /Your access covers only some parts of this page|could not be read as plain UTF-8 text/);
  if (part !== undefined) assert.equal(r.part, part);
};

test('keyInScope: exact or prefix; no keys means the whole page; hasSectionLimit only for a real limit', () => {
  assert.equal(keyInScope('hero_title', ['hero_']), true);
  assert.equal(keyInScope('hero', ['hero']), true);
  assert.equal(keyInScope('price', ['hero_']), false);
  assert.equal(keyInScope('price', []), true);
  assert.equal(keyInScope('price', undefined), true);
  assert.equal(hasSectionLimit(['hero_']), true);
  assert.equal(hasSectionLimit([]), false);
  assert.equal(hasSectionLimit(undefined), false);
  assert.equal(hasSectionLimit(['']), false);
});

test('an editor with no section limit is never checked, whatever changes', () => {
  assert.equal(checkSectionWrite(PAGE, '<p>anything at all</p>', []), null);
  assert.equal(checkSectionWrite(PAGE, PAGE.replace('Bakery', 'X'), undefined), null);
  assert.equal(checkSectionWrite(PAGE, null, []), null);
});

test('an unchanged page passes', () => {
  assert.equal(checkSectionWrite(PAGE, PAGE, HERO), null);
});

test('a text edit inside one of the editor’s parts is accepted, markup and all', () => {
  assert.equal(checkSectionWrite(PAGE, edit([{ key: 'hero_title', html: 'Warm <em>bread</em>' }]), HERO), null);
  assert.equal(checkSectionWrite(PAGE, edit([{ key: 'hero_title', html: 'A' }, { key: 'hero_body', html: '' }]), HERO), null);
});

test('a text edit to a part outside the editor’s parts is refused, naming the part', () => {
  const r = checkSectionWrite(PAGE, edit([{ key: 'price', html: 'Free' }]), HERO);
  refused(r, 'price');
  assert.match(r.error, /“price”/);
  // With an allowed edit alongside: still refused.
  refused(checkSectionWrite(PAGE, edit([{ key: 'hero_title', html: 'A' }, { key: 'footer_note', html: 'B' }]), HERO), 'footer_note');
});

test('attribute edits: allowed on the editor’s parts, refused on others, never on data-cms markers or handlers', () => {
  // A picture's src/alt and a link's href on an in-scope part.
  assert.equal(checkSectionWrite(PAGE, edit([{ key: 'hero_img', attr: 'alt', value: 'Loaves' }]), HERO), null);
  assert.equal(checkSectionWrite(PAGE, edit([{ key: 'cta', attr: 'href', value: '/shop/' }]), ['cta']), null);
  // A new attribute the engine inserts.
  assert.equal(checkSectionWrite(PAGE, edit([{ key: 'cta', attr: 'target', value: '_blank' }]), ['cta']), null);
  // A src swap drops the picture's <source> siblings, as the engine does.
  const swapped = edit([{ key: 'hero_img', attr: 'src', value: '/b.jpg' }]);
  assert.doesNotMatch(swapped, /<source/);
  assert.equal(checkSectionWrite(PAGE, swapped, HERO), null);
  // Dropping the <source> without a swap is a change outside.
  refused(checkSectionWrite(PAGE, PAGE.replace(/<source[^>]*>/, ''), HERO));
  // Out-of-scope part: refused.
  refused(checkSectionWrite(PAGE, edit([{ key: 'cta', attr: 'href', value: '/shop/' }]), HERO), 'cta');
  // A handler or a data-cms marker on an in-scope part: refused.
  refused(checkSectionWrite(PAGE, PAGE.replace('<h1 data-cms="hero_title">', '<h1 data-cms="hero_title" onclick="x()">'), HERO), 'hero_title');
  refused(checkSectionWrite(PAGE, PAGE.replace('data-cms-attr="src" src', 'data-cms-attr="alt" src'), HERO), 'hero_img');
});

test('renaming a part, or giving it another key, is refused', () => {
  refused(checkSectionWrite(PAGE, PAGE.replace('data-cms="price"', 'data-cms="hero_price"'), HERO));
  refused(checkSectionWrite(PAGE, PAGE.replace('data-cms="hero_title"', 'data-cms="price2"'), HERO));
  refused(checkSectionWrite(PAGE, PAGE.replace('<h1 data-cms="hero_title">Fresh every day</h1>', '<h2 data-cms="hero_title">Fresh every day</h2>'), HERO));
});

test('whitespace or reordering outside the editor’s parts is refused', () => {
  refused(checkSectionWrite(PAGE, PAGE.replace('\n  <h1', '\n    <h1'), HERO));
  refused(checkSectionWrite(PAGE, PAGE.replace('</body></html>\n', '</body></html>'), HERO));
  const a = '  <h1 data-cms="hero_title">Fresh every day</h1>\n  <p data-cms="hero_body">Since <b>1982</b>.</p>\n';
  const b = '  <p data-cms="hero_body">Since <b>1982</b>.</p>\n  <h1 data-cms="hero_title">Fresh every day</h1>\n';
  refused(checkSectionWrite(PAGE, PAGE.replace(a, b), HERO));
});

test('page settings and the site menu are outside every part, and say so', () => {
  const title = checkSectionWrite(PAGE, PAGE.replace('<title>Bakery</title>', '<title>Cakes</title>'), HERO);
  refused(title, undefined);
  assert.match(title.error, /page’s settings/);
  const desc = checkSectionWrite(PAGE, PAGE.replace('Fresh bread', 'Cakes'), HERO);
  assert.match(desc.error, /page’s settings/);
  const menu = checkSectionWrite(PAGE, PAGE.replace('>Menu</a>', '>Our menu</a>'), ['nav', 'hero_']);
  refused(menu, 'nav');
  assert.match(menu.error, /site menu/);
  // A plain element outside any part.
  const foot = checkSectionWrite(PAGE, PAGE.replace('<footer>', '<footer class="x">'), HERO);
  refused(foot);
  assert.match(foot.error, /<footer>/);
});

test('adding or removing a part is refused', () => {
  refused(checkSectionWrite(PAGE, PAGE.replace('<footer>', '<p data-cms="extra">New</p><footer>'), HERO), 'extra');
  refused(checkSectionWrite(PAGE, PAGE.replace('<p data-cms="price">From $4</p>', ''), HERO), 'price');
  refused(checkSectionWrite(PAGE, PAGE.replace('<p data-cms="hero_body">Since <b>1982</b>.</p>', ''), HERO), 'hero_body');
});

test('a part may not take in a part named for a key from outside the editor’s parts', () => {
  const r = checkSectionWrite(PAGE, edit([{ key: 'hero_body', html: 'Hi <span data-cms="price">Free</span>' }]), HERO);
  refused(r, 'price');
  // An in-scope name inside is fine.
  assert.equal(checkSectionWrite(PAGE, edit([{ key: 'hero_body', html: 'Hi <span data-cms="hero_x">x</span>' }]), HERO), null);
});

test('lists: blocks edited, added and removed inside an in-scope list are accepted; inside an out-of-scope list refused', () => {
  const two = '<li><h3 data-cms="event_title">Open day</h3><p data-cms="event_when">May 1</p></li><li><h3 data-cms="event_title">Bake sale</h3><p data-cms="event_when">June 2</p></li>';
  const added = edit([{ key: 'events', html: `\n    ${two}\n  ` }]);
  assert.equal(checkSectionWrite(PAGE, added, ['events']), null);
  assert.equal(checkSectionWrite(added, PAGE, ['events']), null, 'removing a block');
  assert.equal(checkSectionWrite(PAGE, edit([{ key: 'event_title', html: 'Closed day' }]), ['events']), null);
  refused(checkSectionWrite(PAGE, added, HERO), 'events');
  // A field inside a list is governed by its list, as on the editor's screen:
  // "hero_member" matches hero_ but its list "team" does not.
  refused(checkSectionWrite(PAGE, PAGE.replace('>Ana<', '>Bo<'), HERO), 'team');
  // A list anchor is never an editor's part.
  const list = '<!doctype html><html><head></head><body><ul data-cms-list="posts"><li>a</li></ul></body></html>';
  refused(checkSectionWrite(list, list.replace('<li>a</li>', '<li>b</li><li>a</li>'), ['posts']), 'posts');
});

test('prefix keys: one prefix covers many parts; an exact key covers only itself and keys that start with it', () => {
  assert.equal(checkSectionWrite(PAGE, edit([{ key: 'hero_title', html: 'A' }, { key: 'hero_img', attr: 'alt', value: 'B' }]), ['hero']), null);
  assert.equal(checkSectionWrite(PAGE, edit([{ key: 'price', html: '$5' }]), ['price']), null);
  refused(checkSectionWrite(PAGE, edit([{ key: 'hero_body', html: 'x' }]), ['hero_title']), 'hero_body');
});

test('a page with duplicate keys: the editor’s copies may change, the rest stay', () => {
  const dup = '<!doctype html><html><head></head><body><p data-cms="hero_t">A</p><p data-cms="x">X</p><p data-cms="hero_t">B</p></body></html>';
  assert.equal(checkSectionWrite(dup, dup.replace('>B<', '>C<'), HERO), null);
  assert.equal(checkSectionWrite(dup, dup.replace('>A<', '>C<'), HERO), null);
  refused(checkSectionWrite(dup, dup.replace('>X<', '>Y<'), HERO), 'x');
});

test('nested parts: an in-scope part inside an out-of-scope one may change; the outer one’s own text may not', () => {
  const nest = '<!doctype html><html><head></head><body><div data-cms="card">Intro <h2 data-cms="hero_h">T</h2> end</div></body></html>';
  assert.equal(checkSectionWrite(nest, nest.replace('>T<', '>U<'), HERO), null);
  refused(checkSectionWrite(nest, nest.replace('Intro', 'Outro'), HERO), 'card');
});

test('unparseable or non-text pages are refused safely', () => {
  refused(checkSectionWrite(null, PAGE, HERO));
  refused(checkSectionWrite(PAGE, undefined, HERO));
  // Bytes that are not UTF-8 do not decode; a BOM is kept so its removal counts.
  assert.equal(strictUtf8(new Uint8Array([0x3c, 0x70, 0xff, 0x3e])), null);
  assert.equal(strictUtf8FromB64(Buffer.from([0xc3, 0x28]).toString('base64')), null);
  assert.equal(strictUtf8FromB64('%%%not base64'), null);
  const bom = strictUtf8FromB64(Buffer.from('﻿' + PAGE).toString('base64'));
  assert.equal(bom[0], '﻿');
  refused(checkSectionWrite(bom, PAGE, HERO));
  // Garbage still parses as HTML: a change to it is outside every part.
  refused(checkSectionWrite('<<<>>>', '<<<>>>x', HERO));
});
