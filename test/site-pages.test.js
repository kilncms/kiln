/**
 * Search & jump on a site a generator builds lists the site's real pages.
 *
 * It listed "/public/kiln.html", the sign-in page under an address that does
 * not exist, and none of the real ones, because it read the repository's
 * .html files. The list now comes from the adapter's routes, the links on the
 * page and the sitemap, and every entry is checked against the built site
 * (src/editor/site-pages.js). A whole built site is played here by a map of
 * address → page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astroRoutes, adapterRoutes, sameSiteLinks, sitemapLocs, locPaths, pageKey, readPage, hrefsIn, builtPages } from '../src/editor/site-pages.js';

const REPO_FILES = [
  'astro.config.mjs', 'package.json', 'public/kiln.html', 'public/_headers', 'public/assets/kiln.js', 'public/terms.html', 'public/old/index.html',
  'src/content.config.ts', 'src/content/events/one.md', 'src/content/events/two.md', 'src/content/site/home.md', 'src/lib/kiln-astro.mjs',
  'src/pages/index.astro', 'src/pages/about.astro', 'src/pages/events/index.astro', 'src/pages/events/[id].astro', 'src/pages/blog/[...slug].astro',
  'src/pages/contact.md', 'src/pages/guide/start.mdx', 'src/pages/_draft.astro', 'src/pages/_parts/card.astro', 'src/pages/404.astro',
  'src/pages/feed.xml.js', 'src/pages/api/search.json.ts', 'src/pages/styles.css', 'src/layouts/Base.astro',
];

test('astroRoutes: each file under src/pages that is a page by itself, and the .html files of public/; never the sign-in page', () => {
  assert.deepEqual(astroRoutes(REPO_FILES).sort(), ['/', '/about/', '/contact/', '/events/', '/guide/start/', '/old/', '/terms.html']);
  // No route with a parameter, no underscore file, no endpoint, no error page, no layout, no content file.
  for (const not of ['/events/[id]/', '/_draft/', '/404/', '/feed.xml/', '/api/search.json/', '/kiln.html', '/public/kiln.html']) {
    assert.equal(astroRoutes(REPO_FILES).includes(not), false, not);
  }
  assert.deepEqual(astroRoutes([]), []);
  assert.deepEqual(astroRoutes(undefined), []);
  assert.deepEqual(adapterRoutes('astro', ['src/pages/index.astro']), ['/']);
  assert.deepEqual(adapterRoutes('hugo', ['content/_index.md']), [], 'an adapter not known here names no route');
});

test('sameSiteLinks: the pages of this site that the links on a page point at, each once', () => {
  const here = 'https://site.example/events/one/';
  const hrefs = ['/', '/about/', '/about/#team', 'about/?x=1', '../two/', 'https://site.example/contact', 'https://elsewhere.example/', 'mailto:a@site.example',
    '#top', '/assets/flyer.pdf', '/photo.jpg', '/kiln', '/kiln.html', '/terms.html', '', null, 'javascript:void(0)', 'http://[bad'];
  assert.deepEqual(sameSiteLinks(hrefs, here), ['/', '/about/', '/events/one/about/', '/events/two/', '/contact', '/terms.html']);
  assert.deepEqual(sameSiteLinks(hrefs, 'not an address'), []);
});

test('sitemap: the addresses it lists, as paths, whatever host it was written for', () => {
  const xml = '<?xml version="1.0"?><urlset><url><loc>https://www.site.example/</loc></url><url><loc> https://www.site.example/about/ </loc></url><url><loc>https://www.site.example/a?b=1&amp;c=2</loc></url><url><loc>https://www.site.example/flyer.pdf</loc></url></urlset>';
  assert.deepEqual(sitemapLocs(xml), ['https://www.site.example/', 'https://www.site.example/about/', 'https://www.site.example/a?b=1&c=2', 'https://www.site.example/flyer.pdf']);
  assert.deepEqual(locPaths(sitemapLocs(xml)), ['/', '/about/', '/a']);
  assert.deepEqual(sitemapLocs(''), []);
});

test('pageKey: one spelling per page', () => {
  for (const [a, b] of [['/', '/'], ['/index.html', '/'], ['/about', '/about'], ['/about/', '/about'], ['/about/index.html', '/about'], ['/about.html', '/about'], ['', '/'], ['/caf%C3%A9/', '/café']]) {
    assert.equal(pageKey(a), b, a);
  }
});

test('readPage: a built page\'s title and its words, without its scripts and styles', () => {
  const r = readPage('<!doctype html><html><head><title> About &amp; us </title><style>p{color:red}</style></head><body><h1>About</h1><script>var x = "hidden";</script><p>Seven&nbsp;days &#8212; all welcome.</p></body></html>');
  assert.equal(r.title, 'About & us');
  assert.equal(r.flat, 'About Seven days — all welcome.');
});

// ─── A whole site ────────────────────────────────────────────────────────────

const html = (title, words) => `<!doctype html><html><head><title>${title}</title></head><body><main>${words}</main><script src="/assets/kiln.js"></script></body></html>`;
const SITE = {
  '/': html('Week of Remembrance', 'Three gatherings, one week.'),
  '/about/': html('About the week', 'Seven days of gatherings.'),
  '/events/one/': html('Interfaith Worship Service', 'Doors at 5:30pm.'),
  '/events/two/': html('Walking Tour', 'A guided walk.'),
  '/kiln.html': html('Sign in', 'Sign in to edit.'),
};
/** A static host: a page for its address, a 404 for anything else. */
function host(site, { spa = false, asked = [] } = {}) {
  return async (pathname) => {
    asked.push(pathname);
    let p = pathname;
    if (site[p] === undefined && site[`${p}/`] !== undefined) p = `${p}/`;   // the host adds the slash
    if (site[p] !== undefined) return { ok: true, type: p.endsWith('.xml') ? 'application/xml' : 'text/html; charset=utf-8', path: p, text: site[p] };
    if (spa) return { ok: true, type: 'text/html', path: pathname, text: site['/'] };
    return { ok: false, type: 'text/html', path: pathname, text: '<h1>Not found</h1>' };
  };
}
const TREE = ['public/kiln.html', 'src/pages/index.astro', 'src/pages/about.astro', 'src/pages/events/[id].astro', 'src/pages/pricing.astro', 'src/content/events/one.md'];
const urls = (list) => list.map(p => p.url);

