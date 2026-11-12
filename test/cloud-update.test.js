/**
 * Updating the Kiln editor in a site's repository from the dashboard
 * (worker/update.js, GET and POST /cloud/sites/update): what `kiln update`
 * does in a terminal, done by the service. The real handlers run over the
 * SQLite-backed D1 stand-in and an in-memory GitHub with a real git object
 * model, so each test can look at what the repository holds afterwards.
 * Kiln's own files come from a stand-in for the release branch. Nothing here
 * touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { fakeKV, withFetch, githubWrites } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { editorFolder, GATE_FILES, ROUTES_WANTED, UPDATE_COMMAND } from '../worker/update.js';
import { EDITOR_FILES } from '../worker/prepare.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASE = 'https://raw.githubusercontent.com/kilncms/kiln/release';
/** kiln.js as a build writes it: the stamp is at the top. */
const editor = (stamp) => `(function(){"use strict";var t=window.KILN||{};window.KILN_VERSION="${stamp}";/* the rest of kiln.js */})();\n`;
// The release branch, at editor r2. The editor bundle holds bytes that are not
// text at all: what lands in the repository must be these bytes.
const released = {
  'dist/VERSION': Buffer.from('r2\n'),
  'dist/kiln.js': Buffer.from(editor('r2')),
  'dist/kiln-editor.js': Buffer.concat([Buffer.from('/* editor r2: é */ '), Buffer.from([0xff, 0x00, 0x80, 0x0a])]),
  'dist/kiln-features.js': Buffer.from('/* features r2 */\n'),
  'templates/functions/_kiln.js': Buffer.from('// gate helper r2\n'),
  'templates/functions/_middleware.js': Buffer.from('// encoded addresses r2\n'),
  'templates/functions/api/member-redeem-google.js': Buffer.from('// redeem r2\n'),
  'templates/functions/members/_middleware.js': Buffer.from('// gate r2\n'),
  'templates/_routes.json': Buffer.from('{\n  "version": 1,\n  "include": ["/members/*", "/api/member-redeem-google", "/*%*"],\n  "exclude": []\n}\n'),
};
const CONFIG = "window.KILN = {\n  repo:   'ada/club',\n  branch: 'main',\n  worker: 'https://worker.example',\n  styles: [],\n};\n";
/** A site of plain files with the editor at `stamp` in `dir`. */
const site = (stamp = 'r1', dir = 'assets') => ({
  'index.html': '<!doctype html><body><h1>Club</h1><script src="/assets/kiln-config.js"></script><script src="/assets/kiln.js" defer></script></body>\n',
  'style.css': 'body{}',
  'img/logo.svg': '<svg/>',
  [`${dir}/kiln.js`]: editor(stamp),
  [`${dir}/kiln-editor.js`]: `/* editor ${stamp} */`,
  [`${dir}/kiln-features.js`]: `/* features ${stamp} */`,
  [`${dir}/kiln-config.js`]: CONFIG,
});
const THREE = ['assets/kiln.js', 'assets/kiln-editor.js', 'assets/kiln-features.js'];

/** One account (ada) with one site (ada/club), its repository, and the release branch. */
function world(files, { site: over = {}, env: extra = {}, branch = 'main', kv: seed = {}, release = released } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files, defaultBranch: branch });
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token', ...seed }), extra);
  addSite(env, over);
  const handler = async (url, init) => {
    if (url.startsWith(`${RELEASE}/`)) { const f = release[url.slice(RELEASE.length + 1)]; return f ? new Response(f) : undefined; }
    return gh.handler(url, init);
  };
  return { gh, env, handler };
}
const ask = (env, method, pathname, body, token = 'tok') => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const look = (env, id = 'site-1') => ask(env, 'GET', `/cloud/sites/update?site=${id}`);
const press = (env, id = 'site-1') => ask(env, 'POST', '/cloud/sites/update', { id });
const me = async (env) => (await ask(env, 'GET', '/cloud/me')).json();
const fromRelease = (calls) => calls.filter(c => c.url.startsWith(RELEASE)).map(c => c.url.slice(RELEASE.length + 1));

