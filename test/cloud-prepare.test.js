/**
 * Adding Kiln to a site's repository from the dashboard (worker/prepare.js,
 * GET and POST /cloud/sites/prepare): what the setup tool does in a terminal,
 * done by the service. The real handlers run over the SQLite-backed D1
 * stand-in and an in-memory GitHub with a real git object model, so each test
 * can look at what the repository holds afterwards. Kiln's own files come
 * from a stand-in for the release branch. Nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { fakeKV, withFetch, githubWrites } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { withKilnTags, isSitePage, KILN_TAGS, KILN_PAGE, kilnConfigFile, MAX_PAGES } from '../worker/prepare.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASE = 'https://raw.githubusercontent.com/kilncms/kiln/release';
// The editor's files as the release branch serves them. The second holds bytes
// that are not text at all: what lands in the repository must be these bytes.
const released = {
  'dist/kiln.js': Buffer.from('/* kiln.js */ var KILN_VERSION = "t1";\n'),
  'dist/kiln-editor.js': Buffer.concat([Buffer.from('/* editor: é */ '), Buffer.from([0xff, 0x00, 0x80, 0x0a])]),
  'dist/kiln-features.js': Buffer.from('/* features */\n'),
  'templates/_headers': Buffer.from('/*\n  X-Frame-Options: SAMEORIGIN\n'),
};
const page = (title, extra = '') => `<!doctype html>\n<html>\n<head><title>${title}</title></head>\n<body>\n  <h1>${title}</h1>\n${extra}</body>\n</html>\n`;
const TAGS = `${KILN_TAGS[0]}\n${KILN_TAGS[1]}\n`;
const KILN_FILES = ['_headers', 'assets/kiln-config.js', 'assets/kiln-editor.js', 'assets/kiln-features.js', 'assets/kiln.js', 'kiln.html'];

/** One account (ada) with one site (ada/club), its repository, and the release branch. */
function world(files, { site = {}, env: extra = {}, branch = 'main', kv: seed = {}, release = released } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files, defaultBranch: branch });
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token', ...seed }), extra);
  addSite(env, site);
  const handler = async (url, init) => {
    if (url.startsWith(`${RELEASE}/`)) { const f = release[url.slice(RELEASE.length + 1)]; return f ? new Response(f) : undefined; }
    return gh.handler(url, init);
  };
  return { gh, env, handler };
}
const ask = (env, method, pathname, body, token = 'tok') => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const look = (env, id = 'site-1') => ask(env, 'GET', `/cloud/sites/prepare?site=${id}`);
const press = (env, id = 'site-1') => ask(env, 'POST', '/cloud/sites/prepare', { id });
const prepared = (env) => env.kiln_cloud.row('SELECT prepared_at, prepared_commit FROM sites WHERE id = ?', 'site-1');

test('prepare: looking says what would change, by name and number, and writes nothing', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world({
    'index.html': page('Home'),
    'about/index.html': page('About'),
    'shop.html': page('Shop', TAGS),                       // already loads the editor
    'old.html': '<h1>No body tag here</h1>',
    'dist/index.html': page('Built copy'),                 // a build folder: not a page of the site
    'node_modules/x/demo.html': page('A package demo'),
    '.github/notes.html': page('Hidden'),
    'style.css': 'body{}',
  });
  const before = gh.head();
  await withFetch(handler, async (calls) => {
    const res = await look(env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.state, 'ready');
    assert.equal(body.repo, 'ada/club');
    assert.equal(body.branch, 'main');
    assert.deepEqual(body.pages, { total: 4, already: 1, add: 2, add_names: ['about/index.html', 'index.html'], skipped: [{ path: 'old.html', why: 'no_body' }], skipped_count: 1 });
    assert.deepEqual([...body.files.add].sort(), KILN_FILES);
    assert.deepEqual(body.files.kept, []);
    assert.equal(JSON.stringify(body).includes('<h1>'), false, 'no page text leaves the service');
    assert.deepEqual(githubWrites(calls), [], 'looking writes nothing to GitHub');
    assert.equal(calls.some(c => c.url.startsWith(RELEASE)), false, 'and fetches nothing it will not use');
  });
  assert.equal(gh.head(), before);
  assert.equal(prepared(env).prepared_at, null);
});

