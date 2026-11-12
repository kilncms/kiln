/**
 * "Check this site" (worker/sitecheck.js, GET /cloud/sites/check): the
 * checklist a site's owner sees on its row in the dashboard. The real handlers
 * run over the SQLite-backed D1 stand-in, an in-memory GitHub, and a stand-in
 * for the customer's live site that records every request made to it, so each
 * test can say what was asked, what was sent along, and what the person is
 * told. Nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, githubWrites } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { KILN_TAGS, KILN_PAGE, kilnConfigFile, SETUP_COMMAND } from '../worker/prepare.js';
import { checkSite, refusedAddress, LIMITS } from '../worker/sitecheck.js';

const SITE = 'https://club.example';
const WWW = 'https://www.club.example';
const SERVICE = 'https://worker.example';
const INSTALL = 'https://github.com/apps/kiln-cms/installations/new';
const ALL = ['repository', 'files', 'settings', 'address', 'live', 'signin'];
const TAGS = `${KILN_TAGS[0]}\n${KILN_TAGS[1]}\n`;
const page = (title, extra = '') => `<!doctype html>\n<html>\n<head><title>${title}</title></head>\n<body>\n  <h1>${title}</h1>\n${extra}</body>\n</html>\n`;
const SETTINGS = kilnConfigFile({ repo: 'ada/club', branch: 'main', worker: SERVICE });
/** A repository with Kiln in it, as "Add Kiln to this site" leaves one. */
const withKiln = (over = {}) => ({
  'index.html': page('Home', TAGS), 'about.html': page('About', TAGS),
  'assets/kiln.js': '/* kiln */', 'assets/kiln-editor.js': '/* editor */', 'assets/kiln-features.js': '/* features */',
  'assets/kiln-config.js': SETTINGS, 'kiln.html': KILN_PAGE, '_headers': '/*\n  X-Frame-Options: SAMEORIGIN\n', ...over,
});
const answer = (status, headers = {}) => () => new Response(null, { status, headers });

/**
 * One account (ada) with one site (ada/club at https://club.example), its
 * repository, and its live site. The live site serves `served` (the
 * repository's own files unless a test says the host is behind) the way a
 * static host does: / is index.html and /kiln is kiln.html. `over` answers a
 * path (or a whole address) by hand. `asked` is every request that went to
 * anything but GitHub.
 */
function world(files, { site = {}, served = files, over = {}, installed = true, githubRepo = 'ada/club' } = {}) {
  const gh = fakeGitHub({ repo: githubRepo, files });
  const env = cloudEnv(fakeKV(installed ? { 'itok:ada/club': 'inst-token' } : {}));
  addSite(env, site);
  const asked = [];
  const handler = async (url, init) => {
    if (url.startsWith('https://api.github.com/')) return gh.handler(url, init);
    asked.push({ url, init });
    const u = new URL(url);
    const ours = u.origin === SITE || u.origin === WWW;
    const byHand = over[url] || (u.origin === SITE ? over[u.pathname] : null);
    if (byHand) return byHand(url, init);
    if (!ours) return undefined;
    const name = u.pathname === '/' ? 'index.html' : u.pathname === '/kiln' ? 'kiln.html' : u.pathname.slice(1);
    return served[name] == null ? new Response('Not found', { status: 404 }) : new Response(served[name], { status: 200, headers: { 'Content-Type': 'text/html' } });
  };
  return { gh, env, handler, asked };
}
const ask = (env, method, pathname, token = 'tok') => worker.fetch(new Request(`${SERVICE}${pathname}`, { method, headers: { Authorization: `Bearer ${token}` } }), env);
/** Press "Check this site": { res, body, by (the lines by id), calls }. */
const check = (w, id = 'site-1', token = 'tok') => withFetch(w.handler, async (calls) => {
  const res = await ask(w.env, 'GET', `/cloud/sites/check?site=${id}`, token);
  const body = await res.json();
  return { res, body, calls, by: Object.fromEntries((body.checks || []).map(c => [c.id, c])) };
});
const urls = (w) => w.asked.map(a => a.url);