test('update: looking says which editor the site has, which one is released and what would be replaced, and writes nothing', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world(site());
  const before = gh.head();
  await withFetch(handler, async (calls) => {
    const res = await look(env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true, state: 'behind', repo: 'ada/club', branch: 'main', folder: 'assets', installed: 'r1', latest: 'r2',
      files: { replace: THREE, add: [] },
    });
    assert.deepEqual(githubWrites(calls), [], 'looking writes nothing to GitHub');
    assert.deepEqual(fromRelease(calls), ['dist/VERSION'], 'and fetches nothing it will not use');
  });
  assert.equal(gh.head(), before);

  // An editor from before the stamp is behind, and a file of Kiln's that is missing is added.
  const files = site();
  files['assets/kiln.js'] = '/* an editor from before it carried a stamp */';
  delete files['assets/kiln-features.js'];
  const old = world(files);
  await withFetch(old.handler, async () => {
    const body = await (await look(old.env)).json();
    assert.equal(body.state, 'behind');
    assert.equal(body.installed, null);
    assert.deepEqual(body.files, { replace: ['assets/kiln.js', 'assets/kiln-editor.js'], add: ['assets/kiln-features.js'] });
    assert.equal((await press(old.env)).status, 200);
  });
  assert.equal(old.gh.read('assets/kiln-features.js'), '/* features r2 */\n');
  assert.match(old.gh.commits.get(old.gh.head()).message, /are now version r2\. Updated from the Kiln dashboard by ada\.$/);
});

test('update: pressing the button makes one commit in the owner\'s name that replaces Kiln\'s files with the released bytes, and nothing else changes', { skip: d1Skip }, async () => {
  const files = site();
  const { gh, env, handler } = world(files, { branch: 'trunk' });
  env.KILN.map.set('csess:tok', JSON.stringify({ account_id: 'acct-1', login: 'ada', uid: 42, gh: 'gho_x' }));   // a session that knows GitHub's number for ada
  const before = gh.head('trunk');
  await withFetch(handler, async (calls) => {
    const res = await press(env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'done');
    assert.equal(body.installed, 'r1');
    assert.equal(body.latest, 'r2');
    assert.equal(body.commit.sha, gh.head('trunk'));
    assert.equal(body.commit.url, `https://github.com/ada/club/commit/${gh.head('trunk')}`);
    assert.deepEqual(fromRelease(calls).sort(), ['dist/VERSION', 'dist/kiln-editor.js', 'dist/kiln-features.js', 'dist/kiln.js'], 'no members gate here, so its files are not fetched');
  });
  const made = gh.commits.get(gh.head('trunk'));
  assert.deepEqual(made.parents, [before], 'exactly one commit, on top of what was there');
  assert.equal(made.author.name, 'ada');
  assert.equal(made.author.email, '42+ada@users.noreply.github.com');
  assert.equal(made.message, 'Update the Kiln editor\n\nThe editor\'s files are now version r2 (they were version r1). Updated from the Kiln dashboard by ada.');

  // Kiln's own files are the released bytes.
  const blob = (p) => gh.blobs.get(gh.trees.get(made.tree).get(p).sha);
  assert.deepEqual(blob('assets/kiln.js'), released['dist/kiln.js']);
  assert.deepEqual(blob('assets/kiln-editor.js'), released['dist/kiln-editor.js'], 'byte for byte, even where the bytes are not text');
  assert.deepEqual(blob('assets/kiln-features.js'), released['dist/kiln-features.js']);

  // Everything else is as it was: no file added (no security headers file either), none removed, the settings untouched.
  assert.deepEqual(gh.paths('trunk'), Object.keys(files).sort());
  for (const p of ['index.html', 'style.css', 'img/logo.svg', 'assets/kiln-config.js']) assert.equal(gh.read(p, 'trunk'), files[p], p);

  // Asking again changes nothing.
  const after = gh.head('trunk');
  await withFetch(handler, async (calls) => {
    const seen = await (await look(env)).json();
    assert.deepEqual(seen, { ok: true, state: 'current', repo: 'ada/club', branch: 'trunk', folder: 'assets', installed: 'r2', latest: 'r2' });
    const again = await press(env);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).state, 'current');
    assert.deepEqual(githubWrites(calls), []);
    assert.deepEqual([...new Set(fromRelease(calls))], ['dist/VERSION']);
  });
  assert.equal(gh.head('trunk'), after);
  assert.equal(await env.KILN.get('updlock:site-1'), null);
});

