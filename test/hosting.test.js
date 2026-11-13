/**
 * Copying a site's files from its repository to Kiln's Cloudflare
 * (worker/hosting.js). The real code runs over an in-memory GitHub with a real
 * git object model and an in-memory Cloudflare that behaves as the real one
 * did when it was tried, so each test can look at what a visitor would get.
 * Nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch, githubWrites } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare } from './cloudflare-fake.js';
import { deploySite, removeSite, publishedFiles, fingerprint, buildManifest, siteName, siteAddress, contentType, hostingOn, hostingSentence, HostingError, LIMITS } from '../worker/hosting.js';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80]);
const site = {
  'index.html': '<!doctype html><h1>Home</h1>',
  'about.html': '<!doctype html><h1>About</h1>',
  'blog/first.html': '<!doctype html><h1>First</h1>',
  'assets/site.css': 'h1{color:red}',
  'assets/kiln.js': '/* kiln */',
  'img/logo.png': png,
  '404.html': '<!doctype html><h1>Not here</h1>',
  '_headers': '/*\n  X-Frame-Options: SAMEORIGIN\n',
  '_redirects': '/old /about 301\n',
  'README.md': '# The club',
  '.gitignore': 'node_modules',
  '.github/workflows/ci.yml': 'on: push',
  'node_modules/x/index.js': 'x',
  'functions/members/_middleware.js': 'export const onRequest = () => {}',
};
function world(files = site, opts = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files });
  const cf = fakeCloudflare(opts);
  const env = { HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites', ...(opts.env || {}) };
  const handler = async (url, init) => (await cf.handler(url, init)) || gh.handler(url, init);
  return { gh, cf, env, handler };
}
const go = (w, extra = {}) => deploySite(w.env, { token: 'inst-token', repo: 'ada/club', name: 'club-12345678', first: true, ...extra });
const blobsRead = (calls) => calls.filter(c => /\/git\/blobs\//.test(c.url)).length;

test('hosting: the first copy sends every file of the website, and a visitor then gets each one as the repository holds it', async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    const out = await go(w);
    assert.deepEqual({ state: out.state, url: out.url, commit: out.commit, branch: out.branch, files: out.files, sent: out.sent, skipped: out.skipped },
      { state: 'live', url: 'https://club-12345678.kiln-sites.workers.dev', commit: w.gh.head(), branch: 'main', files: 8, sent: 8, skipped: [] });
    assert.deepEqual(githubWrites(calls), [], 'the repository is only read');
  });
  const live = w.cf.scripts.get('club-12345678');
  assert.equal(live.address, true, 'its address is switched on');
  assert.deepEqual(Object.keys(live.manifest).sort(), ['/404.html', '/README.md', '/about.html', '/assets/kiln.js', '/assets/site.css', '/blog/first.html', '/img/logo.png', '/index.html']);
  for (const p of ['/.gitignore', '/.github/workflows/ci.yml', '/node_modules/x/index.js', '/functions/members/_middleware.js', '/_headers', '/_redirects']) assert.equal(live.manifest[p], undefined, `${p} is not part of the website`);
  assert.equal(w.cf.serve('club-12345678', '/index.html').bytes.toString(), site['index.html']);
  assert.equal(w.cf.serve('club-12345678', '/index.html').type, 'text/html; charset=utf-8');
  assert.equal(w.cf.serve('club-12345678', '/assets/site.css').type, 'text/css; charset=utf-8');
  assert.deepEqual(w.cf.serve('club-12345678', '/img/logo.png').bytes, png, 'a picture arrives byte for byte');
  assert.equal(w.cf.serve('club-12345678', '/img/logo.png').type, 'image/png');
  // The site's own headers and redirects are handed over as settings, and clean addresses and its own 404 page are on.
  assert.deepEqual(live.config, { html_handling: 'auto-trailing-slash', not_found_handling: '404-page', _headers: site._headers, _redirects: site._redirects });
  assert.match(live.message, /^ada\/club at [0-9a-f]{7}$/);
});

test('hosting: a later copy sends only what changed, and nothing at all when nothing did', async () => {
  const w = world();
  await withFetch(w.handler, async () => { await go(w); });
  w.gh.commit({ 'about.html': '<!doctype html><h1>About us</h1>', 'news.html': '<!doctype html><h1>News</h1>' });
  await withFetch(w.handler, async (calls) => {
    const out = await go(w, { first: false });
    assert.equal(out.state, 'live');
    assert.equal(out.files, 9);
    assert.equal(out.sent, 2, 'the changed page and the new one');
    assert.equal(blobsRead(calls), 4, 'two pages, and the two settings files');
    assert.equal(w.cf.calls.filter(c => /\/subdomain$/.test(c.path)).length, 1, 'the address is switched on once, not again');
  });
  assert.equal(w.cf.serve('club-12345678', '/about.html').bytes.toString(), '<!doctype html><h1>About us</h1>');
  assert.equal(w.cf.serve('club-12345678', '/news.html').bytes.toString(), '<!doctype html><h1>News</h1>');
  assert.equal(w.cf.serve('club-12345678', '/index.html').bytes.toString(), site['index.html']);
  await withFetch(w.handler, async (calls) => {
    const out = await go(w, { first: false });
    assert.equal(out.sent, 0);
    assert.equal(calls.filter(c => /assets\/upload/.test(c.url)).length, 0);
    assert.equal(w.cf.scripts.get('club-12345678').deploys, 3, 'it is still deployed, so the list is what the repository holds');
  });
  // A page that is removed stops being served.
  w.gh.commit({ 'news.html': null });
  await withFetch(w.handler, async () => { await go(w, { first: false }); });
  assert.equal(w.cf.serve('club-12345678', '/news.html'), null);
});

