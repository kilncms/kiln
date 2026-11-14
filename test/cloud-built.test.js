/**
 * Kiln hosting a site that Astro builds (worker/hosting.js,
 * worker/hosted.js, the routes in worker/cloud.js and /gh/webhook). Such a
 * repository holds source, so Kiln copies the branch a build in the
 * customer's own repository pushes the finished pages to (kiln-built), and
 * tells the dashboard where that build stands. The real handlers run over the
 * SQLite-backed D1 stand-in, an in-memory GitHub and an in-memory Cloudflare.
 * Nothing here touches the network, and nothing here builds anything: a build
 * is stood for by a push to kiln-built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare } from './cloudflare-fake.js';
import { BUILD_SENTENCES, BUILD_REFUSALS, BUILD_FILE, BUILD_FILE_TEXT, buildFile, addUrl, GATE_PATHS, hostingSentence } from '../worker/hosting.js';
import { prepareSentence } from '../worker/prepare.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'whsec-github';
const NAME = 'club-site1';
/** A folder's files, as { path: text }. */
const folder = (dir, under = '') => Object.assign({}, ...readdirSync(path.join(dir, under)).map((n) => {
  const rel = under ? `${under}/${n}` : n;
  return statSync(path.join(dir, rel)).isDirectory() ? folder(dir, rel) : { [rel]: readFileSync(path.join(dir, rel), 'utf8') };
}));
// The Astro fixture with Kiln added to it, as the button of the step before leaves it.
const fixture = { ...folder(path.join(HERE, 'fixtures/astro-site')), ...folder(path.join(HERE, 'fixtures/astro-site-with-kiln')) };
const WORKFLOW = readFileSync(path.join(HERE, '../templates/kiln-build.yml'), 'utf8');
/** The source of an Astro site that installs with npm, without the build file. */
const source = (more = {}) => ({ ...fixture, 'package-lock.json': '{}', ...more });
/** The same with the build file committed. */
const withFile = (more = {}) => source({ [BUILD_FILE]: WORKFLOW, ...more });
/** What a build leaves in dist/: the pages, and public/ copied to the top. */
const built = (more = {}) => ({ 'index.html': '<!doctype html><h1>Built home</h1>', 'kiln.html': '<!doctype html><title>Kiln</title>', 'assets/kiln-config.js': 'window.KILN_CONFIG = {};', '_astro/site.css': 'h1{}', ...more });
const plain = { 'index.html': '<!doctype html><h1>Plain home</h1>', 'about.html': '<!doctype html><h1>About</h1>' };

function world(files, { env: extra = {} } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files });
  const cf = fakeCloudflare();
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token' }), {
    HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites', GH_WEBHOOK_SECRET: SECRET, ...extra,
  });
  addSite(env, { id: 'site1', plan: 'managed', status: 'trialing' });
  // The first pass is on record and the release is out of reach, so what Kiln does to a repository before its first copy is not what is tried here.
  try { env.kiln_cloud.exec("UPDATE sites SET firstpass_at = 1 WHERE id = 'site1'"); } catch { /* a database before migration 0004 */ }
  const handler = async (url, init) => (await cf.handler(url, init)) || gh.handler(url, init);
  return { gh, cf, env, handler };
}
const ask = (env, method, pathname, body) => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const switchOn = (env) => ask(env, 'POST', '/cloud/sites/hosting', { id: 'site1' });
const hosting = async (env) => (await (await ask(env, 'GET', '/cloud/sites/hosting?site=site1')).json()).hosting;
const row = (env) => env.kiln_cloud.row('SELECT * FROM hosting WHERE site_id = ?', 'site1');
const up = (w) => w.cf.scripts.get(NAME);
const served = (w, file) => w.cf.serve(NAME, file)?.bytes.toString() ?? null;
/** A push notice as GitHub sends it. */
async function notice(w, branch = 'main') {
  const body = JSON.stringify({ ref: `refs/heads/${branch}`, after: w.gh.head(branch), deleted: false, repository: { full_name: 'ada/club', default_branch: 'main' } });
  const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  const res = await worker.fetch(new Request('https://worker.example/gh/webhook', { method: 'POST', headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sig, 'Content-Type': 'application/json' }, body }), w.env);
  return res.json();
}
const sweep = (env) => worker.scheduled({}, env);
/** A build finishes: the pages are pushed to kiln-built as one fresh commit that names its source. */
const build = (w, files = built(), from = w.gh.head()) => w.gh.push('kiln-built', files, { message: `Built from ${from}` });
/** A built site that is up: hosting switched on, then its first build arrives. */
async function liveWorld(files = withFile(), pages = built(), options = {}) {
  const w = world(files, options);
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    build(w, pages);
    assert.equal((await notice(w, 'kiln-built')).published, 1, 'the first build is published');
  });
  return w;
}