test('update: on a site a generator builds, the editor is replaced in its public folder, and a copy in a build folder is left alone', { skip: d1Skip }, async () => {
  const files = {
    'astro.config.mjs': 'export default {}',
    'src/pages/index.astro': '---\n---\n<h1>Hi</h1>',
    'public/kiln.html': '<!doctype html><script src="/assets/kiln-config.js"></script><script src="/assets/kiln.js" defer></script>',
    'public/assets/kiln.js': editor('r1'),
    'public/assets/kiln-editor.js': '/* editor r1 */',
    'public/assets/kiln-features.js': '/* features r1 */',
    'public/assets/kiln-config.js': CONFIG,
    'dist/assets/kiln.js': editor('r0'),                    // what a build left behind
    'dist/assets/kiln-editor.js': '/* editor r0 */',
    'dist/assets/kiln-config.js': CONFIG,
  };
  const { gh, env, handler } = world(files);
  await withFetch(handler, async () => {
    const seen = await (await look(env)).json();
    assert.equal(seen.folder, 'public/assets');
    assert.equal(seen.installed, 'r1');
    assert.deepEqual(seen.files, { replace: ['public/assets/kiln.js', 'public/assets/kiln-editor.js', 'public/assets/kiln-features.js'], add: [] });
    assert.equal((await press(env)).status, 200);
  });
  assert.equal(gh.read('public/assets/kiln.js'), editor('r2'));
  assert.equal(gh.read('public/assets/kiln-features.js'), '/* features r2 */\n');
  assert.equal(gh.read('dist/assets/kiln.js'), editor('r0'));
  assert.equal(gh.read('public/assets/kiln-config.js'), CONFIG);
  assert.deepEqual(gh.paths(), Object.keys(files).sort(), 'nothing is added at the top of the repository');
});

test('update: a site with a members area gets the current gate too, its own routing file is left alone, and a gate that answers to another service is not touched', { skip: d1Skip }, async () => {
  const gated = { ...site(), 'members/index.html': '<h1>Members</h1>', 'functions/members/_middleware.js': '// gate r1', 'functions/_kiln.js': '// gate helper r1' };
  const GATE = ['functions/_kiln.js', 'functions/_middleware.js', 'functions/api/member-redeem-google.js', 'functions/members/_middleware.js'];

  // The settings name this service: the gate's files and the routing file come along, in the same commit.
  const a = world(gated);
  const before = a.gh.head();
  await withFetch(a.handler, async () => {
    const seen = await (await look(a.env)).json();
    assert.equal(seen.members_gate, 'refresh');
    assert.deepEqual(seen.files, { replace: [...THREE, 'functions/_kiln.js', 'functions/members/_middleware.js'], add: ['functions/_middleware.js', 'functions/api/member-redeem-google.js', '_routes.json'] });
    assert.equal(seen.routes_missing, undefined);
    assert.equal((await press(a.env)).status, 200);
  });
  const made = a.gh.commits.get(a.gh.head());
  assert.deepEqual(made.parents, [before]);
  assert.match(made.message, /The files that guard the members area are the current ones too\. Updated from the Kiln dashboard by ada\.$/);
  const blob = (p) => a.gh.blobs.get(a.gh.trees.get(made.tree).get(p).sha);
  for (const p of GATE) assert.deepEqual(blob(p), released[`templates/${p}`], p);
  assert.deepEqual(blob('_routes.json'), released['templates/_routes.json']);
  assert.equal(a.gh.read('members/index.html'), '<h1>Members</h1>');
  assert.deepEqual(a.gh.paths(), [...new Set([...Object.keys(gated), ...GATE, '_routes.json'])].sort());

  // A routing file that is already there is the owner's: left as it is, and the rules it lacks are named.
  const mine = '{"version":1,"include":["/members/*"],"exclude":[]}';
  const b = world({ ...gated, '_routes.json': mine });
  await withFetch(b.handler, async (calls) => {
    const seen = await (await look(b.env)).json();
    assert.deepEqual(seen.routes_missing, ['/api/member-redeem-google', '/*%*']);
    assert.equal(seen.files.add.includes('_routes.json'), false);
    assert.equal(seen.files.replace.includes('_routes.json'), false);
    assert.equal((await press(b.env)).status, 200);
    assert.equal(fromRelease(calls).includes('templates/_routes.json'), false);
  });
  assert.equal(b.gh.read('_routes.json'), mine);
  assert.equal(b.gh.read('functions/members/_middleware.js'), '// gate r2\n');

  // Settings that name another sign-in service: the editor is updated, the gate is left alone, and the answer says so.
  const c = world({ ...gated, 'assets/kiln-config.js': CONFIG.replace('https://worker.example', 'https://my-own.example.workers.dev') });
  await withFetch(c.handler, async (calls) => {
    const seen = await (await look(c.env)).json();
    assert.equal(seen.members_gate, 'left');
    assert.equal(seen.other_worker, 'https://my-own.example.workers.dev');
    assert.deepEqual(seen.files, { replace: THREE, add: [] });
    assert.equal((await press(c.env)).status, 200);
    assert.equal(fromRelease(calls).some(f => f.startsWith('templates/')), false);
    assert.equal(calls.some(c2 => c2.url.includes('my-own.example')), false, 'the other service is not called');
  });
  assert.equal(c.gh.read('assets/kiln.js'), editor('r2'));
  assert.equal(c.gh.read('functions/members/_middleware.js'), '// gate r1');
  assert.equal(c.gh.read('functions/_kiln.js'), '// gate helper r1');
  assert.equal(c.gh.paths().includes('_routes.json'), false);
});

