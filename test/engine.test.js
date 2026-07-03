import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexHtml, applyEdits, readValues, pageFileCandidates, editHead, readHead, findNthTag, annotateNthTag, appendIntoNthTag, removeAnnotations } from '../src/engine.js';

test('editHead updates title and inserts/updates meta description', () => {
  const html = '<html><head>\n  <title>Old</title>\n</head><body>x</body></html>';
  const v1 = editHead(html, { title: 'New & Better', description: 'Hello "world"' });
  assert.ok(v1.includes('<title>New &amp; Better</title>'));
  assert.ok(v1.includes('<meta name="description" content="Hello &quot;world&quot;" />'));
  const v2 = editHead(v1, { description: 'Second pass' });
  assert.ok(v2.includes('content="Second pass"'));
  assert.ok(!v2.includes('Hello &quot;world&quot;'));
  const head = readHead(v2);
  assert.equal(head.title, 'New &amp; Better'.replace('&amp;', '&'));
  assert.equal(head.description, 'Second pass');
});

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

test('missing attribute is inserted into the start tag', () => {
  const html = '<img data-cms="pic" src="/a.jpg">';
  const { html: out, applied } = applyEdits(html, [{ key: 'pic', attr: 'alt', value: 'A "nice" photo' }]);
  assert.deepEqual(applied, ['pic']);
  assert.equal(out, '<img data-cms="pic" src="/a.jpg" alt="A &quot;nice&quot; photo">');
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

test('swapping an <img> inside a <picture> strips the shadowing <source> siblings', () => {
  const html = `<picture><source type="image/webp" srcset="old.webp"><img data-cms="hero" data-cms-attr="src" src="old.jpg" alt="x"></picture>`;
  const r = applyEdits(html, [{ key: 'hero', attr: 'src', value: 'new.webp' }]);
  assert.deepEqual(r.skipped, []);
  assert.ok(r.html.includes('src="new.webp"'), 'img src updated');
  assert.ok(!r.html.includes('<source'), 'shadowing <source> removed');
  // A plain <img> (no <picture>) still works and is untouched structurally.
  const plain = applyEdits(`<img data-cms="h" data-cms-attr="src" src="a.jpg">`, [{ key: 'h', attr: 'src', value: 'b.webp' }]);
  assert.ok(plain.html.includes('src="b.webp"'));
});

test('duplicate data-cms keys warn outside a repeat but not inside one', () => {
  assert.equal(indexHtml('<div data-cms-repeat="x"><h3 data-cms="t">a</h3><h3 data-cms="t">b</h3></div>').warnings.length, 0);
  assert.equal(indexHtml('<h3 data-cms="t">a</h3><h3 data-cms="t">b</h3>').warnings.length, 1);
});

test('style attribute: splices size styles, rejects css smuggling', () => {
  const html = '<img data-cms="pic" data-cms-attr="src" src="a.jpg" alt="x">';
  const ok = applyEdits(html, [{ key: 'pic', attr: 'style', value: 'width:50%;height:auto' }]);
  assert.ok(ok.html.includes('style="width:50%;height:auto"'));
  const bad = applyEdits(html, [{ key: 'pic', attr: 'style', value: 'background:url(https://evil.example/x)' }]);
  assert.ok(!bad.html.includes('url('));
  const bad2 = applyEdits(html, [{ key: 'pic', attr: 'style', value: 'behavior:url(#default#time2)' }]);
  assert.ok(!bad2.html.includes('behavior'));
});

test('findNthTag / annotateNthTag: locates and annotates by tree-order index', () => {
  const html = '<body><p>alpha</p><div><p>beta</p></div><p>gamma</p></body>';
  const n1 = findNthTag(html, 'p', 1);
  assert.ok(n1 && html.slice(n1.start, n1.end) === '<p>');
  assert.equal(n1.innerText, 'beta');
  const out = annotateNthTag(html, 'p', 1, ' data-cms="beta_text"');
  assert.ok(out.includes('<div><p data-cms="beta_text">beta</p></div>'));
  assert.equal(annotateNthTag(html, 'p', 9, ' data-cms="x"'), null);
  // self-closing tag: insert lands INSIDE the tag and indexes as a real field
  const img = annotateNthTag('<img src="a.jpg" />', 'img', 0, ' data-cms="pic" data-cms-attr="src"');
  const { fields } = indexHtml(img);
  assert.ok(fields.has('pic'));
  assert.equal(fields.get('pic').tag, 'img');
});

test('removeAnnotations: strips every kiln attribute, preserves the rest', () => {
  const html = '<ul class="books" data-cms-repeat="books" data-kiln-gallery data-kiln-filters><li data-cms="b">x</li></ul>';
  const out = removeAnnotations(html, 'books');
  assert.ok(out.includes('<ul class="books">'));
  assert.ok(out.includes('<li data-cms="b">x</li>'));   // inner field untouched
  const out2 = removeAnnotations(out, 'b');
  assert.ok(out2.includes('<li>x</li>'));
  assert.equal(removeAnnotations(html, 'nope'), null);
});

test('editHead: og:image insert + update, scheme-sanitized', () => {
  const html = '<html><head>\n  <title>T</title>\n</head><body>x</body></html>';
  const v1 = editHead(html, { ogImage: '/assets/social.jpg' });
  assert.ok(v1.includes('<meta property="og:image" content="/assets/social.jpg" />'));
  const v2 = editHead(v1, { ogImage: '/assets/new.jpg' });
  assert.ok(v2.includes('content="/assets/new.jpg"'));
  assert.ok(!v2.includes('social.jpg'));
  assert.equal(readHead(v2).ogImage, '/assets/new.jpg');
  const bad = editHead(html, { ogImage: 'javascript:alert(1)' });
  assert.ok(!bad.includes('javascript:'));
});

test('appendIntoNthTag: inserts before the element closing tag', () => {
  const html = '<body><main><h1>Hi</h1></main></body>';
  const out = appendIntoNthTag(html, 'main', 0, '<section id="new">X</section>');
  assert.ok(out.includes('<h1>Hi</h1><section id="new">X</section></main>'));
  assert.equal(appendIntoNthTag(html, 'main', 5, '<x>'), null);
  // falls back to body when no main
  const nobody = '<body><p>Y</p></body>';
  assert.ok(appendIntoNthTag(nobody, 'body', 0, '<z>Z</z>').includes('<p>Y</p><z>Z</z></body>'));
});
