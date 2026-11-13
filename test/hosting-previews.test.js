/**
 * Previews of suggestions on a site Kiln hosts: a branch the editor writes a
 * suggestion or a shared draft to (kiln/suggest-<name>, kiln-drafts) goes up as
 * a Worker of its own when GitHub says it changed, and comes down when the
 * branch is deleted, when the site comes down or is removed, when a sixth
 * preview needs the room, and after thirty days without a change
 * (worker/hosted.js, worker/hosting.js, migration 0010). The real handlers run
 * over the SQLite-backed D1 stand-in, an in-memory GitHub and an in-memory
 * Cloudflare. Nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';
import { fakeGitHub } from './github-fake.js';
import { fakeCloudflare } from './cloudflare-fake.js';
import { previewPattern, previewAlias, previewName, isPreviewBranch, siteName, PREVIEW_HEADERS } from '../worker/hosting.js';
import { previewNotice } from '../worker/hosted.js';
import { previewUrl } from '../src/editor/suggest.js';

const SECRET = 'whsec-github';
const DAY = 24 * 60 * 60 * 1000;
const SUGGEST = 'kiln/suggest-Ana';
const PV = 'pv-site1-kiln-suggest-ana';
const pages = {
  'index.html': '<!doctype html><h1>Home</h1>',
  'about.html': '<!doctype html><h1>About</h1>',
  'members/index.html': '<!doctype html><h1>Members only</h1>',
  'members/minutes.html': '<!doctype html><h1>Minutes</h1>',
};

function world(files = pages, { site = {}, env: extra = {}, d1 } = {}) {
  const gh = fakeGitHub({ repo: 'ada/club', files });
  const cf = fakeCloudflare();
  const env = cloudEnv(fakeKV({ 'itok:ada/club': 'inst-token' }), {
    HOSTING_ACCOUNT_ID: cf.account, HOSTING_API_TOKEN: cf.token, HOSTING_SUBDOMAIN: 'kiln-sites', GH_WEBHOOK_SECRET: SECRET,
    // The members area is switched on for this service, so the site itself is put up with its gate.
    HOSTING_MEMBER_KEY: 'member-key', HOSTING_SERVICE_URL: 'https://worker.example', ...(d1 ? { d1 } : {}), ...extra,
  });
  addSite(env, { id: 'site1', plan: 'managed', status: 'trialing', ...site });
  try { env.kiln_cloud.exec("UPDATE sites SET firstpass_at = 1 WHERE id = 'site1'"); } catch { /* a database before migration 0004 */ }
  const handler = async (url, init) => (await cf.handler(url, init)) || gh.handler(url, init);
  return { gh, cf, env, handler };
}
const ask = (env, method, pathname, body) => worker.fetch(new Request(`https://worker.example${pathname}`, {
  method, headers: { Authorization: 'Bearer tok', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
}), env);
const switchOn = (env, id = 'site1') => ask(env, 'POST', '/cloud/sites/hosting', { id });
const sweep = (env) => worker.scheduled({}, env);
const rows = (env) => env.kiln_cloud.db.prepare('SELECT * FROM previews ORDER BY alias').all();
const served = (w, path, name = PV) => w.cf.serve(name, path)?.bytes.toString() ?? null;
const previewsUp = (w) => [...w.cf.scripts.keys()].filter(n => n.startsWith('pv-')).sort();
/** Somebody's change lands on `branch`, which is made from the default branch when it is new. Returns the commit. */
function change(w, branch, files) {
  if (!w.gh.refs.has(`heads/${branch}`)) w.gh.refs.set(`heads/${branch}`, w.gh.head());
  return w.gh.commit(files, { branch });
}
/** A push notice as GitHub sends it, signed. */
async function notice(w, { branch, ref = `refs/heads/${branch}`, after = w.gh.head(branch), deleted = false } = {}) {
  const body = JSON.stringify({ ref, after: deleted ? '0'.repeat(40) : after, deleted, repository: { full_name: 'ada/club', default_branch: 'main' } });
  const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
  const res = await worker.fetch(new Request('https://worker.example/gh/webhook', { method: 'POST', headers: { 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sig, 'Content-Type': 'application/json' }, body }), w.env);
  return { status: res.status, body: await res.json() };
}
/** A change on `branch` and GitHub's notice of it. */
async function push(w, branch, files = { 'index.html': `<!doctype html><h1>${branch}</h1>` }) {
  const commit = change(w, branch, files);
  return { commit, ...(await notice(w, { branch })) };
}

test('previews: a suggestion pushed to a hosted site goes up at an address of its own, without the members pages and out of search engines', { skip: d1Skip }, async () => {
  const w = world({ ...pages, _headers: '/assets/*\n  Cache-Control: max-age=600\n' });
  await withFetch(w.handler, async (calls) => {
    assert.equal((await switchOn(w.env)).status, 200);
    const site = siteName(w.env, { repo: 'ada/club', id: 'site1' });
    assert.ok(w.cf.scripts.get(site).module, 'the site itself has its members gate');
    const first = await push(w, SUGGEST, { 'index.html': '<!doctype html><h1>Ana suggests</h1>', 'members/minutes.html': '<!doctype html><h1>Secret change</h1>' });
    assert.deepEqual([first.status, first.body], [200, { ok: true, previews: 1 }]);

    // A second Worker, named for the site and the branch, with that branch's files.
    assert.deepEqual(previewsUp(w), [PV]);
    const up = w.cf.scripts.get(PV);
    assert.equal(served(w, '/index.html'), '<!doctype html><h1>Ana suggests</h1>');
    assert.equal(served(w, '/about.html'), pages['about.html']);
    assert.equal(up.address, true, 'its address is switched on');
    assert.equal(w.cf.serve(site, '/index.html').bytes.toString(), pages['index.html'], 'the site itself is as it was');

    // Nothing under members/ is in it, and it has no gate and no program at all.
    assert.deepEqual(Object.keys(up.manifest).sort(), ['/about.html', '/index.html']);
    assert.equal((await w.cf.visit(PV, new Request('https://pv.example/members/minutes'))).status, 404);
    assert.equal(up.module, null);
    assert.equal(up.meta.main_module, undefined);
    assert.equal(up.meta.bindings, undefined);
    assert.equal(up.config.run_worker_first, undefined);
    assert.deepEqual(up.parts, ['metadata']);

    // Every answer says noindex, after what the site's own _headers says.
    assert.equal(up.config._headers, '/assets/*\n  Cache-Control: max-age=600\n\n/*\n  X-Robots-Tag: noindex\n');
    assert.ok(up.config._headers.endsWith(PREVIEW_HEADERS));

    // It is never attached to a domain.
    assert.equal(calls.filter(c => /\/workers\/domains|\/zones/.test(c.url)).length, 0);

    // The record.
    const [row, ...more] = rows(w.env);
    assert.equal(more.length, 0);
    assert.deepEqual({ ...row, deployed_at: null, updated_at: null }, { site_id: 'site1', alias: 'kiln-suggest-ana', branch: SUGGEST, name: PV, commit_sha: first.commit, deployed_at: null, updated_at: null });
    assert.ok(row.deployed_at > 0 && row.updated_at >= row.deployed_at);

    // A second push changes the same Worker and the same row.
    w.env.kiln_cloud.exec('UPDATE previews SET updated_at = 5, deployed_at = 5');
    const second = await push(w, SUGGEST, { 'about.html': '<!doctype html><h1>About, by Ana</h1>' });
    assert.deepEqual(second.body, { ok: true, previews: 1 });
    assert.deepEqual(previewsUp(w), [PV]);
    assert.equal(w.cf.scripts.get(PV).deploys, 2);
    assert.equal(served(w, '/about.html'), '<!doctype html><h1>About, by Ana</h1>');
    assert.equal(rows(w.env).length, 1);
    assert.equal(rows(w.env)[0].commit_sha, second.commit);
    assert.ok(rows(w.env)[0].updated_at > 5);
    // The address is switched on once, with the first copy.
    assert.equal(calls.filter(c => c.url.endsWith(`/workers/scripts/${PV}/subdomain`)).length, 1);

    // The same notice delivered twice copies nothing again.
    const n = calls.length;
    assert.deepEqual((await notice(w, { branch: SUGGEST })).body, { ok: true, previews: 1 });
    assert.equal(calls.slice(n).filter(c => c.url.includes('cloudflare')).length, 0);

    // A shared draft is a preview too. A site with no _headers of its own gets the one rule.
    w.gh.commit({ _headers: null }, { branch: 'main' });
    await push(w, 'kiln-drafts', { 'index.html': '<!doctype html><h1>A draft</h1>' });
    assert.deepEqual(previewsUp(w), ['pv-site1-kiln-drafts', PV]);
    assert.equal(served(w, '/index.html', 'pv-site1-kiln-drafts'), '<!doctype html><h1>A draft</h1>');
    assert.equal(w.cf.scripts.get('pv-site1-kiln-drafts').config._headers, PREVIEW_HEADERS);
    assert.equal(PREVIEW_HEADERS, '/*\n  X-Robots-Tag: noindex\n');
  });
});

test('previews: a change that arrives while a preview is being copied is not lost', { skip: d1Skip }, async () => {
  const w = world();
  let during = null;
  // GitHub's second notice comes in at the moment the first copy is handed to Cloudflare.
  const handler = async (url, init = {}) => {
    if (!during && init.method === 'PUT' && url.endsWith(`/workers/scripts/${PV}`)) {
      during = {};
      change(w, SUGGEST, { 'index.html': '<!doctype html><h1>Second thoughts</h1>' });
      during = await notice(w, { branch: SUGGEST });
    }
    return w.handler(url, init);
  };
  await withFetch(handler, async () => {
    await switchOn(w.env);
    const first = await push(w, SUGGEST, { 'index.html': '<!doctype html><h1>First thoughts</h1>' });
    assert.deepEqual(during.body, { ok: true, previews: 0 }, 'one copy at a time for a preview');
    assert.deepEqual(first.body, { ok: true, previews: 1 });
    assert.notEqual(first.commit, w.gh.head(SUGGEST));
    assert.equal(served(w, '/index.html'), '<!doctype html><h1>Second thoughts</h1>');
    assert.equal(rows(w.env)[0].commit_sha, w.gh.head(SUGGEST));
    assert.equal(w.cf.scripts.get(PV).deploys, 2);
    assert.deepEqual([...w.env.KILN.map.keys()].filter(k => k.startsWith('pv')), [], 'nothing is left locked');
  });
});

test('previews: a push to any other branch puts nothing up', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async (calls) => {
    await switchOn(w.env);
    const n = calls.length;
    for (const branch of ['feature-x', 'kiln/other', 'kiln-drafts-2', 'my/kiln/suggest-ana']) {
      const res = await push(w, branch);
      assert.deepEqual([res.status, res.body], [200, { ok: true, ignored: 'not the default branch' }], branch);
    }
    // A tag of that name is not a branch.
    change(w, 'kiln-drafts', { 'index.html': '<!doctype html><h1>Draft</h1>' });
    assert.ok((await notice(w, { ref: 'refs/tags/kiln-drafts', after: w.gh.head('kiln-drafts') })).body.ignored);
    assert.equal(calls.slice(n).filter(c => c.url.includes('cloudflare')).length, 0, 'none of these copied anything');
    assert.deepEqual(previewsUp(w), []);
    assert.equal(rows(w.env).length, 0);
    // A branch with no home page has nothing to show, and leaves no row behind.
    change(w, SUGGEST, { 'index.html': null });
    assert.deepEqual((await notice(w, { branch: SUGGEST })).body, { ok: true, previews: 0 });
    assert.deepEqual(previewsUp(w), []);
    assert.equal(rows(w.env).length, 0);
  });
  assert.equal(await previewNotice(w.env, { repo: 'ada/club', branch: 'feature-x', sha: 'x' }, { installationToken: async () => 'inst-token', hasAccess: () => true }), 0);
});