test('update: only the signed-in owner of a site that may be edited can ask, and each refusal says why', { skip: d1Skip }, async () => {
  // Not signed in; a site of another account; a site that does not exist.
  let w = world(site());
  w.env.kiln_cloud.exec("INSERT INTO accounts (id, github_login, created_at) VALUES ('acct-2', 'bob', 1)");
  addSite(w.env, { id: 'site-2', account_id: 'acct-2', repo: 'bob/shop', origin: 'https://shop.example' });
  await withFetch(w.handler, async (calls) => {
    assert.equal((await ask(w.env, 'GET', '/cloud/sites/update?site=site-1', null, 'nobody')).status, 401);
    assert.equal((await ask(w.env, 'POST', '/cloud/sites/update', { id: 'site-1' }, 'nobody')).status, 401);
    for (const id of ['site-2', 'nope', '']) {
      const res = await press(w.env, id);
      assert.equal(res.status, 404, id);
      assert.equal((await res.json()).code, 'no_such_site');
    }
    assert.deepEqual(calls, [], 'neither GitHub nor the release is even asked');
  });

  // A free trial that ran out: editing is off, and so is this.
  w = world(site(), { site: { status: 'canceled' } });
  await withFetch(w.handler, async (calls) => {
    const res = await press(w.env);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'plan_ended');
    assert.match(body.error, /Subscribe/);
    assert.deepEqual(calls, []);
  });

  // The Kiln app is not on the repository: say so, with where to install it.
  w = world(site());
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
  w = world(site());
  await withFetch(async () => undefined, async () => {
    const body = await (await press(w.env)).json();
    assert.equal(body.code, 'no_access');
    assert.match(body.error, /not installed on that repository yet, or it was removed/);
  });

  // A repository of an organisation the signed-in person may not change.
  const org = fakeGitHub({ repo: 'acme/site', files: site() });
  const env = cloudEnv(fakeKV({ 'itok:acme/site': 'inst-token' }));
  addSite(env, { repo: 'acme/site' });
  await withFetch(async (url) => (url === 'https://api.github.com/repos/acme/site' ? new Response(JSON.stringify({ permissions: { push: false, admin: false } }), { status: 200 }) : org.handler(url)), async (calls) => {
    const res = await press(env);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'not_yours');
    assert.deepEqual(githubWrites(calls), []);
  });
  assert.equal(org.read('assets/kiln.js'), editor('r1'));
});