test('builtPages: the real pages, this one first; not the sign-in page, not a route the built site does not have', async () => {
  const pages = await builtPages({ adapter: 'astro', here: 'https://site.example/about/', hrefs: ['/', '/about/', '/events/one/', '/kiln'],
    treePaths: async () => TREE, fetchPage: host(SITE) });
  assert.deepEqual(urls(pages), ['/about/', '/', '/events/one/']);
  assert.deepEqual(pages.map(p => p.title), ['About the week', 'Week of Remembrance', 'Interfaith Worship Service']);
  assert.equal(pages[0].flat, 'Seven days of gatherings.');
  // /pricing/ is a file in the repository that this build of the site does not serve: never listed.
  assert.equal(urls(pages).some(u => /pricing|kiln|public/.test(u)), false);
});

test('builtPages: what the repository lists as .html is not what is listed (the fault this replaces)', async () => {
  const pages = await builtPages({ adapter: 'astro', here: 'https://site.example/', hrefs: [], treePaths: async () => ['public/kiln.html', 'src/pages/index.astro'], fetchPage: host(SITE) });
  assert.deepEqual(urls(pages), ['/']);
});

test('builtPages: a page reached only through a parameter route is found by the links on the page and by the sitemap', async () => {
  const withMap = { ...SITE,
    '/sitemap-index.xml': '<sitemapindex><sitemap><loc>https://www.site.example/sitemap-0.xml</loc></sitemap></sitemapindex>',
    '/sitemap-0.xml': '<urlset><url><loc>https://www.site.example/</loc></url><url><loc>https://www.site.example/events/two/</loc></url><url><loc>https://www.site.example/gone/</loc></url></urlset>' };
  const pages = await builtPages({ adapter: 'astro', here: 'https://site.example/', hrefs: ['/events/one/'], treePaths: async () => TREE, fetchPage: host(withMap) });
  assert.deepEqual(urls(pages), ['/', '/about/', '/events/one/', '/events/two/']);
});