test('previews: a site that is not hosted, whose hosting is down, or that may not be edited gets no preview', { skip: d1Skip }, async () => {
  // Not hosted: hosting was never switched on for it.
  let w = world();
  await withFetch(w.handler, async (calls) => {
    assert.deepEqual((await push(w, SUGGEST)).body, { ok: true, previews: 0 });
    assert.equal(calls.filter(c => c.url.includes('cloudflare')).length, 0);
  });
  assert.equal(w.cf.scripts.size, 0);
  assert.equal(rows(w.env).length, 0);

  // Hosting is down: the site was taken down from Kiln's hosting.
  w = world();
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    w.env.kiln_cloud.exec("UPDATE hosting SET state = 'ended', reason = 'trial_ended' WHERE site_id = 'site1'");
    assert.deepEqual((await push(w, SUGGEST)).body, { ok: true, previews: 0 });
    w.env.kiln_cloud.exec("UPDATE hosting SET state = 'removing' WHERE site_id = 'site1'");
    assert.deepEqual((await push(w, 'kiln-drafts')).body, { ok: true, previews: 0 });
  });
  assert.deepEqual(previewsUp(w), []);
  assert.equal(rows(w.env).length, 0);

  // May not be edited: its plan ended.
  w = world(pages, { site: { ls_subscription_id: '77', status: 'active' } });
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    w.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled', access_until = ? WHERE id = 'site1'", Date.now() - DAY);
    assert.deepEqual((await push(w, SUGGEST)).body, { ok: true, previews: 0 });
  });
  assert.deepEqual(previewsUp(w), []);
  assert.equal(rows(w.env).length, 0);

  // A service that hosts nothing ignores the push.
  w = world(pages, { env: { HOSTING_API_TOKEN: '' } });
  await withFetch(w.handler, async () => assert.deepEqual((await push(w, SUGGEST)).body, { ok: true, ignored: 'hosting is off' }));
});