test('update: a repository that Kiln is not in is told to add Kiln first, and when GitHub does not answer nothing is changed', { skip: d1Skip }, async () => {
  // No editor at all, and an editor with no settings file beside it (not a site's own copy).
  for (const files of [{ 'index.html': '<h1>Club</h1>', 'assets/site.js': '' }, { 'index.html': '<h1>Club</h1>', 'vendor/kiln.js': editor('r1') }]) {
    const { gh, env, handler } = world(files);
    const before = gh.head();
    await withFetch(handler, async (calls) => {
      const seen = await look(env);
      assert.equal(seen.status, 200);
      const body = await seen.json();
      assert.equal(body.ok, false);
      assert.equal(body.state, 'absent');
      assert.equal(body.error, 'Kiln\'s editor is not in ada/club yet, so there is nothing to update. Add Kiln to this site first, then come back.');
      const pressed = await press(env);
      assert.equal(pressed.status, 409);
      assert.equal((await pressed.json()).code, 'absent');
      assert.deepEqual(githubWrites(calls), []);
      assert.deepEqual(fromRelease(calls), [], 'the release is not asked about a site with no editor');
    });
    assert.equal(gh.head(), before);
  }

  // GitHub fails while the repository is being read.
  for (const failing of [/^$/, /^\/git\/trees\//, /^\/git\/blobs\//]) {
    const g = world(site());
    const before = g.gh.head();
    g.gh.failOn((method, p) => method === 'GET' && failing.test(p));
    await withFetch(g.handler, async (calls) => {
      for (const res of [await look(g.env), await press(g.env)]) {
        assert.equal(res.status, 502, String(failing));
        const body = await res.json();
        assert.equal(body.code, 'github', String(failing));
        assert.match(body.error, /GitHub did not answer just now\. Nothing was changed\./);
      }
      assert.deepEqual(githubWrites(calls), []);
    });
    assert.equal(g.gh.head(), before);
    assert.equal(await g.env.KILN.get('updlock:site-1'), null, 'and the button works again at once');
  }
});

test('update: when the repository changes while Kiln is working, or the branch takes no direct change, nothing is changed and the answer says so', { skip: d1Skip }, async () => {
  // Someone pushes between Kiln's reading and its writing.
  const { gh, env, handler } = world(site());
  let theirs = null;
  gh.onWrite((api) => { if (!theirs) theirs = api.commit({ 'index.html': '<h1>Changed by the owner</h1>' }); });
  await withFetch(handler, async () => {
    const res = await press(env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'moved');
    assert.match(body.error, /Nothing was changed\. Please press the button again\./);
  });
  assert.equal(gh.head(), theirs, 'the branch is where the owner left it');
  assert.equal(gh.read('assets/kiln.js'), editor('r1'));
  assert.equal(await env.KILN.get('updlock:site-1'), null, 'and the button works again at once');
  gh.onWrite(null);
  await withFetch(handler, async () => assert.equal((await press(env)).status, 200));
  assert.equal(gh.read('assets/kiln.js'), editor('r2'));
  assert.equal(gh.read('index.html'), '<h1>Changed by the owner</h1>', 'and the owner\'s change is kept');
  assert.deepEqual(gh.commits.get(gh.head()).parents, [theirs]);

  // A protected branch.
  const p = world(site());
  const before = p.gh.head();
  await withFetch(async (url, init) => (init.method === 'PATCH' && /\/git\/refs\/heads\/main$/.test(url)
    ? new Response(JSON.stringify({ message: 'Repository rule violations found\n\nChanges must be made through a pull request.' }), { status: 422 })
    : p.handler(url, init)), async () => {
    const res = await press(p.env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'protected');
    assert.match(body.error, /main branch of ada\/club does not take a direct change \(it is protected\), so Kiln could not update its editor there\. Nothing was changed\./);
    assert.equal(body.command, 'npx github:kilncms/kiln#release update');
  });
  assert.equal(p.gh.head(), before);
  assert.equal(p.gh.read('assets/kiln.js'), editor('r1'));
});

test('update: when Kiln\'s own files cannot be fetched, or GitHub fails part-way, the repository is left as it was', { skip: d1Skip }, async () => {
  const cases = {
    'the stamp is missing': { ...released, 'dist/VERSION': undefined },
    'the stamp is not a stamp': { ...released, 'dist/VERSION': Buffer.from('<html>Not the file you asked for</html>') },
    'one of the files is missing': { ...released, 'dist/kiln-editor.js': undefined },
    'one of the files is empty': { ...released, 'dist/kiln-features.js': Buffer.alloc(0) },
    'a release came out between the stamp and the files': { ...released, 'dist/kiln.js': Buffer.from(editor('r3')) },
  };
  for (const [name, release] of Object.entries(cases)) {
    const r = world(site(), { release });
    const before = r.gh.head();
    await withFetch(r.handler, async (calls) => {
      const res = await press(r.env);
      assert.equal(res.status, 502, name);
      const body = await res.json();
      assert.equal(body.code, 'release', name);
      assert.equal(body.error, 'Kiln could not fetch its own editor files just now. Nothing was changed. Please try again in a minute.', name);
      assert.deepEqual(githubWrites(calls), [], `${name}: nothing is written before every file is in hand`);
    });
    assert.equal(r.gh.head(), before, name);
    assert.equal(await r.env.KILN.get('updlock:site-1'), null, name);
  }
  // Without the stamp, looking cannot say where the site stands either.
  const v = world(site(), { release: cases['the stamp is missing'] });
  await withFetch(v.handler, async () => {
    const res = await look(v.env);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'release');
  });

  for (const failing of ['/git/blobs', '/git/trees', '/git/commits']) {
    const g = world(site());
    const was = g.gh.head();
    g.gh.failOn((method, p) => method === 'POST' && p === failing);
    await withFetch(g.handler, async () => {
      const res = await press(g.env);
      assert.equal(res.status, 502, failing);
      assert.equal((await res.json()).code, 'github', failing);
    });
    assert.equal(g.gh.head(), was, failing);
    assert.equal(g.gh.read('assets/kiln.js'), editor('r1'), failing);
    const told = await me(g.env);
    assert.equal(told.sites[0].editor_build, 'r1', `${failing}: the dashboard still offers the update`);
  }
});

