/**
 * The pages of a site a generator builds, for Search & jump.
 *
 * On such a site the repository's .html files are not its pages: the one it
 * usually has is public/kiln.html, the sign-in page, and the real pages are
 * made at build time from templates and content files. So the list is put
 * together from what can be known, and then checked against the built site:
 *
 *   - the adapter's routes: each file under src/pages that is a page by
 *     itself (Astro), and each .html file in public/, which is copied as is;
 *   - the links on the page being looked at (the site's own menu), and the
 *     links on each page found, which is how a page behind a route with a
 *     parameter is reached;
 *   - the built site's sitemap, when it publishes one.
 *
 * A page is listed only once the built site has answered for its address with
 * a page of its own. A route the adapter names that the site does not serve
 * (another base path, a build that failed) is left out, and so is an address
 * a host answers with its home page or its "not found" page. Never a page
 * that does not exist.
 *
 * Everything here is pure or takes its fetching from the caller, so it runs
 * in node. main.js wires it to the page and the repository.
 */

/** One spelling per page: no index.html, no trailing slash (the root stays "/"). */
export function pageKey(pathname) {
  let p = String(pathname || '/');
  try { p = decodeURI(p); } catch { /* as written */ }
  p = p.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

const PAGE_FILE = /\.(astro|md|mdx|markdown|mdown|mkdn|mkd|mdwn|html)$/i;

/**
 * The addresses an Astro repository's files say exist, from its file list:
 * every file under src/pages that is one page (not a folder or file that
 * starts with an underscore, not a route with a [parameter], not an endpoint,
 * not the error pages), and every .html file under public/ except the sign-in
 * page. With a trailing slash, as Astro builds them by default.
 */
export function astroRoutes(paths) {
  const out = new Set();
  for (const raw of paths || []) {
    const path = String(raw);
    let m;
    if ((m = /^src\/pages\/(.+)$/.exec(path))) {
      const rest = m[1];
      if (!PAGE_FILE.test(rest)) continue;
      const segs = rest.replace(PAGE_FILE, '').split('/');
      if (segs.some(s => s.startsWith('_') || s.includes('[') || s === '')) continue;
      if (segs[segs.length - 1] === 'index') segs.pop();
      if (segs.length === 1 && /^(404|500)$/.test(segs[0])) continue;
      out.add(segs.length ? `/${segs.join('/')}/` : '/');
    } else if ((m = /^public\/(.+\.html?)$/i.exec(path))) {
      if (isSignInPage(`/${m[1]}`)) continue;
      out.add(/(^|\/)index\.html?$/i.test(m[1]) ? `/${m[1].replace(/index\.html?$/i, '')}` : `/${m[1]}`);
    }
  }
  return [...out];
}

/** Routes by adapter. An adapter not known here names none: links and the sitemap still do. */
export function adapterRoutes(adapter, paths) {
  return adapter === 'astro' ? astroRoutes(paths) : [];
}

/** The sign-in page is not a page of the site. */
function isSignInPage(pathname) {
  return /^\/kiln(\.html?|\/)?$/i.test(pathname);
}

// What a link can point at that is not a page.
const NOT_A_PAGE = /\.(?!html?$)[a-z0-9]{1,5}$/i;

/**
 * The pages of this site that a list of link addresses points at: same
 * origin, a page and not a file, without its #place or ?query, each once.
 * `here` is the address of the page the links are on.
 */
export function sameSiteLinks(hrefs, here) {
  const out = new Set();
  let base;
  try { base = new URL(here); } catch { return []; }
  for (const href of hrefs || []) {
    if (typeof href !== 'string' || !href.trim() || href.trim().startsWith('#')) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.origin !== base.origin || !/^https?:$/.test(u.protocol)) continue;
    if (NOT_A_PAGE.test(u.pathname) || isSignInPage(u.pathname)) continue;
    out.add(u.pathname);
  }
  return [...out];
}

/** The <loc> addresses of a sitemap (or of a sitemap index), as written. */
export function sitemapLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) && out.length < 2000) out.push(m[1].replace(/&amp;/g, '&'));
  return out;
}

/** The pathname of each address, whatever host the sitemap was written for. */
export function locPaths(locs) {
  const out = [];
  for (const loc of locs || []) {
    try { const u = new URL(loc, 'https://site.invalid'); if (!NOT_A_PAGE.test(u.pathname) && !isSignInPage(u.pathname)) out.push(u.pathname); } catch { /* not an address */ }
  }
  return out;
}

/** The words of a built page and its title, for the list and for searching the site's text. */
export function readPage(html) {
  const text = String(html || '');
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] || '').replace(/\s+/g, ' ').trim();
  const body = /<body[\s\S]*$/i.exec(text)?.[0] ?? text;
  const flat = body.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return { title: decodeEntities(title), flat: decodeEntities(flat).replace(/\s+/g, ' ').trim() };
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }[e.toLowerCase()]))
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return m; } });
}

const MAX_PAGES = 60;