test('built site: the build file is the template, short enough to read and with no secret in it', () => {
  assert.equal(BUILD_FILE_TEXT, WORKFLOW, 'worker/hosting.js and templates/kiln-build.yml hold the same text');
  assert.ok(WORKFLOW.split('\n').length <= 46, 'about forty lines');
  assert.doesNotMatch(WORKFLOW, /secrets\./, 'no secret but the run\'s own token');
  assert.match(WORKFLOW, /Built from \$GITHUB_SHA/);
  assert.match(WORKFLOW, /contents: write[^\n]*\n\s+statuses: write/);
  assert.match(WORKFLOW, /cancel-in-progress: true/);
  const pnpm = buildFile({ tool: 'pnpm', branch: 'trunk' });
  assert.match(pnpm, /pnpm install --frozen-lockfile/);
  assert.match(pnpm, /- run: pnpm build/);
  assert.doesNotMatch(pnpm, /npm ci|npm run build/);
  assert.match(pnpm, /branches: \["trunk"\]/);
  assert.equal(new URL(addUrl({ repo: 'a/b', branch: 'site/live' })).pathname, '/a/b/new/site/live');
  assert.equal(hostingSentence('needs_build_file'), BUILD_SENTENCES.needs_file);
  assert.equal(hostingSentence('astro_unusual'), prepareSentence('astro_unusual'));
  for (const s of [...Object.values(BUILD_SENTENCES), ...Object.values(BUILD_REFUSALS)]) assert.doesNotMatch(s, /—|\brepo\b|\bsync|\bconfig\b|\bdeploy/i);
});

test('built site: with no build file the owner is shown the one press that adds it, and nothing is uploaded', { skip: d1Skip }, async () => {
  const w = world(source());
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    const h = await hosting(w.env);
    assert.equal(h.state, 'waiting');
    assert.equal(h.error, BUILD_SENTENCES.needs_file);
    assert.deepEqual(h.build, {
      state: 'needs_file', sentence: BUILD_SENTENCES.needs_file,
      add_url: `https://github.com/ada/club/new/main?filename=.github/workflows/kiln-build.yml&value=${encodeURIComponent(WORKFLOW)}`,
    });
    const page = new URL(h.build.add_url);
    assert.equal(page.searchParams.get('filename'), '.github/workflows/kiln-build.yml');
    assert.equal(page.searchParams.get('value'), WORKFLOW, 'GitHub is handed the npm file as it is');
  });
  assert.equal(w.cf.scripts.has(NAME), false, 'nothing is uploaded');
  assert.equal(row(w.env).built, 1);

  // A site that installs with pnpm is handed the pnpm form of the same file.
  const { 'package-lock.json': left, ...noLock } = source();
  const p = world({ ...noLock, 'pnpm-lock.yaml': 'lockfileVersion: \'9.0\'' });
  await withFetch(p.handler, async () => {
    await switchOn(p.env);
    const h = await hosting(p.env);
    assert.equal(h.build.state, 'needs_file');
    const file = new URL(h.build.add_url).searchParams.get('value');
    assert.equal(file, buildFile({ tool: 'pnpm' }));
    assert.match(file, /corepack enable && pnpm install --frozen-lockfile/);
    assert.doesNotMatch(file, /npm ci/);
  });
  assert.equal(p.cf.scripts.has(NAME), false);
});