test('hosting: a fingerprint comes from git\'s id for the bytes and the extension, so nothing is downloaded to make the list', async () => {
  const a = await fingerprint('a'.repeat(40), '/index.html');
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, await fingerprint('a'.repeat(40), '/other/page.html'), 'the same bytes under the same extension are one upload');
  assert.notEqual(a, await fingerprint('a'.repeat(40), '/index.txt'), 'the same bytes under another extension are another, because the type goes with the bytes');
  assert.notEqual(a, await fingerprint('b'.repeat(40), '/index.html'));
  const { manifest, byHash } = await buildManifest([{ path: '/a.html', sha: 'a'.repeat(40), size: 3 }, { path: '/b.html', sha: 'a'.repeat(40), size: 3 }]);
  assert.deepEqual(Object.keys(manifest), ['/a.html', '/b.html']);
  assert.equal(byHash.size, 1);
  const w = world();
  await withFetch(w.handler, async (calls) => {
    await go(w);
    const firstUpload = calls.findIndex(c => /assets\/upload/.test(c.url));
    const session = calls.findIndex(c => /assets-upload-session/.test(c.url));
    assert.equal(calls.slice(0, session).filter(c => /\/git\/blobs\//.test(c.url)).length, 0, 'no file is read before Cloudflare says which it lacks');
    assert.ok(firstUpload > session);
  });
});

test('hosting: which files are the website', () => {
  const e = (path, size = 10) => ({ path, type: 'blob', sha: 'c'.repeat(40), size });
  const out = publishedFiles([e('index.html'), e('a/b/c.html'), e('.env'), e('a/.secret/x.html'), e('node_modules/p/i.js'), e('lib/node_modules/p/i.js'), e('functions/api.js'), e('docs/functions/x.html'),
    e('_headers'), e('_redirects'), e('_routes.json'), e('blog/_headers'), e('big.mp4', LIMITS.fileBytes + 1), e('ok.mp4', LIMITS.fileBytes), { path: 'img', type: 'tree', sha: 'd'.repeat(40) }]);
  assert.deepEqual(out.files.map(f => f.path), ['/a/b/c.html', '/blog/_headers', '/docs/functions/x.html', '/index.html', '/ok.mp4']);
  assert.equal(out.headers.path, '_headers');
  assert.equal(out.redirects.path, '_redirects');
  assert.deepEqual(out.skipped, [{ path: 'big.mp4', why: 'large' }]);
  assert.equal(contentType('/a/Photo.JPG'), 'image/jpeg');
  assert.equal(contentType('/feed'), 'application/octet-stream');
  assert.equal(contentType('/.well-known'), 'application/octet-stream');
});

test('hosting: a site\'s name is safe as a web address and never shared by two sites', () => {
  const env = { HOSTING_SUBDOMAIN: 'kiln-sites' };
  assert.equal(siteName(env, { repo: 'ada/The_Club.Site', id: '3F2A9C1D-aaaa-bbbb' }), 'the-club-site-3f2a9c1d');
  assert.notEqual(siteName(env, { repo: 'ada/club', id: 'aaaaaaaa-1' }), siteName(env, { repo: 'bob/club', id: 'bbbbbbbb-1' }));
  assert.equal(siteName({ HOSTING_PREFIX: 'stg-' }, { repo: 'ada/club', id: 'abcdef12-9' }), 'stg-club-abcdef12');
  // A repository whose name already ends with the start of the site's id (a site whose files Kiln keeps) is not given it twice.
  assert.equal(siteName(env, { repo: 'kiln-sites/oak-bakery-3f2a9c1d', id: '3f2a9c1d-aaaa-bbbb' }), 'oak-bakery-3f2a9c1d');
  assert.equal(siteName(env, { repo: 'ada/oak-bakery-3f2a9c1d', id: '77777777-aaaa' }), 'oak-bakery-3f2a9c1d-77777777');
  const long = siteName(env, { repo: `ada/${'x'.repeat(200)}`, id: 'abcdef12' });
  assert.ok(long.length <= 63 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(long), long);
  assert.equal(siteName(env, { repo: 'ada/---', id: '' }), 'site-0');
  // No site's name begins the way every preview's name does, whatever the repository is called.
  assert.equal(siteName(env, { repo: 'tess/pv-site1-kiln-suggest-x', id: 'tsite999-aaaa' }), 's-pv-site1-kiln-suggest-x-tsite999');
  assert.equal(siteName(env, { repo: 'tess/PV', id: 'abcdef12' }), 's-pv-abcdef12');
  assert.equal(siteName(env, { repo: 'tess/--pv--club', id: 'abcdef12' }), 's-pv-club-abcdef12');
  assert.equal(siteName({ HOSTING_PREFIX: 'stg-' }, { repo: 'tess/pv-club', id: 'abcdef12-9' }), 'stg-s-pv-club-abcdef12');
  assert.equal(siteName(env, { repo: 'kiln-sites/pv-club-3f2a9c1d', id: '3f2a9c1d-aaaa' }), 's-pv-club-3f2a9c1d');
  assert.equal(siteName(env, { repo: 'ada/pvc-pipes', id: 'abcdef12' }), 'pvc-pipes-abcdef12', 'a name that only starts with those two letters is left alone');
  assert.equal(siteAddress(env, 'club-1'), 'https://club-1.kiln-sites.workers.dev');
  assert.equal(hostingOn({}), false);
  assert.equal(hostingOn({ HOSTING_ACCOUNT_ID: 'a', HOSTING_API_TOKEN: 't', HOSTING_SUBDOMAIN: 's' }), true);
});

test('hosting: a repository that cannot be a website as it stands is told why, and nothing is deployed', async () => {
  const cases = {
    no_home: [{ 'pages/index.html': '<h1>deep</h1>', 'README.md': 'x' }, /no home page/],
    empty: [null, /has no files yet/],
  };
  for (const [state, [files, sentence]] of Object.entries(cases)) {
    const w = world(files || { 'x': 'y' });
    const handler = files ? w.handler : async (url, init) => (/\/git\/ref\//.test(url) ? new Response('{"message":"Git Repository is empty."}', { status: 409 }) : w.handler(url, init));
    await withFetch(handler, async () => {
      const out = await go(w);
      assert.equal(out.state, state);
      assert.match(hostingSentence(out.state, { repo: 'ada/club' }), sentence);
    });
    assert.equal(w.cf.scripts.size, 0, state);
  }
  // The Kiln app cannot read the repository.
  const w = world();
  await withFetch(async (url, init) => (url.startsWith('https://api.github.com/') ? new Response('{}', { status: 404 }) : w.handler(url, init)), async () => {
    assert.equal((await go(w)).state, 'no_access');
  });
  // Hosting is not set up on this service at all.
  await assert.rejects(deploySite({}, { token: 't', repo: 'ada/club', name: 'x' }), (e) => e instanceof HostingError && e.code === 'not_set_up');
});

test('hosting: when a copy fails part-way, visitors keep getting the site as it was', async () => {
  const w = world();
  await withFetch(w.handler, async () => { await go(w); });
  const before = JSON.stringify(w.cf.scripts.get('club-12345678').manifest);
  w.gh.commit({ 'index.html': '<!doctype html><h1>New home</h1>', 'about.html': '<!doctype html><h1>New about</h1>', 'c.html': 'c' });
  for (const [what, breakIt] of Object.entries({
    'Cloudflare fails while files are sent': () => w.cf.failOn((method, path) => path === '/workers/assets/upload'),
    'Cloudflare fails at the deploy': () => w.cf.failOn((method, path) => method === 'PUT'),
    'GitHub will not hand over a file': () => w.gh.failOn((method, path) => /^\/git\/blobs\//.test(path)),
  })) {
    w.cf.failOn(null); w.gh.failOn(null);
    breakIt();
    await withFetch(w.handler, async () => {
      await assert.rejects(go(w, { first: false }), (e) => e instanceof HostingError && ['cloudflare', 'github'].includes(e.code), what);
    });
    assert.equal(JSON.stringify(w.cf.scripts.get('club-12345678').manifest), before, what);
    assert.equal(w.cf.serve('club-12345678', '/index.html').bytes.toString(), site['index.html'], what);
  }
  // Once the trouble is over the same copy goes through, and sends only what was still missing.
  w.cf.failOn(null); w.gh.failOn(null);
  await withFetch(w.handler, async () => { assert.equal((await go(w, { first: false })).state, 'live'); });
  assert.equal(w.cf.serve('club-12345678', '/index.html').bytes.toString(), '<!doctype html><h1>New home</h1>');
});

test('hosting: a site with no 404 page and no settings files, a settings file that is not text, and taking a site down', async () => {
  const w = world({ 'index.html': '<h1>x</h1>', '_headers': Buffer.from([0xff, 0xfe, 0x00]) });
  await withFetch(w.handler, async () => { assert.equal((await go(w)).state, 'live'); });
  assert.deepEqual(w.cf.scripts.get('club-12345678').config, { html_handling: 'auto-trailing-slash', not_found_handling: 'none' });
  await withFetch(w.handler, async () => {
    assert.equal(await removeSite(w.env, 'club-12345678'), true);
    assert.equal(w.cf.scripts.size, 0);
    assert.equal(await removeSite(w.env, 'club-12345678'), true, 'taking down a site that is already gone is not a failure');
  });
  // The token for the hosting account is the only credential Cloudflare is shown.
  assert.ok(w.cf.calls.every(c => c.auth === w.cf.token || c.auth.startsWith('sess-')));
});