test('update: two presses at once make one commit', { skip: d1Skip }, async () => {
  const { gh, env, handler } = world(site(), { kv: { 'updlock:site-1': '1' } });
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
  // The lock is this route's own: adding Kiln is not held up by it, nor the other way round.
  const other = world(site(), { kv: { 'preplock:site-1': '1' } });
  await withFetch(other.handler, async () => assert.equal((await press(other.env)).status, 200));
});

test('update: the dashboard hears of a new release within ten minutes, and the release is not read on every load', { skip: d1Skip }, async () => {
  const MIN = 60 * 1000;
  const kept = (stamp, minutesAgo) => ({ 'ebuild:ada/club': { build: 'r1', at: 5 }, elatest: { stamp, at: Date.now() - minutesAgo * MIN } });
  // r1 was read nine minutes ago and r2 has come out since: still r1, and the release is not asked.
  const soon = world(site(), { kv: kept('r1', 9) });
  await withFetch(soon.handler, async (calls) => {
    assert.equal((await me(soon.env)).editor_latest, 'r1');
    assert.equal((await me(soon.env)).editor_latest, 'r1');
    assert.deepEqual(fromRelease(calls), []);
  });
  // Read eleven minutes ago: the release is read again, once, and the dashboard says r2 and offers the update.
  const later = world(site(), { kv: kept('r1', 11) });
  await withFetch(later.handler, async (calls) => {
    const body = await me(later.env);
    assert.equal(body.editor_latest, 'r2');
    assert.equal(body.sites[0].editor_build, 'r1', 'the site is behind, so the button is offered');
    assert.equal((await me(later.env)).editor_latest, 'r2');
    assert.deepEqual(fromRelease(calls), ['dist/VERSION']);
    assert.ok(Date.now() - (await later.env.KILN.get('elatest', 'json')).at < MIN, 'what is kept says when it was read');
  });
  // What an older service kept for an hour is not believed past ten minutes either, and a value with no time on it is read again.
  for (const elatest of [{ stamp: 'r1', at: Date.now() - 59 * MIN }, { stamp: 'r1' }, { stamp: 'r1', at: 'yesterday' }]) {
    const old = world(site(), { kv: { 'ebuild:ada/club': { build: 'r1', at: 5 }, elatest } });
    await withFetch(old.handler, async (calls) => {
      assert.equal((await me(old.env)).editor_latest, 'r2', JSON.stringify(elatest));
      assert.deepEqual(fromRelease(calls), ['dist/VERSION']);
    });
  }
  // A release that could not be read is asked again after five minutes, not ten.
  for (const [minutesAgo, asked] of [[4, []], [6, ['dist/VERSION']]]) {
    const none = world(site(), { kv: kept(null, minutesAgo) });
    await withFetch(none.handler, async (calls) => {
      assert.equal((await me(none.env)).editor_latest, asked.length ? 'r2' : null);
      assert.deepEqual(fromRelease(calls), asked);
    });
  }
  // The day a hosted site waits is counted from the first sight of a release, which reading it more often does not move.
  const first = world(site(), { kv: { ...kept('r1', 11), 'eseen:r2': String(Date.now() - 5 * 3600 * 1000) } });
  await withFetch(first.handler, async () => {
    const seen = await first.env.KILN.get('eseen:r2');
    assert.equal((await me(first.env)).editor_latest, 'r2');
    assert.equal(await first.env.KILN.get('eseen:r2'), seen);
  });
});