test('builtPages: a page behind a route with a parameter is found through the links of the pages that are found', async () => {
  // Looking at /about/, which links only to the home page; the home page lists the events.
  const linked = { ...SITE, '/': html('Week of Remembrance', 'Three gatherings. <a href="/events/one/">Details</a> <a href=\'/events/two/#when\'>Details</a> <a href=/about/>About</a> <a href="/missing/">Old link</a> <a href="https://elsewhere.example/">Away</a>') };
  const asked = [];
  const pages = await builtPages({ adapter: 'astro', here: 'https://site.example/about/', hrefs: ['/', '/about/'], treePaths: async () => TREE, fetchPage: host(linked, { asked }) });
  assert.deepEqual(urls(pages), ['/about/', '/', '/events/one/', '/events/two/']);
  assert.equal(asked.some(p => /elsewhere/.test(p)), false, 'another site is never asked');
  assert.deepEqual(hrefsIn('<a class="x" href="/a/">A</a><A HREF=\'/b?x=1&amp;y=2\'>B</A><a href=/c>C</a><link href="/style.css"><a name="top">no address</a>'), ['/a/', '/b?x=1&y=2', '/c']);
});

test('builtPages: a host that answers every address with its home page lists no page that does not exist', async () => {
  const pages = await builtPages({ adapter: 'astro', here: 'https://site.example/about/', hrefs: ['/', '/events/one/', '/nowhere/'],
    treePaths: async () => [...TREE, 'src/pages/pricing.astro'], fetchPage: host(SITE, { spa: true }) });
  assert.deepEqual(urls(pages), ['/about/', '/', '/events/one/']);
});

test('builtPages: built as files rather than folders, a route is found without its slash', async () => {
  const flat = { '/': SITE['/'], '/about.html': SITE['/about/'] };
  const fetchPage = async (pathname) => {
    if (pathname === '/') return { ok: true, type: 'text/html', path: '/', text: flat['/'] };
    if (pathname === '/about') return { ok: true, type: 'text/html', path: '/about', text: flat['/about.html'] };
    return { ok: false, type: 'text/html', path: pathname, text: '' };
  };
  const pages = await builtPages({ adapter: 'astro', here: 'https://site.example/', hrefs: [], treePaths: async () => TREE, fetchPage });
  assert.deepEqual(urls(pages), ['/', '/about']);
});

test('builtPages: when the repository cannot be listed, or the site does not answer, the list is shorter and nothing throws', async () => {
  const noTree = await builtPages({ adapter: 'astro', here: 'https://site.example/', hrefs: ['/about/'], treePaths: async () => { throw new Error('403'); }, fetchPage: host(SITE) });
  assert.deepEqual(urls(noTree), ['/', '/about/']);
  const down = await builtPages({ adapter: 'astro', here: 'https://site.example/', hrefs: ['/about/'], treePaths: async () => TREE, fetchPage: async () => { throw new TypeError('fetch failed'); } });
  assert.deepEqual(down, []);
  // Something that is not a page (a feed, a file) is not listed even when it answers.
  const feed = await builtPages({ adapter: 'astro', here: 'https://site.example/', hrefs: ['/feed'], treePaths: async () => [],
    fetchPage: async (p) => (p === '/feed' ? { ok: true, type: 'application/xml', path: p, text: '<rss/>' } : host(SITE)(p)) });
  assert.deepEqual(urls(feed), ['/']);
});

test('builtPages: no more than sixty addresses are asked for, however many the site links to', async () => {
  const asked = [];
  const many = Array.from({ length: 200 }, (_, i) => `/p${i}/`);
  const big = Object.fromEntries([['/', SITE['/']], ...many.map(p => [p, html(p, `page ${p}`)])]);
  const pages = await builtPages({ adapter: 'astro', here: 'https://site.example/', hrefs: many, treePaths: async () => [], fetchPage: host(big, { asked }) });
  assert.equal(pages.length, 60);
  assert.ok(asked.filter(p => /^\/p\d+\/$/.test(p)).length <= 60);
  // Pages that link on and on are followed no further than that either.
  const chain = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [i ? `/c${i}/` : '/', html(`c${i}`, `<a href="/c${i + 1}/">next</a> page ${i}`)]));
  const far = await builtPages({ adapter: 'astro', here: 'https://site.example/', hrefs: [], treePaths: async () => [], fetchPage: host(chain) });
  assert.equal(far.length, 60);
});
