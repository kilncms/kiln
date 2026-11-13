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
import { saveDomain, domainRow, publicDomain } from '../worker/domain.js';

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

// ─── A site on Kiln's hosting ────────────────────────────────────────────────
// Such a site answers at the address the hosting gave it. Its own domain is on
// record but is not pointed at Kiln, so the check looks at the hosting's
// address, and no line sends the owner to "your host": Kiln is the host.

const HOSTED = 'https://club-1a2b3c4d.kiln-sites.workers.dev';
const HOSTING_ON = { HOSTING_ACCOUNT_ID: 'cf-account', HOSTING_API_TOKEN: 'cf-token', HOSTING_SUBDOMAIN: 'kiln-sites' };
/** The hosting's address serving `served` the way the hosting does. */
const hostedSite = (served) => Object.fromEntries([['/', 'index.html'], ['/kiln', 'kiln.html'], ['/assets/kiln.js', 'assets/kiln.js']].map(([at, name]) =>
  [`${HOSTED}${at}`, () => (served[name] == null ? new Response('Not found', { status: 404 }) : new Response(served[name], { status: 200, headers: { 'Content-Type': 'text/html' } }))]));
/** `world`, with hosting switched on and the site on it in `state`. */
function hostedWorld(files, { state = 'live', reason = null, deployed = 5, served = files, over = null, site = {}, on = true } = {}) {
  const w = world(files, { site: { plan: 'managed', ...site }, over: over || hostedSite(served), served: {} });
  if (on) Object.assign(w.env, HOSTING_ON);
  w.env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, reason, deployed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    'site-1', 'club-1a2b3c4d', HOSTED, state, reason, deployed, 5, 5);
  return w;
}
const noHostWords = (body) => { for (const c of body.checks) assert.equal(/your host\b/i.test(c.detail), false, `${c.id} sends nobody to "your host": ${c.detail}`); };

test('check, hosted: the address Kiln\'s hosting gave the site is the one looked at, and the address on record is asked for nothing', { skip: d1Skip }, async () => {
  const w = hostedWorld(withKiln());
  const { res, body, by } = await check(w);
  assert.equal(res.status, 200);
  assert.equal(body.origin, SITE, 'the address on record is still the one named for the site');
  assert.equal(body.looked_at, HOSTED);
  assert.deepEqual(body.checks.map(c => c.id), ALL);
  for (const c of body.checks) assert.equal(c.ok, true, `${c.id}: ${c.detail}`);
  assert.equal(body.all_ok, true);
  assert.equal(by.address.detail, `${HOSTED} answers. That is the address Kiln's hosting gave this site.`);
  assert.equal(by.live.detail, `The home page at ${HOSTED} loads Kiln, and the editor's file (${HOSTED}/assets/kiln.js) answers.`);
  assert.equal(by.signin.detail, `The sign-in page is at ${HOSTED}/kiln. Open it to sign in and edit.`);
  assert.deepEqual(urls(w).sort(), [`${HOSTED}/`, `${HOSTED}/assets/kiln.js`, `${HOSTED}/kiln`]);
  assert.equal(urls(w).some(u => u.startsWith(SITE)), false);
  noHostWords(body);
});