test('built site: the build file is there and the first build is not, so the site is building, and late after fifteen minutes', { skip: d1Skip }, async () => {
  const w = world(withFile());
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    let h = await hosting(w.env);
    assert.equal(h.state, 'waiting');
    assert.deepEqual(h.build, { state: 'building', sentence: BUILD_SENTENCES.building, runs_url: 'https://github.com/ada/club/actions' });
    assert.equal(h.error, BUILD_SENTENCES.building);
    assert.equal(row(w.env).build_wanted_sha, w.gh.head());
    w.env.kiln_cloud.exec(`UPDATE hosting SET build_wanted_at = ${Date.now() - 16 * 60 * 1000} WHERE site_id = 'site1'`);
    h = await hosting(w.env);
    assert.deepEqual(h.build, { state: 'late', sentence: BUILD_SENTENCES.late, runs_url: 'https://github.com/ada/club/actions' });
    assert.equal(h.error, BUILD_SENTENCES.late);
  });
  assert.equal(w.cf.scripts.has(NAME), false, 'nothing is uploaded before a build');
});

test('built site: the built pages go up, and nothing of the source does', { skip: d1Skip }, async () => {
  const w = await liveWorld();
  assert.equal(served(w, '/index.html'), built()['index.html']);
  assert.equal(served(w, '/kiln.html'), built()['kiln.html']);
  assert.equal(served(w, '/assets/kiln-config.js'), built()['assets/kiln-config.js']);
  assert.deepEqual(Object.keys(up(w).manifest).sort(), ['/_astro/site.css', '/assets/kiln-config.js', '/index.html', '/kiln.html'], 'exactly the built branch');
  for (const file of ['/package.json', '/package-lock.json', '/astro.config.mjs', '/src/pages/index.astro', '/public/kiln.html', `/${BUILD_FILE}`]) assert.equal(served(w, file), null, `${file} is not on the site`);
  await withFetch(w.handler, async () => {
    const h = await hosting(w.env);
    assert.equal(h.state, 'live');
    assert.equal(h.commit, w.gh.head(), 'the commit shown is the source commit the pages were built from');
    assert.equal(h.files, 4);
    assert.deepEqual(h.build, { state: 'built', runs_url: 'https://github.com/ada/club/actions' });
    assert.equal(h.error, undefined);
  });
  const r = row(w.env);
  assert.deepEqual({ built: r.built, built_sha: r.built_sha, branch: r.branch, tool: r.build_tool, wanted: r.build_wanted_sha }, { built: 1, built_sha: w.gh.head('kiln-built'), branch: 'main', tool: 'npm', wanted: null });
});

test('built site: a push to the default branch is put on record and does not publish, and the build\'s push publishes and ends the wait', { skip: d1Skip }, async () => {
  const w = await liveWorld();
  await withFetch(w.handler, async () => {
    const before = w.gh.head(), copies = up(w).deploys;
    const next = w.gh.commit({ 'src/pages/index.astro': '---\n---\n<h1>Changed</h1>' });
    assert.equal((await notice(w)).published, 0);
    assert.equal(up(w).deploys, copies, 'nothing was copied');
    assert.equal(served(w, '/index.html'), built()['index.html']);
    let r = row(w.env);
    assert.equal(r.build_wanted_sha, next);
    assert.ok(r.build_wanted_at > 0);
    assert.equal(r.commit_sha, before);
    let h = await hosting(w.env);
    assert.equal(h.state, 'live');
    assert.equal(h.build.state, 'building');

    build(w, built({ 'index.html': '<!doctype html><h1>Changed</h1>' }), next);
    assert.equal((await notice(w, 'kiln-built')).published, 1);
    assert.equal(served(w, '/index.html'), '<!doctype html><h1>Changed</h1>');
    r = row(w.env);
    assert.deepEqual({ wanted: r.build_wanted_sha, at: r.build_wanted_at, commit: r.commit_sha, state: r.build_state }, { wanted: null, at: null, commit: next, state: null });
    h = await hosting(w.env);
    assert.equal(h.build.state, 'built');
    // The same notice again changes nothing.
    assert.equal((await notice(w, 'kiln-built')).published, 0);
    assert.equal(up(w).deploys, copies + 1);
  });
});