test('previews: deleting the branch takes its preview down', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    await push(w, SUGGEST);
    await push(w, 'kiln-drafts');
    assert.deepEqual(previewsUp(w), ['pv-site1-kiln-drafts', PV]);
    // Another branch that would stand at the same address is not the one that is up: deleting it changes nothing.
    assert.deepEqual((await notice(w, { branch: 'kiln/suggest-ANA', deleted: true })).body, { ok: true, previews: 0 });
    assert.deepEqual(previewsUp(w), ['pv-site1-kiln-drafts', PV]);
    w.gh.refs.delete(`heads/${SUGGEST}`);
    const res = await notice(w, { branch: SUGGEST, deleted: true });
    assert.deepEqual([res.status, res.body], [200, { ok: true, previews: 1 }]);
    assert.deepEqual(previewsUp(w), ['pv-site1-kiln-drafts']);
    assert.deepEqual(rows(w.env).map(r => r.alias), ['kiln-drafts']);
    // Deleting it again, or a branch that never had a preview, is nothing.
    assert.deepEqual((await notice(w, { branch: SUGGEST, deleted: true })).body, { ok: true, previews: 0 });
    // A site that may not be edited any more still loses the preview of a deleted branch.
    w.env.kiln_cloud.exec("UPDATE sites SET status = 'canceled', access_until = ? WHERE id = 'site1'", Date.now() - DAY);
    assert.deepEqual((await notice(w, { branch: 'kiln-drafts', deleted: true })).body, { ok: true, previews: 1 });
    assert.deepEqual(previewsUp(w), []);
    assert.equal(rows(w.env).length, 0);
  });
  assert.equal(w.cf.scripts.size, 1, 'the site itself is still up');
});

