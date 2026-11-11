import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageIdentity, mapUrls, fileToHref, cleanPage, rewriteCssUrls, extractRefs, sitemapPages, sitemapIndexChildren, staticLostLines, sameSite, notCopiedLines } from '../cli/rescue.mjs';

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
  assert.ok(html.includes('src="https://site.com/js/app.js"'), 'a kept script is not copied, so it keeps its full address on the old site');
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
  assert.equal((html.match(/src="https:\/\/site\.com\/eager\.jpg"/g) || []).length, 2, 'not copied, so its full address; no double promotion');
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

test('rescue: rewriteCssUrls — assetMap → local, same-site file not copied → full address, off-origin left', () => {
  const css = `@font-face{src:url("https://site.com/f/a.woff2")}
.a{background:url(https://site.com/img/bg.png)}
.b{background:url('/img/rel.png')}
.c{background:url(https://foreign.example/x.png)}
.d{background:url(data:image/gif;base64,AAAA)}`;
  const assetMap = new Map([['https://site.com/f/a.woff2', 'assets/rescued/dddd4444-a.woff2']]);
  const rel = rewriteCssUrls(css, { base: 'https://site.com/site.css', assetMap });
  assert.ok(rel.css.includes('url("/assets/rescued/dddd4444-a.woff2")'));
  assert.ok(rel.css.includes('url(https://site.com/img/bg.png)'), 'not copied: a root-relative path would find nothing in the copy');
  assert.ok(rel.css.includes("url('https://site.com/img/rel.png')"));
  assert.deepEqual(rel.leftBehind, ['https://site.com/img/bg.png', 'https://site.com/img/rel.png']);
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

// ─── sitemaps (WordPress and Yoast publish an index of child sitemaps) ────────

const SM_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://site.com/wp-sitemap-posts-post-1.xml</loc></sitemap>
<sitemap><loc> https://site.com/wp-sitemap-pages-1.xml </loc></sitemap>
<sitemap><loc>https://site.com/wp-sitemap-posts-post-1.xml</loc></sitemap>
<sitemap><loc>https://evil.com/wp-sitemap.xml</loc></sitemap>
</sitemapindex>`;

test('rescue: sitemapIndexChildren — same-origin children once each; a plain sitemap gives []', () => {
  assert.deepEqual(sitemapIndexChildren(SM_INDEX, SITE), [
    'https://site.com/wp-sitemap-posts-post-1.xml',
    'https://site.com/wp-sitemap-pages-1.xml',
  ]);
  assert.deepEqual(sitemapIndexChildren('<urlset><url><loc>https://site.com/a</loc></url></urlset>', SITE), []);
  // an index lists only .xml files, so sitemapPages finds no pages in it
  assert.deepEqual(sitemapPages(SM_INDEX, SITE), []);
});

test('rescue: sitemapPages reads a WordPress child sitemap; image:loc noise ignored', () => {
  const child = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>https://site.com/menu?utm=x&amp;b=2</loc><image:image><image:loc>https://site.com/img/pic.jpg</image:loc></image:image></url>
  <url><loc>https://site.com/about/</loc></url></urlset>`;
  assert.deepEqual(sitemapPages(child, SITE), ['/menu', '/about']);
});

// ─── WordPress head cruft ────────────────────────────────────────────────────

test('rescue: cleanPage strips WordPress machinery links, keeps profile + icon', () => {
  const wp = `<!DOCTYPE html><html><head>
<link rel="pingback" href="https://site.com/xmlrpc.php">
<link rel="EditURI" type="application/rsd+xml" href="https://site.com/xmlrpc.php?rsd">
<link rel="wlwmanifest" type="application/wlwmanifest+xml" href="https://site.com/wp-includes/wlwmanifest.xml">
<link rel="shortlink" href="https://site.com/?p=42">
<link rel="https://api.w.org/" href="https://site.com/wp-json/">
<link rel="alternate" type="application/json+oembed" href="https://site.com/wp-json/oembed/1.0/embed?url=x">
<link rel="alternate" type="application/rss+xml" title="Feed" href="https://site.com/feed/">
<link rel="profile" href="https://gmpg.org/xfn/11">
<link rel="icon" href="/favicon.ico">
</head><body><p>hi</p></body></html>`;
  const r = cleanPage(wp, { baseUrl: 'https://site.com/' });
  for (const gone of ['pingback', 'EditURI', 'wlwmanifest', 'shortlink', 'api.w.org', 'oembed', 'rss+xml']) {
    assert.ok(!r.html.includes(gone), `${gone} should be stripped`);
  }
  assert.ok(r.html.includes('gmpg.org/xfn/11'), 'profile link survives');
  assert.ok(r.html.includes('favicon.ico'), 'icon survives');
  assert.ok(r.cruft >= 7, `counted ${r.cruft} cruft removals`);
});

