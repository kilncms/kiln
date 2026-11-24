/**
 * One customer can never reach another customer's site through the dashboard's
 * service. Every route that takes a site is asked, by a person signed in to a
 * different account (with GitHub, with Google, and by email), about a site of
 * the first account: a site in a repository and a site whose files Kiln keeps.
 * For each answer: nothing of the other account is in it, nothing of the other
 * account changed, and no outside service (GitHub, Stripe, Cloudflare) was
 * asked about the other account's site. The operator's routes refuse them all.
 *
 * A route added later that takes a site belongs in SITE_ROUTES below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, addAccount, d1Skip } from './d1-fake.js';

// Every dashboard route that names a site: GET with ?site=, POST with {id}.
const SITE_ROUTES = [
  ['GET', '/cloud/sites/prepare'], ['POST', '/cloud/sites/prepare'],
  ['GET', '/cloud/sites/firstpass'], ['POST', '/cloud/sites/firstpass'],
  ['POST', '/cloud/sites/hosting/build'],
  ['GET', '/cloud/sites/hosting'], ['POST', '/cloud/sites/hosting'],
  ['GET', '/cloud/sites/domain'], ['POST', '/cloud/sites/domain'],
  ['GET', '/cloud/sites/domain/records'],
  ['GET', '/cloud/sites/mail'], ['POST', '/cloud/sites/mail'],
  ['GET', '/cloud/sites/files'],
  ['POST', '/cloud/sites/editor'],
  ['POST', '/cloud/sites/remove'],
  ['GET', '/cloud/sites/update'], ['POST', '/cloud/sites/update'],
  ['GET', '/cloud/portal'],
  ['GET', '/cloud/sites/check'],
  ['GET', '/cloud/checkout'],
  ['GET', '/cloud/sites/bring'], ['POST', '/cloud/sites/bring/again'],
  ['GET', '/cloud/sites/newdomain'], ['POST', '/cloud/sites/newdomain'],
];
// The operator's routes: refused to anyone who is not the operator, whatever they send.
const ADMIN_ROUTES = [
  ['GET', '/admin/cloud/overview'], ['GET', '/admin/cloud/runbook'], ['GET', '/admin/cloud/diagnose'],
  ['POST', '/admin/cloud/grant'], ['POST', '/admin/cloud/remove'], ['POST', '/admin/cloud/needs/hide'],
  ['GET', '/admin/cloud/registrations'],
];

// What belongs to the first account, and must never be in an answer to anyone else.
const THEIRS = ['ada/club', 'club.example', 'kiln-sites/ada-kept', 'ada-kept.example', 'sub_ada', 'cus_ada', 'ada@example.com'];

function world() {
  const kv = fakeKV();
  const env = cloudEnv(kv, { CLOUD_ADMIN: 'ada', HOSTING_ACCOUNT_ID: 'cf-acct', HOSTING_API_TOKEN: 'cf-token' });
  // The first account ('acct-1', signed in as 'ada' with 'tok'): a paid site in a repository, and a site Kiln keeps.
  addSite(env, { id: 'site-ada', repo: 'ada/club', origin: 'https://club.example', plan: 'managed', status: 'active', stripe_subscription_id: 'sub_ada', prepared_at: 5, firstpass_at: 6 });
  addSite(env, { id: 'kept-ada', repo: 'kiln-sites/ada-kept', origin: 'https://ada-kept.example', plan: 'managed', status: 'trialing', kept: 1 });
  try { env.kiln_cloud.exec("UPDATE sites SET stripe_customer_id = 'cus_ada' WHERE id = 'site-ada'"); } catch { /* an older column set */ }
  // Three other people, one for each way of signing in.
  addAccount(env, { id: 'acct-eve', github_login: 'eve', email: 'eve@example.com' });
  kv.map.set('csess:tok-eve', JSON.stringify({ account_id: 'acct-eve', login: 'eve', uid: 202, gh: 'gho_eve' }));
  addAccount(env, { id: 'acct-gus', google_sub: 'g-gus', google_email: 'gus@example.com', name: 'Gus' });
  kv.map.set('csess:tok-gus', JSON.stringify({ account_id: 'acct-gus', login: null, uid: null, gh: null, google: { sub: 'g-gus', email: 'gus@example.com', name: 'Gus' } }));
  addAccount(env, { id: 'acct-em', signin_email: 'em@example.com' });
  kv.map.set('csess:tok-em', JSON.stringify({ account_id: 'acct-em', login: null, uid: null, gh: null, byEmail: { email: 'em@example.com', name: null } }));
  return { env, kv };
}

/** What the first account has, as text, to compare before and after. */
function theirState(env, kv) {
  const rows = (sql) => JSON.stringify(env.kiln_cloud.db.prepare(sql).all());
  const keys = [...kv.map.entries()].filter(([k]) => !/^(csess|ratelimit|rl|wl):/.test(k)).sort();
  return [
    rows("SELECT * FROM sites WHERE account_id = 'acct-1' ORDER BY id"),
    rows("SELECT * FROM accounts WHERE id = 'acct-1'"),
    JSON.stringify(keys),
  ].join('\n');
}

