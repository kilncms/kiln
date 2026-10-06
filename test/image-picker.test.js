import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { inScope, siteImages, filterImages, formatSize, chooseSiteImage } from '../src/editor/image-picker.js';
import { pathInScope } from '../worker/index.js';

const blob = (path, size = 1000) => ({ path, type: 'blob', size });
const TREE = [
  blob('index.html'), blob('assets/kiln.js'),
  blob('img/hero.jpg', 184320), blob('img/team/anna.png', 2 * 1024 * 1024), blob('img/team/ben.webp', 512),
  blob('assets/uploads/img-m1abc.webp', 40000), blob('assets/uploads/master-m1abc.webp', 900000),
  blob('blog/pics/loaf 2.jpg', 5000), blob('blog/pics/loaf 10.jpg', 5000),
  blob('favicon.png'), blob('apple-touch-icon.png'), blob('.github/logo.png'), blob('node_modules/x/y.png'),
  blob('docs/notes.pdf'), { path: 'img', type: 'tree' }, blob('img/icon.svg', 300), blob('img/anim.GIF', 700),
];

test('image picker: the listing is the site\'s pictures, with names, folders and sizes', () => {
  const list = siteImages(TREE);
  assert.deepEqual(list.map(i => i.path), [
    'assets/uploads/img-m1abc.webp', 'blog/pics/loaf 2.jpg', 'blog/pics/loaf 10.jpg',
    'img/anim.GIF', 'img/hero.jpg', 'img/icon.svg', 'img/team/anna.png', 'img/team/ben.webp',
  ], 'no pages, scripts, PDFs, icons, hidden folders, node_modules or kept masters');
  const hero = list.find(i => i.name === 'hero.jpg');
  assert.deepEqual(hero, { path: 'img/hero.jpg', url: '/img/hero.jpg', name: 'hero.jpg', folder: 'img', size: 184320, onPage: false });
  assert.equal(list.find(i => i.name === 'loaf 2.jpg').url, '/blog/pics/loaf%202.jpg', 'the address is safe to put in src');
  assert.deepEqual(siteImages(null), []);
});

test('image picker: pictures used on this page come first, in page order', () => {
  const list = siteImages(TREE, { onPage: ['/img/team/ben.webp', '/img/hero.jpg', '/not/in/repo.png'] });
  assert.deepEqual(list.slice(0, 3).map(i => [i.name, i.onPage]), [['ben.webp', true], ['hero.jpg', true], ['img-m1abc.webp', false]]);
  assert.equal(list.filter(i => i.onPage).length, 2);
});

test('image picker: a site published from a subfolder lists only that folder, with addresses from its root', () => {
  const tree = [blob('site/img/a.png'), blob('site/assets/uploads/img-1.webp'), blob('README-shot.png'), blob('other/b.png')];
  const list = siteImages(tree, { root: 'site/' });
  assert.deepEqual(list.map(i => [i.path, i.url]), [['site/assets/uploads/img-1.webp', '/assets/uploads/img-1.webp'], ['site/img/a.png', '/img/a.png']]);
});

test('image picker: an editor limited to certain folders sees only pictures in them', () => {
  assert.deepEqual(siteImages(TREE, { paths: ['blog'] }).map(i => i.path), ['blog/pics/loaf 2.jpg', 'blog/pics/loaf 10.jpg']);
  assert.deepEqual(siteImages(TREE, { paths: ['img/team', 'assets/uploads'] }).map(i => i.path),
    ['assets/uploads/img-m1abc.webp', 'img/team/anna.png', 'img/team/ben.webp']);
  assert.deepEqual(siteImages(TREE, { paths: ['shop'] }), [], 'nothing outside the grant, even though the tree was readable');
  assert.equal(siteImages(TREE, { paths: [''] }).length, 8, 'a whole-site grant sees everything');
  assert.equal(siteImages(TREE, { paths: [] }).length, 8);
});

test('image picker: the folder rule is the worker\'s own, case for case', () => {
  const cases = [
    ['blog/pics/a.png', ['blog']], ['blog2/a.png', ['blog']], ['blog', ['blog']], ['img/a.png', ['blog', 'img/']], ['a.png', ['']],
    ['a.png', ['**']], ['a.png', []], ['a.png', null], ['x/../blog/a.png', ['blog']], ['./a.png', ['']], ['/blog/a.png', ['/blog/']],
    ['assets/uploads/x.webp', ['blog']], ['assets/uploads/x.webp', ['assets']],
  ];
  for (const [file, paths] of cases) assert.equal(inScope(file, paths), pathInScope(file, paths), `${file} in ${JSON.stringify(paths)}`);
});