test('previews: a site has five at most, and a sixth takes the place of the one changed longest ago', { skip: d1Skip }, async () => {
  const w = world();
  const names = ['amy', 'ben', 'cy', 'di', 'ed'];
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    for (const n of names) assert.deepEqual((await push(w, `kiln/suggest-${n}`)).body, { ok: true, previews: 1 }, n);
    assert.equal(previewsUp(w).length, 5);
    // Cy's is the one nobody changed for the longest time.
    names.forEach((n, i) => w.env.kiln_cloud.exec('UPDATE previews SET updated_at = ? WHERE alias = ?', n === 'cy' ? 1000 : 5000 + i, `kiln-suggest-${n}`));
    // A push to a branch that already has a preview takes nobody's place.
    await push(w, 'kiln/suggest-amy', { 'about.html': '<!doctype html><h1>Amy again</h1>' });
    assert.equal(previewsUp(w).length, 5);
    assert.deepEqual((await push(w, 'kiln-drafts')).body, { ok: true, previews: 1 });
    assert.deepEqual(previewsUp(w), ['pv-site1-kiln-drafts', 'pv-site1-kiln-suggest-amy', 'pv-site1-kiln-suggest-ben', 'pv-site1-kiln-suggest-di', 'pv-site1-kiln-suggest-ed']);
    assert.deepEqual(rows(w.env).map(r => r.alias), ['kiln-drafts', 'kiln-suggest-amy', 'kiln-suggest-ben', 'kiln-suggest-di', 'kiln-suggest-ed']);

    // When the oldest cannot be taken down just now, the new one waits: five stays five.
    w.cf.failOn((method) => method === 'DELETE');
    assert.deepEqual((await push(w, 'kiln/suggest-fay')).body, { ok: true, previews: 0 });
    assert.equal(previewsUp(w).length, 5);
    assert.equal(rows(w.env).length, 5);
    w.cf.failOn(null);
    assert.deepEqual((await notice(w, { branch: 'kiln/suggest-fay' })).body, { ok: true, previews: 1 });
    assert.equal(previewsUp(w).length, 5);
    assert.ok(previewsUp(w).includes('pv-site1-kiln-suggest-fay'));
  });
});