async function ask(env, method, path, token, siteId) {
  const url = method === 'GET' ? `https://worker.example${path}?site=${encodeURIComponent(siteId)}` : `https://worker.example${path}`;
  const init = { method, headers: { Authorization: `Bearer ${token}`, Origin: 'https://app.example' } };
  if (method === 'POST') {
    init.headers['Content-Type'] = 'application/json';
    // Everything a route could want, so a refusal is about whose site it is and not about a missing field.
    init.body = JSON.stringify({ id: siteId, site: siteId, site_id: siteId, action: 'setup', name: 'club.example', status: 'active', force: true, key: 'no_site:acct-1:-', checked: true, inbox: 'x@example.com', address: 'https://club.example' });
  }
  const res = await worker.fetch(new Request(url, init), env);
  return { status: res.status, text: await res.text() };
}

test('another account reaches nothing of a site that is not its own, on every route that takes a site', { skip: d1Skip }, async () => {
  const { env, kv } = world();
  const before = theirState(env, kv);
  const seen = [];
  await withFetch(async () => undefined, async (calls) => {
    for (const token of ['tok-eve', 'tok-gus', 'tok-em']) {
      for (const siteId of ['site-ada', 'kept-ada']) {
        for (const [method, path] of SITE_ROUTES) {
          const r = await ask(env, method, path, token, siteId);
          seen.push(`${token} ${method} ${path} ${siteId} → ${r.status}`);
          // Remove answers a site that is not the account's as it answers one already removed: a bare ok, and
          // nothing done (checked below). The two are told apart for nobody, so a site's id cannot be probed for.
          const alreadyGone = path === '/cloud/sites/remove' && r.status === 200 && r.text === '{"ok":true}';
          assert.ok(r.status >= 400 || alreadyGone, `${token} ${method} ${path} for ${siteId} answered ${r.status}: ${r.text.slice(0, 200)}`);
          for (const t of THEIRS) assert.equal(r.text.includes(t), false, `${token} ${method} ${path} for ${siteId} answered with "${t}": ${r.text.slice(0, 200)}`);
        }
      }
    }
    const outside = calls.filter(c => THEIRS.some(t => String(c.url).includes(t) || JSON.stringify(c.body || '').includes(t)));
    assert.deepEqual(outside.map(c => `${c.method} ${c.url}`), [], 'no outside service was asked about the other account\'s sites');
  });
  assert.equal(theirState(env, kv), before, 'nothing of the first account changed');
  assert.ok(seen.length === 3 * 2 * SITE_ROUTES.length);
});

test('the same questions from the site\'s own account get past the check: the refusals above are about whose site it is', { skip: d1Skip }, async () => {
  const { env } = world();
  const through = [];
  await withFetch(async () => undefined, async () => {
    for (const [method, path] of SITE_ROUTES.filter(([m, p]) => m === 'GET' && p !== '/cloud/checkout')) {
      const r = await ask(env, method, path, 'tok', 'site-ada');
      // Refused for whose site it is, the answer would say so; anything else got past the check.
      if (!/not on this account|no such site|no_such_site/i.test(r.text)) through.push(path);
    }
  });
  for (const path of ['/cloud/sites/hosting', '/cloud/sites/domain', '/cloud/sites/mail', '/cloud/sites/check', '/cloud/sites/update', '/cloud/portal']) {
    assert.ok(through.includes(path), `${path} let its own account past (got past: ${through.join(', ')})`);
  }
});

test('the operator\'s routes refuse every other account, however it signed in', { skip: d1Skip }, async () => {
  const { env, kv } = world();
  const before = theirState(env, kv);
  await withFetch(async () => undefined, async () => {
    for (const token of ['tok-eve', 'tok-gus', 'tok-em', 'no-such-session']) {
      for (const [method, path] of ADMIN_ROUTES) {
        const r = await ask(env, method, path, token, 'site-ada');
        assert.ok(r.status === 403 || r.status === 404, `${token} ${method} ${path} answered ${r.status}: ${r.text.slice(0, 200)}`);
        for (const t of THEIRS) assert.equal(r.text.includes(t), false, `${token} ${method} ${path} answered with "${t}"`);
      }
    }
  });
  assert.equal(theirState(env, kv), before);
});

test('nobody signed in reaches any site route, and a made-up token is nobody', { skip: d1Skip }, async () => {
  const { env } = world();
  await withFetch(async () => undefined, async () => {
    for (const [method, path] of SITE_ROUTES) {
      for (const headers of [{}, { Authorization: 'Bearer not-a-session' }, { Authorization: 'Bearer ' }, { Authorization: 'tok' }]) {
        const url = method === 'GET' ? `https://worker.example${path}?site=site-ada` : `https://worker.example${path}`;
        const res = await worker.fetch(new Request(url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ id: 'site-ada' }) } : {}) }), env);
        const text = await res.text();
        assert.ok(res.status >= 400, `${method} ${path} with ${JSON.stringify(headers)} answered ${res.status}`);
        for (const t of THEIRS) assert.equal(text.includes(t), false, `${method} ${path} answered with "${t}"`);
      }
    }
  });
});