test('check: a site that is set up right gets six lines, all yes, and its address is asked for three things with nothing sent along', { skip: d1Skip }, async () => {
  const w = world(withKiln());
  const { res, body } = await check(w);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.repo, 'ada/club');
  assert.equal(body.origin, SITE);
  assert.deepEqual(body.checks.map(c => c.id), ALL);
  for (const c of body.checks) {
    assert.equal(c.ok, true, `${c.id}: ${c.detail}`);
    assert.equal(c.fix, undefined, `${c.id} offers nothing to fix`);
    assert.ok(c.title && /\.$/.test(c.detail), `${c.id} has a title and a whole sentence`);
    assert.equal(/—/.test(c.title + c.detail), false);
  }
  assert.equal(body.all_ok, true);
  assert.match(body.checks[1].detail, /^Kiln's files are in ada\/club, and all 2 of its pages load the editor\.$/);
  assert.match(body.checks[2].detail, /^assets\/kiln-config\.js names this service \(https:\/\/worker\.example\) and this repository \(ada\/club\)\.$/);

  assert.deepEqual(urls(w).sort(), [`${SITE}/`, `${SITE}/assets/kiln.js`, `${SITE}/kiln`]);
  for (const { url, init } of w.asked) {
    assert.equal(init.method, 'GET', url);
    assert.equal(init.redirect, 'manual', `${url}: redirects are followed by hand`);
    assert.ok(init.signal, `${url}: it can be stopped`);
    assert.equal(init.body, undefined);
    assert.ok(init.credentials === undefined || init.credentials === 'omit');
    assert.deepEqual(Object.keys(init.headers).map(h => h.toLowerCase()).sort(), ['accept', 'user-agent'], `${url}: no cookie, no Authorization`);
  }
});

test('check: a repository the Kiln app cannot reach is the first no, with the install link, and the live site is still looked at', { skip: d1Skip }, async () => {
  // Never installed: there is no token for the repository at all.
  let w = world(withKiln(), { installed: false });
  let r = await check(w);
  assert.equal(r.res.status, 200, 'it answers all the same: this is a line in the list');
  assert.deepEqual(r.body.checks.map(c => c.id), ALL);
  assert.equal(r.by.repository.ok, false);
  assert.match(r.by.repository.detail, /^The Kiln app is not installed on ada\/club, or it was removed/);
  assert.deepEqual(r.by.repository.fix, { url: INSTALL, label: 'Install the Kiln app' });
  for (const id of ['files', 'settings']) {
    assert.equal(r.by[id].ok, null, `${id} is not checked, which is not a no`);
    assert.match(r.by[id].detail, /^Not checked, because Kiln (cannot|could not) read the repository/);
    assert.equal(r.by[id].fix, undefined);
  }
  for (const id of ['address', 'live', 'signin']) assert.equal(r.by[id].ok, true, id);
  assert.equal(r.body.all_ok, false);

  // Removed since: a token is still on hand, and GitHub no longer knows the repository for it.
  w = world(withKiln(), { githubRepo: 'someone/else' });
  r = await check(w);
  assert.equal(r.by.repository.ok, false);
  assert.deepEqual(r.by.repository.fix, { url: INSTALL, label: 'Install the Kiln app' });

  // GitHub not answering is not the owner's doing: nothing is called wrong.
  w = world(withKiln());
  w.gh.failOn(() => true);
  r = await check(w);
  for (const id of ['repository', 'files', 'settings']) assert.equal(r.by[id].ok, null, id);
  assert.match(r.by.repository.detail, /GitHub did not answer just now\. Please check again in a minute\./);
  assert.equal(r.body.checks.some(c => c.ok === false), false);
  assert.equal(r.body.all_ok, false);
});