test('prepare: pressing the button makes one commit in the owner\'s name that adds the files and the two lines, and nothing else changes', { skip: d1Skip }, async () => {
  const files = {
    'index.html': page('Home'),
    'about/index.html': page('About'),
    'shop.html': page('Shop', TAGS),
    'style.css': 'body{}',
    'img/logo.svg': '<svg/>',
  };
  const { gh, env, handler } = world(files, { branch: 'trunk' });
  env.KILN.map.set('csess:tok', JSON.stringify({ account_id: 'acct-1', login: 'ada', uid: 42, gh: 'gho_x' }));   // a session that knows GitHub's number for ada
  const before = gh.head('trunk');
  await withFetch(handler, async () => {
    const res = await press(env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'done');
    assert.equal(body.commit.sha, gh.head('trunk'));
    assert.equal(body.commit.url, `https://github.com/ada/club/commit/${gh.head('trunk')}`);
    assert.equal(body.pages.add, 2);
  });
  const made = gh.commits.get(gh.head('trunk'));
  assert.deepEqual(made.parents, [before], 'exactly one commit, on top of what was there');
  assert.equal(made.author.name, 'ada');
  assert.equal(made.author.email, '42+ada@users.noreply.github.com');
  assert.match(made.message, /^Add Kiln to this site\n\n2 pages now load the editor\. Added from the Kiln dashboard by ada\.$/);

  // The two lines sit before </body>, and every other character of the page is as it was.
  assert.equal(gh.read('index.html', 'trunk'), page('Home', TAGS));
  assert.equal(gh.read('about/index.html', 'trunk'), page('About', TAGS));
  assert.equal(gh.read('shop.html', 'trunk'), files['shop.html']);
  assert.equal(gh.read('style.css', 'trunk'), 'body{}');
  assert.equal(gh.read('img/logo.svg', 'trunk'), '<svg/>');
  assert.deepEqual(gh.paths('trunk'), [...Object.keys(files), ...KILN_FILES].sort());

  // Kiln's own files are the released bytes, the settings name this site and this service.
  const blob = (p) => gh.blobs.get(gh.trees.get(made.tree).get(p).sha);
  assert.deepEqual(blob('assets/kiln.js'), released['dist/kiln.js']);
  assert.deepEqual(blob('assets/kiln-editor.js'), released['dist/kiln-editor.js'], 'byte for byte, even where the bytes are not text');
  assert.deepEqual(blob('assets/kiln-features.js'), released['dist/kiln-features.js']);
  assert.deepEqual(blob('_headers'), released['templates/_headers']);
  assert.equal(gh.read('assets/kiln-config.js', 'trunk'), "window.KILN = {\n  repo:   'ada/club',\n  branch: 'trunk',\n  worker: 'https://worker.example',\n  styles: [],\n};\n");
  assert.equal(gh.read('kiln.html', 'trunk'), KILN_PAGE);

  // The dashboard is told, and asking again changes nothing.
  assert.equal(prepared(env).prepared_commit, gh.head('trunk'));
  assert.ok(prepared(env).prepared_at > 0);
  const me = await (await ask(env, 'GET', '/cloud/me')).json();
  assert.equal(me.prepare, true);
  assert.ok(me.sites[0].prepared_at > 0);
  const after = gh.head('trunk');
  await withFetch(handler, async (calls) => {
    assert.equal((await (await look(env)).json()).state, 'prepared');
    const again = await press(env);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).state, 'prepared');
    assert.deepEqual(githubWrites(calls), []);
  });
  assert.equal(gh.head('trunk'), after);
});