test('check, hosted: when the hosting is behind the repository, the lines say Kiln has not published yet and to press Publish again', { skip: d1Skip }, async () => {
  const before = { 'index.html': page('Home') };                      // what the hosting still serves: no Kiln on it
  const w = hostedWorld(withKiln(), { served: before });
  const { body, by } = await check(w);
  assert.equal(by.files.ok, true);
  assert.equal(by.address.ok, true);
  assert.equal(by.live.ok, false);
  assert.equal(by.live.detail, `Kiln is in your repository, but the home page at ${HOSTED} does not load it yet. Kiln has not published the change yet. Press Publish again on the site's row, wait a few seconds, and check again.`);
  assert.equal(by.signin.ok, false);
  assert.match(by.signin.detail, /The page \(kiln\.html\) is in your repository\. Kiln has not published the change yet\. Press Publish again on the site's row, wait a few seconds, and check again\.$/);
  noHostWords(body);
  for (const c of body.checks) assert.equal(/—/.test(c.detail), false);
});

test('check, hosted: with no Kiln in the repository, the next step says Kiln publishes it, and the settings line too', { skip: d1Skip }, async () => {
  const bare = { 'index.html': page('Home') };
  let w = hostedWorld(bare);
  let { body, by } = await check(w);
  assert.equal(by.files.ok, false);
  assert.match(by.live.detail, /does not load Kiln\. Add Kiln to the repository first \(see the line about the repository above\)\. Kiln publishes it in a few seconds\. Then check again\.$/);
  noHostWords(body);

  // A settings file that names another service: saved, then Kiln publishes it.
  w = hostedWorld(withKiln({ 'assets/kiln-config.js': kilnConfigFile({ repo: 'ada/club', branch: 'main', worker: 'https://other.example' }) }));
  ({ body, by } = await check(w));
  assert.equal(by.settings.ok, false);
  assert.match(by.settings.detail, /Save the file\. Kiln publishes it in a few seconds\. Then check again\.$/);
  noHostWords(body);
});

test('check, hosted: an address that does not answer is Kiln\'s to put right, and the owner is told what to press', { skip: d1Skip }, async () => {
  const w = hostedWorld(withKiln(), { over: { [`${HOSTED}/`]: answer(503) } });
  const { body, by } = await check(w);
  assert.equal(by.address.ok, false);
  assert.match(by.address.detail, /That is the address Kiln's hosting gave this site, so there is nothing for you to change at a host\. Press Publish again on the site's row and check again in a minute\. If it still does not answer, write to info@kilncms\.com\.$/);
  assert.deepEqual(by.address.fix, { url: HOSTED, label: 'Open your site' });
  assert.equal(by.live.ok, null);
  assert.equal(by.signin.ok, null);
  noHostWords({ checks: body.checks.filter(c => c.id !== 'address') });
});

test('check, hosted: a site that was taken down says why, and no address is asked for anything', { skip: d1Skip }, async () => {
  const w = hostedWorld(withKiln(), { state: 'ended', reason: 'trial_ended', deployed: null });
  const { body, by } = await check(w);
  assert.equal(body.looked_at, null);
  assert.equal(by.repository.ok, true);
  assert.equal(by.files.ok, true);
  assert.equal(by.address.ok, false);
  assert.equal(by.address.detail, 'Kiln took this site down from its hosting because the free days ran out. Your repository is untouched. Now that the site is subscribed, put it up again.');
  for (const id of ['live', 'signin']) { assert.equal(by[id].ok, null); assert.equal(by[id].detail, 'Not checked, because the site is not online.'); }
  assert.deepEqual(urls(w), []);
  assert.equal(body.all_ok, false);
  noHostWords(body);
});

test('check, hosted: a site that is going up for the first time says so, and one whose last copy failed is still looked at where it serves', { skip: d1Skip }, async () => {
  let w = hostedWorld(withKiln(), { state: 'starting', deployed: null });
  let { body, by } = await check(w);
  assert.equal(by.address.detail, 'Kiln is putting this site up now. Check again in a minute.');
  assert.deepEqual(urls(w), []);

  w = hostedWorld({ 'about.html': page('About') }, { state: 'waiting', reason: 'no_home', deployed: null });
  ({ body, by } = await check(w));
  assert.match(by.address.detail, /^Kiln found no home page \(a file named index\.html\) at the top of ada\/club/);
  assert.deepEqual(urls(w), []);

  // Was live, and the last copy failed: it still serves what it served.
  w = hostedWorld(withKiln(), { state: 'failed', reason: 'cloudflare', deployed: 5 });
  ({ body, by } = await check(w));
  assert.equal(body.looked_at, HOSTED);
  assert.equal(by.address.ok, true);
  assert.equal(body.all_ok, true);
});

test('check: with hosting switched off for the service, or a site on the hosting plan that was never put up, the address on record is looked at as before', { skip: d1Skip }, async () => {
  // The service has no hosting: a row left in the table changes nothing.
  let w = world(withKiln(), { site: { plan: 'managed' } });
  w.env.kiln_cloud.exec('INSERT INTO hosting (site_id, name, url, state, deployed_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', 'site-1', 'club', HOSTED, 'live', 5, 5, 5);
  let { body, by } = await check(w);
  assert.equal(body.looked_at, SITE);
  assert.equal(by.address.detail, `${SITE} answers.`);
  assert.equal(urls(w).every(u => u.startsWith(SITE)), true);

  // Hosting is on, the plan includes it, and the owner has not pressed the button: their own host is where the site is.
  w = world(withKiln(), { site: { plan: 'managed' } });
  Object.assign(w.env, HOSTING_ON);
  ({ body, by } = await check(w));
  assert.equal(body.looked_at, SITE);
  assert.equal(by.address.detail, `${SITE} answers.`);
});

// ─── A hosted site on its owner's own domain ─────────────────────────────────
// Once the domain is live the site is looked at there. While the domain still
// waits for its name servers, the address the hosting gave is looked at and
// one more line says what the domain waits for.

const OWN = 'oakbakery.test';
const DOMAIN = `https://${OWN}`;
/** An address serving `served` the way the hosting does. */
const servedAt = (base, served) => Object.fromEntries([['/', 'index.html'], ['/kiln', 'kiln.html'], ['/assets/kiln.js', 'assets/kiln.js']].map(([at, name]) =>
  [`${base}${at}`, () => (served[name] == null ? new Response('Not found', { status: 404 }) : new Response(served[name], { status: 200, headers: { 'Content-Type': 'text/html' } }))]));
const ownDomain = (w, state, more = {}) => saveDomain(w.env, 'site-1', { name: OWN, zone_id: 'zone-1', state, ns1: 'ada.ns.cloudflare.com', ns2: 'bob.ns.cloudflare.com', seller: 'GoDaddy.com, LLC', seller_id: 146, ...more });

test('check, hosted: a site whose own domain is live is looked at there, and the lines still say that Kiln publishes', { skip: d1Skip }, async () => {
  const files = withKiln();
  let w = hostedWorld(files, { over: servedAt(DOMAIN, files) });
  await ownDomain(w, 'live');
  w.env.kiln_cloud.exec("UPDATE sites SET origin = ? WHERE id = 'site-1'", DOMAIN);
  let { res, body, by } = await check(w);
  assert.equal(res.status, 200);
  assert.equal(body.looked_at, DOMAIN);
  assert.deepEqual(body.checks.map(c => c.id), ALL);
  for (const c of body.checks) assert.equal(c.ok, true, `${c.id}: ${c.detail}`);
  assert.equal(by.address.detail, `${DOMAIN} answers. That is this site's own domain, and Kiln's hosting answers there.`);
  assert.equal(by.signin.detail, `The sign-in page is at ${DOMAIN}/kiln. Open it to sign in and edit.`);
  assert.equal(urls(w).some(u => u.startsWith(HOSTED)), false, 'the temporary address is asked for nothing');
  noHostWords(body);

  // The domain does not answer: the line says what the owner can have changed, and what to press.
  w = hostedWorld(files, { over: servedAt(DOMAIN, {}) });
  await ownDomain(w, 'live');
  w.env.kiln_cloud.exec("UPDATE sites SET origin = ? WHERE id = 'site-1'", DOMAIN);
  ({ body, by } = await check(w));
  assert.equal(body.looked_at, DOMAIN);
  assert.equal(by.address.ok, false);
  assert.match(by.address.detail, / That is this site's own domain, which is live on Kiln's hosting\. If you changed its name servers away from Kiln, change them back where you bought the domain\. If you did not, press Publish again on the site's row and check again in a minute\. If it still does not answer, write to /);
  for (const c of body.checks) assert.doesNotMatch(c.detail, /[—–]/);
  noHostWords(body);
});

test('check, hosted: while a domain waits for its name servers, the address the hosting gave is looked at, and one more line says what the domain waits for', { skip: d1Skip }, async () => {
  let w = hostedWorld(withKiln());
  await ownDomain(w, 'waiting');
  const seller = publicDomain(await domainRow(w.env, 'site-1')).seller.name;
  let { body, by } = await check(w);
  assert.equal(body.looked_at, HOSTED);
  assert.deepEqual(body.checks.map(c => c.id), [...ALL, 'domain']);
  assert.equal(by.address.detail, `${HOSTED} answers. That is the address Kiln's hosting gave this site.`);
  assert.deepEqual(by.domain, { id: 'domain', ok: true, title: 'The site\'s own domain is ready on Kiln\'s side',
    detail: `${OWN} is ready on Kiln's side and waits for its name servers to be changed at ${seller}. The site's row in the dashboard shows the two names to enter there. Until then, this check looks at the address Kiln's hosting gave the site.` });
  assert.doesNotMatch(by.domain.detail, /[—–]|undefined|null/);
  assert.equal(body.all_ok, true);
  assert.equal(urls(w).some(u => u.includes(OWN)), false, 'the domain is asked for nothing');
  noHostWords(body);

  // Nobody could say where the domain was bought: the line still says where to go.
  w = hostedWorld(withKiln());
  await ownDomain(w, 'waiting', { seller: null, seller_id: null });
  ({ by } = await check(w));
  assert.match(by.domain.detail, /to be changed at the company you bought the domain from\. /);

  // A set-up that was put away: the address the hosting gave, and no line about a domain.
  w = hostedWorld(withKiln());
  await ownDomain(w, 'put_away', { reason: 'not_changed' });
  ({ body } = await check(w));
  assert.equal(body.looked_at, HOSTED);
  assert.deepEqual(body.checks.map(c => c.id), ALL);
});

// ─── A site whose files Kiln keeps ────────────────────────────────────────────

/** checkSite itself, for the site in `w`, as a site on Kiln's hosting. */
const lines = (w, over = {}) => withFetch(w.handler, async () => {
  const checks = await checkSite({ token: 'inst-token', repo: 'ada/club', origin: SITE, worker: SERVICE, installUrl: INSTALL, hosted: true, ...over });
  return { checks, by: Object.fromEntries(checks.map(c => [c.id, c])) };
});
const KEPT_IDS = ['files', 'settings', 'address', 'live', 'signin'];
const noRepository = (checks) => {
  for (const c of checks) assert.equal(/repositor|github|ada\/club|—|–|undefined/i.test(JSON.stringify(c)), false, JSON.stringify(c));
};

test('check: a site Kiln keeps the files of has no line about installing the app, and says "your site\'s files" where another site\'s list says the repository', async () => {
  const plain = await lines(world(withKiln()));
  const kept = await lines(world(withKiln()), { kept: true });
  assert.deepEqual(kept.checks.map(c => c.id), KEPT_IDS);
  for (const c of kept.checks) assert.equal(c.ok, true, `${c.id}: ${c.detail}`);
  noRepository(kept.checks);
  assert.equal(kept.by.files.title, "Kiln is in your site's files");
  assert.equal(kept.by.settings.title, "The settings file names this service and your site's files");
  assert.ok(plain.by.files.detail.startsWith("Kiln's files are in ada/club, and "), plain.by.files.detail);
  assert.equal(kept.by.files.detail, plain.by.files.detail.replace("Kiln's files are in ada/club", "Kiln's files are among your site's files"));
  assert.equal(kept.by.settings.detail, `assets/kiln-config.js names this service (${SERVICE}) and your site's files.`);
  // The lines about the live site say nothing of a repository for anybody, so they are the same.
  for (const id of ['address', 'live', 'signin']) assert.deepEqual(kept.by[id], plain.by[id]);
});

test('check: a site that is not kept reads exactly as before, with the flag off or not given', async () => {
  const a = await lines(world(withKiln()));
  const b = await lines(world(withKiln()), { kept: false });
  assert.deepEqual(a.checks, b.checks);
  assert.deepEqual(a.checks.map(c => c.id), ALL);
  assert.equal(a.by.repository.title, 'Kiln can reach the repository');
  assert.equal(a.by.repository.detail, 'The Kiln app is installed on ada/club and can read it.');
  assert.equal(a.by.files.title, 'Kiln is in the repository');
  assert.equal(a.by.settings.detail, `assets/kiln-config.js names this service (${SERVICE}) and this repository (ada/club).`);
  const none = await lines(world(withKiln()), { token: null });
  assert.equal(none.by.repository.fix.url, INSTALL);
  assert.equal(none.by.files.detail, 'Not checked, because Kiln cannot read the repository yet.');
});

test('check: what a kept site\'s owner reads when something is wrong never sends them to GitHub or asks them to change a file by hand', async () => {
  const UNREAD = "Not checked, because Kiln could not read your site's files just now. Please check again in a minute.";
  // Kiln could not read the files: nothing to install, only to try again.
  const none = await lines(world(withKiln()), { kept: true, token: null });
  assert.deepEqual(none.checks.map(c => c.id), KEPT_IDS);
  assert.deepEqual([none.by.files.ok, none.by.files.detail, none.by.settings.detail], [null, UNREAD, UNREAD]);
  assert.equal(none.checks.some(c => c.fix && c.fix.url), false, 'no link to install anything');
  noRepository(none.checks);

  // One of Kiln's files is missing: the button the row already has.
  const { 'assets/kiln-features.js': gone, ...rest } = withKiln();
  const missing = await lines(world(rest), { kept: true });
  assert.equal(missing.by.files.ok, false);
  assert.ok(missing.by.files.detail.includes("This file is missing from your site's files: assets/kiln-features.js."), missing.by.files.detail);
  assert.deepEqual(missing.by.files.fix, { action: 'prepare', label: 'Add Kiln to this site' });
  noRepository(missing.checks);

  // The settings file names something else: only Kiln can change it, so there is no link to GitHub.
  const other = await lines(world(withKiln({ 'assets/kiln-config.js': kilnConfigFile({ repo: 'someone/else', branch: 'main', worker: SERVICE }) })), { kept: true });
  assert.equal(other.by.settings.ok, false);
  assert.equal(other.by.settings.detail, 'The settings file (assets/kiln-config.js) needs a change that only Kiln can make. Write to info@kilncms.com and say which site it is, and a person will put it right.');
  assert.equal('fix' in other.by.settings, false);
  noRepository(other.checks);

  // Kiln is in the files and the live site does not load it yet.
  const behind = await lines(world(withKiln(), { served: { 'index.html': page('Home'), 'kiln.html': KILN_PAGE } }), { kept: true });
  assert.equal(behind.by.live.ok, false);
  assert.equal(behind.by.live.detail, `Kiln is in your site's files, but the home page at ${SITE} does not load it yet. Kiln has not published the change yet. Press Publish again on the site's row, wait a few seconds, and check again.`);
  noRepository(behind.checks);
});

test('check: the dashboard\'s route says a site is kept, and a kept site that is not on Kiln\'s hosting yet is told to put it there', { skip: d1Skip }, async () => {
  const w = world(withKiln());
  w.env.kiln_cloud.exec("UPDATE sites SET kept = 1 WHERE id = 'site-1'");
  const { res, body, by } = await check(w);
  assert.equal(res.status, 200);
  assert.deepEqual(body.checks.map(c => c.id), KEPT_IDS);
  assert.equal(by.files.title, "Kiln is in your site's files");
  assert.deepEqual([by.address.ok, by.address.detail], [false, "Your site is not up yet. Press Put it on Kiln's hosting on the site's row, then check again."]);
  noRepository(body.checks);
  assert.deepEqual(urls(w), [], 'no address is asked for anything while the site is not up');
});
