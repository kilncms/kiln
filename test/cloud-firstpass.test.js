/**
 * A first pass at what can be edited, from the dashboard (worker/firstpass.js,
 * GET and POST /cloud/sites/firstpass): the setup tool's cautious pass
 * (src/autotag.js), run by the service with one press. The real handlers run
 * over the SQLite-backed D1 stand-in and an in-memory GitHub with a real git
 * object model, so each test can look at what the repository holds afterwards.
 * Nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, githubWrites } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { autotag } from '../src/autotag.js';
import { onlyAddsMarks } from '../worker/firstpass.js';

const home = `<!doctype html>
<html>
<head><title>The Club</title></head>
<body>
  <nav class="top"><a href="/">Home</a><a href="/about.html">About</a><a href="/join.html">Join</a></nav>
  <h1 class="hero">Welcome to the club</h1>
  <p>We meet on Tuesdays.</p>
  <img src="/img/hall.jpg" alt="The hall">
  <div class="cards">
    <div class="card"><h3>Chess</h3><p>Every week.</p></div>
    <div class="card"><h3>Darts</h3><p>Every month.</p></div>
    <div class="card"><h3>Quiz</h3><p>Now and then.</p></div>
  </div>
  <table><tr><td>Mon</td><td>Closed</td></tr></table>
  <script>var x = "<p>not a paragraph</p>";</script>
</body>
</html>
`;
const about = '<html><body>\n<h2>About us</h2>\n<p>Since 1950.</p>\n</body></html>\n';
const stripMarks = (html) => html.replace(/ data-cms(?:-[a-z]+)*(?:="[^"]*")?/g, '');

function world(files, { site = {}, env: extra = {}, kv: seed = {} } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files });
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token', ...seed }), extra);
  addSite(env, site);
  return { gh, env, handler: (url, init) => gh.handler(url, init) };
}
const ask = (env, method, pathname, body, token = 'tok') => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const look = (env, id = 'site-1') => ask(env, 'GET', `/cloud/sites/firstpass?site=${id}`);
const press = (env, id = 'site-1') => ask(env, 'POST', '/cloud/sites/firstpass', { id });
const recorded = (env) => env.kiln_cloud.row('SELECT firstpass_at, firstpass_commit FROM sites WHERE id = ?', 'site-1');

test('first pass: looking says how much it would mark, of what kind and on which pages, and writes nothing', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world({ 'index.html': home, 'about.html': about, 'style.css': 'p{}', 'dist/index.html': home });
  const before = gh.head();
  await withFetch(handler, async (calls) => {
    const res = await look(env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.state, 'ready');
    assert.equal(body.repo, 'ada/club');
    assert.deepEqual(body.pages, { total: 2, change: 2, change_names: ['about.html', 'index.html'], untouched: 0, skipped: [], skipped_count: 0 });
    const expected = [home, about].map(h => autotag(h).counts).reduce((a, c) => ({ text: a.text + c.fields, pictures: a.pictures + c.images, lists: a.lists + c.repeats, menus: a.menus + c.menu }), { text: 0, pictures: 0, lists: 0, menus: 0 });
    assert.deepEqual(body.marks, expected);
    assert.ok(body.marks.text >= 4 && body.marks.pictures === 1 && body.marks.lists === 1 && body.marks.menus === 1, JSON.stringify(body.marks));
    assert.equal(JSON.stringify(body).includes('Tuesdays'), false, 'no page text leaves the service');
    assert.deepEqual(githubWrites(calls), []);
  });
  assert.equal(gh.head(), before);
  assert.equal(recorded(env).firstpass_at, null);
});

test('first pass: pressing the button makes one commit in the owner\'s name that only adds marks, exactly as the setup tool would', { skip: d1Skip }, async () => {
  const files = { 'index.html': home, 'about.html': about, 'style.css': 'p{}', 'notes.txt': 'keep' };
  const { gh, env, handler } = world(files);
  env.KILN.map.set('csess:tok', JSON.stringify({ account_id: 'acct-1', login: 'ada', uid: 42, gh: 'gho_x' }));
  const before = gh.head();
  await withFetch(handler, async () => {
    const res = await press(env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'done');
    assert.equal(body.commit.sha, gh.head());
    assert.equal(body.commit.url, `https://github.com/ada/club/commit/${gh.head()}`);
  });
  const made = gh.commits.get(gh.head());
  assert.deepEqual(made.parents, [before], 'exactly one commit');
  assert.equal(made.author.email, '42+ada@users.noreply.github.com');
  assert.match(made.message, /^Mark a first pass of what can be edited\n\n.+ on 2 pages\. Made from the Kiln dashboard by ada\./);

  for (const [p, original] of [['index.html', home], ['about.html', about]]) {
    const now = gh.read(p);
    assert.equal(now, autotag(original).html, `${p}: what the setup tool's own pass writes`);
    assert.equal(stripMarks(now), original, `${p}: with the marks taken off again it is the page as it was`);
  }
  const index = gh.read('index.html');
  assert.match(index, /<h1 class="hero" data-cms="|<h1 data-cms="[a-z0-9_]+" class="hero"/, 'the heading is marked');
  assert.match(index, /data-cms-menu="main"/);
  assert.match(index, /data-cms-repeat="/);
  assert.match(index, /<table><tr><td>Mon<\/td><td>Closed<\/td><\/tr><\/table>/, 'a table is left as it is');
  assert.match(index, /<script>var x = "<p>not a paragraph<\/p>";<\/script>/, 'nothing inside a script is marked');
  assert.equal(gh.read('style.css'), 'p{}');
  assert.equal(gh.read('notes.txt'), 'keep');
  assert.deepEqual(gh.paths(), Object.keys(files).sort(), 'no file is added or removed');

  // The dashboard is told, and pressing again finds nothing left to mark.
  assert.equal(recorded(env).firstpass_commit, gh.head());
  const me = await (await ask(env, 'GET', '/cloud/me')).json();
  assert.equal(me.firstpass, true);
  assert.ok(me.sites[0].firstpass_at > 0);
  const after = gh.head();
  await withFetch(handler, async (calls) => {
    assert.equal((await (await look(env)).json()).state, 'nothing');
    const again = await press(env);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).state, 'nothing');
    assert.deepEqual(githubWrites(calls), []);
  });
  assert.equal(gh.head(), after);
});

test('first pass: what the owner already marked stays as it is, and a site with nothing left to mark is told so and not written to', { skip: d1Skip }, async () => {
  const mine = '<html><body>\n<h1 data-cms="my_title" data-cms-plain>Mine</h1>\n<p>New words.</p>\n</body></html>\n';
  const { gh, env, handler } = world({ 'index.html': mine });
  await withFetch(handler, async () => assert.equal((await press(env)).status, 200));
  const now = gh.read('index.html');
  assert.match(now, /<h1 data-cms="my_title" data-cms-plain>Mine<\/h1>/, 'the owner\'s own mark is untouched');
  assert.match(now, /<p data-cms="[a-z0-9_]+">New words\.<\/p>/);

  const done = world({ 'index.html': '<html><body><div>No headings or paragraphs here</div></body></html>' });
  const before = done.gh.head();
  await withFetch(done.handler, async (calls) => {
    const body = await (await look(done.env)).json();
    assert.equal(body.state, 'nothing');
    assert.equal(body.pages.untouched, 1);
    assert.deepEqual(githubWrites(calls), []);
  });
  assert.equal(done.gh.head(), before);
  assert.ok(recorded(done.env).firstpass_at > 0, 'and the dashboard stops offering the button');
});

test('first pass: a page keeps its line endings and its byte-order mark, and a page that is not UTF-8 text is left alone and named', { skip: d1Skip }, async () => {
  const crlf = '﻿<html>\r\n<body>\r\n<h1>Café</h1>\r\n</body>\r\n</html>\r\n';
  const latin1 = Buffer.from('<html><body><h1>caf\xe9</h1></body></html>', 'latin1');
  const { gh, env, handler } = world({ 'index.html': crlf, 'old.html': latin1 });
  await withFetch(handler, async () => {
    assert.deepEqual((await (await look(env)).json()).pages.skipped, [{ path: 'old.html', why: 'not_text' }]);
    assert.equal((await press(env)).status, 200);
  });
  const tree = gh.trees.get(gh.commits.get(gh.head()).tree);
  assert.equal(stripMarks(gh.read('index.html')), crlf);
  assert.deepEqual(gh.blobs.get(tree.get('index.html').sha).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.deepEqual(gh.blobs.get(tree.get('old.html').sha), latin1, 'not one byte of it changed');
});

test('first pass: a page is written only when the pass did nothing but add marks', () => {
  const before = '<body>\n  <h1 class="hero">Hi</h1>\n  <p>Words</p>\n</body>';
  assert.equal(onlyAddsMarks(before, autotag(before).html), true);
  assert.equal(onlyAddsMarks(home, autotag(home).html), true);
  assert.equal(onlyAddsMarks(before, before), true);
  assert.equal(onlyAddsMarks(before, before.replace('<h1', '<h1 data-cms="title" data-cms-plain')), true);
  assert.equal(onlyAddsMarks(before, before.replace('<h1', '<h1 data-cms="pic" data-cms-attr="src"')), true);
  const not = {
    'a word changed': before.replace('Words', 'Other'),
    'a character dropped': before.replace('Hi', 'H'),
    'another attribute added': before.replace('<h1', '<h1 onclick="steal()"'),
    'a mark with script in its value': before.replace('<h1', '<h1 data-cms="x&quot; onmouseover=&quot;y"'),
    'an element added': before.replace('</body>', '<script src="//evil.example/x.js"></script></body>'),
    'text added after the end': `${before}<p>more</p>`,
    'an attribute that only starts like a mark': before.replace('<h1', '<h1 data-cmsx="1"'),
  };
  for (const [what, after] of Object.entries(not)) assert.equal(onlyAddsMarks(before, after), false, what);
});

test('first pass: a site that a generator builds, or that has no pages, is refused with the reason, and nothing is written', { skip: d1Skip }, async () => {
  const cases = {
    built: [{ 'astro.config.mjs': 'export default {}', 'src/pages/index.astro': '---\n---\n<h1>Hi</h1>' }, /built by Astro.+set in the files it is built from/],
    no_pages: [{ 'README.md': '# club' }, /found no web pages/],
  };
  for (const [state, [files, sentence]] of Object.entries(cases)) {
    const { gh, env, handler } = world(files);
    const before = gh.head();
    await withFetch(handler, async (calls) => {
      const body = await (await look(env)).json();
      assert.equal(body.ok, false, state);
      assert.equal(body.state, state);
      assert.match(body.error, sentence);
      const pressed = await press(env);
      assert.equal(pressed.status, 409, state);
      assert.equal((await pressed.json()).code, state);
      assert.deepEqual(githubWrites(calls), [], state);
    });
    assert.equal(gh.head(), before, state);
    assert.equal(recorded(env).firstpass_at, null, state);
  }
});

test('first pass: only the signed-in owner of a site that may be edited can ask', { skip: d1Skip }, async () => {
  let w = world({ 'index.html': home });
  await withFetch(w.handler, async (calls) => {
    assert.equal((await ask(w.env, 'GET', '/cloud/sites/firstpass?site=site-1', null, 'nobody')).status, 401);
    assert.equal((await ask(w.env, 'POST', '/cloud/sites/firstpass', { id: 'site-1' }, 'nobody')).status, 401);
    assert.equal((await press(w.env, 'nope')).status, 404);
    assert.deepEqual(calls, []);
  });
  w = world({ 'index.html': home }, { site: { status: 'canceled' } });
  await withFetch(w.handler, async (calls) => {
    const res = await press(w.env);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'plan_ended');
    assert.deepEqual(calls, []);
  });
  w = world({ 'index.html': home });
  w.env.KILN.map.delete('itok:ada/club');
  await withFetch(w.handler, async () => {
    const res = await press(w.env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'no_access');
    assert.match(body.install_url, /^https:\/\/github\.com\/apps\//);
  });
});

test('first pass: when the repository changes meanwhile, the branch is protected, or GitHub fails, nothing is changed and the answer says so', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world({ 'index.html': home });
  let theirs = null;
  gh.onWrite((api) => { if (!theirs) theirs = api.commit({ 'index.html': home.replace('Tuesdays', 'Fridays') }); });
  await withFetch(handler, async () => {
    const res = await press(env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'moved');
    assert.match(body.error, /Nothing was changed\. Please press the button again\./);
  });
  assert.equal(gh.head(), theirs);
  assert.equal(recorded(env).firstpass_at, null);
  assert.equal(await env.KILN.get('fplock:site-1'), null, 'and the button works again at once');

  const p = world({ 'index.html': home });
  const before = p.gh.head();
  await withFetch(async (url, init) => (init.method === 'PATCH' && /\/git\/refs\/heads\/main$/.test(url)
    ? new Response(JSON.stringify({ message: 'Repository rule violations found' }), { status: 422 })
    : p.handler(url, init)), async () => {
    const res = await press(p.env);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'protected');
  });
  assert.equal(p.gh.head(), before);

  for (const failing of ['/git/trees', '/git/commits']) {
    const g = world({ 'index.html': home });
    const was = g.gh.head();
    g.gh.failOn((method, pth) => method === 'POST' && pth === failing);
    await withFetch(g.handler, async () => {
      const res = await press(g.env);
      assert.equal(res.status, 502, failing);
      assert.equal((await res.json()).code, 'github', failing);
    });
    assert.equal(g.gh.head(), was, failing);
    assert.equal(g.gh.read('index.html'), home, failing);
  }
});

test('first pass: two presses at once make one commit', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world({ 'index.html': home }, { kv: { 'fplock:site-1': '1' } });
  const before = gh.head();
  await withFetch(handler, async (calls) => {
    const res = await press(env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'busy');
    assert.match(body.error, /already marking this site/);
    assert.deepEqual(githubWrites(calls), []);
  });
  assert.equal(gh.head(), before);
});

test('first pass: on a database a migration has not reached, the pages are still marked and the dashboard still loads', { skip: d1Skip }, async () => {
  for (const upTo of [2, 3]) {
    const { gh, env, handler } = world({ 'index.html': home }, { env: { d1: { upTo } } });
    await withFetch(handler, async () => {
      assert.equal((await press(env)).status, 200, `migrations up to ${upTo}`);
      const me = await ask(env, 'GET', '/cloud/me');
      assert.equal(me.status, 200);
      assert.equal((await me.json()).sites[0].firstpass_at, null);
    });
    assert.equal(gh.read('index.html'), autotag(home).html);
  }
});