test('prepare: a file that is already in the repository is never replaced, and settings that name another service are pointed out', { skip: d1Skip }, async () => {
  const mine = {
    'index.html': page('Home'),
    '_headers': '/*\n  X-Mine: yes\n',
    'assets/kiln-config.js': "window.KILN = {\n  repo: 'ada/club',\n  worker: 'https://my-own-worker.example.workers.dev',\n};\n",
    'assets/kiln-editor.js': '/* an older editor */',
  };
  const { gh, env, handler } = world(mine);
  await withFetch(handler, async (calls) => {
    const seen = await (await look(env)).json();
    assert.deepEqual([...seen.files.add].sort(), ['assets/kiln-features.js', 'assets/kiln.js', 'kiln.html']);
    assert.deepEqual([...seen.files.kept].sort(), ['_headers', 'assets/kiln-config.js', 'assets/kiln-editor.js']);
    assert.equal(seen.other_worker, 'https://my-own-worker.example.workers.dev');
    assert.equal((await press(env)).status, 200);
    assert.equal(calls.some(c => c.url === `${RELEASE}/dist/kiln-editor.js` || c.url === `${RELEASE}/templates/_headers`), false, 'what is kept is not even fetched');
  });
  for (const f of ['_headers', 'assets/kiln-config.js', 'assets/kiln-editor.js']) assert.equal(gh.read(f), mine[f], f);
  assert.equal(gh.read('index.html'), page('Home', TAGS));

  // Settings that name this very service are not remarked on.
  const same = world({ 'index.html': page('Home'), 'assets/kiln-config.js': "window.KILN = { repo: 'ada/club', worker: 'https://worker.example/' };" });
  await withFetch(same.handler, async () => assert.equal((await (await look(same.env)).json()).other_worker, undefined));
});

test('prepare: a site that has Kiln and lacks only the security headers file counts as done, and is not written to for that file alone', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world({
    'index.html': page('Home', TAGS),
    'assets/kiln.js': 'k', 'assets/kiln-editor.js': 'e', 'assets/kiln-features.js': 'f', 'assets/kiln-config.js': "window.KILN = { repo: 'ada/club', worker: 'https://worker.example' };", 'kiln.html': KILN_PAGE,
  });
  const before = gh.head();
  await withFetch(handler, async (calls) => {
    const seen = await (await look(env)).json();
    assert.equal(seen.state, 'prepared');
    assert.deepEqual(seen.files.add, []);
    assert.equal((await (await press(env)).json()).state, 'prepared');
    assert.deepEqual(githubWrites(calls), []);
  });
  assert.equal(gh.head(), before);
  assert.ok(prepared(env).prepared_at > 0, 'and the dashboard stops offering the button');
});

test('prepare: a page added later gets its two lines when the button is pressed again, and nothing else is written', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world({ 'index.html': page('Home') });
  await withFetch(handler, async () => assert.equal((await press(env)).status, 200));
  const first = gh.head();
  gh.commit({ 'news.html': page('News') });
  await withFetch(handler, async (calls) => {
    const seen = await (await look(env)).json();
    assert.equal(seen.state, 'ready');
    assert.deepEqual(seen.pages.add_names, ['news.html']);
    assert.deepEqual(seen.files.add, []);
    assert.equal((await press(env)).status, 200);
    assert.equal(calls.some(c => c.url.startsWith(RELEASE)), false);
  });
  assert.equal(gh.read('news.html'), page('News', TAGS));
  assert.equal(gh.read('index.html'), page('Home', TAGS));
  assert.equal(gh.commits.get(gh.head()).parents.length, 1);
  assert.notEqual(gh.head(), first);
  assert.match(gh.commits.get(gh.head()).message, /1 page now loads the editor/);
});