test('previews: a removed site loses all of its previews, and so does a site that comes down from Kiln\'s hosting', { skip: d1Skip }, async () => {
  let w = world();
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    await push(w, SUGGEST);
    await push(w, 'kiln-drafts');
    assert.equal(w.cf.scripts.size, 3);
    assert.equal((await ask(w.env, 'POST', '/cloud/sites/remove', { id: 'site1' })).status, 200);
  });
  assert.equal(w.cf.scripts.size, 0);
  assert.equal(rows(w.env).length, 0);

  // A trial nobody subscribed for: the sweep takes the site down, and its previews with it.
  w = world();
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    await push(w, SUGGEST);
    await push(w, 'kiln-drafts');
    w.env.kiln_cloud.exec("UPDATE sites SET created_at = ? WHERE id = 'site1'", Date.now() - 60 * DAY);
    await sweep(w.env);
  });
  assert.equal(w.env.kiln_cloud.row("SELECT state FROM hosting WHERE site_id = 'site1'").state, 'ended');
  assert.equal(w.cf.scripts.size, 0);
  assert.equal(rows(w.env).length, 0);
});

test('previews: when Cloudflare does not answer a removal the row stays, nothing fails, and the sweep finishes it', { skip: d1Skip }, async () => {
  // A deleted branch.
  let w = world();
  const warned = [];
  const warn = console.warn;
  console.warn = (line) => { warned.push(String(line)); };
  try {
    await withFetch(w.handler, async () => {
      await switchOn(w.env);
      await push(w, SUGGEST);
      w.cf.failOn((method) => method === 'DELETE');
      const res = await notice(w, { branch: SUGGEST, deleted: true });
      assert.deepEqual([res.status, res.body], [200, { ok: true, previews: 0 }]);
      assert.deepEqual(previewsUp(w), [PV]);
      assert.equal(rows(w.env).length, 1);
      assert.ok(warned.some(l => { try { const o = JSON.parse(l); return o.evt === 'preview_remove_failed' && o.name === PV; } catch { return false; } }), 'the operator can read why');
      await sweep(w.env);   // Cloudflare is still not answering: the sweep goes on as ever
      assert.equal(rows(w.env).length, 1);
      w.cf.failOn(null);
      await sweep(w.env);
      assert.deepEqual(previewsUp(w), []);
      assert.equal(rows(w.env).length, 0);
      assert.equal(w.cf.scripts.size, 1, 'the site itself is still up');
    });

    // A removed site.
    w = world();
    await withFetch(w.handler, async () => {
      await switchOn(w.env);
      await push(w, SUGGEST);
      await push(w, 'kiln-drafts');
      w.cf.failOn((method, path) => method === 'DELETE' && path.includes('pv-'));
      assert.equal((await ask(w.env, 'POST', '/cloud/sites/remove', { id: 'site1' })).status, 200, 'the site is removed all the same');
      assert.equal(previewsUp(w).length, 2);
      assert.equal(rows(w.env).length, 2);
      w.cf.failOn(null);
      await sweep(w.env);
    });
    assert.equal(w.cf.scripts.size, 0);
    assert.equal(rows(w.env).length, 0);
  } finally { console.warn = warn; }
});

