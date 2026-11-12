/**
 * The address a new page or post gets from its title
 * (src/editor/page-address.js, and where main.js uses it).
 *
 * A tester called a page "qa-L'été d'Émile à Noël" and got
 * /qa-l-t-d-mile-no-l.html: every accented letter was dropped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plainAddress, pageAddress } from '../src/editor/page-address.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(path.join(ROOT, 'src', 'editor', 'main.js'), 'utf8');

test('an accented letter becomes its plain letter', () => {
  assert.equal(pageAddress('qa-L\'été d\'Émile à Noël'), 'qa-l-ete-d-emile-a-noel');
  assert.equal(pageAddress('Crème brûlée & café'), 'creme-brulee-cafe');
  assert.equal(pageAddress('Año Nuevo en España'), 'ano-nuevo-en-espana');
  assert.equal(pageAddress('Çà et là: Ångström, Zoë, Dvořák'), 'ca-et-la-angstrom-zoe-dvorak');
  // the same letter written as a letter and a separate mark
  assert.equal(pageAddress('été'), 'ete');
});

test('letters that are not a plain letter with a mark are spelled out', () => {
  assert.equal(pageAddress('Straße'), 'strasse');
  assert.equal(pageAddress('Smørrebrød'), 'smorrebrod');
  assert.equal(pageAddress('Ærø og Æbler'), 'aero-og-aebler');
  assert.equal(pageAddress('Œuvres'), 'oeuvres');
  assert.equal(pageAddress('Łódź'), 'lodz');
  assert.equal(pageAddress('Þingvellir, Ísland'), 'thingvellir-island');
  assert.equal(pageAddress('Diyarbakır'), 'diyarbakir');
  // ligatures and full-width letters a keyboard or a paste can bring
  assert.equal(pageAddress('ﬁne ｏｆﬁce'), 'fine-office');
});

test('a plain title gets the address it always got', () => {
  assert.equal(pageAddress('Our Services'), 'our-services');
  assert.equal(pageAddress('  Hello,   World!  '), 'hello-world');
  assert.equal(pageAddress('Top 10 pickles of 2026'), 'top-10-pickles-of-2026');
  assert.equal(pageAddress('--About--'), 'about');
});

test('a long title is cut at 64 letters and never ends in a hyphen', () => {
  const long = pageAddress('a'.repeat(63) + ' b and more words after that');
  assert.equal(long, 'a'.repeat(63));
  assert.ok(pageAddress('é'.repeat(200)).length === 64);
});

test('a title with no letter that can be written plainly still gets an address of its own', () => {
  assert.equal(plainAddress('日本語のページ'), '');
  assert.equal(pageAddress('日本語のページ', { kind: 'page', stamp: 'mwe0s3hw' }), 'page-mwe0s3hw');
  assert.equal(pageAddress('Ελληνικά', { kind: 'post', stamp: 'mwe0s3hx' }), 'post-mwe0s3hx');
  assert.equal(pageAddress('!!! ???', { kind: 'page', stamp: 'MWE 0s' }), 'page-mwe-0s');
  assert.equal(pageAddress('', { kind: 'post', stamp: 'a1' }), 'post-a1');
  // two such titles made at different times do not get the same address
  assert.notEqual(pageAddress('日本', { stamp: 'a1' }), pageAddress('中国', { stamp: 'a2' }));
  // with nothing to tell them apart it is the kind alone, as before
  assert.equal(pageAddress('???', { kind: 'post' }), 'post');
  assert.equal(pageAddress(null), 'page');
  // a title with some plain letters keeps them and needs no stamp
  assert.equal(pageAddress('東京 Tokyo 2026', { stamp: 'zz' }), 'tokyo-2026');
});

test('an address is only ever plain letters, digits and single hyphens', () => {
  for (const t of ['L\'été', 'Straße & Søn', '日本語', 'a/b\\c?d#e', '../../etc/passwd', '<script>', 'İstanbul', 'ǅ ǈ', '½ cup']) {
    assert.match(pageAddress(t, { stamp: 'x1' }), /^[a-z0-9]+(?:-[a-z0-9]+)*$/, t);
  }
});

test('main.js makes the address with it, and passes the time for a title with no plain letters', () => {
  const make = main.slice(main.indexOf('function newContent()'), main.indexOf('function menuEditor()'));
  assert.match(main, /import \{ pageAddress \} from '\.\/page-address\.js';/);
  assert.match(make, /const slug = pageAddress\(title, \{ kind, stamp: Date\.now\(\)\.toString\(36\) \}\);/);
  assert.doesNotMatch(make, /title\.toLowerCase\(\)\.replace\(/);
});