test('built site: the five-minute look publishes a build nobody announced, learns of one that stopped, and "Build again" looks at once', { skip: d1Skip }, async () => {
  const w = await liveWorld();
  await withFetch(w.handler, async () => {
    const one = w.gh.commit({ 'src/pages/index.astro': '---\n---\n<h1>One</h1>' });
    await notice(w);
    build(w, built({ 'index.html': 'one' }), one);          // no notice comes
    await sweep(w.env);
    assert.equal(served(w, '/index.html'), 'one');
    assert.equal(row(w.env).build_wanted_sha, null);

    // A push no notice announced is found by the same look, and waited for.
    const two = w.gh.commit({ 'src/pages/index.astro': '---\n---\n<h1>Two</h1>' });
    w.env.kiln_cloud.exec("UPDATE hosting SET checked_at = 0 WHERE site_id = 'site1'");
    await sweep(w.env);
    assert.equal(row(w.env).build_wanted_sha, two);
    assert.equal((await hosting(w.env)).build.state, 'building');
    assert.equal(served(w, '/index.html'), 'one');

    // Fifteen minutes with no result: late.
    w.env.kiln_cloud.exec(`UPDATE hosting SET build_wanted_at = ${Date.now() - 16 * 60 * 1000} WHERE site_id = 'site1'`);
    await sweep(w.env);
    let h = await hosting(w.env);
    assert.deepEqual(h.build, { state: 'late', sentence: BUILD_SENTENCES.late, runs_url: 'https://github.com/ada/club/actions' });
    assert.equal(h.state, 'live', 'the site still shows the version from before');

    // The build marks its commit as failed: the look puts that on record. Another tool's mark is not the build's.
    w.gh.statuses.set(two, [{ context: 'some-other-check', state: 'failure' }]);
    await sweep(w.env);
    assert.equal((await hosting(w.env)).build.state, 'late');
    w.gh.statuses.set(two, [{ context: 'kiln-build', state: 'failure' }, { context: 'kiln-build', state: 'pending' }]);
    await sweep(w.env);
    h = await hosting(w.env);
    assert.deepEqual(h.build, { state: 'failed', sentence: BUILD_SENTENCES.failed, runs_url: 'https://github.com/ada/club/actions' });

    // The owner runs the build again on GitHub, it finishes, and presses Build again.
    build(w, built({ 'index.html': 'two' }), two);
    const res = await ask(w.env, 'POST', '/cloud/sites/hosting/build', { id: 'site1' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.hosting.build.state, 'built');
    assert.equal(body.hosting.commit, two);
    assert.equal(served(w, '/index.html'), 'two');
  });
});

test('built site: a site that runs on a server, one with an installer Kiln does not know and an unusual one are refused in their own sentences', { skip: d1Skip }, async () => {
  const refused = async (files, sentence) => {
    const w = world(files);
    build(w);
    await withFetch(w.handler, async () => {
      await switchOn(w.env);
      const h = await hosting(w.env);
      assert.equal(h.state, 'waiting');
      assert.equal(h.error, sentence);
      assert.equal(h.build, undefined);
    });
    assert.equal(w.cf.scripts.has(NAME), false, 'nothing is uploaded');
  };
  await refused(withFile({ 'astro.config.mjs': "import node from '@astrojs/node';\nexport default { adapter: node() };\n" }), BUILD_REFUSALS.build_server);
  await refused(withFile({ 'astro.config.mjs': 'export default { output: "server" };\n' }), BUILD_REFUSALS.build_server);
  await refused(withFile({ 'astro.config.mjs': "export default { output: 'server', base: '/x' };\n" }), BUILD_REFUSALS.build_server);
  await refused(withFile({ 'astro.config.mjs': "export default { base: '/club' };\n" }), prepareSentence('astro_unusual'));
  const { 'package-lock.json': left, ...noLock } = withFile();
  await refused({ ...noLock, 'yarn.lock': '# yarn' }, BUILD_REFUSALS.build_tool);
  assert.equal(BUILD_REFUSALS.build_server, 'This site runs a program for each visit. Kiln\'s hosting serves ready-made pages only, so it cannot host this site. You can still use Kiln with the host you have now.');
  assert.equal(BUILD_REFUSALS.build_tool, 'This site installs its parts with a tool Kiln\'s build file does not know yet. Write to info@kilncms.com and we will add it.');

  // A setting that is only talked about in a comment refuses nothing.
  const w = await liveWorld(withFile({ 'astro.config.mjs': "// adapter: node(), output: 'server'\nexport default {};\n" }));
  assert.equal(served(w, '/index.html'), built()['index.html']);
});

test('built site: the pages under members/ are never served openly, exactly as on a plain site', { skip: d1Skip }, async () => {
  const pages = built({ 'members/index.html': '<!doctype html><h1>Members only</h1>', 'members/minutes/index.html': '<!doctype html><h1>Minutes</h1>' });
  // Where this service cannot guard a members area, those pages are left out of what goes up.
  const off = await liveWorld(withFile(), pages);
  assert.equal(served(off, '/index.html'), pages['index.html']);
  assert.equal(served(off, '/members/index.html'), null);
  assert.equal(served(off, '/members/minutes/index.html'), null);
  assert.ok(!Object.keys(up(off).manifest).some(file => file.startsWith('/members/')), 'no members page is in what was uploaded');
  assert.equal(up(off).config.run_worker_first, undefined);

  // Where it can, they go up behind the same gate a plain site gets, which Cloudflare runs before every address under members/.
  const on = await liveWorld(withFile(), pages, { env: { HOSTING_MEMBER_KEY: 'member-key', HOSTING_SERVICE_URL: 'https://worker.example' } });
  assert.deepEqual(up(on).config.run_worker_first, GATE_PATHS);
  assert.ok(GATE_PATHS.includes('/members/*'));
  const visit = await on.cf.visit(NAME, new Request(`https://${NAME}.kiln-sites.workers.dev/members/`));
  assert.notEqual(visit.status, 200, 'a visitor who is not signed in is not handed the page');
  assert.doesNotMatch(await visit.text(), /Members only/);

  // The same holds for a plain site, so the two are guarded alike.
  const same = world({ ...plain, 'members/index.html': pages['members/index.html'] }, { env: { HOSTING_MEMBER_KEY: 'member-key', HOSTING_SERVICE_URL: 'https://worker.example' } });
  await withFetch(same.handler, async () => { await switchOn(same.env); });
  assert.deepEqual(up(same).config.run_worker_first, up(on).config.run_worker_first);
});

test('built site: a plain site is published from its own branch as before, even with a branch that happens to be named kiln-built', { skip: d1Skip }, async () => {
  const w = world(plain);
  w.gh.push('kiln-built', { 'index.html': 'not the site' }, { message: `Built from ${w.gh.head()}` });
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    let h = await hosting(w.env);
    assert.equal(h.state, 'live');
    assert.equal(h.commit, w.gh.head());
    assert.equal(h.build, undefined);
    assert.equal(served(w, '/index.html'), plain['index.html']);
    assert.equal(served(w, '/about.html'), plain['about.html']);
    assert.equal((await notice(w, 'kiln-built')).published, 0, 'a push to that branch publishes nothing');
    assert.equal(served(w, '/index.html'), plain['index.html']);
    w.gh.commit({ 'index.html': '<!doctype html><h1>Plain, changed</h1>' });
    assert.equal((await notice(w)).published, 1, 'a push to its own branch publishes at once');
    assert.equal(served(w, '/index.html'), '<!doctype html><h1>Plain, changed</h1>');
    h = await hosting(w.env);
    assert.equal(h.commit, w.gh.head());
  });
  const r = row(w.env);
  assert.deepEqual({ built: r.built, built_sha: r.built_sha, wanted: r.build_wanted_sha }, { built: 0, built_sha: null, wanted: null });
});

