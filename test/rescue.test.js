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

// ─── a site drawn by JavaScript, copied without --render ────────────────────

const SHELL = '<!doctype html><html><head><title>Outings</title><link rel="stylesheet" href="/s.css"></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript><script type="module" src="/assets/index-abc.js"></script></body></html>';
const REAL = (title) => `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="/s.css"></head><body><main class="legal"><h1>${title}</h1><p>What we keep about you and why we keep it.</p><a href="/">Back</a></main><script src="/count.js"></script></body></html>`;

/** A site held in a table: path → [content type, body]. Anything else is a 404. */
async function tableSite(t, files) {
  const server = createServer((req, res) => {
    const f = files[new URL(req.url, 'http://x').pathname];
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no'); }
    res.writeHead(f[2] || 200, { 'content-type': f[0], ...(f[3] || {}) });
    res.end(f[1]);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections?.(); server.close(r); }));
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-rescue-site-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { url: `http://127.0.0.1:${server.address().port}`, out: path.join(dir, 'copy') };
}
function rescueRun(args) {
  const CLI = fileURLToPath(new URL('../cli/index.mjs', import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'rescue', ...args], { env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stdout += d; });
    child.on('close', code => resolve({ code, stdout }));
  });
}
const sitemapOf = (site, paths) => ['application/xml', `<?xml version="1.0"?><urlset>${paths.map(p => `<url><loc>${site}${p}</loc></url>`).join('')}</urlset>`];

test('rescue: looksBlank knows an empty shell from a short real page', async () => {
  const { looksBlank } = await import('../cli/rescue.mjs');
  assert.equal(looksBlank(SHELL), true, 'one empty root element and a script');
  assert.equal(looksBlank('<html><body><div id="app"><div class="spinner">Loading...</div></div><script src="/a.js"></script></body></html>'), true, 'a few words of "loading" are not a page');
  assert.equal(looksBlank('<html><body><div id="root"><svg class="spin"><circle r="4"/></svg></div><script>boot()</script></body></html>'), true, 'a drawn spinner is not a page');
  assert.equal(looksBlank(REAL('Privacy')), false);
  assert.equal(looksBlank('<html><body><h1>Thanks!</h1><script src="https://www.googletagmanager.com/gtag/js"></script></body></html>'), false, 'a heading is a page, however short');
  assert.equal(looksBlank('<html><body><div class="hero"><img src="/soon.jpg" alt=""></div><script src="/a.js"></script></body></html>'), false, 'a picture is a page');
  assert.equal(looksBlank('<html><body><div id="root"></div></body></html>'), false, 'no script: nothing would ever fill it in, so it is not called a JavaScript site');
  assert.equal(looksBlank('<html><body><div></div><script type="application/ld+json">{"a":1}</script></body></html>'), false, 'structured data is not a script that draws');
});

test('rescue: a site drawn by JavaScript is not called copied: blank pages are left out, the real ones come across, and the command to use is given', async (t) => {
  const files = { '/': ['text/html', SHELL], '/browse': ['text/html', SHELL], '/events/one': ['text/html', SHELL],
    '/privacy': ['text/html', REAL('Privacy')], '/terms': ['text/html', REAL('Terms')], '/s.css': ['text/css', 'body{margin:0}'] };
  const s = await tableSite(t, files);
  files['/sitemap.xml'] = sitemapOf(s.url, ['/', '/browse', '/privacy', '/terms', '/events/one']);
  const r = await rescueRun([s.url, `--out=${s.out}`, '--delay=0']);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /3 of the 5 pages read from http:\/\/127\.0\.0\.1:\d+ are blank\. This site draws its pages with JavaScript/);
  assert.match(r.stdout, /the 2 pages that have words on them were copied/);
  assert.match(r.stdout, /This copy is not finished: do not put it online as it is\./);
  assert.ok(r.stdout.includes(`npx github:kilncms/kiln#release rescue ${s.url} --render --out=${s.out} --delay=0`), r.stdout);
  assert.match(r.stdout, /npm install playwright-core/);
  assert.match(r.stdout, /\[\d\/50\] \/browse\n\s+blank: nothing is on this page until its JavaScript runs/);
  assert.doesNotMatch(r.stdout, /✅ crawled/, 'no green tick on a copy that is mostly blank');
  assert.doesNotMatch(r.stdout, /Deploy on Cloudflare Pages|gh repo create/, 'nobody is told to push and deploy it');
  const { existsSync } = await import('node:fs');
  for (const f of ['index.html', 'browse/index.html', 'events/one/index.html']) assert.ok(!existsSync(path.join(s.out, f)), `${f} is blank, so it is not written`);
  const privacy = readFileSync(path.join(s.out, 'privacy', 'index.html'), 'utf8');
  assert.match(privacy, /<h1 data-cms="[^"]+">Privacy<\/h1>/);
  assert.ok(readFileSync(path.join(s.out, 'terms', 'index.html'), 'utf8').includes('What we keep about you'));
  const report = readFileSync(path.join(s.out, 'RESCUE-REPORT.md'), 'utf8');
  assert.match(report, /- Pages crawled: 2, written: 2/);
  assert.match(report, /- Blank pages left out: 3 of the 5 read/);
  assert.match(report, /## This copy is not finished/);
  assert.match(report, /- \/browse\n/);
  assert.match(report, /Chrome, Edge, Brave or Chromium on this computer/);
  assert.doesNotMatch(report, /Deploy on Cloudflare Pages/);
  assert.doesNotMatch(r.stdout + report, /—.*blank|blank.*—/, 'no dashes in the new sentences');
});

test('rescue: when every page is blank nothing is written, and --dry says the same', async (t) => {
  const files = { '/': ['text/html', SHELL], '/browse': ['text/html', SHELL] };
  const s = await tableSite(t, files);
  files['/sitemap.xml'] = sitemapOf(s.url, ['/', '/browse']);
  for (const extra of [[], ['--dry']]) {
    const r = await rescueRun([s.url, `--out=${s.out}`, '--delay=0', ...extra]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /All 2 pages read from \S+ are blank\. This site draws its pages with JavaScript, so a plain copy of them is empty pages\. Nothing was written\./);
    assert.ok(r.stdout.includes(`rescue ${s.url} --render`), r.stdout);
    assert.doesNotMatch(r.stdout, /✅|Next steps/);
    const { existsSync } = await import('node:fs');
    assert.ok(!existsSync(s.out), 'no folder is left behind');
  }
});