test('prepare: a page keeps its line endings and its byte-order mark, and a page that is not UTF-8 text is left alone and named', { skip: d1Skip }, async () => {
  const crlf = '﻿<html>\r\n<body>\r\n\t<p>café</p>\r\n\t</body>\r\n</html>\r\n';
  const latin1 = Buffer.from('<html><body><p>caf\xe9</p></body></html>', 'latin1');
  const { gh, env, handler } = world({ 'index.html': crlf, 'old.html': latin1, 'inline.html': '<html><body><p>x</p></body></html>' });
  await withFetch(handler, async () => {
    const seen = await (await look(env)).json();
    assert.deepEqual(seen.pages.skipped, [{ path: 'old.html', why: 'not_text' }]);
    assert.equal((await press(env)).status, 200);
  });
  const tree = gh.trees.get(gh.commits.get(gh.head()).tree);
  assert.equal(gh.read('index.html'), `﻿<html>\r\n<body>\r\n\t<p>café</p>\r\n\t${KILN_TAGS[0]}\r\n\t${KILN_TAGS[1]}\r\n\t</body>\r\n</html>\r\n`, 'the mark, the CRLFs and the indentation are kept');
  assert.deepEqual(gh.blobs.get(tree.get('index.html').sha).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.deepEqual(gh.blobs.get(tree.get('old.html').sha), latin1, 'not one byte of it changed');
  assert.equal(gh.read('inline.html'), `<html><body><p>x</p>\n${KILN_TAGS[0]}\n${KILN_TAGS[1]}\n</body></html>`);
});

test('prepare: a site that a generator builds, or that has no pages, is refused with the reason and what to do, and nothing is written', { skip: d1Skip }, async () => {
  const cases = {
    built: [{ 'astro.config.mjs': 'export default {}', 'src/pages/index.astro': '---\n---\n<h1>Hi</h1>', 'public/robots.txt': '' }, /built by Astro/, true],
    no_pages: [{ 'README.md': '# club', 'public/index.html': page('In a build folder') }, /found no web pages/, false],
  };
  for (const [state, [files, sentence, command]] of Object.entries(cases)) {
    const { gh, env, handler } = world(files);
    const before = gh.head();
    await withFetch(handler, async (calls) => {
      const seen = await look(env);
      assert.equal(seen.status, 200, state);
      const body = await seen.json();
      assert.equal(body.ok, false, state);
      assert.equal(body.state, state);
      assert.match(body.error, sentence);
      assert.equal(body.command, command ? 'npx github:kilncms/kiln#release' : undefined, state);
      const pressed = await press(env);
      assert.equal(pressed.status, 409, state);
      assert.equal((await pressed.json()).code, state);
      assert.deepEqual(githubWrites(calls), [], state);
    });
    assert.equal(gh.head(), before, state);
    assert.equal(prepared(env).prepared_at, null, state);
  }
  // More pages than this takes on.
  const many = Object.fromEntries(Array.from({ length: MAX_PAGES + 1 }, (_, i) => [`p/${i}.html`, '<body></body>']));
  const big = world(many);
  await withFetch(big.handler, async (calls) => {
    const body = await (await look(big.env)).json();
    assert.equal(body.state, 'too_big');
    assert.match(body.error, new RegExp(`more than ${MAX_PAGES} pages`));
    assert.equal(calls.some(c => /\/git\/blobs\//.test(c.url)), false, 'and no page is read for nothing');
  });
});

test('prepare: only the signed-in owner of a site that may be edited can ask, and each refusal says why', { skip: d1Skip }, async () => {
  const files = { 'index.html': page('Home') };
  // Not signed in; a site of another account; a site that does not exist.
  let w = world(files);
  w.env.kiln_cloud.exec("INSERT INTO accounts (id, github_login, created_at) VALUES ('acct-2', 'bob', 1)");
  addSite(w.env, { id: 'site-2', account_id: 'acct-2', repo: 'bob/shop', origin: 'https://shop.example' });
  await withFetch(w.handler, async (calls) => {
    assert.equal((await ask(w.env, 'GET', '/cloud/sites/prepare?site=site-1', null, 'nobody')).status, 401);
    assert.equal((await ask(w.env, 'POST', '/cloud/sites/prepare', { id: 'site-1' }, 'nobody')).status, 401);
    for (const id of ['site-2', 'nope', '']) {
      const res = await press(w.env, id);
      assert.equal(res.status, 404, id);
      assert.equal((await res.json()).code, 'no_such_site');
    }
    assert.deepEqual(calls, [], 'GitHub is not even asked');
  });

  // A free trial that ran out: editing is off, and so is this.
  w = world(files, { site: { status: 'canceled' } });
  await withFetch(w.handler, async (calls) => {
    const res = await press(w.env);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'plan_ended');
    assert.match(body.error, /Subscribe/);
    assert.deepEqual(calls, []);
  });

  // The Kiln app is not on the repository: say so, with where to install it.
  w = world(files, { kv: { 'itok:ada/club': '' } });
  w.env.KILN.map.delete('itok:ada/club');
  await withFetch(w.handler, async () => {
    for (const res of [await look(w.env), await press(w.env)]) {
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.code, 'no_access');
      assert.match(body.install_url, /^https:\/\/github\.com\/apps\//);
    }
  });
  // …or it was removed after the token was handed out: GitHub answers 404.
  w = world(files);
  await withFetch(async () => undefined, async () => assert.equal((await (await press(w.env)).json()).code, 'no_access'));

  // A repository of an organisation the signed-in person may not change.
  const org = fakeGitHub({ repo: 'acme/site', files });
  const env = cloudEnv(fakeKV({ 'itok:acme/site': 'inst-token' }));
  addSite(env, { repo: 'acme/site' });
  await withFetch(async (url) => (url === 'https://api.github.com/repos/acme/site' ? new Response(JSON.stringify({ permissions: { push: false, admin: false } }), { status: 200 }) : org.handler(url)), async (calls) => {
    const res = await press(env);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'not_yours');
    assert.deepEqual(githubWrites(calls), []);
  });
  assert.equal(org.read('index.html'), page('Home'));
});

test('prepare: when the repository changes while Kiln is working, or the branch takes no direct change, nothing is changed and the answer says so', { skip: d1Skip }, async () => {
  // Someone pushes between Kiln's reading and its writing.
  const { gh, env, handler } = world({ 'index.html': page('Home') });
  let theirs = null;
  gh.onWrite((api) => { if (!theirs) theirs = api.commit({ 'index.html': page('Home, changed by the owner') }); });
  await withFetch(handler, async () => {
    const res = await press(env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'moved');
    assert.match(body.error, /Nothing was changed\. Please press the button again\./);
  });
  assert.equal(gh.head(), theirs, 'the branch is where the owner left it');
  assert.equal(gh.read('index.html'), page('Home, changed by the owner'));
  assert.equal(prepared(env).prepared_at, null);
  assert.equal(await env.KILN.get('preplock:site-1'), null, 'and the button works again at once');
  gh.onWrite(null);
  await withFetch(handler, async () => assert.equal((await press(env)).status, 200));
  assert.equal(gh.read('index.html'), page('Home, changed by the owner', TAGS));

  // A protected branch.
  const p = world({ 'index.html': page('Home') });
  const before = p.gh.head();
  await withFetch(async (url, init) => (init.method === 'PATCH' && /\/git\/refs\/heads\/main$/.test(url)
    ? new Response(JSON.stringify({ message: 'Repository rule violations found\n\nChanges must be made through a pull request.' }), { status: 422 })
    : p.handler(url, init)), async () => {
    const res = await press(p.env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'protected');
    assert.match(body.error, /main branch of ada\/club does not take a direct change/);
    assert.equal(body.command, 'npx github:kilncms/kiln#release');
  });
  assert.equal(p.gh.head(), before);
});

test('prepare: when Kiln\'s own files cannot be fetched, or GitHub fails part-way, the repository is left as it was', { skip: d1Skip }, async () => {
  const r = world({ 'index.html': page('Home') }, { release: { ...released, 'dist/kiln-editor.js': undefined } });
  const before = r.gh.head();
  await withFetch(r.handler, async (calls) => {
    const res = await press(r.env);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.code, 'release');
    assert.match(body.error, /Nothing was changed/);
    assert.deepEqual(githubWrites(calls), [], 'nothing is written before every file is in hand');
  });
  assert.equal(r.gh.head(), before);

  for (const failing of ['/git/trees', '/git/commits']) {
    const g = world({ 'index.html': page('Home') });
    const was = g.gh.head();
    g.gh.failOn((method, p) => method === 'POST' && p === failing);
    await withFetch(g.handler, async () => {
      const res = await press(g.env);
      assert.equal(res.status, 502, failing);
      assert.equal((await res.json()).code, 'github', failing);
    });
    assert.equal(g.gh.head(), was, failing);
    assert.equal(g.gh.read('index.html'), page('Home'), failing);
    assert.equal(prepared(g.env).prepared_at, null, failing);
  }
  // A page GitHub will not hand over might be one that needs the two lines: nothing is written, and it is not called done.
  const h = world({ 'index.html': page('Home'), 'b.html': page('B') });
  h.gh.failOn((method, p) => method === 'GET' && /^\/git\/blobs\//.test(p));
  await withFetch(h.handler, async (calls) => {
    const res = await press(h.env);
    assert.equal(res.status, 502);
    assert.deepEqual(githubWrites(calls), []);
  });
});

test('prepare: two presses at once make one commit', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world({ 'index.html': page('Home') }, { kv: { 'preplock:site-1': '1' } });
  const before = gh.head();
  await withFetch(handler, async (calls) => {
    const res = await press(env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'busy');
    assert.match(body.error, /already making this change/);
    assert.deepEqual(githubWrites(calls), []);
    assert.equal((await look(env)).status, 200, 'looking is still allowed');
  });
  assert.equal(gh.head(), before);
});