test('built site: a suggestion on a built site gets no preview, and nothing fails', { skip: d1Skip }, async () => {
  const w = await liveWorld();
  await withFetch(w.handler, async () => {
    w.gh.refs.set('heads/kiln/suggest-ben', w.gh.head());
    w.gh.commit({ 'src/pages/index.astro': '---\n---\n<h1>Suggested</h1>' }, { branch: 'kiln/suggest-ben', message: `A suggestion (via Kiln)` });
    const answer = await notice(w, 'kiln/suggest-ben');
    assert.equal(answer.ok, true);
    assert.equal(answer.previews, 0);
    await sweep(w.env);
  });
  assert.deepEqual([...w.cf.scripts.keys()], [NAME], 'the site is the only thing that is up');
  assert.equal(w.gh.read('public/assets/kiln-config.js').includes('preview:'), fixture['public/assets/kiln-config.js'].includes('preview:'), 'the settings file was not given a preview line');
});

test('built site: on a database migration 0014 has not reached, a built site and a plain site are still published and nothing fails', { skip: d1Skip }, async () => {
  const w = world(withFile(), { env: { d1: { upTo: 13 } } });
  build(w);
  await withFetch(w.handler, async () => {
    assert.equal((await switchOn(w.env)).status, 200);
    let h = await hosting(w.env);
    assert.equal(h.state, 'live');
    assert.equal(h.build, undefined, 'the build is not on record there');
    assert.equal(served(w, '/index.html'), built()['index.html']);
    assert.equal(served(w, '/package.json'), null);
    assert.equal(row(w.env).built, undefined);
    w.gh.commit({ 'src/pages/index.astro': '---\n---\n<h1>Changed</h1>' });
    assert.equal((await notice(w)).ok, true);
    assert.equal((await notice(w, 'kiln-built')).ok, true);
    await sweep(w.env);
    h = await hosting(w.env);
    assert.equal(h.state, 'live');
    assert.equal(served(w, '/index.html'), built()['index.html']);
  });

  const p = world(plain, { env: { d1: { upTo: 13 } } });
  await withFetch(p.handler, async () => {
    await switchOn(p.env);
    p.gh.commit({ 'index.html': 'changed' });
    assert.equal((await notice(p)).published, 1);
    assert.equal(p.cf.serve(NAME, '/index.html').bytes.toString(), 'changed');
    p.gh.commit({ 'index.html': 'changed again' });
    await p.env.kiln_cloud.exec("UPDATE hosting SET checked_at = 0 WHERE site_id = 'site1'");
    await sweep(p.env);
    assert.equal(p.cf.serve(NAME, '/index.html').bytes.toString(), 'changed again');
  });
});