test('image picker: search matches every word against the name and the folder', () => {
  const list = siteImages(TREE);
  assert.deepEqual(filterImages(list, 'team').map(i => i.name), ['anna.png', 'ben.webp']);
  assert.deepEqual(filterImages(list, 'LOAF 10').map(i => i.name), ['loaf 10.jpg']);
  assert.deepEqual(filterImages(list, 'img webp').map(i => i.name), ['img-m1abc.webp', 'ben.webp']);
  assert.equal(filterImages(list, '   ').length, list.length);
  assert.deepEqual(filterImages(list, 'zebra'), []);
});

test('image picker: sizes read the way people say them', () => {
  assert.equal(formatSize(184320), '180 KB');
  assert.equal(formatSize(2 * 1024 * 1024), '2.0 MB');
  assert.equal(formatSize(300), '1 KB');
  assert.equal(formatSize(0), '');
});

/** The least of an <img> that chooseSiteImage touches. */
function fakeImg(attrs = {}, repeat = null) {
  const a = { ...attrs }, classes = new Set();
  return { attrs: a, classes,
    getAttribute: (n) => (n in a ? a[n] : null), setAttribute: (n, v) => { a[n] = String(v); }, removeAttribute: (n) => { delete a[n]; },
    classList: { add: (c) => classes.add(c) }, closest: (sel) => (sel === '[data-cms-repeat]' ? repeat : null) };
}

test('image picker: choosing a picture sets the reference an upload would, and commits no file', () => {
  const calls = [];
  const deps = { stagePending: (key, patch) => calls.push(['stagePending', key, patch]), stageContainer: (c, key) => calls.push(['stageContainer', key]), safeUrl: (u) => u };
  const img = fakeImg({ src: 'blob:local-preview', 'data-kiln-src': '/assets/uploads/img-new.webp', 'data-kiln-master': '/assets/uploads/master-new.webp', alt: 'Old' });
  assert.equal(chooseSiteImage(img, 'hero_img', '/img/team/anna.png', deps), true);
  assert.equal(img.attrs.src, '/img/team/anna.png');
  assert.equal(img.attrs['data-kiln-master'], '/img/team/anna.png', 'the file is its own full-size version');
  assert.equal('data-kiln-src' in img.attrs, false, 'an upload that was waiting is no longer what the image points at');
  assert.equal(img.attrs.alt, 'Old', 'the description is not touched');
  assert.ok(img.classes.has('kiln-modified'));
  assert.deepEqual(calls, [['stagePending', 'hero_img', { attrs: { src: '/img/team/anna.png', 'data-kiln-master': '/img/team/anna.png' } }]],
    'one staged attribute change, the same shape an upload stages');
});

test('image picker: a picture inside a list of blocks stages the list, as an upload there does', () => {
  const calls = [];
  const repeat = { getAttribute: () => 'products' };
  const deps = { stagePending: (...a) => calls.push(['stagePending', ...a]), stageContainer: (c, key) => calls.push(['stageContainer', c === repeat, key]), safeUrl: (u) => u };
  chooseSiteImage(fakeImg({ src: '/img/a.png' }, repeat), 'card_img', '/img/hero.jpg', deps);
  assert.deepEqual(calls, [['stageContainer', true, 'products']]);
});

test('image picker: an address that is not safe is refused and nothing is staged', () => {
  const calls = [];
  const img = fakeImg({ src: '/img/a.png' });
  const deps = { stagePending: (...a) => calls.push(a), stageContainer: (...a) => calls.push(a), safeUrl: () => '' };
  assert.equal(chooseSiteImage(img, 'k', 'javascript:alert(1)', deps), false);
  assert.equal(img.attrs.src, '/img/a.png');
  assert.deepEqual(calls, []);
});

test('image picker: the module has no way to queue or commit a file', () => {
  const src = readFileSync(new URL('../src/editor/image-picker.js', import.meta.url), 'utf8');
  for (const word of ['stageBinary', 'pendingBinaries', 'commitFiles', 'putBinaryFile', 'putFile', "'PUT'", "'POST'", "'PATCH'"]) {
    assert.ok(!src.includes(word), `image-picker.js does not mention ${word}`);
  }
  assert.match(src, /deps\.request\('GET', `\/repos\/\$\{deps\.repo\}\/git\/trees\//, 'its one request is a read of the tree');
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  const choose = main.slice(main.indexOf('function replaceImage('), main.indexOf('function pickImage('));
  assert.ok(!choose.includes('stageBinary'), 'the editor\'s choose path stages no file either');
  assert.match(choose, /paths: mode === 'editor' \? \(state\.scope\?\.paths \|\| null\) : null/, 'an editor\'s folders are passed in');
});
