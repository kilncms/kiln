import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { wordDiff, trimDiff, cleanNote, noteMessage, blockNames, blockChange, imageSources, linkProblems,
  itemWarnings, previewOff, setPreviewOff } from '../src/editor/publish-sheet.js';

const flat = (parts) => parts.map(p => (p.t === 'same' ? p.s : p.t === 'del' ? `[-${p.s}-]` : `{+${p.s}+}`)).join(' ');

test('publish sheet: a text change is shown word by word', () => {
  assert.equal(flat(wordDiff('Fresh bread every morning', 'Fresh bread each morning')), 'Fresh bread [-every-] {+each+} morning');
  assert.equal(flat(wordDiff('Soft shirts.', 'Soft shirts. Made in Atlanta.')), 'Soft shirts. {+Made in Atlanta.+}');
  assert.equal(flat(wordDiff('heavy rotation.', '')), '[-heavy rotation.-]');
  assert.equal(flat(wordDiff('', 'New words')), '{+New words+}');
  assert.equal(flat(wordDiff('same  text\nhere', 'same text here')), 'same text here', 'spacing alone is not a change');
  assert.equal(flat(wordDiff('a b c d e', 'a x c y e')), 'a [-b-] {+x+} c [-d-] {+y+} e');
});

test('publish sheet: a long text with one changed word stays cheap and readable', () => {
  const long = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ');
  const parts = wordDiff(long, long.replace('w1500', 'CHANGED'));
  assert.deepEqual(parts.filter(p => p.t !== 'same'), [{ t: 'del', s: 'w1500' }, { t: 'ins', s: 'CHANGED' }]);
  const short = flat(trimDiff(parts));
  assert.equal(short, '… w1494 w1495 w1496 w1497 w1498 w1499 [-w1500-] {+CHANGED+} w1501 w1502 w1503 w1504 w1505 w1506 …');
  // two texts with nothing in common, too large to compare word by word
  const a = Array.from({ length: 500 }, (_, i) => `a${i}`).join(' '), b = Array.from({ length: 500 }, (_, i) => `b${i}`).join(' ');
  assert.deepEqual(wordDiff(a, b).map(p => p.t), ['del', 'ins']);
  assert.deepEqual(trimDiff([{ t: 'same', s: 'nothing changed here at all in this text' }]), [{ t: 'same', s: 'nothing changed here at all in this text' }]);
});

test('publish sheet: the note is one line of plain text with a length limit', () => {
  assert.equal(cleanNote('  New autumn   menu \n and prices '), 'New autumn menu and prices');
  assert.equal(cleanNote('<script>alert(1)</script>Fixed the <b>phone</b> number'), 'alert(1) Fixed the phone number');
  assert.equal(cleanNote('a < b > c'), 'a c', 'anything between angle brackets goes');
  assert.equal(cleanNote('5 > 3 and 2 < 4'), '5 3 and 2 4');
  assert.equal(cleanNote('tab\there' + String.fromCharCode(0, 7, 27) + 'bell'), 'tab here bell');
  assert.equal(cleanNote('zero' + String.fromCharCode(0x200b) + 'width' + String.fromCharCode(0x202e) + 'flip' + String.fromCharCode(0x2028) + 'line'), 'zero width flip line');
  assert.equal(cleanNote('x'.repeat(500)).length, 140);
  assert.equal(cleanNote(null), '');
  assert.equal(cleanNote('Prix d’été: 12 € — café'), 'Prix d’été: 12 € — café', 'ordinary punctuation and accents stay');
});

test('publish sheet: a note becomes the commit message; no note keeps the usual one', () => {
  assert.equal(noteMessage('New autumn menu'), 'New autumn menu (via Kiln)');
  assert.equal(noteMessage('   '), '');
  assert.equal(noteMessage('<b></b>'), '');
  assert.equal(noteMessage(undefined), '');
});

test('publish sheet: the source file holds no raw control characters', () => {
  const src = readFileSync(new URL('../src/editor/publish-sheet.js', import.meta.url), 'utf8');
  const bad = [...src].filter(ch => { const c = ch.codePointAt(0); return (c < 32 && c !== 10) || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || c === 0xfeff; });
  assert.deepEqual(bad, []);
});

