/**
 * Search & jump finds what is on the page, and lists nothing that does not
 * hold the word (src/editor/palette.js).
 *
 * In the demo, "faq" (a page of the site, and a link on this one) and
 * "raccoon" (a word in the list of shirts) both answered "Nothing matches.",
 * and "sale" listed the one heading that held it and four that did not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowScore, snippetAt, pagesFromLinks } from '../src/editor/palette.js';

const src = readFileSync(new URL('../src/editor/palette.js', import.meta.url), 'utf8');

test('search: a word is found wherever it stands in a part, however far in', () => {
  const list = 'Mend (Patch) $26.99 A quiet argument, made in thread. '.repeat(12) + 'Wildflower Raccoons $26.99 Trash pandas, but make it botanical.';
  const products = { name: 'Products', text: `Products products ${list}` };
  assert.ok(rowScore('raccoon', products) > 0);
  assert.ok(rowScore('RACCOONS', products) > 0);
  assert.equal(rowScore('ferret', products), -1);
});

test('search: a heading that does not hold the word is not listed', () => {
  const hero = { name: 'Hero headline', text: 'Hero headline hero_headline Big sale this Saturday.' };
  assert.ok(rowScore('sale', hero) > 0);
  // s-a-l-e can be picked out of each of these names letter by letter, which is how they used to be listed
  for (const name of ['Shirts headline', 'Studio headline', 'Colors headline', 'Closing headline', 'Rotation subheading']) {
    assert.equal(rowScore('sale', { name, text: `${name} some other words` }), -1, name);
  }
});

test('search: the first letters of a name\'s words still find it', () => {
  const pic = { name: 'Hero picture', text: 'Hero picture hero_img Garment-dyed tees' };
  assert.ok(rowScore('hpic', pic) >= 0);
  assert.ok(rowScore('hp', pic) >= 0);
  assert.ok(rowScore('ps', { name: 'Page settings', text: 'Page settings' }) >= 0);
  assert.ok(rowScore('fr', { name: 'Find & replace', text: 'Find & replace' }) >= 0);
  assert.equal(rowScore('pgs', { name: 'Page settings', text: 'Page settings' }), -1, 'letters from the middle of a word do not');
  // found as typed ranks above found by first letters
  assert.ok(rowScore('hero', pic) > rowScore('hp', pic));
});

test('search: the row shows the words around what was found', () => {
  const text = 'Mend (Patch) $26.99 A quiet argument, made in thread. Wildflower Raccoons $26.99 Trash pandas, but make it botanical.';
  const at = text.toLowerCase().indexOf('raccoon');
  assert.equal(snippetAt(text, at, 7), '…in thread. Wildflower Raccoons $26.99 Trash pandas,…');
  assert.equal(snippetAt('Big sale this Saturday.', 4, 4), 'Big sale this Saturday.');
});

test('search: without a repository to list, the site\'s pages are the ones this page links to', () => {
  const links = [
    { href: 'http://shop.test/faq/', text: 'FAQ' }, { href: 'http://shop.test/faq/#shipping', text: 'Shipping & returns' },
    { href: 'http://shop.test/#shirts', text: 'Shop all 28' }, { href: 'http://shop.test/shirts/', text: 'Shirts' },
    { href: 'https://elsewhere.test/shirts/mend/', text: 'Mend' }, { href: 'mailto:hello@shop.test', text: 'Email' },
    { href: 'http://shop.test/img/hero.jpg', text: 'Picture' }, { href: 'http://shop.test/kiln', text: 'Sign in' },
    { href: 'http://shop.test/about.html', text: '' },
  ];
  assert.deepEqual(pagesFromLinks(links, 'http://shop.test', '/'),
    [{ url: '/', title: 'this page' }, { url: '/faq/', title: 'FAQ' }, { url: '/shirts/', title: 'Shirts' }, { url: '/about.html', title: '' }]);
});

test('search: the hints at the foot are for a keyboard, and are not shown where there is none', () => {
  assert.match(src, /class="kiln-pal-foot kiln-keys-only"/);
});