test('built site: "Check this site" says nothing about previews for a site that gets none', { skip: d1Skip }, async () => {
  const page = '<!doctype html><html><head><script src="/assets/kiln-config.js"></script><script src="/assets/kiln.js" defer></script></head><body><h1>Home</h1></body></html>';
  const w = await liveWorld(withFile(), built({ 'index.html': page, 'kiln.html': fixture['public/kiln.html'], 'assets/kiln-config.js': fixture['public/assets/kiln-config.js'], 'assets/kiln.js': '// the editor' }));
  // The check opens the site's own address: here Cloudflare's stand-in answers for it.
  const address = `https://${NAME}.kiln-sites.workers.dev`;
  const handler = async (url, init) => (String(url).startsWith(address) ? w.cf.visit(NAME, new Request(url, init)) : w.handler(url, init));
  await withFetch(handler, async () => {
    const res = await ask(w.env, 'GET', '/cloud/sites/check?site=site1');
    assert.equal(res.status, 200);
    const { checks } = await res.json();
    assert.ok(checks.length >= 4, 'the site was checked');
    assert.match(JSON.stringify(checks), /public\/assets\/kiln-config\.js/, 'the settings file was found where an Astro site keeps it');
    assert.doesNotMatch(JSON.stringify(checks), /preview/i, 'no line promises a preview');
  });
});