test('update: the dashboard is told which editor each site has and which one is released, without a repository being read', { skip: d1Skip }, async () => {
  const { env, handler } = world(site(), { kv: { 'ebuild:ada/club': { build: 'r1', at: 5 } } });
  addSite(env, { id: 'site-2', repo: 'ada/shop', origin: 'https://shop.example' });
  const builds = (body) => Object.fromEntries(body.sites.map(s => [s.repo, s.editor_build]));
  await withFetch(handler, async (calls) => {
    const first = await me(env);
    assert.equal(first.editor_latest, 'r2');
    assert.deepEqual(builds(first), { 'ada/club': 'r1', 'ada/shop': null });
    assert.equal(calls.some(c => c.url.startsWith('https://api.github.com/')), false, 'no repository is read');
    // The released stamp is remembered for ten minutes, so opening the dashboard again does not read the release again.
    await me(env);
    assert.deepEqual(fromRelease(calls), ['dist/VERSION']);
    const ttl = env.KILN.expires.get('elatest') - Math.floor(Date.now() / 1000);
    assert.ok(ttl > 500 && ttl <= 600, `kept for about ten minutes (${ttl}s)`);
  });

  // After the update the site counts as up to date at once, even while its
  // editors still say they run the copy their browser has.
  await withFetch(handler, async () => {
    assert.equal((await press(env)).status, 200);
    assert.deepEqual(builds(await me(env)), { 'ada/club': 'r2', 'ada/shop': null });
    env.KILN.map.set('ebuild:ada/club', JSON.stringify({ build: 'r1', at: Date.now() + 60000 }));
    assert.equal(builds(await me(env))['ada/club'], 'r2');
  });

  // A site updated in a terminal: the dashboard still offers the button, and looking tells it the site is up to date.
  const t = world(site('r2'), { kv: { 'ebuild:ada/club': { build: 'r1', at: 5 } } });
  await withFetch(t.handler, async (calls) => {
    assert.equal(builds(await me(t.env))['ada/club'], 'r1');
    assert.equal((await (await look(t.env)).json()).state, 'current');
    assert.equal(builds(await me(t.env))['ada/club'], 'r2');
    assert.deepEqual(githubWrites(calls), []);
  });
  // …or its editors say so themselves, once they have opened a page.
  const s = world(site('r2'), { kv: { 'ebuild:ada/club': { build: 'r2', at: 9 }, 'erepo:ada/club': { build: 'r1', at: 5 } } });
  await withFetch(s.handler, async () => assert.equal(builds(await me(s.env))['ada/club'], 'r2'));

  // A release newer than what the service last put in the repository is offered again.
  const n = world(site('r2'), { kv: { 'ebuild:ada/club': { build: 'r1', at: 5 }, 'erepo:ada/club': { build: 'r2', at: 9 } }, release: { ...released, 'dist/VERSION': Buffer.from('r3\n') } });
  await withFetch(n.handler, async () => {
    const body = await me(n.env);
    assert.equal(body.editor_latest, 'r3');
    assert.equal(builds(body)['ada/club'], 'r2', 'the later of the two things known');
  });

  // With no site whose editor is known there is nothing to compare, and the release is not asked.
  const q = world(site());
  await withFetch(q.handler, async (calls) => {
    const body = await me(q.env);
    assert.equal(body.editor_latest, null);
    assert.equal(body.sites[0].editor_build, null);
    assert.deepEqual(calls, []);
  });
});

test('update: the dashboard still loads when the release or what the service remembers cannot be read', { skip: d1Skip }, async () => {
  const kv = { 'ebuild:ada/club': { build: 'r1', at: 5 } };
  const whole = (body) => { assert.equal(body.account.github_login, 'ada'); assert.equal(body.sites.length, 1); assert.equal(body.prepare, true); };

  // The release does not answer: no stamp, and it is not asked again for five minutes.
  const a = world(site(), { kv, release: {} });
  await withFetch(a.handler, async (calls) => {
    const res = await ask(a.env, 'GET', '/cloud/me');
    assert.equal(res.status, 200);
    const body = await res.json();
    whole(body);
    assert.equal(body.editor_latest, null);
    assert.equal(body.sites[0].editor_build, 'r1');
    assert.equal((await me(a.env)).editor_latest, null);
    assert.deepEqual(fromRelease(calls), ['dist/VERSION']);
    const ttl = a.env.KILN.expires.get('elatest') - Math.floor(Date.now() / 1000);
    assert.ok(ttl > 200 && ttl <= 300, `asked again in five minutes (${ttl}s)`);
  });

  // The network is down.
  const b = world(site(), { kv });
  await withFetch(async (url, init) => { if (url.startsWith(RELEASE)) throw new Error('network down'); return b.handler(url, init); }, async () => {
    const res = await ask(b.env, 'GET', '/cloud/me');
    assert.equal(res.status, 200);
    const body = await res.json();
    whole(body);
    assert.equal(body.editor_latest, null);
  });

  // The store refuses to be read, or to be written.
  for (const broken of ['get', 'put']) {
    const c = world(site(), { kv });
    const real = c.env.KILN[broken].bind(c.env.KILN);
    c.env.KILN[broken] = async (k, ...rest) => { if (/^(ebuild:|erepo:|elatest$)/.test(k)) throw new Error('KV is down'); return real(k, ...rest); };
    await withFetch(c.handler, async () => {
      const res = await ask(c.env, 'GET', '/cloud/me');
      assert.equal(res.status, 200, broken);
      const body = await res.json();
      whole(body);
      assert.equal(body.editor_latest, broken === 'get' ? null : 'r2', broken);
      assert.equal(body.sites[0].editor_build, broken === 'get' ? null : 'r1', broken);
      // The update itself does not depend on what is remembered.
      assert.equal((await press(c.env)).status, 200, broken);
    });
    assert.equal(c.gh.read('assets/kiln.js'), editor('r2'), broken);
  }

  // What is stored is not what was expected.
  const d = world(site(), { kv: { 'ebuild:ada/club': 'not json {', 'elatest': '"a string"' } });
  await withFetch(d.handler, async () => {
    const res = await ask(d.env, 'GET', '/cloud/me');
    assert.equal(res.status, 200);
    const body = await res.json();
    whole(body);
    assert.equal(body.editor_latest, null);
    assert.equal(body.sites[0].editor_build, null);
  });
  const e = world(site(), { kv: { 'ebuild:ada/club': { build: '<script>alert(1)</script>', at: 1 }, 'erepo:ada/club': { build: 7 } } });
  await withFetch(e.handler, async () => assert.equal((await me(e.env)).sites[0].editor_build, null, 'only a stamp is handed to the browser'));
});