// ─── staticLostLines (what a plain crawl cost) ───────────────────────────────

test('rescue: staticLostLines — dead forms, outside forms, search, comments, old sign-in', () => {
  const page = `<html><body>
<form id="contact" action="/wp-admin/admin-post.php" method="post">
  <input name="name"><input name="email"><textarea name="msg"></textarea>
  <input type="hidden" name="action" value="contact">
</form>
<form class="newsletter" action="https://app.formspree.io/f/abc" method="post"><input name="email"></form>
<form role="search" action="/" method="get"><input name="s"></form>
<form action="https://site.com/wp-comments-post.php" method="post"><textarea name="comment"></textarea></form>
<a href="https://site.com/wp-login.php">Log in</a>
</body></html>`;
  const L = staticLostLines([{ href: '/', html: page }], 'https://site.com');
  const text = L.join('\n');
  assert.ok(text.includes('## What freezing cost'));
  assert.ok(/Forms that posted into the old site: 1\b/.test(text), 'one dead form');
  assert.ok(text.includes('"contact" (3 fields, posted to /wp-admin/admin-post.php)'), text);
  assert.ok(text.includes('posts to app.formspree.io'), 'outside form named by host');
  assert.ok(text.includes('Search boxes on /'));
  assert.ok(text.includes('Comment threads on /'));
  assert.ok(text.includes('wp-login'));
  assert.deepEqual(staticLostLines([{ href: '/', html: '<html><body><p>hi</p></body></html>' }], 'https://site.com'), []);
});

// ─── one site, whatever the address says ─────────────────────────────────────

test('rescue: http and https, with or without www., are one site', () => {
  assert.ok(sameSite('http://info.cern.ch/a', 'https://info.cern.ch/'));
  assert.ok(sameSite('https://www.site.com/', 'http://site.com/'));
  assert.ok(!sameSite('https://site.com.evil.example/', 'https://site.com/'));
  assert.ok(!sameSite('https://blog.site.com/', 'https://site.com/'));
  assert.equal(pageIdentity('http://site.com/hypertext/Who.html', SITE), '/hypertext/Who.html', 'http link on an https site is a page of it');
  assert.equal(pageIdentity('https://www.site.com/about/', SITE), '/about');
  const { pages, assets } = extractRefs('<a href="http://site.com/old">o</a><a href="https://www.site.com/w">w</a><img src="http://www.site.com/p.jpg">', 'https://site.com/');
  assert.deepEqual(pages, ['/old', '/w']);
  assert.deepEqual(assets, ['https://site.com/p.jpg'], 'one file, written the way the site writes itself');
  const { html } = cleanPage('<a href="http://site.com/old">o</a><img src="http://www.site.com/p.jpg">', {
    baseUrl: 'https://site.com/', pageMap: new Map([['/old', 'old/index.html']]),
    assetMap: new Map([['https://site.com/p.jpg', 'assets/rescued/1234abcd-p.jpg']]) });
  assert.ok(html.includes('href="/old/"'), 'the other scheme still finds the copied page');
  assert.ok(html.includes('src="/assets/rescued/1234abcd-p.jpg"'), 'and the copied picture');
  assert.deepEqual(sitemapPages('<urlset><loc>http://site.com/a</loc></urlset>', SITE), ['/a']);
});

// ─── files the copy did not take ─────────────────────────────────────────────

test('rescue: a same-site file that was not copied keeps its full address everywhere', () => {
  const raw = `<html><head><link rel="stylesheet" href="/big.css"><link rel="preload" href="/f.woff2" as="font"></head><body>
    <img src="/big.jpg" srcset="/big.jpg 1x, /big-2x.jpg 2x"><a href="/brochure.pdf">PDF</a><a href="/about">About</a>
    <video src="/clip.mp4" poster="/poster.jpg"></video><div style="background:url('/bg.png')"></div></body></html>`;
  const { html, leftBehind } = cleanPage(raw, { baseUrl: 'https://site.com/', assetMap: new Map() });
  for (const want of ['href="https://site.com/big.css"', 'href="https://site.com/f.woff2"', 'src="https://site.com/big.jpg"',
    'srcset="https://site.com/big.jpg 1x, https://site.com/big-2x.jpg 2x"', 'href="https://site.com/brochure.pdf"',
    'src="https://site.com/clip.mp4"', 'poster="https://site.com/poster.jpg"', "url('https://site.com/bg.png')"]) {
    assert.ok(html.includes(want), want);
  }
  assert.ok(html.includes('href="/about"'), 'a page link stays a path on the new site');
  assert.ok(leftBehind.includes('https://site.com/big.jpg') && leftBehind.includes('https://site.com/brochure.pdf'));
});