test('check: a repository without Kiln says how many pages and which files, and offers the button the row already has', { skip: d1Skip }, async () => {
  let w = world({ 'index.html': page('Home'), 'about.html': page('About'), 'shop.html': page('Shop', TAGS), 'style.css': 'body{}' });
  let r = await check(w);
  assert.equal(r.by.repository.ok, true);
  assert.equal(r.by.files.ok, false);
  assert.match(r.by.files.detail, /^2 pages out of 3 do not have the two lines that load the editor: about\.html, index\.html\. /);
  assert.match(r.by.files.detail, /These files are missing from ada\/club: assets\/kiln\.js, assets\/kiln-editor\.js, assets\/kiln-features\.js, assets\/kiln-config\.js, kiln\.html, _headers\. /);
  assert.match(r.by.files.detail, /Press the button and Kiln shows you the change, then adds what is missing\.$/);
  assert.deepEqual(r.by.files.fix, { action: 'prepare', label: 'Add Kiln to this site' });
  assert.equal(r.by.settings.ok, null);
  assert.match(r.by.settings.detail, /^Not checked, because the settings file \(assets\/kiln-config\.js\) is not in the repository yet\./);
  assert.equal(r.by.address.ok, true);
  // The live home page is the one without the two lines.
  assert.equal(r.by.live.ok, false);
  assert.match(r.by.live.detail, /^The home page at https:\/\/club\.example does not load Kiln\. Add Kiln to the repository first/);
  assert.equal(r.by.signin.ok, false);
  assert.match(r.by.signin.detail, /^The sign-in page at https:\/\/club\.example\/kiln answered with an error \(404\)\. The page \(kiln\.html\) is not in your repository yet\./);
  assert.equal(r.body.all_ok, false);

  // One page added since: that page alone is named, and no file is called missing.
  w = world(withKiln({ 'news/index.html': page('News') }));
  r = await check(w);
  assert.equal(r.by.files.ok, false);
  assert.match(r.by.files.detail, /^1 page out of 3 does not have the two lines that load the editor: news\/index\.html\. Press the button/);
  assert.deepEqual(r.by.files.fix, { action: 'prepare', label: 'Add Kiln to this site' });
  assert.equal(r.by.settings.ok, true);

  // A repository with no pages has nothing to press.
  w = world({ 'README.md': '# club' });
  r = await check(w);
  assert.equal(r.by.files.ok, false);
  assert.match(r.by.files.detail, /^Kiln found no web pages/);
  assert.equal(r.by.files.fix, undefined);
});