test('update: the service replaces what the terminal tool replaces, and finds the editor where a site keeps it', () => {
  const cli = readFileSync(path.join(ROOT, 'cli', 'index.mjs'), 'utf8');
  // The editor's three files.
  const names = Function(`return ${cli.match(/for \(const f of (\[[^\]]+\])\) cpSync\(path\.join\(PKG_ROOT, 'dist', f\)/)[1]}`)();
  assert.deepEqual(EDITOR_FILES, names.map(f => [`assets/${f}`, `dist/${f}`]));
  // The members gate: every file under templates/functions, as `cpSync(templates/functions, functions)` copies them.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const inTemplates = walk(path.join(ROOT, 'templates', 'functions')).map(f => path.relative(path.join(ROOT, 'templates'), f).split(path.sep).join('/')).sort();
  assert.deepEqual(GATE_FILES.map(([to]) => to).sort(), inTemplates);
  for (const [to, from] of GATE_FILES) assert.equal(from, `templates/${to}`);
  assert.match(cli, /existsSync\(gate\)/);
  assert.match(cli, /const gate = path\.join\('functions', 'members', '_middleware\.js'\);/);
  // The routing rules.
  assert.deepEqual(ROUTES_WANTED, Function(`return ${cli.match(/const want = (\[[^\]]+\]);/)[1]}`)());
  assert.deepEqual(JSON.parse(readFileSync(path.join(ROOT, 'templates', '_routes.json'), 'utf8')).include, ROUTES_WANTED);
  // The command a person is sent to when the service cannot do it.
  assert.equal(UPDATE_COMMAND, 'npx github:kilncms/kiln#release update');
  assert.ok(cli.includes(UPDATE_COMMAND));
  // What the service relies on in a release: the stamp in dist/VERSION is the one at the top of dist/kiln.js.
  const stamp = readFileSync(path.join(ROOT, 'dist', 'VERSION'), 'utf8').trim();
  assert.match(stamp, /^[\w.-]{1,40}$/);
  assert.ok(readFileSync(path.join(ROOT, 'dist', 'kiln.js'), 'utf8').slice(0, 4000).includes(`window.KILN_VERSION="${stamp}"`));

  const pair = (dir) => [`${dir}kiln.js`, `${dir}kiln-config.js`];
  assert.equal(editorFolder([...pair('assets/'), 'index.html']), 'assets');
  assert.equal(editorFolder([...pair('public/assets/'), 'astro.config.mjs']), 'public/assets');
  assert.equal(editorFolder([...pair('static/assets/'), ...pair('dist/assets/')]), 'static/assets');
  assert.equal(editorFolder([...pair('dist/assets/'), ...pair('assets/'), ...pair('public/assets/')]), 'assets');
  assert.equal(editorFolder(pair('js/')), 'js');
  assert.equal(editorFolder(pair('')), '', 'the top of the repository');
  assert.equal(editorFolder(pair('dist/assets/')), 'dist/assets', 'a build folder is taken when it is the only place');
  for (const none of [[], ['assets/kiln.js'], ['assets/kiln-config.js'], ['assets/mykiln.js', 'assets/kiln-config.js'], pair('node_modules/x/'), pair('.cache/assets/')]) assert.equal(editorFolder(none), null, JSON.stringify(none));
});