/**
 * The site's real pages: [{ url, title, flat }], this page first, then by
 * address. Never throws: what cannot be asked is left out.
 *
 *   adapter     the site's adapter id
 *   here        the address of the page being looked at
 *   hrefs       the link addresses on it
 *   treePaths   async () => the repository's file paths (may throw)
 *   fetchPage   async (pathname) => { ok, type, path, text }: the built site's
 *               answer for an address; `path` is where it ended up after any
 *               redirect, `type` its content type
 */
export async function builtPages({ adapter, here, hrefs, treePaths, fetchPage }) {
  let herePath = '/';
  let base = 'https://site.invalid/';
  try { const u = new URL(here); herePath = u.pathname; base = u.origin + '/'; } catch { /* no address: the home page stands in */ }
  const ask = async (pathname) => { try { return await fetchPage(pathname); } catch { return { ok: false, type: '', path: pathname, text: '' }; } };

  // What might be a page, most certain first.
  const want = new Map();   // pageKey → pathname to ask for
  const add = (pathname) => { const k = pageKey(pathname); if (!want.has(k)) want.set(k, pathname); };
  add(herePath);
  let routes = [];
  try { routes = adapterRoutes(adapter, await treePaths()); } catch { /* the repository could not be listed */ }
  routes.forEach(add);
  sameSiteLinks(hrefs, here).forEach(add);
  for (const map of ['/sitemap-index.xml', '/sitemap.xml']) {
    const res = await ask(map);
    if (!res.ok || !/<(sitemapindex|urlset)\b/i.test(res.text)) continue;
    let locs = sitemapLocs(res.text);
    if (/<sitemapindex\b/i.test(res.text)) {
      const inner = [];
      for (const p of locPathsAny(locs).slice(0, 5)) { const r = await ask(p); if (r.ok) inner.push(...sitemapLocs(r.text)); }
      locs = inner;
    }
    locPaths(locs).forEach(add);
    break;
  }

  // What the site answers for an address that cannot exist. A host that sends
  // its home page (or a "not found" page) with a 200 for anything is found out here.
  const nowhere = await ask(`/kiln-no-such-page-${Math.random().toString(36).slice(2, 10)}/`);
  const hollow = nowhere.ok && isHtml(nowhere) ? readPage(nowhere.text).flat : null;

  // Asked in turn, six at a time. A page that is there is read for its own
  // links too, which is how the pages behind a route with a parameter are
  // found (an event's page, linked from the list of events). Sixty addresses
  // at most are asked for, however far the links go.
  const todo = [...want.values()];
  const found = new Map();   // pageKey of where it ended up → page
  let next = 0;
  let busy = 0;
  const work = async () => {
    for (;;) {
      if (next >= MAX_PAGES) return;
      if (next >= todo.length) {
        if (!busy) return;                                   // nobody is reading a page that could name more
        await new Promise(r => setTimeout(r, 15));
        continue;
      }
      const pathname = todo[next++];
      busy++;
      try { await visit(pathname); } finally { busy--; }
    }
  };
  const visit = async (pathname) => {
    let res = await ask(pathname);
    // Built as a file rather than a folder: the same route without its slash.
    if (!res.ok && pathname.length > 1 && pathname.endsWith('/')) res = await ask(pathname.slice(0, -1));
    if (!res.ok || !isHtml(res)) return;
    const page = readPage(res.text);
    const at = res.path || pathname;
    const key = pageKey(at);
    // The same words as the answer for nowhere: not a page of its own. (The
    // home page and the page being looked at are pages, whatever nowhere says.)
    if (hollow !== null && page.flat === hollow && key !== '/' && key !== pageKey(herePath)) return;
    if (isSignInPage(at) || found.has(key)) return;
    found.set(key, { url: at, title: page.title, flat: page.flat });
    for (const link of sameSiteLinks(hrefsIn(res.text), new URL(at, base).href)) {
      const k = pageKey(link);
      if (!want.has(k)) { want.set(k, link); todo.push(link); }
    }
  };
  await Promise.all([work(), work(), work(), work(), work(), work()]);
  const hereKey = pageKey(herePath);
  return [...found].sort(([a], [b]) => (a === hereKey ? -1 : b === hereKey ? 1 : a < b ? -1 : a > b ? 1 : 0)).map(([, page]) => page);
}

/** The addresses of the links in a page's HTML, as written. */
export function hrefsIn(html) {
  const out = [];
  const re = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(String(html || ''))) && out.length < 500) out.push((m[1] ?? m[2] ?? m[3]).replace(/&amp;/g, '&'));
  return out;
}

const isHtml = (res) => /text\/html|application\/xhtml/i.test(res.type || '') || (!res.type && /<html[\s>]/i.test(res.text || ''));

/** Sitemap files named by an index: their pathnames, xml included. */
function locPathsAny(locs) {
  const out = [];
  for (const loc of locs || []) { try { out.push(new URL(loc, 'https://site.invalid').pathname); } catch { /* skip */ } }
  return out;
}
