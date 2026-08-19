import { test } from 'node:test';
import assert from 'node:assert';
import { pageIdentity, mapUrls, fileToHref, cleanPage, rewriteCssUrls, extractRefs } from '../cli/rescue.mjs';

const SITE = 'https://site.com';

// ─── URL → file mapping ──────────────────────────────────────────────────────

test('rescue: pageIdentity strips query/fragment/trailing slash, rejects off-origin + non-http', () => {
  assert.equal(pageIdentity('https://site.com/', SITE), '/');
  assert.equal(pageIdentity('https://site.com/about?x=1#team', SITE), '/about');
  assert.equal(pageIdentity('https://site.com/about/', SITE), '/about');
  assert.equal(pageIdentity('/index.html', SITE), '/', '/index.html is the homepage');
  assert.equal(pageIdentity('/blog/index.html', SITE), '/blog');
  assert.equal(pageIdentity('/blog/post-1', SITE), '/blog/post-1');
  assert.equal(pageIdentity('//site.com/a', SITE), '/a');
  assert.equal(pageIdentity('https://other.com/x', SITE), null);
  assert.equal(pageIdentity('mailto:a@b.c', SITE), null);
  assert.equal(pageIdentity('tel:+1555', SITE), null);
  assert.equal(pageIdentity('javascript:void(0)', SITE), null);
});

test('rescue: mapUrls — directory style, .html kept, trailing-slash pages merge', () => {
  const m = mapUrls(['/', '/about', '/blog/post-1', '/legacy.html']);
  assert.equal(m.get('/'), 'index.html');
  assert.equal(m.get('/about'), 'about/index.html');
  assert.equal(m.get('/blog/post-1'), 'blog/post-1/index.html');
  assert.equal(m.get('/legacy.html'), 'legacy.html');
  // /about and /about/ share one identity (pageIdentity), so one file
  assert.equal(mapUrls([pageIdentity('/about/', SITE)]).get('/about'), 'about/index.html');
});

test('rescue: mapUrls — deterministic collision suffixes, first claimant wins', () => {
  const m = mapUrls(['/a b', '/a-b', '/a%20b.html', '/a-b.html']);
  assert.equal(m.get('/a b'), 'a-b/index.html');
  assert.equal(m.get('/a-b'), 'a-b-2/index.html');
  assert.equal(m.get('/a%20b.html'), 'a-b.html');
  assert.equal(m.get('/a-b.html'), 'a-b-2.html');
  // dotdot segments can never escape the output dir
  assert.ok(!mapUrls(['/%2e%2e/etc/passwd']).get('/%2e%2e/etc/passwd').includes('..'));
});

test('rescue: fileToHref — pretty URLs back out of files', () => {
  assert.equal(fileToHref('index.html'), '/');
  assert.equal(fileToHref('about/index.html'), '/about/');
  assert.equal(fileToHref('blog/post-1/index.html'), '/blog/post-1/');
  assert.equal(fileToHref('legacy.html'), '/legacy.html');
});

// ─── cleanPage ───────────────────────────────────────────────────────────────

