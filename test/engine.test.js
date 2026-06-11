import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexHtml, applyEdits, readValues, pageFileCandidates } from '../src/engine.js';

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title data-cms="page_title">Maple &amp; Co.</title>
</head>
<body>
  <nav><span class="logo" data-cms="nav_logo">Maple & Co.</span></nav>
  <h1 data-cms="hero_headline">Handcrafted goods made with intention.</h1>
  <p  data-cms="hero_body">We make
    small-batch goods — multi-line, with — dashes & entities.</p>
  <img data-cms="hero_img" data-cms-attr="src" src="img/old.jpg" alt="hero">
  <a href='/contact' class="cta" data-cms="cta">See Our Work</a>
  <footer data-cms="footer">© 2025 Maple &amp; Co. 🌿</footer>
</body>
</html>`;

test('indexHtml finds every key with correct inner ranges', () => {
  const { fields, warnings } = indexHtml(PAGE);
  assert.equal(warnings.length, 0);
  assert.deepEqual([...fields.keys()].sort(),
    ['cta', 'footer', 'hero_body', 'hero_headline', 'hero_img', 'nav_logo', 'page_title'].sort());
  const h1 = fields.get('hero_headline');
  assert.equal(PAGE.slice(h1.inner.start, h1.inner.end), 'Handcrafted goods made with intention.');
  const footer = fields.get('footer');
  assert.equal(PAGE.slice(footer.inner.start, footer.inner.end), '© 2025 Maple &amp; Co. 🌿');
});

test('single edit changes only that region', () => {
  const { html, applied, skipped } = applyEdits(PAGE, [{ key: 'hero_headline', html: 'New headline!' }]);
  assert.deepEqual(applied, ['hero_headline']);
  assert.equal(skipped.length, 0);
  assert.ok(html.includes('<h1 data-cms="hero_headline">New headline!</h1>'));
  // everything before and after the h1 is byte-identical
  const [preOld, postOld] = PAGE.split('Handcrafted goods made with intention.');
  const [preNew, postNew] = html.split('New headline!');
  assert.equal(preNew, preOld);
  assert.equal(postNew, postOld);
});

test('batch edit applies multiple fields in one pass', () => {
  const { html, applied } = applyEdits(PAGE, [
    { key: 'hero_headline', html: 'A' },
    { key: 'footer', html: 'B' },
    { key: 'nav_logo', html: 'C' },
  ]);
  assert.equal(applied.length, 3);
  assert.ok(html.includes('>A</h1>'));
  assert.ok(html.includes('>B</footer>'));
  assert.ok(html.includes('>C</span>'));
});

test('unicode and emoji content keeps offsets honest', () => {
  const { html } = applyEdits(PAGE, [{ key: 'footer', html: '© 2026 — naïve café 日本語 🎉' }]);
  assert.ok(html.includes('<footer data-cms="footer">© 2026 — naïve café 日本語 🎉</footer>'));
  assert.ok(html.trimEnd().endsWith('</html>'));
});

test('attribute splice replaces only the value, escapes quotes', () => {
  const { html, applied } = applyEdits(PAGE, [{ key: 'hero_img', attr: 'src', value: 'img/new "x".webp' }]);
  assert.deepEqual(applied, ['hero_img']);
  assert.ok(html.includes('src="img/new &quot;x&quot;.webp"'));
  assert.ok(html.includes('alt="hero"'));
});

test('single-quoted attribute handled', () => {
  const { html } = applyEdits(PAGE, [{ key: 'cta', attr: 'href', value: "/it's-here" }]);
  assert.ok(html.includes("href='/it&#39;s-here'"));
});

test('void element rejects inner edits with a reason', () => {
  const { skipped } = applyEdits(PAGE, [{ key: 'hero_img', html: 'nope' }]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /no editable inner/);
});

test('unknown key is skipped, not fatal', () => {
  const { applied, skipped } = applyEdits(PAGE, [{ key: 'ghost', html: 'x' }, { key: 'cta', html: 'ok' }]);
  assert.deepEqual(applied, ['cta']);
  assert.equal(skipped[0].key, 'ghost');
});

test('duplicate keys warn and use first occurrence', () => {
  const dupe = '<p data-cms="k">one</p><p data-cms="k">two</p>';
  const { warnings } = indexHtml(dupe);
  assert.match(warnings[0], /duplicate/);
  const { html } = applyEdits(dupe, [{ key: 'k', html: 'EDITED' }]);
  assert.equal(html, '<p data-cms="k">EDITED</p><p data-cms="k">two</p>');
});

test('nested data-cms edited together: inner skipped, outer applied', () => {
  const nested = '<div data-cms="outer">a <b data-cms="inner">deep</b> z</div>';
  const { html, applied, skipped } = applyEdits(nested, [
    { key: 'outer', html: 'OUT' },
    { key: 'inner', html: 'IN' },
  ]);
  assert.deepEqual(applied, ['outer']);
  assert.equal(skipped[0].key, 'inner');
  assert.equal(html, '<div data-cms="outer">OUT</div>');
});

test('nested inner edited alone works fine', () => {
  const nested = '<div data-cms="outer">a <b data-cms="inner">deep</b> z</div>';
  const { html } = applyEdits(nested, [{ key: 'inner', html: 'IN' }]);
  assert.equal(html, '<div data-cms="outer">a <b data-cms="inner">IN</b> z</div>');
});

test('idempotent: re-applying the same edit is a no-op', () => {
  const once = applyEdits(PAGE, [{ key: 'cta', html: 'Same' }]).html;
  const twice = applyEdits(once, [{ key: 'cta', html: 'Same' }]).html;
  assert.equal(once, twice);
});

test('sloppy hand-written HTML: splice does not reformat the rest', () => {
  const sloppy = `<HTML><Body bgcolor=white>
  <P data-cms="msg">old text
  <p>unclosed paragraphs everywhere
  <div CLASS=weird  spacing = "yes" >stuff</div>`;
  const { html } = applyEdits(sloppy, [{ key: 'msg', html: 'new text' }]);
  assert.ok(html.includes('new text'));
  assert.ok(html.includes('<div CLASS=weird  spacing = "yes" >stuff</div>'), 'untouched markup preserved verbatim');
  assert.ok(html.startsWith('<HTML><Body bgcolor=white>'));
});

test('prepend inserts at inner start without touching existing content', () => {
  const list = '<div data-cms="posts">\n  <article>old post</article>\n</div>';
  const { html, applied } = applyEdits(list, [{ key: 'posts', prepend: '\n  <article>new post</article>' }]);
  assert.deepEqual(applied, ['posts']);
  assert.equal(html, '<div data-cms="posts">\n  <article>new post</article>\n  <article>old post</article>\n</div>');
});

test('data-cms-list indexes as kind=list and accepts prepend', () => {
  const list = '<div data-cms-list="posts"><article>old</article></div>';
  const { fields } = indexHtml(list);
  assert.equal(fields.get('posts').kind, 'list');
  const { html } = applyEdits(list, [{ key: 'posts', prepend: '<article>new</article>' }]);
  assert.equal(html, '<div data-cms-list="posts"><article>new</article><article>old</article></div>');
});

test('data-cms fields are kind=field', () => {
  const { fields } = indexHtml('<p data-cms="x">hi</p>');
  assert.equal(fields.get('x').kind, 'field');
});

test('repeat and menu containers index with their kinds and accept inner edits', () => {
  const html = '<div data-cms-repeat="cards"><div>a</div><div>b</div></div><nav data-cms-menu="main"><a href="/">Home</a></nav>';
  const { fields } = indexHtml(html);
  assert.equal(fields.get('cards').kind, 'repeat');
  assert.equal(fields.get('main').kind, 'menu');
  const { html: out } = applyEdits(html, [
    { key: 'cards', html: '<div>a</div><div>a-copy</div><div>b</div>' },
    { key: 'main', html: '<a href="/">Home</a>\n<a href="/about.html">About</a>' },
  ]);
  assert.ok(out.includes('a-copy'));
  assert.ok(out.includes('/about.html'));
});

test('readValues returns current source content', () => {
  const vals = readValues(PAGE);
  assert.equal(vals.cta, 'See Our Work');
  assert.equal(vals.hero_img, null); // void element → no inner value
});

test('pageFileCandidates mapping', () => {
  assert.deepEqual(pageFileCandidates('/'), ['index.html']);
  assert.deepEqual(pageFileCandidates('/about/'), ['about/index.html']);
  assert.deepEqual(pageFileCandidates('/about.html'), ['about.html']);
  assert.deepEqual(pageFileCandidates('/about'), ['about.html', 'about/index.html']);
  assert.deepEqual(pageFileCandidates('/blog/my-post.html', 'demo'), ['demo/blog/my-post.html']);
  assert.deepEqual(pageFileCandidates('/', 'demo'), ['demo/index.html']);
});
