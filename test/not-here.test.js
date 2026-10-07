/**
 * A tap on something that cannot be changed here (src/editor/not-here.js, and
 * where main.js uses it).
 *
 * In the demo the same shirt is shown twice: in a row of six at the top,
 * which nobody marked as editable, and in the list of all 28, where its name
 * and price are. A tap on the price in the row did nothing a person could
 * read; a tap on the price in the list opened it. Where the editor can tell
 * that what was tapped shows the same thing as a part that can be changed, it
 * says so and offers to go there. It makes nothing editable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findTwin, notHereWords } from '../src/editor/not-here.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const SHOP = 'https://shop.example/shirts/';
const fields = [
  { id: 1, key: 'card_title', list: 'products', words: 'My Therapist Purrs', href: SHOP + 'purrs/' },
  { id: 2, key: 'card_price', list: 'products', words: '$26.99', href: SHOP + 'purrs/' },
  { id: 3, key: 'card_title', list: 'products', words: 'Mend (Patch)', href: SHOP + 'mend/' },
  { id: 4, key: 'card_price', list: 'products', words: '$26.99', href: SHOP + 'mend/' },
  { id: 5, key: 'shirts_headline', list: null, words: 'all 28.', href: null },
  { id: 6, key: 'footer_email', list: null, words: 'Shirts', href: null },
];

test('the same words inside a link to the same place: that is the part to change', () => {
  // the price in the row of six: many parts read "$26.99", one of them belongs to the same shirt
  assert.deepEqual(findTwin({ words: '$26.99', href: SHOP + 'purrs/' }, fields), { field: fields[1], same: 'words' });
  assert.deepEqual(findTwin({ words: ' my therapist  purrs ', href: SHOP + 'purrs/' }, fields), { field: fields[0], same: 'words' });
  // a photo in that card: no words of its own, but the card leads where one editable block leads
  assert.deepEqual(findTwin({ words: '', href: SHOP + 'mend/' }, fields), { field: fields[2], same: 'place' });
});

test('where the editor cannot tell, it says nothing and takes nothing over', () => {
  // the same price with no link to tell the shirts apart
  assert.equal(findTwin({ words: '$26.99', href: null }, fields), null);
  // a link to somewhere no editable part leads
  assert.equal(findTwin({ words: '$26.99', href: SHOP + 'other/' }, fields), null);
  assert.equal(findTwin({ words: '', href: SHOP + 'other/' }, fields), null);
  // the site's own menu: "Shirts" is also a part's words, and a menu link must still go where it goes
  assert.equal(findTwin({ words: 'Shirts', href: '/shirts/', nav: true }, fields), null);
  assert.equal(findTwin({ words: 'Shirts', href: null, nav: true }, fields), null);
  // nothing tapped, or a whole section's worth of words
  assert.equal(findTwin({ words: '', href: null }, fields), null);
  assert.equal(findTwin({ words: 'x'.repeat(400), href: null }, fields), null);
});

test('words that only one editable part has, outside any link, are that part', () => {
  assert.deepEqual(findTwin({ words: 'all 28.', href: null }, fields), { field: fields[4], same: 'words' });
});

test('what the line says, without a dash or a shout, and never that the copy will change too', () => {
  const words = notHereWords({ same: 'words', name: 'Card price', list: 'Products' });
  assert.equal(words, 'This copy can’t be changed here. The same words can, in Products.');
  assert.equal(notHereWords({ same: 'words', name: 'Shirts headline', list: null }), 'This copy can’t be changed here. The same words can, in “Shirts headline”.');
  assert.equal(notHereWords({ same: 'place', name: 'Card title', list: 'Products' }), 'This can’t be changed here. The same item is in Products, where its outlined parts can.');
  assert.equal(notHereWords({ inBlock: true, picture: true }), 'This picture isn’t set up to be changed here. The outlined parts of this block are.');
  assert.equal(notHereWords({ inBlock: true }), 'This isn’t set up to be changed here. The outlined parts of this block are.');
  for (const w of [words, notHereWords({ same: 'place', name: 'x', list: 'y' }), notHereWords({ inBlock: true })]) assert.equal(/[!—–]| - /.test(w), false, w);
});

test('wired: one listener, before the page\'s own, that leaves fields, forms and the editor\'s own parts alone', () => {
  assert.match(main, /document\.addEventListener\('click', tapNotHere, true\);/);
  const fn = main.slice(main.indexOf('function tapNotHere('), main.indexOf('// ─── Repeatable blocks'));
  // never while typing, picking, or with a modifier held (that is how a link is followed in edit mode)
  assert.match(fn, /if \(state\.active \|\| sourceActive \|\| pickMode \|\| e\.metaKey \|\| e\.ctrlKey\) return;/);
  assert.match(fn, /\[data-cms\], \[data-kiln-source\]/);
  // the link is only held back when the editor has somewhere to send the person instead
  assert.ok(fn.indexOf('e.preventDefault();') > fn.indexOf('const twin = findTwin('), 'nothing is prevented before a twin is found');
  assert.equal((fn.match(/e\.preventDefault\(\);/g) || []).length, 1);
});