const PAGE = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="generator" content="Squarespace">
<link rel="preconnect" href="https://cdn.builder.com">
<link rel="dns-prefetch" href="https://tracker.example">
<link rel="preload" as="script" href="/runtime.js">
<link rel="preload" as="style" href="/keep-me.css">
<link rel="stylesheet" href="https://site.com/site.css">
<script src="https://cdn.builder.com/runtime.js"></script>
<script src="https://site.com/js/app.js"></script>
<script>window.BUILDER = {"boot":1};</script>
<script type="application/ld+json">{"@type":"LocalBusiness","name":"Bakery"}</script>
<script type="application/ld+json">{oops not json</script>
</head><body>
<a href="https://site.com/about?ref=nav#team">About</a>
<a href="//site.com/contact/">Contact</a>
<a href="/stay-root-relative">Stay</a>
<a href="https://other.com/external">External</a>
<a href="mailto:hi@site.com">Mail</a>
<img src="https://site.com/img/hero.jpg" srcset="https://site.com/img/hero.jpg 1x, /img/hero@2x.jpg 2x">
<img src="https://stray-cdn.example/pic.png">
<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe>
<noscript><img src="https://www.facebook.com/tr?id=1" height="1"></noscript>
<noscript>Please enable JavaScript to see the map.</noscript>
</body></html>`;

const OPTS = {
  baseUrl: 'https://site.com/',
  pageMap: new Map([['/', 'index.html'], ['/about', 'about/index.html'], ['/contact', 'contact/index.html']]),
  assetMap: new Map([
    ['https://site.com/img/hero.jpg', 'assets/rescued/aaaa1111-hero.jpg'],
    ['https://site.com/img/hero@2x.jpg', 'assets/rescued/bbbb2222-hero-2x.jpg'],
    ['https://site.com/site.css', 'assets/rescued/cccc3333-site.css'],
  ]),
};

test('rescue: cleanPage strips every script but keeps valid JSON-LD', () => {
  const { html, scripts } = cleanPage(PAGE, OPTS);
  assert.ok(!/<script\b(?![^>]*ld\+json)/.test(html), 'runtime scripts gone');
  assert.ok(html.includes('"@type":"LocalBusiness"'), 'valid JSON-LD kept');
  assert.ok(!html.includes('oops not json'), 'unparseable JSON-LD dropped');
  assert.equal(scripts, 4);   // 2 external + inline + broken ld+json
});

test('rescue: cleanPage --keep-scripts keeps scripts, still drops cruft', () => {
  const { html, scripts } = cleanPage(PAGE, { ...OPTS, keepScripts: true });
  assert.equal(scripts, 0);
  assert.ok(html.includes('window.BUILDER'));
  assert.ok(html.includes('src="/js/app.js"'), 'same-origin script src still made root-relative');
  assert.ok(html.includes('src="https://cdn.builder.com/runtime.js"'), 'off-origin script src untouched');
  assert.ok(!html.includes('rel="preconnect"'), 'cruft still stripped');
});

test('rescue: cleanPage strips builder cruft, keeps innocent tags', () => {
  const { html, cruft } = cleanPage(PAGE, OPTS);
  assert.ok(!html.includes('preconnect') && !html.includes('dns-prefetch'));
  assert.ok(!html.includes('runtime.js'), 'preload as=script gone');
  assert.ok(html.includes('/keep-me.css'), 'preload as=style kept');
  assert.ok(!html.includes('generator'), 'meta generator gone');
  assert.ok(!html.includes('googletagmanager'), 'tracker iframe gone');
  assert.ok(!html.includes('facebook.com/tr'), 'noscript pixel gone');
  assert.ok(html.includes('Please enable JavaScript to see the map.'), 'innocent noscript kept');
  assert.ok(cruft >= 6);
});

test('rescue: cleanPage rewrites links — crawled pages to pretty URLs, rest root-relative', () => {
  const { html } = cleanPage(PAGE, OPTS);
  assert.ok(html.includes('href="/about/?ref=nav#team"'), 'crawled page → pretty URL, query+hash kept');
  assert.ok(html.includes('href="/contact/"'), 'protocol-relative crawled page rewritten');
  assert.ok(html.includes('href="/stay-root-relative"'));
  assert.ok(html.includes('href="https://other.com/external"'), 'off-origin link untouched');
  assert.ok(html.includes('href="mailto:hi@site.com"'), 'mailto untouched');
});

test('rescue: cleanPage rewrites assets incl. srcset, reports off-origin leftovers', () => {
  const { html, offOrigin } = cleanPage(PAGE, OPTS);
  assert.ok(html.includes('src="/assets/rescued/aaaa1111-hero.jpg"'));
  assert.ok(html.includes('srcset="/assets/rescued/aaaa1111-hero.jpg 1x, /assets/rescued/bbbb2222-hero-2x.jpg 2x"'));
  assert.ok(html.includes('href="/assets/rescued/cccc3333-site.css"'), 'stylesheet ref localized');
  assert.ok(html.includes('src="https://stray-cdn.example/pic.png"'), 'unlocalized off-origin asset left as-is');
  assert.deepEqual(offOrigin, ['https://stray-cdn.example/pic.png']);
});

test('rescue: cleanPage de-lazifies builder images (data-src promoted to src)', () => {
  const raw = `<html><body>
    <img data-src="https://cdn.builder.com/lazy.jpg" data-image="https://cdn.builder.com/lazy.jpg" data-load="false">
    <img src="/eager.jpg" data-src="/eager.jpg">
    </body></html>`;
  const assetMap = new Map([['https://cdn.builder.com/lazy.jpg', 'assets/rescued/eeee5555-lazy.jpg']]);
  const { html } = cleanPage(raw, { baseUrl: 'https://site.com/', assetMap });
  assert.ok(html.includes('data-src="/assets/rescued/eeee5555-lazy.jpg"'), 'data-src localized');
  assert.ok(html.includes('data-image="/assets/rescued/eeee5555-lazy.jpg"'), 'data-image localized');
  assert.ok(/<img[^>]*data-load[^>]*src="\/assets\/rescued\/eeee5555-lazy\.jpg"/.test(html), 'src promoted from data-src');
  assert.equal((html.match(/src="\/eager\.jpg"/g) || []).length, 2, 'existing src untouched, no double promotion');
});

test('rescue: svg sprite <use> refs collected and rewritten, fragment kept', () => {
  const raw = '<html><body><svg><use xlink:href="/universal/svg/social.svg#instagram"></use></svg></body></html>';
  const { assets } = extractRefs(raw, 'https://site.com/');
  assert.ok(assets.includes('https://site.com/universal/svg/social.svg'), 'sprite collected without fragment');
  const assetMap = new Map([['https://site.com/universal/svg/social.svg', 'assets/rescued/ffff6666-social.svg']]);
  const { html } = cleanPage(raw, { baseUrl: 'https://site.com/', assetMap });
  assert.ok(html.includes('xlink:href="/assets/rescued/ffff6666-social.svg#instagram"'));
});

test('rescue: cleanPage honors and removes <base href>', () => {
  const raw = '<html><head><base href="https://site.com/deep/"></head><body><a href="page">P</a></body></html>';
  const { html } = cleanPage(raw, { baseUrl: 'https://site.com/' });
  assert.ok(html.includes('href="/deep/page"'), 'relative link resolved against base');
  assert.ok(!html.includes('<base'), 'base tag removed');
});

// ─── CSS rewriting ───────────────────────────────────────────────────────────

test('rescue: rewriteCssUrls — same-origin → root-relative, assetMap → local, off-origin left', () => {
  const css = `@font-face{src:url("https://site.com/f/a.woff2")}
.a{background:url(https://site.com/img/bg.png)}
.b{background:url('/img/rel.png')}
.c{background:url(https://foreign.example/x.png)}
.d{background:url(data:image/gif;base64,AAAA)}`;
  const assetMap = new Map([['https://site.com/f/a.woff2', 'assets/rescued/dddd4444-a.woff2']]);
  const rel = rewriteCssUrls(css, { base: 'https://site.com/site.css', assetMap });
  assert.ok(rel.css.includes('url("/assets/rescued/dddd4444-a.woff2")'));
  assert.ok(rel.css.includes('url(/img/bg.png)'));
  assert.ok(rel.css.includes("url('/img/rel.png')"));
  assert.ok(rel.css.includes('url(https://foreign.example/x.png)'));
  assert.ok(rel.css.includes('url(data:image/gif;base64,AAAA)'), 'data: untouched');
  assert.deepEqual(rel.offOrigin, ['https://foreign.example/x.png']);
  // sameDir mode (for CSS written into assets/rescued/) uses the bare filename
  const same = rewriteCssUrls(css, { base: 'https://site.com/site.css', assetMap, sameDir: true });
  assert.ok(same.css.includes('url("dddd4444-a.woff2")'));
});

// ─── reference extraction ────────────────────────────────────────────────────

test('rescue: extractRefs finds same-origin pages and assets on any origin', () => {
  const { pages, assets } = extractRefs(`<html><head>
    <link rel="stylesheet" href="/site.css">
    <link rel="icon" href="/favicon.ico">
    <meta property="og:image" content="https://images.squarespace-cdn.com/og.jpg">
    <style>.x{background:url(/inline-bg.jpg)}</style>
    </head><body>
    <a href="/about/">A</a><a href="/about#x">A2</a><a href="https://other.com/">B</a>
    <a href="/brochure.pdf">PDF</a><a href="mailto:x@y.z">M</a>
    <img src="/img/a.jpg" srcset="/img/a.jpg 1x, https://cdn.example/a@2x.jpg 2x">
    <div style="background:url('/attr-bg.png')"></div>
    </body></html>`, 'https://site.com/');
  assert.deepEqual(pages, ['/about']);
  for (const want of ['https://site.com/site.css', 'https://site.com/favicon.ico',
    'https://images.squarespace-cdn.com/og.jpg', 'https://site.com/inline-bg.jpg',
    'https://site.com/img/a.jpg', 'https://cdn.example/a@2x.jpg', 'https://site.com/attr-bg.png']) {
    assert.ok(assets.includes(want), `missing ${want}`);
  }
});