test('prepare: a large site is sent to GitHub in several parts and arrives whole', { skip: d1Skip }, async () => {
  const filler = `<p>${'word '.repeat(60000)}</p>\n`;           // about 300 KB a page
  const files = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}.html`, page(`Page ${i}`, filler)]));
  const { gh, env, handler } = world(files);
  await withFetch(handler, async (calls) => {
    assert.equal((await press(env)).status, 200);
    const trees = calls.filter(c => c.method === 'POST' && /\/git\/trees$/.test(c.url));
    assert.ok(trees.length >= 3, `several tree requests (${trees.length})`);
    for (const t of trees) assert.ok(JSON.stringify(t.body).length < 1.6 * 1024 * 1024, 'none of them large');
  });
  for (let i = 0; i < 9; i++) assert.equal(gh.read(`p${i}.html`), page(`Page ${i}`, filler + TAGS), `p${i}.html`);
  assert.equal(gh.commits.get(gh.head()).parents.length, 1, 'and it is still one commit');
});

test('prepare: on a database the migration has not reached, Kiln is still added and the dashboard still loads', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world({ 'index.html': page('Home') }, { env: { d1: { upTo: 2 } } });
  await withFetch(handler, async () => {
    assert.equal((await press(env)).status, 200);
    const me = await ask(env, 'GET', '/cloud/me');
    assert.equal(me.status, 200);
    assert.equal((await me.json()).sites[0].prepared_at, null);
    assert.equal((await (await look(env)).json()).state, 'prepared');
  });
  assert.equal(gh.read('index.html'), page('Home', TAGS));
});

test('prepare: the service adds what the setup tool adds (the same two lines, the same sign-in page, the same folders left alone)', () => {
  const cli = readFileSync(path.join(ROOT, 'cli', 'index.mjs'), 'utf8');
  const tags = cli.match(/const KILN_TAGS = \[(.+?)\];/)[1];
  assert.deepEqual(Function(`return [${tags}]`)(), KILN_TAGS);
  const signIn = cli.match(/writeFileSync\(at\('kiln\.html'\), `([\s\S]+?)`\);/)[1];
  assert.equal(signIn, KILN_PAGE);
  const list = (name) => Function(`return ${cli.match(new RegExp(`const ${name} = (\\[[^\\]]+\\]);`))[1]}`)();
  const never = list('NEVER').filter(d => d !== '.git'), notAtTop = list('NOT_AT_TOP');
  assert.ok(never.includes('node_modules') && notAtTop.includes('public'));
  for (const dir of [...never, ...notAtTop]) assert.equal(isSitePage(`${dir}/index.html`), false, dir);
  for (const dir of never) assert.equal(isSitePage(`blog/${dir}/index.html`), false, `blog/${dir}`);
  // names that are also ordinary words in a site's addresses are folders of pages below the top
  for (const dir of notAtTop) assert.equal(isSitePage(`lists/${dir}/index.html`), true, `lists/${dir}`);
  const config = cli.match(/writeFileSync\(cfgFile, `([\s\S]+?)`\);/)[1];
  const fromCli = config.replace("'${repo}'", "'ada/club'").replace("'${workerUrl}'", "'https://auth.kilncms.com'").replace(/\$\{isSource[\s\S]+?: ''\}/, '');
  assert.equal(kilnConfigFile({ repo: 'ada/club', branch: 'main', worker: 'https://auth.kilncms.com' }), fromCli);

  assert.equal(isSitePage('index.html'), true);
  assert.equal(isSitePage('blog/2026/post.html'), true);
  for (const p of ['kiln.html', 'members-login.html', 'a/kiln.html', '.hidden.html', '.well-known/x.html', 'README.md', 'index.htm', 'INDEX.HTML']) assert.equal(isSitePage(p), false, p);
  // The settings file cannot be broken out of by a branch's name.
  assert.match(kilnConfigFile({ repo: 'a/b', branch: "it's", worker: 'https://w.example' }), /branch: 'it\\'s',/);
  assert.equal(withKilnTags(page('x', TAGS)).state, 'already');
  assert.equal(withKilnTags('<p>no body</p>').state, 'no-body');
  const half = withKilnTags(`<body>\n${KILN_TAGS[0]}\n</body>`);
  assert.equal(half.html, `<body>\n${KILN_TAGS[0]}\n${KILN_TAGS[1]}\n</body>`, 'the settings line is not repeated');
});

test('prepare: one address cannot ask the dashboard\'s repository routes over and over', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world({ 'index.html': page('Home') });
  let left = 2;
  env.RL = { limit: async ({ key }) => { assert.equal(key, '203.0.113.9'); return { success: left-- > 0 }; } };
  const from = (pathname, method = 'GET', body) => worker.fetch(new Request(`https://worker.example${pathname}`, {
    method, headers: { Authorization: 'Bearer tok', 'CF-Connecting-IP': '203.0.113.9', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }), env);
  const before = gh.head();
  await withFetch(handler, async (calls) => {
    assert.equal((await from('/cloud/sites/prepare?site=site-1')).status, 200);
    assert.equal((await from('/cloud/sites/firstpass?site=site-1')).status, 200);
    for (const [pathname, method, body] of [['/cloud/sites/prepare', 'POST', { id: 'site-1' }], ['/cloud/sites/check?site=site-1', 'GET'], ['/cloud/sites/update?site=site-1', 'GET']]) {
      const n = calls.length;
      const res = await from(pathname, method, body);
      assert.equal(res.status, 429, pathname);
      assert.equal(calls.length, n, `${pathname}: nothing is read once the limit is reached`);
    }
    left = 5;
    assert.equal((await from('/cloud/me')).status, 200, 'the account page itself is not held back');
  });
  assert.equal(gh.head(), before);
});