test('previews: one that nobody changed for thirty days comes down, five a sweep at most', { skip: d1Skip }, async () => {
  const w = world();
  await withFetch(w.handler, async () => {
    await switchOn(w.env);
    await push(w, SUGGEST);
    await push(w, 'kiln-drafts');
    w.env.kiln_cloud.exec("UPDATE previews SET updated_at = ? WHERE alias = 'kiln-drafts'", Date.now() - 29 * DAY);
    w.env.kiln_cloud.exec("UPDATE previews SET updated_at = ? WHERE alias = 'kiln-suggest-ana'", Date.now() - 31 * DAY);
    await sweep(w.env);
    assert.deepEqual(previewsUp(w), ['pv-site1-kiln-drafts']);
    assert.deepEqual(rows(w.env).map(r => r.alias), ['kiln-drafts']);
    assert.equal(w.cf.scripts.size, 2, 'the site itself is still up');

    // Seven old ones on record (of sites that are long gone, say): five go in one sweep, the rest in the next.
    for (let i = 0; i < 7; i++) {
      w.cf.addScript(`pv-gone${i}-kiln-drafts`);
      w.env.kiln_cloud.exec('INSERT INTO previews (site_id, alias, branch, name, commit_sha, deployed_at, updated_at) VALUES (?,?,?,?,?,?,?)', `gone${i}`, 'kiln-drafts', 'kiln-drafts', `pv-gone${i}-kiln-drafts`, 'abc', 1, 1 + i);
    }
    await sweep(w.env);
    assert.deepEqual(previewsUp(w), ['pv-gone5-kiln-drafts', 'pv-gone6-kiln-drafts', 'pv-site1-kiln-drafts']);
    await sweep(w.env);
    assert.deepEqual(previewsUp(w), ['pv-site1-kiln-drafts']);
    assert.equal(rows(w.env).length, 1);
  });
});

test('previews: on a database the migration has not reached there are none, and nothing fails', { skip: d1Skip }, async () => {
  const w = world(pages, { d1: { upTo: 9 } });
  assert.throws(() => rows(w.env), /no such table/);
  await withFetch(w.handler, async () => {
    assert.equal((await switchOn(w.env)).status, 200);
    const res = await push(w, SUGGEST);
    assert.deepEqual([res.status, res.body], [200, { ok: true, previews: 0 }]);
    assert.deepEqual((await notice(w, { branch: SUGGEST, deleted: true })).body, { ok: true, previews: 0 });
    assert.deepEqual(previewsUp(w), []);
    await sweep(w.env);
    // The site itself is published as before, and is removed as before.
    w.gh.commit({ 'index.html': '<!doctype html><h1>Changed</h1>' });
    assert.equal((await notice(w, { branch: 'main' })).body.published, 1);
    assert.equal((await ask(w.env, 'POST', '/cloud/sites/remove', { id: 'site1' })).status, 200);
  });
  assert.equal(w.cf.scripts.size, 0);
});

test('previews: the pattern for a site\'s settings file gives the address the editor\'s link rule makes', () => {
  const env = { HOSTING_ACCOUNT_ID: 'a', HOSTING_API_TOKEN: 't', HOSTING_SUBDOMAIN: 'kiln-sites' };
  const site = { id: '3f9a1c2e-77aa-4b1c-9d2e-000000000000', repo: 'ada/club' };
  const pattern = previewPattern(env, site);
  assert.equal(pattern, 'https://pv-3f9a1c2e-{branch}.kiln-sites.workers.dev');
  for (const [branch, name] of Object.entries({
    'kiln/suggest-Ana': 'pv-3f9a1c2e-kiln-suggest-ana',
    'kiln-drafts': 'pv-3f9a1c2e-kiln-drafts',
    'kiln/suggest-Jean-Luc.O\'Neil_the_Second': 'pv-3f9a1c2e-kiln-suggest-jean-luc-o-neil',
  })) {
    assert.equal(previewName(site, branch), name, branch);
    assert.equal(previewUrl(branch, pattern), `https://${name}.kiln-sites.workers.dev`, branch);
    assert.equal(previewUrl(branch, '{branch}'), previewAlias(branch), branch);
    assert.ok(name.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name), `${name} can be a Worker's name`);
  }
  // The longest name there can be: 3 + 8 + 1 + 28.
  assert.equal(previewName(site, `kiln/suggest-${'x'.repeat(80)}`).length, 40);
  assert.equal(previewName(site, '///'), null);
  assert.equal(previewAlias('--'), '');
  assert.deepEqual(['kiln-drafts', 'kiln/suggest-a', 'kiln/suggest-', 'main', 'kiln-drafts/x', 'Kiln-drafts', null].map(isPreviewBranch), [true, true, true, false, false, false, false]);
  // Hosting is off: there is no pattern.
  assert.equal(previewPattern({ HOSTING_ACCOUNT_ID: 'a', HOSTING_API_TOKEN: 't' }, site), null);
  assert.equal(previewPattern({}, site), null);
  assert.equal(previewPattern(env, null), null);
});