test('rescue: one blank page on a site of real pages is left out and named, and the copy still counts', async (t) => {
  const home = '<!doctype html><html><head><title>Shop</title></head><body><h1>Shop</h1><p>Bread, cakes and coffee on Mill Lane.</p><a href="/about">About</a> <a href="/app">Order</a></body></html>';
  const s = await tableSite(t, { '/': ['text/html', home], '/about': ['text/html', REAL('About')], '/app': ['text/html', SHELL] });
  const r = await rescueRun([s.url, `--out=${s.out}`, '--delay=0']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /1 of the 3 pages read from \S+ is blank\. This site draws that page with JavaScript, so a plain copy of it is an empty page\. It was left out, and the 2 pages that have words on them were copied\./);
  const report = readFileSync(path.join(s.out, 'RESCUE-REPORT.md'), 'utf8');
  assert.match(report, /## Blank pages left out/);
  assert.match(report, /The blank page:\n\n- \/app\n/);
  assert.match(report, /Deploy on Cloudflare Pages/, 'the usual next steps are still given');
  assert.ok(readFileSync(path.join(s.out, 'index.html'), 'utf8').includes('href="/app"'), 'the link to the page left out is kept as it was');
});

// ─── addresses that lead away from the site ─────────────────────────────────

test('rescue: --max-pages counts every address tried, each skipped one says why, and a site that has mostly moved is named once', async (t) => {
  const other = await tableSite(t, { '/': ['text/html', REAL('Elsewhere')] });
  const moved = Array.from({ length: 15 }, (_, i) => `/m${i + 1}`);
  const home = `<html><head><title>Home</title></head><body><h1>Home</h1><p>Some words here for the page.</p>${moved.map(p => `<a href="${p}">x</a>`).join('')}<a href="/a">A</a><a href="/b">B</a></body></html>`;
  const files = { '/': ['text/html', home], '/a': ['text/html', REAL('A')], '/b': ['text/html', REAL('B')] };
  for (const p of moved) files[p] = ['text/plain', '', 302, { location: `${other.url}${p}` }];
  const s = await tableSite(t, files);
  const host = other.url.replace('http://', '').replace(/\./g, '\\.');

  // the limit is five addresses, and four of them lead away
  const r = await rescueRun([s.url, `--out=${s.out}`, '--delay=0', '--max-pages', '5']);
  assert.equal(r.code, 0, r.stdout);
  for (const n of [1, 2, 3, 4, 5]) assert.equal(r.stdout.split(`[${n}/5] `).length, 2, `one progress line numbered ${n}`);
  assert.doesNotMatch(r.stdout, /\[6\/5\]|\[1\/5\][^\n]*\n[^\n]*\[1\/5\]/);
  assert.match(r.stdout, new RegExp(`\\[2/5\\] /m1\\n\\s+skipped: it has moved to another site, ${host}\\n`));
  assert.match(r.stdout, /crawled 1 page, 4 addresses skipped \(13 more found beyond --max-pages\)/);
  assert.match(r.stdout, new RegExp(`4 of the 5 addresses tried have moved to ${host}, so most of this site lives there now\\. To copy those pages, run the rescue on that address: npx github:kilncms/kiln#release rescue ${other.url.replace(/\./g, '\\.')} --max-pages=5 --delay=0`));
  assert.doesNotMatch(r.stdout, /off-origin →|failed/);
  const report = readFileSync(path.join(s.out, 'RESCUE-REPORT.md'), 'utf8');
  assert.match(report, /- Addresses skipped: 4\. 4 of the 5 addresses tried have moved to /);
  assert.match(report, new RegExp(`  - /m4: it has moved to another site, ${host}\\n`));

  // many skipped: the terminal shows ten and the file keeps them all
  const out2 = s.out + '-2';
  const r2 = await rescueRun([s.url, `--out=${out2}`, '--delay=0', '--max-pages', '30']);
  assert.equal(r2.code, 0, r2.stdout);
  assert.match(r2.stdout, /crawled 3 pages, 15 addresses skipped\n/);
  assert.match(r2.stdout, /- Addresses skipped: 15\. 15 of the 18 addresses tried have moved to [^\n]+ The first 10 are below, and RESCUE-REPORT\.md lists them all with the reason:/);
  assert.match(r2.stdout, /  - and 5 more\n/);
  assert.ok(!r2.stdout.includes('- /m15: it has moved'), 'the long list is not printed');
  const full = readFileSync(path.join(out2, 'RESCUE-REPORT.md'), 'utf8');
  for (const p of moved) assert.ok(full.includes(`  - ${p}: it has moved to another site, `), `${p} is in the file`);
  assert.ok(!full.includes('The first 10 are below'));
});

test('rescue: an address that answers with an error or is not a page says so in plain words', async (t) => {
  const home = '<html><head><title>Home</title></head><body><h1>Home</h1><p>Some words here for the page.</p><a href="/gone">Gone</a><a href="/updates">Updates</a></body></html>';
  const s = await tableSite(t, { '/': ['text/html', home], '/updates': ['application/rss+xml', '<rss/>'] });
  const r = await rescueRun([s.url, `--out=${s.out}`, '--delay=0']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /\/gone\n\s+skipped: the site answered with an error \(HTTP 404\)/);
  assert.match(r.stdout, /\/updates\n\s+skipped: it is not a page \(application\/rss\+xml\)/);
  assert.doesNotMatch(r.stdout, /have moved to/, 'nothing moved, so no such sentence');
});

// ─── smaller things the report and the pages get right ──────────────────────

test('rescue: the report says what kinds of script were taken out, the preview picture keeps its site name, and no manifest link is left dangling', async () => {
  const { scriptKindsLine, addKinds } = await import('../cli/rescue.mjs');
  const html = `<html><head><link rel="manifest" href="/manifest.webmanifest"><link rel="canonical" href="https://site.com/"><meta property="og:image" content="https://site.com/og.png"><meta name="twitter:image" content="/og.png"><meta property="og:url" content="https://site.com/"><link rel="icon" href="/favicon.ico"></head><body><h1>Hi</h1>
<script type="module" src="/assets/index-abc.js"></script><script>window.x = 1</script>
<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script><script src="https://widget.intercom.io/widget/abc"></script></body></html>`;
  const assetMap = new Map([['https://site.com/og.png', 'assets/rescued/1234-og.png']]);
  const r = cleanPage(html, { baseUrl: 'https://site.com/', assetMap });
  assert.equal(r.scripts, 4);
  assert.deepEqual(r.kinds, { own: 1, inline: 1, visitors: { 'static.cloudflareinsights.com': 1 }, outside: { 'widget.intercom.io': 1 } });
  assert.ok(r.html.includes('<meta property="og:image" content="https://site.com/assets/rescued/1234-og.png">'), r.html);
  assert.ok(r.html.includes('<meta name="twitter:image" content="https://site.com/assets/rescued/1234-og.png">'));
  assert.equal(r.previews, 2);
  assert.ok(r.html.includes('<link rel="canonical" href="https://site.com/">'), 'the canonical address stays a full address, like og:url');
  assert.ok(!r.html.includes('manifest'), 'the manifest link is gone: its file is not copied');
  assert.ok(r.html.includes('rel="icon"'));
  assert.equal(scriptKindsLine(r.kinds), "Of these, 1 was the old site's own, 1 was written into the pages themselves, 1 counted visitors (static.cloudflareinsights.com), 1 came from other sites (widget.intercom.io). Whatever those did is gone from the copy: if you count visitors, or had a chat box, a cookie notice or a booking widget, add it again on the new site.");
  const two = addKinds(addKinds({ own: 0, inline: 0, visitors: {}, outside: {} }, r.kinds), r.kinds);
  assert.match(scriptKindsLine(two), /2 were the old site's own, 2 were written into the pages themselves, 2 counted visitors/);
  assert.equal(scriptKindsLine({ own: 0, inline: 0, visitors: {}, outside: {} }), '');
  assert.doesNotMatch(scriptKindsLine({ own: 3, inline: 0, visitors: {}, outside: {} }), /gone from the copy/);
});

test('rescue: the written report names the kinds of script and the preview picture', async (t) => {
  const page = '<html><head><title>Home</title><meta property="og:image" content="/og.png"><link rel="manifest" href="/site.webmanifest"></head><body><h1>Home</h1><p>Some words here for the page.</p><script src="/app.js"></script><script src="https://static.cloudflareinsights.com/beacon.min.js"></script></body></html>';
  const s = await tableSite(t, { '/': ['text/html', page], '/og.png': ['image/png', Buffer.alloc(300, 1)] });
  const r = await rescueRun([s.url, `--out=${s.out}`, '--delay=0']);
  assert.equal(r.code, 0, r.stdout);
  const report = readFileSync(path.join(s.out, 'RESCUE-REPORT.md'), 'utf8');
  assert.match(report, /- Scripts stripped: 2 \(\+ 1 builder cruft tags removed\)\. Of these, 1 was the old site's own, 1 counted visitors \(static\.cloudflareinsights\.com\)\. Whatever those did is gone from the copy/);
  assert.match(report, /- The picture for link previews \(og:image, twitter:image\) is written with this site's full address, http:\/\/127\.0\.0\.1:\d+\/assets\/rescued\/…/);
  const html = readFileSync(path.join(s.out, 'index.html'), 'utf8');
  assert.match(html, new RegExp(`<meta property="og:image" content="${s.url.replace(/[.:/]/g, '\\$&')}/assets/rescued/[0-9a-f]{8}-og\\.png">`));
  assert.ok(!html.includes('webmanifest'));
});

// ─── WordPress with plain addresses, a site in a folder, the phone menu, the report's words ───

import { existsSync } from 'node:fs';
import { splitSearch, siteFolder, inFolder, plainMenu, plainMenuLine, againCommand, shopOf, shopLines, queryLinksLine, leftOutLine, folderLines } from '../cli/rescue.mjs';

test('rescue: an address with a WordPress page ending is a page of its own', () => {
  assert.equal(pageIdentity('/?p=14', SITE), '/?p=14');
  assert.equal(pageIdentity('https://site.com/blog/?page_id=2#top', SITE), '/blog?page_id=2');
  assert.equal(pageIdentity('/?paged=2&cat=5', SITE), '/?cat=5&paged=2', 'one fixed order, however the link wrote it');
  assert.equal(pageIdentity('/?p=14&utm_source=x', SITE), '/?p=14');
  assert.equal(pageIdentity('/?tag=slow%20food', SITE), '/?tag=slow%20food');
  for (const q of ['?add-to-cart=349', '?replytocom=5', '?s=tea', '?orderby=price', '?p=']) assert.equal(pageIdentity('/shop/' + q, SITE), '/shop', q);
  assert.deepEqual(splitSearch(new URL('https://site.com/?p=14&orderby=price')), { page: 'p=14', rest: '?orderby=price', other: true });
  assert.deepEqual(splitSearch(new URL('https://site.com/?add-to-cart=3')), { page: '', rest: '?add-to-cart=3', other: false });
  assert.deepEqual(splitSearch(new URL('https://site.com/x')), { page: '', rest: '', other: false });
});

test('rescue: mapUrls gives a page ending its own file, and makes the folder a site lived in the top of the copy', () => {
  const m = mapUrls(['/', '/?p=14', '/?cat=5&paged=2', '/blog?page_id=2', '/old.html?p=3', '/?tag=slow%20food']);
  assert.equal(m.get('/'), 'index.html');
  assert.equal(m.get('/?p=14'), 'p-14/index.html');
  assert.equal(m.get('/?cat=5&paged=2'), 'cat-5-paged-2/index.html');
  assert.equal(m.get('/blog?page_id=2'), 'blog/page_id-2/index.html');
  assert.equal(m.get('/old.html?p=3'), 'old-p-3.html');
  assert.equal(m.get('/?tag=slow%20food'), 'tag-slow-food/index.html');
  const f = mapUrls(['/shop-demo', '/shop-demo/store', '/shop-demo?p=8', '/shop-demo/a.html', '/elsewhere'], '/shop-demo');
  assert.equal(f.get('/shop-demo'), 'index.html');
  assert.equal(f.get('/shop-demo/store'), 'store/index.html');
  assert.equal(f.get('/shop-demo?p=8'), 'p-8/index.html');
  assert.equal(f.get('/shop-demo/a.html'), 'a.html');
  assert.equal(f.get('/elsewhere'), 'elsewhere/index.html');
  assert.equal(fileToHref(f.get('/shop-demo?p=8')), '/p-8/');
});

test('rescue: extractRefs follows page endings, leaves sign-in and feeds out, and notes links whose ending is dropped', () => {
  const html = `<meta name="msapplication-TileImage" content="/tile.png">
    <a href="/?p=14">Post</a><a href="/?page_id=2">Page</a><a href="/?cat=5">Cat</a><a href="/?author=1">A</a><a href="/?m=202401">M</a><a href="/?paged=2">2</a><a href="/?tag=x">T</a>
    <a href="/shop/?orderby=price">Sort</a><a href="/shop/?add-to-cart=349">Add</a><a href="/?p=14&replytocom=3#respond">Reply</a><a href="/?s=tea">Search</a>
    <a href="/wp-login.php?redirect_to=x">Log in</a><a href="/wp-login.php?redirect_to=y">Log in</a><a href="/wp-admin/">Admin</a><a href="/feed/">Feed</a><a href="/comments/feed/">CF</a><a href="/?feed=rss2">F2</a>
    <a href="/cdn-cgi/l/email-protection#0b">[email&#160;protected]</a>`;
  const r = extractRefs(html, SITE + '/');
  assert.deepEqual([...r.pages].sort(), ['/', '/?author=1', '/?cat=5', '/?m=202401', '/?p=14', '/?page_id=2', '/?paged=2', '/?tag=x', '/shop'].sort());
  assert.deepEqual(r.signin, ['/wp-login.php', '/wp-admin/'], 'one sign-in page is counted once, whatever follows its question mark');
  assert.ok(!r.pages.some(p => p.includes('cdn-cgi')), "Cloudflare's email-hiding address is not a page");
  assert.deepEqual(r.feeds, ['/feed/', '/comments/feed/', '/?feed=rss2']);
  assert.deepEqual(r.queryLinks, ['/shop/?orderby=price'], 'a cart action, a reply and a search are not counted');
  assert.ok(r.assets.includes('https://site.com/tile.png'), 'the tile picture named in the head is copied too');
});

test('rescue: cleanPage points every link to a numbered page at its file, and drops only the part that named the page', () => {
  const pageMap = mapUrls(['/', '/?p=14', '/?cat=5']);
  const r = cleanPage('<a href="/?p=14">a</a><a href="https://site.com/?p=14&x=1#c">b</a><a href="?cat=5">c</a><a href="/?p=99">d</a><a href="/?add-to-cart=3">e</a>', { baseUrl: SITE + '/', pageMap });
  assert.ok(r.html.includes('<a href="/p-14/">a</a>'), r.html);
  assert.ok(r.html.includes('<a href="/p-14/?x=1#c">b</a>'), r.html);
  assert.ok(r.html.includes('<a href="/cat-5/">c</a>'), r.html);
  assert.ok(r.html.includes('<a href="/?p=99">d</a>'), 'a page that was not copied keeps its address');
  assert.ok(r.html.includes('<a href="/?add-to-cart=3">e</a>'), r.html);
});

test('rescue: a site that lived in a folder is copied with that folder as its top', () => {
  assert.equal(siteFolder('https://host.com/shop-demo/', ['/shop-demo', '/shop-demo/store', '/shop-demo?p=8', '/']), '/shop-demo');
  assert.equal(siteFolder('https://host.com/shop-demo/index.html', []), '/shop-demo');
  assert.equal(siteFolder('https://host.com/', ['/about']), '');
  assert.equal(siteFolder('https://host.com/home', ['/about', '/contact']), '', 'a page at the top of its host');
  assert.equal(siteFolder('https://host.com/about/', ['/', '/blog', '/contact', '/about']), '', 'one page of a bigger site: most of its links lead out of the folder');
  assert.equal(inFolder('/shop-demo/store', '/shop-demo'), true);
  assert.equal(inFolder('/shop-demo?p=8', '/shop-demo'), true);
  assert.equal(inFolder('/shop-demonstration', '/shop-demo'), false);
  assert.equal(inFolder('/anything', ''), true);

  const folder = '/shop-demo';
  const pageMap = mapUrls(['/shop-demo', '/shop-demo/store', '/shop-demo?p=8'], folder);
  const assetMap = new Map([['https://host.com/shop-demo/wp-content/logo.png', 'assets/rescued/aaaa-logo.png'], ['https://host.com/shop-demo/tile.png', 'assets/rescued/bbbb-tile.png']]);
  const html = `<html><head><meta property="og:image" content="https://host.com/shop-demo/wp-content/logo.png"><meta name="msapplication-TileImage" content="https://host.com/shop-demo/tile.png"><meta name="msapplication-square150x150logo" content="/shop-demo/gone.png"><link rel="canonical" href="https://host.com/shop-demo/"><meta property="og:url" content="https://host.com/shop-demo/"></head><body>
    <a href="/shop-demo/">Home</a><a href="https://host.com/shop-demo/store/">Store</a><a href="/shop-demo/?p=8">Post</a><a href="/shop-demo/cart/">Cart</a><a href="/other-demo/">Other</a><a href="/">Host</a><img src="/shop-demo/wp-content/logo.png"><form action="/shop-demo/store/"></form></body></html>`;
  const r = cleanPage(html, { baseUrl: 'https://host.com/shop-demo/', pageMap, assetMap, folder });
  for (const want of ['<a href="/">Home</a>', '<a href="/store/">Store</a>', '<a href="/p-8/">Post</a>', '<a href="/cart/">Cart</a>',
    '<a href="https://host.com/other-demo/">Other</a>', '<a href="https://host.com/">Host</a>', '<img src="/assets/rescued/aaaa-logo.png">', '<form action="/store/">',
    '<meta property="og:image" content="/assets/rescued/aaaa-logo.png">', '<meta name="msapplication-TileImage" content="/assets/rescued/bbbb-tile.png">',
    '<meta name="msapplication-square150x150logo" content="https://host.com/shop-demo/gone.png">']) assert.ok(r.html.includes(want), `${want}\n${r.html}`);
  assert.deepEqual(r.leftBehind, ['https://host.com/shop-demo/gone.png'], 'a head picture that was not copied is listed');
  assert.equal(r.previews, 1);
  assert.equal(r.oldHead, 2, 'the canonical link and og:url still name the old address');
  // a site at the top of its host: the preview picture keeps the site name in front, the tile does not need it
  const top = cleanPage('<meta property="og:image" content="/logo.png"><meta name="msapplication-TileImage" content="/tile.png">',
    { baseUrl: 'https://host.com/', assetMap: new Map([['https://host.com/logo.png', 'assets/rescued/c-logo.png'], ['https://host.com/tile.png', 'assets/rescued/d-tile.png']]) });
  assert.ok(top.html.includes('content="https://host.com/assets/rescued/c-logo.png"'), top.html);
  assert.ok(top.html.includes('content="/assets/rescued/d-tile.png"'), top.html);
});

test('rescue: a host\'s sitemap counts only the pages under the folder the site lives in', () => {
  const xml = '<urlset><url><loc>https://host.com/shop-demo/</loc></url><url><loc>https://host.com/shop-demo/store/</loc></url><url><loc>https://host.com/other-demo/</loc></url><url><loc>https://host.com/</loc></url><url><loc>https://host.com/shop-demo/wp-login.php</loc></url><url><loc>https://host.com/shop-demo/?p=8</loc></url></urlset>';
  assert.deepEqual(sitemapPages(xml, 'https://host.com', '/shop-demo'), ['/shop-demo', '/shop-demo/store', '/shop-demo?p=8']);
  assert.equal(sitemapPages(xml, 'https://host.com').length, 5, 'with no folder every page of the host counts, the sign-in address left out');
});

const BLOCK_NAV = '<html><head></head><body><header><nav class="wp-block-navigation"><button aria-haspopup="dialog" aria-label="Open menu" class="wp-block-navigation__responsive-container-open"><svg></svg></button><div class="wp-block-navigation__responsive-container" id="modal-1"><div class="wp-block-navigation__responsive-dialog"><button aria-label="Close menu" class="wp-block-navigation__responsive-container-close"></button><ul><li><a href="/about/">About</a></li></ul></div></div></nav></header></body></html>';

test('rescue: plainMenu finds the phone menu button of a plain copy and marks what it opens', () => {
  const seen = plainMenu(BLOCK_NAV);
  assert.deepEqual({ found: seen.found, known: seen.known, label: seen.label }, { found: true, known: true, label: 'Open menu' });
  assert.equal(seen.html, BLOCK_NAV, 'looking changes nothing');
  const m = plainMenu(BLOCK_NAV, { apply: true });
  assert.match(m.html, /<button [^>]*class="wp-block-navigation__responsive-container-open" data-kiln-menu-toggle="">/);
  assert.match(m.html, /<div class="wp-block-navigation__responsive-container" id="modal-1" data-kiln-menu-swap="wp-block-navigation__responsive-container has-modal-open is-menu-open">/);
  assert.match(m.html, /class="wp-block-navigation__responsive-container-close" data-kiln-menu-close="">/);
  assert.equal(plainMenu(m.html, { apply: true }).html, m.html, 'marking twice changes nothing');

  const astra = '<html><body><div id="ast-mobile-popup" class="ast-mobile-popup-drawer"><div class="ast-mobile-popup-overlay"></div><div class="ast-mobile-popup-inner"><button id="menu-toggle-close" class="menu-toggle-close" aria-label="Close menu"></button><a href="/a/">A</a></div></div><header><button type="button" class="menu-toggle main-header-menu-toggle" aria-expanded="false" aria-label="Main menu toggle"></button></header></body></html>';
  const a = plainMenu(astra, { apply: true });
  assert.equal(a.label, 'Main menu toggle');
  assert.match(a.html, /id="ast-mobile-popup" class="ast-mobile-popup-drawer" data-kiln-menu-swap="ast-mobile-popup-drawer active show"/);
  assert.equal(a.html.split('data-kiln-menu-close').length, 3, 'the close button and the dimmed background both close it');

  const boot = '<html><body><nav class="navbar"><button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#nav" aria-label="Toggle navigation"></button><div class="collapse navbar-collapse" id="nav"><a href="/a/">A</a></div></nav></body></html>';
  assert.match(plainMenu(boot, { apply: true }).html, /id="nav" data-kiln-menu-swap="collapse navbar-collapse show"/);

  const classic = (htmlClass) => `<html class="${htmlClass}"><body><nav id="site-navigation" class="main-navigation"><button class="menu-toggle" aria-controls="top-menu" aria-expanded="false">Menu</button><ul id="top-menu"><li><a href="/a/">A</a></li></ul></nav></body></html>`;
  assert.match(plainMenu(classic('js'), { apply: true }).html, /class="main-navigation" data-kiln-menu-swap="main-navigation toggled toggled-on"/);
  assert.equal(plainMenu(classic('no-js')).found, false, 'a theme with a fallback for no script shows its menu already');

  const odd = '<html><body><header><button class="hamburger" aria-label="Menu" aria-expanded="false"></button></header></body></html>';
  const o = plainMenu(odd, { apply: true });
  assert.deepEqual({ found: o.found, known: o.known, html: o.html }, { found: true, known: false, html: odd }, 'a button it does not know is found and left alone');
  assert.equal(plainMenu('<html><body><button class="buy">Buy</button></body></html>').found, false);
});

test('rescue: the report offers --menu-shim for a plain copy, and says when it was added', () => {
  const menus = [{ href: '/', found: true, known: true, label: 'Open menu' }, { href: '/about/', found: true, known: true, label: 'Open menu' }, { href: '/thanks/', found: false }];
  const cmds = { shim: againCommand('https://site.com/', { out: 'copy', 'max-pages': '12' }, ['menu-shim']), render: againCommand('https://site.com/', {}, ['render', 'menu-shim']) };
  assert.equal(cmds.shim, 'npx github:kilncms/kiln#release rescue https://site.com/ --out=copy --max-pages=12 --menu-shim');
  assert.equal(cmds.render, 'npx github:kilncms/kiln#release rescue https://site.com/ --render --menu-shim');
  const offer = plainMenuLine(menus, false, cmds);
  assert.match(offer, /^- Phone menu: the button "Open menu" does not open the menu on a phone \(on \/, \/about\/\)\. One of the old site's scripts ran it/);
  assert.ok(offer.includes('`' + cmds.shim + '`'), offer);
  assert.match(plainMenuLine(menus, true, cmds), /opens the menu through assets\/kiln-menu\.js, a small script of Kiln's own, on \/, \/about\/\. Open a page on a phone/);
  const odd = plainMenuLine([{ href: '/', found: true, known: false, label: 'Menu' }], true, cmds);
  assert.match(odd, /could not tell from the page alone what the button "Menu" opens\. Run it with `--render --menu-shim`/);
  assert.equal(plainMenuLine([{ href: '/', found: false }], false, cmds), '');
  assert.doesNotMatch(offer + odd, /—/);
  const L = staticLostLines([{ href: '/', html: '<p>Hi</p>' }], SITE, { menuLine: offer }).join('\n');
  assert.match(L, /## What freezing cost/);
  assert.ok(L.includes(offer), 'the menu line is reported even when nothing else stopped working');
});

test('rescue: the count of forms is the number of forms listed', () => {
  const form = '<form class="woocommerce-ordering" method="get"><select name="orderby"></select></form>';
  const pages = ['/store/', '/women/', '/men/'].map(href => ({ href, html: form }));
  pages.push({ href: '/contact/', html: '<form id="contact" action="/contact/"><input name="email"></form>' });
  const L = staticLostLines(pages, SITE).join('\n');
  assert.match(L, /- Forms that posted into the old site: 2, on 4 pages\./);
  assert.equal(L.split('\n').filter(l => l.startsWith('  - "')).length, 2);
});

test('rescue: a file the old site no longer has is listed as already missing, not as one that will disappear', () => {
  const gone = { url: 'https://site.com/app.png', reason: 'the old site no longer has it (HTTP 404)', missing: true };
  const film = { url: 'https://site.com/film.mp4', reason: 'a kind of file the rescue does not copy' };
  const again = { url: 'https://site.com', args: {}, totalBytes: 0, maxAssetBytes: 20 * 1024 * 1024, maxTotalBytes: 250 * 1024 * 1024, capped: false };
  const only = notCopiedLines([gone], again).join('\n');
  assert.match(only, /## Files already missing on the old site\n\n1 file these pages ask for is already missing on the old site: it answered "not found" for it\./);
  assert.doesNotMatch(only, /## Files not copied|will disappear/);
  assert.ok(only.includes('- app.png: https://site.com/app.png'));
  const both = notCopiedLines([gone, film], again).join('\n');
  assert.match(both, /## Files not copied\n\n1 file used by these pages was not copied/);
  assert.ok(both.indexOf('film.mp4') < both.indexOf('## Files already missing on the old site'));
  assert.ok(both.indexOf('app.png') > both.indexOf('## Files already missing on the old site'));
});

test('rescue: a shop is recognised, and the report says in plain words that the shop does not come across', () => {
  assert.equal(shopOf([{ href: '/', html: '<p>Hello</p><form class="cart-notes"></form>' }]), null);
  const woo = shopOf([{ href: '/', html: '<a href="/?add-to-cart=349">Add</a>' }, { href: '/about/', html: '<p>x</p>' }, { href: '/product/shoes/', html: '<form class="variations_form cart"></form>' }]);
  assert.deepEqual(woo, { kind: 'WooCommerce', on: ['/', '/product/shoes/'] });
  assert.equal(shopOf([{ href: '/p/', html: '<form action="/cart/add" method="post"></form>' }]).kind, 'Shopify');
  assert.equal(shopOf([{ href: '/p/', html: '<div class="sqs-add-to-cart-button">Add</div>' }]).kind, 'Squarespace');
  const text = shopLines(woo).join('\n');
  assert.match(text, /^## This site is a shop\n\nThe shop itself does not come across\./);
  for (const w of ['cart', 'checkout', 'filters', 'stock', 'Keep the shop where it is', 'payment link', 'WooCommerce', '/, /product/shoes/']) assert.ok(text.includes(w), w);
  assert.doesNotMatch(text, /—/);
  assert.deepEqual(shopLines(null), []);
});

test('rescue: the report counts links whose ending was dropped, names what was left out on purpose, and says where a folder site\'s home page is', () => {
  assert.equal(queryLinksLine([]), '');
  const one = queryLinksLine(['/store/?orderby=price']);
  assert.match(one, /^- Links not followed: 1 address ends in a question mark and more, like \?orderby=price\./);
  assert.ok(one.endsWith('The address: /store/?orderby=price'), one);
  const many = queryLinksLine(['/a?x=1', '/b?x=2', '/c?x=3', '/d?x=4', '/e?x=5', '/f?x=6', '/g?x=7']);
  assert.match(many, /^- Links not followed: 7 addresses end /);
  assert.ok(many.endsWith('The first five: /a?x=1, /b?x=2, /c?x=3, /d?x=4, /e?x=5'), many);
  assert.doesNotMatch(one + many, /query string|—/);
  assert.equal(leftOutLine([], []), '');
  assert.match(leftOutLine(['/wp-login.php'], ['/feed/', '/comments/feed/']), /^- Left out on purpose: 1 sign-in or admin address of the old site \(wp-login, wp-admin\) and 2 feeds\./);
  const f = folderLines({ origin: 'https://host.com', folder: '/shop-demo', outside: ['/', '/other-demo'] });
  assert.match(f[0], /^- This is a copy of the part of https:\/\/host\.com that lives in the folder \/shop-demo\/\. .*its home page is index\.html at the top of this folder/);
  assert.match(f[1], /^- Links to pages of host\.com outside \/shop-demo\/: 2 \(\/, \/other-demo\)\. .*run the rescue on https:\/\/host\.com\/ instead\./);
  assert.deepEqual(folderLines({ origin: 'https://host.com', folder: '', outside: [] }), []);
});

/** A site that picks its page by what follows the question mark, the way WordPress does with plain addresses. */
async function querySite(t, answer) {
  const server = createServer((req, res) => {
    const f = answer(new URL(req.url, 'http://x'));
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no'); }
    res.writeHead(f[2] || 200, { 'content-type': f[0], ...(f[3] || {}) });
    res.end(f[1]);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections?.(); server.close(r); }));
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-rescue-wp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { url: `http://127.0.0.1:${server.address().port}`, dir };
}

test('rescue: a WordPress shop with plain addresses, living in a folder, comes out as a site that works by itself', async (t) => {
  const page = (title, links = '') => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>Some words here for the page.</p><a href="/demo/">Home</a>${links}</body></html>`;
  const home = `<!doctype html><html><head><title>Demo shop</title><meta property="og:image" content="/demo/logo.png"><meta name="msapplication-TileImage" content="/demo/tile.png"></head><body>
<header><nav class="wp-block-navigation"><button aria-haspopup="dialog" aria-label="Open menu" class="wp-block-navigation__responsive-container-open"></button><div class="wp-block-navigation__responsive-container" id="modal-1"><button aria-label="Close menu" class="wp-block-navigation__responsive-container-close"></button><ul><li><a href="/demo/?page_id=2">About</a></li></ul></div></nav></header>
<h1>Demo shop</h1><p>Some words here for the page.</p>
<a href="/demo/?p=14">A post</a> <a href="/demo/?cat=5">News</a> <a href="/demo/?orderby=price">Sort by price</a> <a href="/demo/?add-to-cart=7">Add to cart</a>
<a href="/demo/wp-login.php">Log in</a> <a href="/demo/feed/">Feed</a> <a href="/other/">Another demo</a>
<img src="/demo/gone.png" alt="Gone"><form class="woocommerce-ordering" method="get"><select name="orderby"><option>Price</option></select></form>
<script src="/demo/wp-includes/nav.js"></script></body></html>`;
  const s = await querySite(t, (u) => {
    if (u.pathname === '/demo') return ['text/plain', '', 301, { location: '/demo/' + u.search }];
    if (u.pathname === '/demo/') {
      if (u.searchParams.get('p') === '14') return ['text/html', page('A post', '<a href="/demo/?page_id=2">About</a>')];
      if (u.searchParams.get('page_id') === '2') return ['text/html', page('About')];
      if (u.searchParams.get('cat') === '5') return ['text/html', page('News', '<a href="/demo/?p=14">A post</a>')];
      return ['text/html', home];
    }
    if (u.pathname === '/demo/logo.png' || u.pathname === '/demo/tile.png') return ['image/png', Buffer.alloc(300, 1)];
    // the host's sitemap lists every site on the host
    if (u.pathname === '/sitemap.xml') return sitemapOf('', ['/other/', '/other/a', '/other/b', '/other/c', '/demo/', '/demo/?p=14']);
    if (u.pathname.startsWith('/other/')) return ['text/html', page('Another demo')];
    return null;
  });
  const out = path.join(s.dir, 'copy');
  const r = await rescueRun([`${s.url}/demo/`, `--out=${out}`, '--delay=0', '--max-pages', '12']);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /\/demo\/ is a site in a folder of its own/);
  assert.match(r.stdout, /crawled 4 pages\n/, 'the home page and its three numbered pages, and nothing of the rest of the host');
  assert.doesNotMatch(r.stdout, /\] \/demo\/wp-login\.php|\] \/demo\/feed|\] \/other|more found beyond/);
  assert.match(r.stdout, /━━ Localizing assets ━/);
  for (const f of ['index.html', 'p-14/index.html', 'page_id-2/index.html', 'cat-5/index.html']) assert.ok(existsSync(path.join(out, f)), `${f} is written`);
  assert.ok(!existsSync(path.join(out, 'demo')) && !existsSync(path.join(out, 'other')), 'the folder name is gone and no other site was copied');
  const html = readFileSync(path.join(out, 'index.html'), 'utf8');
  for (const want of ['href="/p-14/"', 'href="/page_id-2/"', 'href="/cat-5/"', `href="${s.url}/other/"`, 'href="/?orderby=price"']) assert.ok(html.includes(want), `${want}\n${html}`);
  assert.match(html, /<meta property="og:image" content="\/assets\/rescued\/[0-9a-f]{8}-logo\.png">/);
  assert.match(html, /<meta name="msapplication-TileImage" content="\/assets\/rescued\/[0-9a-f]{8}-tile\.png">/);
  assert.ok(readFileSync(path.join(out, 'p-14/index.html'), 'utf8').includes('<a href="/">Home</a>'), 'a link back to the home page goes to the top of the copy');
  assert.ok(!html.includes('kiln-menu'), 'no menu script unless it was asked for');

  const report = readFileSync(path.join(out, 'RESCUE-REPORT.md'), 'utf8');
  assert.match(report, /^# Rescue report: http:\/\/127\.0\.0\.1:\d+\/demo\/\n/);
  assert.match(report, /- Pages crawled: 4, written: 4\.\n/);
  assert.match(report, /- This is a copy of the part of http:\/\/127\.0\.0\.1:\d+ that lives in the folder \/demo\/\./);
  assert.match(report, /- Links to pages of 127\.0\.0\.1:\d+ outside \/demo\/: 1 \(\/other\)\./);
  assert.match(report, /- Sitemap \/sitemap\.xml: 2 pages listed/, 'only the two entries under /demo/ count');
  assert.match(report, /- The picture for link previews \(og:image, twitter:image\) is in the copy, and the pages name it by its place there/);
  assert.match(report, /- Left out on purpose: 1 sign-in or admin address of the old site \(wp-login, wp-admin\) and 1 feed\./);
  assert.match(report, /- Links not followed: 1 address ends in a question mark and more, like \?orderby=price\./);
  assert.match(report, /## This site is a shop\n\nThe shop itself does not come across\./);
  assert.match(report, /- Files already missing on the old site: 1 /);
  assert.match(report, /## Files already missing on the old site\n\n1 file these pages ask for is already missing[^\n]+\n\n- gone\.png: /);
  assert.doesNotMatch(report, /## Files not copied|will disappear|no home page/);
  assert.match(report, /- Forms that posted into the old site: 1\. /);
  assert.match(report, /- Phone menu: the button "Open menu" does not open the menu on a phone \(on \/\)\.[^\n]+ --out=[^\n]+ --max-pages=12 --delay=0 --menu-shim`/);
  assert.ok(report.indexOf('## This site is a shop') < report.indexOf('## What freezing cost'), 'the shop paragraph is near the top');

  // asked for, the menu script is added and the button and its box are marked
  const out2 = path.join(s.dir, 'copy-menu');
  const r2 = await rescueRun([`${s.url}/demo/`, `--out=${out2}`, '--delay=0', '--menu-shim']);
  assert.equal(r2.code, 0, r2.stdout);
  const html2 = readFileSync(path.join(out2, 'index.html'), 'utf8');
  assert.ok(existsSync(path.join(out2, 'assets', 'kiln-menu.js')), 'the menu script is in the copy');
  assert.ok(html2.includes('<script src="/assets/kiln-menu.js" defer></script>'), html2);
  assert.match(html2, /class="wp-block-navigation__responsive-container-open" data-kiln-menu-toggle=""/);
  assert.match(html2, /data-kiln-menu-swap="wp-block-navigation__responsive-container has-modal-open is-menu-open"/);
  assert.ok(!readFileSync(path.join(out2, 'p-14/index.html'), 'utf8').includes('kiln-menu'), 'a page with no menu button is left alone');
  assert.match(readFileSync(path.join(out2, 'RESCUE-REPORT.md'), 'utf8'), /- Phone menu: the button "Open menu" opens the menu through assets\/kiln-menu\.js, a small script of Kiln's own, on \/\./);

  // the dry run uses the same words for the same things
  const r3 = await rescueRun([`${s.url}/demo/`, `--out=${path.join(s.dir, 'never')}`, '--delay=0', '--dry']);
  assert.equal(r3.code, 0, r3.stdout);
  assert.match(r3.stdout, /- Pages crawled: 4 \(dry run, nothing written\)\./);
  assert.match(r3.stdout, /- Assets to localize: at least 3\./);
  assert.match(r3.stdout, /3\. Connect Kiln: /);
  assert.match(r3.stdout, /## This site is a shop/);
  assert.ok(!existsSync(path.join(s.dir, 'never')), 'a dry run writes nothing');
});

// ─── parts the old site showed with a script ────────────────────────────────
import { shownLine, SHOWN_CSS, SHOWN_SHEET } from '../cli/rescue.mjs';

test('cleanPage: an Elementor part that waits for a script to fade it in is shown', () => {
  const page = '<html><head></head><body><h1 class="elementor-element elementor-invisible elementor-widget" data-settings="{&quot;_animation&quot;:&quot;fadeIn&quot;}">Raining Offers</h1><p class="elementor-invisible">25% Off</p><script src="/el.js"></script></body></html>';
  const c = cleanPage(page, { baseUrl: SITE + '/' });
  assert.ok(!c.html.includes('elementor-invisible'), 'the class that hides the part is gone');
  assert.ok(c.html.includes('class="elementor-element elementor-widget"'), 'its other classes stay');
  assert.deepEqual(c.shown, { parts: 2, sheet: false });
  assert.ok(!c.html.includes('shown-without-scripts'), 'no style sheet is added for a change made in the page itself');
  // with the scripts kept, the script still does this itself
  const kept = cleanPage(page, { baseUrl: SITE + '/', keepScripts: true });
  assert.ok(kept.html.includes('elementor-invisible'));
  assert.deepEqual(kept.shown, { parts: 0, sheet: false });
});

test('cleanPage: "animate on scroll" parts are left the way their script leaves them', () => {
  const c = cleanPage('<html><head></head><body><div data-aos="fade-up" class="card">A</div><div data-aos="zoom-in">B</div><section data-sal="slide-up">C</section><p class="plain">D</p></body></html>', { baseUrl: SITE + '/' });
  assert.ok(c.html.includes('<div data-aos="fade-up" class="card aos-init aos-animate">'), c.html);
  assert.ok(/<div data-aos="zoom-in" class="aos-init aos-animate">/.test(c.html), 'a part with no class gets one');
  assert.ok(/<section data-sal="slide-up" class="sal-animate">/.test(c.html));
  assert.ok(c.html.includes('<p class="plain">D</p>'), 'an ordinary part is untouched');
  assert.deepEqual(c.shown, { parts: 3, sheet: false });
});

test('cleanPage: parts hidden by the site\'s own style sheet get one added style sheet', () => {
  const c = cleanPage('<html><head><title>t</title></head><body><div class="wow fadeInUp">A</div><div class="animate__animated">B</div><div class="reveal">C</div><div class="wpb_animate_when_almost_visible">D</div><div class="fl-animation">E</div><div class="et-waypoint">F</div><div class="wowza revealed">G</div></body></html>', { baseUrl: SITE + '/' });
  assert.deepEqual(c.shown, { parts: 6, sheet: true }, 'a class that only looks like one of them does not count');
  assert.equal(c.html.split(`<link rel="stylesheet" href="/${SHOWN_SHEET}">`).length, 2, 'linked once');
  assert.ok(/<link rel="stylesheet" href="\/assets\/rescued\/shown-without-scripts\.css"><\/head>/.test(c.html), 'last in the head, after the site\'s own sheets');
  assert.ok(c.html.includes('class="wow fadeInUp"'), 'the page\'s own classes are left alone');
  const none = cleanPage('<html><head></head><body><p>Hello</p></body></html>', { baseUrl: SITE + '/' });
  assert.ok(!none.html.includes('shown-without-scripts'));
  assert.deepEqual(none.shown, { parts: 0, sheet: false });
});

test('the added style sheet says what it is for and shows every class it is added for', () => {
  assert.equal(SHOWN_SHEET, 'assets/rescued/shown-without-scripts.css');
  assert.ok(SHOWN_CSS.startsWith('/* shown-without-scripts.css'), 'starts with a comment');
  assert.ok(/This copy has no scripts/.test(SHOWN_CSS.split('*/')[0]));
  for (const c of ['.wow', '.animate__animated', '.reveal', '.wpb_animate_when_almost_visible', '.fl-animation', '.et-waypoint']) assert.ok(SHOWN_CSS.includes(c), c);
  assert.ok(/opacity: 1 !important/.test(SHOWN_CSS) && /visibility: visible !important/.test(SHOWN_CSS));
  assert.ok(!SHOWN_CSS.includes('—'));
});

test('cleanPage: a WooCommerce product\'s pictures no longer start invisible', () => {
  const c = cleanPage('<html><head></head><body><div class="woocommerce-product-gallery images" data-columns="4" style="opacity: 0; transition: opacity .25s ease-in-out;"><img src="/shoe.jpg" data-src="/shoe-big.jpg"></div><div class="woocommerce-product-gallery" style="position: relative; opacity:0; transition: opacity .25s">x</div><div class="banner" style="opacity: 0">kept</div></body></html>', { baseUrl: SITE + '/' });
  assert.ok(/<div class="woocommerce-product-gallery images" data-columns="4" style="">/.test(c.html), c.html);
  assert.ok(c.html.includes('style="position: relative"'), 'the rest of its style stays');
  assert.ok(c.html.includes('<div class="banner" style="opacity: 0">'), 'only the gallery is touched: another part may be hidden on purpose');
  assert.ok(/<img src="[^"]*\/shoe\.jpg" data-src="[^"]*\/shoe-big\.jpg">/.test(c.html), 'a picture with a working src keeps it');
  assert.deepEqual(c.shown, { parts: 2, sheet: false });
});

test('cleanPage: a picture that waits for a lazy-loading script gets its real address', () => {
  const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const page = `<html><head></head><body>
    <img class="hero" src="${GIF}" data-lazy-src="${SITE}/a.jpg" data-lazy-srcset="${SITE}/a.jpg 1x, ${SITE}/a2.jpg 2x" data-lazy-sizes="(max-width: 600px) 100vw, 600px">
    <img class="lazyload" src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" data-src="/b.jpg" data-sizes="auto">
    <img data-original="/c.jpg">
    <picture><source data-srcset="/d.webp 1x"><img src="/d.jpg" loading="lazy"></picture>
    <img src="/e.jpg" data-src="/e-big.jpg">
  </body></html>`;
  const assetMap = new Map([[SITE + '/a.jpg', 'assets/rescued/1-a.jpg'], [SITE + '/a2.jpg', 'assets/rescued/2-a2.jpg'], [SITE + '/b.jpg', 'assets/rescued/3-b.jpg'], [SITE + '/c.jpg', 'assets/rescued/4-c.jpg']]);
  const c = cleanPage(page, { baseUrl: SITE + '/', assetMap });
  assert.ok(/<img class="hero" src="\/assets\/rescued\/1-a\.jpg"/.test(c.html), 'the stand-in is replaced by the copied picture');
  assert.ok(c.html.includes(' srcset="/assets/rescued/1-a.jpg 1x, /assets/rescued/2-a2.jpg 2x"'));
  assert.ok(c.html.includes(' sizes="(max-width: 600px) 100vw, 600px"'));
  assert.ok(/<img class="lazyloaded" src="\/assets\/rescued\/3-b\.jpg"/.test(c.html), 'lazysizes: the class its script sets, and the picture');
  assert.ok(!c.html.includes('sizes="auto"') || !/ sizes="auto"/.test(c.html.replace(/data-sizes="auto"/g, '')), '"auto" is the script\'s word, not a size');
  assert.ok(/<img data-original="\/assets\/rescued\/4-c\.jpg" src="\/assets\/rescued\/4-c\.jpg">/.test(c.html));
  assert.ok(/<source data-srcset="[^"]*d\.webp 1x" srcset="[^"]*d\.webp 1x">/.test(c.html));
  assert.ok(/<img src="[^"]*\/e\.jpg" data-src="[^"]*\/e-big\.jpg">/.test(c.html), 'a real src is never swapped for the bigger file beside it');
  assert.equal(c.shown.parts, 4);
  // the files those attributes name are fetched like any other picture
  const refs = extractRefs(page, SITE + '/');
  for (const f of ['/a.jpg', '/a2.jpg', '/b.jpg', '/c.jpg', '/d.webp']) assert.ok(refs.assets.includes(SITE + f), f);
  assert.ok(!refs.assets.some(a => a.startsWith('data:')));
});

test('shownLine: says how many parts were made visible, where, and what to check', () => {
  assert.equal(shownLine([]), '');
  assert.equal(shownLine([{ href: '/', parts: 0, sheet: false }]), '');
  const one = shownLine([{ href: '/', parts: 1, sheet: false }, { href: '/about/', parts: 0, sheet: false }]);
  assert.ok(one.startsWith('- Parts made visible: 1, on /. The old site kept this part hidden until one of its scripts showed it'), one);
  assert.ok(/Open that page and check/.test(one));
  assert.ok(!one.includes('shown-without-scripts'), 'the style sheet is named only when it was added');
  const many = shownLine([{ href: '/', parts: 2, sheet: false }, { href: '/product/shoes/', parts: 5, sheet: true }]);
  assert.ok(many.startsWith('- Parts made visible: 7, on /, /product/shoes/. The old site kept these parts hidden'), many);
  assert.ok(many.includes('assets/rescued/shown-without-scripts.css'));
  assert.ok(/Open those pages and check/.test(many));
  assert.ok(!many.includes('—') && !one.includes('—'));
});

// ─── a shop's layout without the shop's scripts ─────────────────────────────
import { shopChangesOf, shopChangeLines } from '../cli/rescue.mjs';

test('cleanPage: a WooCommerce page gets the class its script would have set, so the shop keeps its layout', () => {
  const shop = '<html><head></head><body class="archive woocommerce woocommerce-page woocommerce-no-js ast-desktop columns-3"><ul class="products"><li class="product">Shoes</li></ul><script>document.body.className = document.body.className.replace(/woocommerce-no-js/, "woocommerce-js");</script></body></html>';
  const c = cleanPage(shop, { baseUrl: SITE + '/store/' });
  assert.ok(c.html.includes('<body class="archive woocommerce woocommerce-page woocommerce-no-js ast-desktop columns-3 woocommerce-js">'), c.html);
  // the class a theme writes the shop's layout against is set once, and never on a page that is not a shop's
  const again = cleanPage(c.html, { baseUrl: SITE + '/store/' });
  assert.equal(again.html.split('woocommerce-js').length, 2, 'not added twice');
  const plain = cleanPage('<html><head></head><body class="home page no-js"><p>Hello</p></body></html>', { baseUrl: SITE + '/' });
  assert.ok(plain.html.includes('<body class="home page no-js">'), 'a page with no shop is left alone, and no-js stays no-js');
  // with the scripts kept, the script still does this itself
  const kept = cleanPage(shop, { baseUrl: SITE + '/store/', keepScripts: true });
  assert.ok(kept.html.includes('woocommerce-no-js ast-desktop columns-3">'), kept.html);
});

test('shopChangesOf and shopChangeLines: the report says what on a shop\'s pages looks different without scripts', () => {
  assert.equal(shopChangesOf([{ href: '/', html: '<p>Hello</p><ul class="tabs"><li>x</li></ul>' }]), null);
  assert.deepEqual(shopChangeLines(null), []);
  const found = shopChangesOf([
    { href: '/store/', html: '<div class="widget woocommerce widget_price_filter"><form><div class="price_slider_wrapper"><div class="price_slider" style="display:none;"></div><div class="price_slider_amount"><input id="min_price"><input id="max_price"></div></div></form></div>' },
    { href: '/product/shoes/', html: '<div class="woocommerce-product-gallery images" style="opacity: 0"></div><div class="woocommerce-tabs wc-tabs-wrapper"><ul class="tabs wc-tabs"><li>Description</li></ul></div>' },
    { href: '/about/', html: '<p>About</p>' },
  ]);
  assert.deepEqual(found, { tabs: ['/product/shoes/'], slider: ['/store/'], gallery: ['/product/shoes/'] });
  const text = shopChangeLines(found).join('\n');
  assert.ok(/all show, one under the other.*This is on \/product\/shoes\/\./.test(text), text);
  assert.ok(/two boxes with a number in each.*This is on \/store\/\./.test(text));
  assert.ok(/does not zoom\. This is on \/product\/shoes\/\./.test(text));
  assert.ok(!text.includes('—'));
  // only what was found is said
  const tabsOnly = shopChangeLines({ tabs: ['/p/'], slider: [], gallery: [] }).join('\n');
  assert.ok(/behind tabs/.test(tabsOnly) && !/price filter/.test(tabsOnly) && !/zoom/.test(tabsOnly));
});