test('publish sheet: added and removed blocks are named', () => {
  const card = (title, body = 'Some words') => `<article class="card"><h3>${title}</h3><p>${body}</p></article>`;
  const before = [card('Sourdough'), card('Rye'), card('Baguette')];
  assert.deepEqual(blockNames(before), ['Sourdough', 'Rye', 'Baguette']);
  assert.deepEqual(blockNames(['<li>Just a line of text that is long enough to be cut off somewhere past here</li>', '<figure><img src="/a.png"></figure>', '<div></div>']),
    ['Just a line of text that is long enough to be…', 'a picture', 'an empty block']);
  assert.deepEqual(blockChange(['Sourdough', 'Rye', 'Baguette'], ['Sourdough', 'Rye', 'Baguette', 'Focaccia']), { added: ['Focaccia'], removed: [], moved: false });
  assert.deepEqual(blockChange(['Sourdough', 'Rye', 'Baguette'], ['Sourdough', 'Baguette']), { added: [], removed: ['Rye'], moved: false });
  assert.deepEqual(blockChange(['Sourdough', 'Rye'], ['Rye', 'Sourdough']), { added: [], removed: [], moved: true });
  assert.deepEqual(blockChange(['Rye', 'Rye'], ['Rye', 'Rye', 'Rye']), { added: ['Rye'], removed: [], moved: false }, 'a duplicate counts once');
  assert.deepEqual(blockChange(['A', 'B'], ['A', 'B']), { added: [], removed: [], moved: false });
});

test('publish sheet: pictures in a piece of HTML are read with their descriptions', () => {
  assert.deepEqual(imageSources('<p><img src="/a.png" alt="A loaf"> and <img alt=\'\' src=\'/b.jpg\'><img src=/c.webp></p>'),
    [{ src: '/a.png', alt: 'A loaf' }, { src: '/b.jpg', alt: '' }, { src: '/c.webp', alt: null }]);
  assert.deepEqual(imageSources('<p>No pictures</p>'), []);
});

test('publish sheet: links that go nowhere are found, good ones are left alone', () => {
  const html = `<p><a href="#">Menu</a> <a href="">Empty</a> <a>Nothing</a> <a href="javascript:void(0)">Script</a>
    <a href="#visit">Visit</a> <a href="/menuu">Our menu</a> <a href="about.html">About</a>
    <a href="https://shop.example/x">Shop</a> <a href="mailto:a@b.c">Mail</a> <a href="tel:+1404">Call</a>
    <a href="https://site.example/prices">Prices</a> <a id="top">anchor target</a></p>`;
  const found = linkProblems(html, 'https://site.example');
  assert.deepEqual(found.map(l => [l.text, l.problem]), [
    ['Menu', 'empty'], ['Empty', 'empty'], ['Nothing', 'empty'], ['Script', 'empty'],
    ['Visit', 'anchor'], ['Our menu', 'check'], ['About', 'check'], ['Prices', 'check'],
  ]);
  assert.deepEqual(linkProblems('<p>plain</p>'), []);
});

test('publish sheet: warnings for an empty heading and a picture with no description', () => {
  assert.deepEqual(itemWarnings({ tag: 'H2', afterText: '  ', images: [] }), [{ kind: 'empty-heading', text: 'This heading is empty.' }]);
  assert.deepEqual(itemWarnings({ tag: 'H2', afterText: 'Hello', images: [] }), []);
  assert.deepEqual(itemWarnings({ tag: 'P', afterText: '', images: [] }), [], 'an empty paragraph is not flagged');
  assert.deepEqual(itemWarnings({ tag: 'IMG', afterText: null, images: [{ alt: '', changed: true }] }), [{ kind: 'no-alt', text: 'This picture has no description.' }]);
  assert.deepEqual(itemWarnings({ tag: 'IMG', images: [{ alt: 'A loaf', changed: true }] }), []);
  assert.deepEqual(itemWarnings({ tag: 'DIV', afterText: 'x', images: [{ alt: null, changed: true }, { alt: '', changed: true }, { alt: '', changed: false }] }),
    [{ kind: 'no-alt', text: '2 pictures have no description.' }], 'a picture that was not touched is not flagged');
});

test('publish sheet: "Publish without the preview" is off by default and remembered per browser', () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  assert.equal(previewOff(storage), false);
  setPreviewOff(storage, true);
  assert.equal(previewOff(storage), true);
  assert.equal(store.get('kiln_publish_nopreview'), '1');
  setPreviewOff(storage, false);
  assert.equal(previewOff(storage), false);
  assert.equal(store.size, 0);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(previewOff(blocked), false, 'storage blocked: the preview stays on');
  assert.doesNotThrow(() => setPreviewOff(blocked, true));
});

test('publish sheet: every Publish control opens the sheet; the note reaches each commit', () => {
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  assert.match(main, /#kiln-publish-quick'\)\.onclick = \(e\) => \{ e\.stopPropagation\(\); requestPublish\(\); \}/);
  assert.match(main, /fab\.querySelector\('#kiln-publish'\)\.onclick = close\(requestPublish\)/);
  assert.match(main, /bar\.querySelector\('#kiln-publish'\)\.onclick = requestPublish/);
  assert.match(main, /noteMsg \|\| editCommitMessage\(/);
  assert.match(main, /publishPartials\(partialEdits, noteMsg\)/);
  assert.match(main, /if \(previewOff\(localStorage\)\) return publish\(\)/);
});