test('rescue: notCopiedLines names the biggest files, the command to copy them, and the warning', () => {
  const MB = 1024 * 1024;
  const L = notCopiedLines([
    { url: 'https://site.com/wp-content/uploads/hero.jpg', reason: 'the limit for the whole run was reached', bytes: 3 * MB, capped: true },
    { url: 'https://site.com/wp-content/uploads/film.mp4', reason: 'bigger than the limit for one file', bytes: 40 * MB, tooBig: true },
    { url: 'https://site.com/menu.pdf', reason: 'a kind of file the rescue does not copy' },
  ], { url: 'https://site.com', args: { out: 'my copy', 'max-pages': '80', render: true }, totalBytes: 250 * MB, maxAssetBytes: 20 * MB, maxTotalBytes: 250 * MB, capped: true }).join('\n');
  assert.match(L, /## Files not copied/);
  assert.match(L, /3 files used by these pages were not copied/);
  assert.match(L, /will disappear from your pages/);
  assert.match(L, /limit of 250\.0 MB for the whole run/);
  assert.ok(L.indexOf('film.mp4, 40.0 MB') < L.indexOf('hero.jpg, 3.0 MB'), 'largest first');
  assert.match(L, /npx github:kilncms\/kiln#release rescue https:\/\/site\.com --out='my copy' --max-pages=80 --render --max-total-mb=\d+ --max-asset-mb=25/);
  assert.match(L, /Cloudflare Pages does not accept a file that big/);
  assert.deepEqual(notCopiedLines([], {}), []);
});

test('rescue: hitting the size limit leaves no broken pictures and says so in RESCUE-REPORT.md', async (t) => {
  const pic = (n) => Buffer.alloc(n, 1);
  const files = {
    '/': ['text/html', '<html><head><title>Shop</title><link rel="stylesheet" href="/s.css"></head><body><h1>Hi</h1><img src="/a.jpg"><img src="/b.jpg"></body></html>'],
    '/s.css': ['text/css', 'body{background:url(/bg.png)}'],
    '/a.jpg': ['image/jpeg', pic(2000)], '/b.jpg': ['image/jpeg', pic(3000)], '/bg.png': ['image/png', pic(900)],
  };
  const server = createServer((req, res) => {
    const f = files[req.url];
    if (!f) { res.writeHead(404); return res.end(); }
    const body = Buffer.from(f[1]);
    res.writeHead(200, { 'content-type': f[0], 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const site = `http://127.0.0.1:${server.address().port}`;
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'kiln-rescue-cap-')), 'copy');
  t.after(() => rmSync(path.dirname(out), { recursive: true, force: true }));
  const CLI = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
  const { code, stdout } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'rescue', site, `--out=${out}`, '--delay=0', '--no-tag', '--max-total-mb=0.002'], { env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stdout += d; });
    child.on('close', code => resolve({ code, stdout }));
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /will disappear when the old site is switched off/);
  assert.doesNotMatch(stdout, /keep their original URLs/);
  const page = readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(page.includes(`src="${site}/b.jpg"`), 'the picture left behind points at the old site, not at a missing /b.jpg');
  assert.ok(!/src="\/(a|b)\.jpg"/.test(page), 'no root-relative path to a file that is not in the copy');
  const css = readFileSync(path.join(out, 'assets', 'rescued', readFileSync(path.join(out, 'index.html'), 'utf8').match(/rescued\/([^"]+\.css)/)[1]), 'utf8');
  assert.ok(css.includes(`url(${site}/bg.png)`), 'inside a copied stylesheet too');
  const report = readFileSync(path.join(out, 'RESCUE-REPORT.md'), 'utf8');
  assert.match(report, /## Files not copied/);
  assert.match(report, /b\.jpg, 3 KB/, 'named with its size');
  assert.match(report, /will disappear from your pages/);
  assert.match(report, new RegExp(`rescue ${site.replace(/[.:/]/g, '\\$&')} --out=\\S+ --delay=0 --no-tag --max-total-mb=\\d+`));
});