test('check: a site a generator builds is reported as it is, with the setup tool and no button, and its live site is still checked', { skip: d1Skip }, async () => {
  const w = world(
    { 'astro.config.mjs': 'export default {}', 'src/pages/index.astro': '---\n---\n<h1>Hi</h1>', 'public/robots.txt': '', 'public/assets/kiln-config.js': SETTINGS },
    { served: withKiln() },
  );
  const { by, body } = await check(w);
  assert.equal(by.repository.ok, true);
  assert.equal(by.files.ok, null, 'neither a yes nor a no');
  assert.match(by.files.detail, /^Not checked\. This site is built by Astro before it is published/);
  assert.match(by.files.detail, /The setup tool handles a site like this: run it in the site's folder\./);
  assert.equal(by.files.fix, undefined);
  assert.equal(by.files.command, SETUP_COMMAND);
  assert.equal(by.settings.ok, true, 'the settings file is found where the generator keeps it');
  assert.match(by.settings.detail, /^public\/assets\/kiln-config\.js names this service/);
  for (const id of ['address', 'live', 'signin']) assert.equal(by[id].ok, true, id);
  assert.equal(body.all_ok, false);
  assert.equal(body.checks.some(c => c.ok === false), false);
});

test('check: a settings file that names another service or another repository says what it names and what to change', { skip: d1Skip }, async () => {
  let w = world(withKiln({ 'assets/kiln-config.js': "window.KILN = {\n  repo: 'ada/old-club',\n  branch: 'main',\n  worker: 'https://my-own.example.workers.dev',\n};\n" }));
  let r = await check(w);
  assert.equal(r.by.files.ok, true, 'the file is there: what it says is the next line');
  assert.equal(r.by.settings.ok, false);
  assert.match(r.by.settings.detail, /^The settings file \(assets\/kiln-config\.js\) needs a change\. /);
  assert.match(r.by.settings.detail, /Its worker line names another sign-in service, https:\/\/my-own\.example\.workers\.dev\. Change that line to worker: 'https:\/\/worker\.example'\./);
  assert.match(r.by.settings.detail, /Its repo line names another repository, ada\/old-club\. Change that line to repo: 'ada\/club'\./);
  assert.deepEqual(r.by.settings.fix, { url: 'https://github.com/ada/club/edit/main/assets/kiln-config.js', label: 'Open the settings file on GitHub' });

  // The same service and repository written a little differently are the same.
  w = world(withKiln({ 'assets/kiln-config.js': 'window.KILN = { repo: "Ada/Club", worker: "https://worker.example/" };' }));
  r = await check(w);
  assert.equal(r.by.settings.ok, true);

  // Neither line there at all.
  w = world(withKiln({ 'assets/kiln-config.js': 'window.KILN = {};' }));
  r = await check(w);
  assert.equal(r.by.settings.ok, false);
  assert.match(r.by.settings.detail, /It has no worker line\. Add one that reads worker: 'https:\/\/worker\.example'\. It has no repo line\. Add one that reads repo: 'ada\/club'\./);
});

test('check: an address that does not answer is a no, and the two lines after it are listed as not checked', { skip: d1Skip }, async () => {
  let w = world(withKiln(), { over: { '/': answer(503) } });
  let r = await check(w);
  for (const id of ['repository', 'files', 'settings']) assert.equal(r.by[id].ok, true, id);
  assert.equal(r.by.address.ok, false);
  assert.match(r.by.address.detail, /^https:\/\/club\.example answered with an error \(503\)\. Kiln could not look at the page\. Open it in your browser/);
  assert.deepEqual(r.by.address.fix, { url: SITE, label: 'Open your site' });
  for (const id of ['live', 'signin']) {
    assert.equal(r.by[id].ok, null, id);
    assert.equal(r.by[id].detail, 'Not checked, because the site\'s address did not answer with a page.');
  }
  assert.deepEqual(urls(w), [`${SITE}/`], 'nothing more is asked of an address that is down');

  // The request itself failing (no such name, no connection).
  w = world(withKiln(), { over: { '/': () => { throw new TypeError('fetch failed'); } } });
  r = await check(w);
  assert.equal(r.by.address.ok, false);
  assert.match(r.by.address.detail, /^https:\/\/club\.example did not answer at all\. Check that the address is spelled right/);
  assert.equal(r.by.live.ok, null);
  assert.equal(r.by.signin.ok, null);
});

test('check: Kiln in the repository and not on the live site says the host has not published it or publishes from somewhere else', { skip: d1Skip }, async () => {
  // The host still serves the pages from before Kiln was added.
  let w = world(withKiln(), { served: { 'index.html': page('Home'), 'about.html': page('About') } });
  let r = await check(w);
  for (const id of ['repository', 'files', 'settings', 'address']) assert.equal(r.by[id].ok, true, id);
  assert.equal(r.by.live.ok, false);
  assert.equal(r.by.live.detail, 'Kiln is in your repository, but the home page at https://club.example does not load it yet. Your host has not published the change yet, or it publishes from another repository or branch. Wait a minute or two and check again. If nothing changes, look at which repository and branch your host publishes from.');
  assert.equal(r.by.live.fix, undefined);
  assert.equal(r.by.signin.ok, false);
  assert.match(r.by.signin.detail, /answered with an error \(404\)\. The page \(kiln\.html\) is in your repository\. Your host has not published the change yet/);
  assert.equal(urls(w).includes(`${SITE}/assets/kiln.js`), false, 'a page that does not ask for the editor is not asked for its file');

  // The page asks for the editor and the file is not served.
  w = world(withKiln(), { served: withKiln({ 'assets/kiln.js': null }) });
  r = await check(w);
  assert.equal(r.by.live.ok, false);
  assert.match(r.by.live.detail, /^The home page at https:\/\/club\.example asks for the editor's file, but https:\/\/club\.example\/assets\/kiln\.js answered with an error \(404\)\. The file is in your repository\. Your host has not published/);
  assert.equal(r.by.signin.ok, true);

  // Only the sign-in page is missing from the live site.
  w = world(withKiln(), { served: withKiln({ 'kiln.html': null }) });
  r = await check(w);
  assert.equal(r.by.live.ok, true);
  assert.equal(r.by.signin.ok, false);
  assert.equal(r.body.checks.filter(c => c.ok === false).length, 1);
});

test('check: the editor file is asked for where the page says it is on this site, and never on another site', { skip: d1Skip }, async () => {
  let w = world(withKiln(), { served: { 'index.html': page('Home', '<script src="/js/kiln.js?v=2" defer></script>\n'), 'js/kiln.js': 'k', 'kiln.html': KILN_PAGE } });
  let r = await check(w);
  assert.equal(r.by.live.ok, true);
  assert.ok(urls(w).includes(`${SITE}/js/kiln.js?v=2`));

  w = world(withKiln(), { served: withKiln({ 'index.html': page('Home', '<script src="https://cdn.example/lib/kiln.js" defer></script>\n') }) });
  r = await check(w);
  assert.equal(r.by.live.ok, true, 'the usual place is asked instead');
  assert.deepEqual(urls(w).filter(u => !u.startsWith(`${SITE}/`)), []);
});

test('check: a trial that ended is said in a line of its own at the top, and the rest of the list is still given', { skip: d1Skip }, async () => {
  const bare = { 'index.html': page('Home') };
  let w = world(bare, { site: { status: 'canceled' } });
  let r = await check(w);
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.body.checks.map(c => c.id), ['editing', ...ALL]);
  assert.equal(r.by.editing.ok, false);
  assert.match(r.by.editing.detail, /^Editing is switched off for this site, because its free trial has ended\. Subscribe to switch it back on\./);
  assert.deepEqual(r.by.editing.fix, { action: 'subscribe', label: 'Subscribe' });
  // Kiln cannot add itself while editing is off, so that button is not offered.
  assert.equal(r.by.files.ok, false);
  assert.equal(r.by.files.fix, undefined);
  assert.match(r.by.files.detail, /Kiln can add what is missing once editing is switched back on for this site\.$/);
  assert.equal(r.body.all_ok, false);
  // The route that changes the repository still refuses this site, as before.
  await withFetch(w.handler, async () => assert.equal((await ask(w.env, 'GET', '/cloud/sites/prepare?site=site-1')).status, 403));

  // A site set up right whose trial ended: the one no is the line at the top.
  w = world(withKiln(), { site: { status: 'canceled' } });
  r = await check(w);
  assert.deepEqual(r.body.checks.filter(c => c.ok !== true).map(c => c.id), ['editing']);
  assert.equal(r.body.all_ok, false);

  // A plan that was paid for and ended, and a payment that failed, are worded as what they are.
  w = world(withKiln(), { site: { status: 'canceled', ls_subscription_id: 'sub_1' } });
  r = await check(w);
  assert.match(r.by.editing.detail, /because its plan has ended\. Subscribe/);
  w = world(withKiln(), { site: { status: 'past_due', ls_subscription_id: 'sub_1' } });
  w.env.kiln_cloud.exec('UPDATE sites SET access_until = 1 WHERE id = ?', 'site-1');
  r = await check(w);
  assert.match(r.by.editing.detail, /because a payment did not go through\. Update your card under Manage billing/);
  assert.deepEqual(r.by.editing.fix, { action: 'portal', label: 'Manage billing' });

  // Cancelled but paid up for now: editing is on, so there is no such line.
  w = world(withKiln(), { site: { status: 'canceled', ls_subscription_id: 'sub_1' } });
  w.env.kiln_cloud.exec('UPDATE sites SET access_until = ? WHERE id = ?', Date.now() + 86400000, 'site-1');
  r = await check(w);
  assert.deepEqual(r.body.checks.map(c => c.id), ALL);
  assert.equal(r.body.all_ok, true);
});

test('check: someone else\'s site is not found, and nobody signed in is told to sign in, with nothing asked of GitHub or of any site', { skip: d1Skip }, async () => {
  const w = world(withKiln());
  w.env.kiln_cloud.exec("INSERT INTO accounts (id, github_login, created_at) VALUES ('acct-2', 'bob', 1)");
  addSite(w.env, { id: 'site-2', account_id: 'acct-2', repo: 'bob/shop', origin: 'https://shop.example' });

  let r = await check(w, 'site-2');
  assert.equal(r.res.status, 404);
  assert.equal(r.body.code, 'no_such_site');
  assert.equal(r.body.checks, undefined);
  assert.deepEqual(r.calls, []);

  r = await check(w, 'no-such-id');
  assert.equal(r.res.status, 404);

  r = await check(w, 'site-1', 'not-a-session');
  assert.equal(r.res.status, 401);
  assert.deepEqual(r.body, { error: 'not signed in' });
  assert.deepEqual(r.calls, []);
});

test('check: an address that is not https, is a number, or only works on a private network is said so and never asked', { skip: d1Skip }, async () => {
  const cases = [
    ['http://club.example', /^This site was added with the address http:\/\/club\.example\. Kiln only looks at addresses that start with https:\/\/, so it did not ask this one\./],
    ['https://203.0.113.9', /which is a number and not a name on the public web, so Kiln does not look at it\./],
    ['https://127.0.0.1:8443', /which is a number and not a name/],
    ['https://[2001:db8::1]', /which is a number and not a name/],
    ['https://localhost', /which only works on your own computer or network, so Kiln cannot look at it from here\./],
    ['https://printer.local', /which only works on your own computer or network/],
    ['https://build.corp.internal', /which only works on your own computer or network/],
    ['https://intranet', /which only works on your own computer or network/],
  ];
  for (const [origin, says] of cases) {
    const w = world(withKiln(), { site: { origin } });
    const r = await check(w);
    assert.equal(r.res.status, 200, origin);
    assert.equal(r.by.address.ok, false, origin);
    assert.match(r.by.address.detail, says, origin);
    assert.match(r.by.address.detail, /[Ww]rite to info@kilncms\.com and we will change it/, origin);
    assert.equal(r.by.address.fix, undefined, `${origin}: no link to an address nobody should open`);
    assert.equal(r.by.live.ok, null, origin);
    assert.equal(r.by.signin.ok, null, origin);
    assert.deepEqual(urls(w), [], `${origin} was never asked`);
    // What the repository holds is still reported.
    assert.equal(r.by.files.ok, true, origin);
  }

  // The rule itself, including numbers written in ways that do not look like one.
  assert.equal(refusedAddress('https://club.example'), null);
  assert.equal(refusedAddress('https://www.club.example/kiln'), null);
  for (const a of ['https://2130706433', 'https://0x7f.1', 'https://127.1', 'https://[::1]', 'https://[::ffff:10.0.0.1]']) assert.equal(refusedAddress(a), 'numbered', a);
  for (const a of ['https://localhost.', 'https://LOCALHOST', 'https://app.localhost', 'https://nas.local.']) assert.equal(refusedAddress(a), 'private', a);
  for (const a of ['http://club.example', 'ftp://club.example', 'file:///etc/passwd', 'javascript:alert(1)']) assert.equal(refusedAddress(a), 'not_https', a);
  assert.equal(refusedAddress('club.example'), 'not_an_address');
});

test('check: a redirect is followed by hand, at most three times, and only to the same site or its www form', { skip: d1Skip }, async () => {
  // To another site: said, and not followed.
  let w = world(withKiln(), { over: { '/': answer(301, { Location: 'https://elsewhere.example/landing' }) } });
  let r = await check(w);
  assert.equal(r.by.address.ok, false);
  assert.match(r.by.address.detail, /^https:\/\/club\.example sends visitors on to https:\/\/elsewhere\.example, which is a different address, and Kiln does not follow them there\./);
  assert.deepEqual(urls(w), [`${SITE}/`]);
  assert.equal(r.by.live.ok, null);
  assert.equal(r.by.signin.ok, null);

  // Not to the same name without https, a numbered address, or a look-alike name either.
  for (const to of ['http://club.example/', 'https://169.254.169.254/latest/meta-data/', 'https://club.example.evil.test/', 'https://club.example:8443/', '//localhost/']) {
    w = world(withKiln(), { over: { '/': answer(302, { Location: to }) } });
    r = await check(w);
    assert.equal(r.by.address.ok, false, to);
    assert.deepEqual(urls(w), [`${SITE}/`], `${to} was not followed`);
  }

  // To the www form of the same site, and to another page of it: followed.
  w = world(withKiln(), { over: { '/': answer(301, { Location: `${WWW}/` }), '/kiln': answer(308, { Location: '/kiln/' }), '/kiln/': () => new Response(KILN_PAGE) } });
  r = await check(w);
  for (const c of r.body.checks) assert.equal(c.ok, true, `${c.id}: ${c.detail}`);
  assert.deepEqual(urls(w).sort(), [`${SITE}/`, `${SITE}/kiln`, `${SITE}/kiln/`, `${WWW}/`, `${WWW}/assets/kiln.js`].sort());

  // Round and round: four requests (the first and three redirects), then it stops.
  let n = 0;
  w = world(withKiln(), { over: { '/': () => new Response(null, { status: 302, headers: { Location: `/?again=${++n}` } }) } });
  r = await check(w);
  assert.equal(r.by.address.ok, false);
  assert.match(r.by.address.detail, /sent Kiln from one address to the next more than 3 times without showing a page\./);
  assert.equal(urls(w).length, 4);
  assert.equal(LIMITS.redirects, 3);
});

test('check: at most 512 KB of a page is read, however much the site sends', { skip: d1Skip }, async () => {
  assert.equal(LIMITS.bodyBytes, 512 * 1024);
  const CHUNK = 64 * 1024;
  let sent = 0, stopped = false;
  const endless = () => new Response(new ReadableStream({
    pull(c) { sent += CHUNK; c.enqueue(new Uint8Array(CHUNK).fill(0x20)); },
    cancel() { stopped = true; },
  }), { status: 200 });
  let w = world(withKiln(), { over: { '/': endless } });
  let r = await check(w);
  assert.equal(r.by.address.ok, true, 'the address answers');
  assert.equal(r.by.live.ok, null, 'what was not read is not judged');
  assert.match(r.by.live.detail, /^Not checked\. The home page at https:\/\/club\.example is larger than 512 KB\. Kiln reads only the first 512 KB of a page/);
  assert.equal(r.by.signin.ok, true, 'the sign-in page is still asked for');
  assert.ok(sent <= LIMITS.bodyBytes + 2 * CHUNK, `${sent} bytes were taken from a page that never ends`);
  assert.equal(stopped, true, 'the rest of the page was let go');

  // A large page that loads the editor near its top is a yes.
  w = world(withKiln(), { served: withKiln({ 'index.html': `<html><body>${TAGS}${'<p>long</p>'.repeat(60000)}` }) });
  r = await check(w);
  assert.equal(r.by.live.ok, true);
});

test('check: a site that never answers is given up on after the time limit, and the request is stopped', async () => {
  assert.equal(LIMITS.timeoutMs, 8000, 'eight seconds for each request, unless a test asks for less');
  let signal = null;
  const started = Date.now();
  const checks = await withFetch(
    (url, init) => { if (url.startsWith(SITE)) { signal = init.signal; return new Promise(() => {}); } return undefined; },
    () => checkSite({ token: null, repo: 'ada/club', origin: SITE, worker: SERVICE, timeoutMs: 40 }),
  );
  assert.ok(Date.now() - started < 4000);
  const by = Object.fromEntries(checks.map(c => [c.id, c]));
  assert.deepEqual(checks.map(c => c.id), ALL);
  assert.equal(by.address.ok, false);
  assert.match(by.address.detail, /^https:\/\/club\.example did not answer within 0\.04 seconds\. Open it in your browser\./);
  assert.equal(signal.aborted, true);
  assert.equal(by.live.ok, null);
  assert.equal(by.signin.ok, null);
});

test('check: whatever goes wrong becomes a line in the list, never an error', async () => {
  const broken = () => { throw new Error('everything is down'); };
  for (const origin of [SITE, 'not an address', '', undefined, 'https://']) {
    const checks = await withFetch(broken, () => checkSite({ token: 'inst-token', repo: 'ada/club', origin, worker: SERVICE, timeoutMs: 40 }));
    assert.deepEqual(checks.map(c => c.id), ALL, String(origin));
    assert.equal(checks.some(c => c.ok === true), false, String(origin));
    for (const c of checks) assert.ok(c.title && c.detail, `${origin}: ${c.id}`);
  }
});

test('check: looking writes nothing: not to GitHub, not to the site, and not to what the dashboard remembers', { skip: d1Skip }, async () => {
  const worlds = [
    world(withKiln()),
    world({ 'index.html': page('Home'), 'about.html': page('About') }),
    world(withKiln({ 'assets/kiln-config.js': "window.KILN = { repo: 'x/y', worker: 'https://other.example' };" })),
    world({ 'astro.config.mjs': 'export default {}', 'src/pages/index.astro': '---\n---\n<h1>Hi</h1>' }),
    world({ 'index.html': page('Home') }, { site: { status: 'canceled' } }),
    world(withKiln(), { installed: false }),
  ];
  for (const w of worlds) {
    const head = w.gh.head();
    const kept = [...w.env.KILN.map.keys()].sort();
    const row = JSON.stringify(w.env.kiln_cloud.row('SELECT * FROM sites WHERE id = ?', 'site-1'));
    const { res, calls } = await check(w);
    assert.equal(res.status, 200);
    assert.deepEqual(githubWrites(calls), []);
    assert.deepEqual(calls.filter(c => c.method !== 'GET'), [], 'every request, to GitHub and to the site, only reads');
    assert.equal(w.gh.head(), head);
    assert.deepEqual([...w.env.KILN.map.keys()].sort(), kept);
    assert.equal(JSON.stringify(w.env.kiln_cloud.row('SELECT * FROM sites WHERE id = ?', 'site-1')), row, 'the site is not marked as having Kiln by a check');
  }
});
