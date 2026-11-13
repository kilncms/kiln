/**
 * Signing in with GitHub, a moment after GitHub has issued the token.
 *
 * GitHub can take a second or two before a new token is accepted everywhere.
 * The dashboard's sign-in asked "who is this?" once, at once, and three tries
 * in four ended on a line of JSON: {"error":"github sign-in failed"} (seen on
 * the live dashboard, 2026-11-11). A site owner's sign-in asked "may this
 * person change the repository?" the same way, and could be told their own
 * site was not theirs. Both now ask again a few times, and a dashboard sign-in
 * that still does not finish goes back to the dashboard, which says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { ghWithNewToken, userCanPush } from '../worker/cloud.js';
import { fakeKV, withFetch, jsonRes } from './worker-harness.js';
import { cloudEnv, d1Skip } from './d1-fake.js';

const DASH = 'https://app.example';
const GH = 'https://api.github.com';
const fast = { waits: [0, 1, 1, 1] };

function env() {
  const kv = fakeKV();
  kv.map.set('app:creds', JSON.stringify({ app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec' }));
  kv.map.set('cstate:s1', '1');
  return cloudEnv(kv, { CLOUD_DASHBOARD: DASH });
}
/** GitHub: the token exchange works; /user answers 401 `notYet` times, then the person. */
const github = (notYet) => { let asked = 0; return async (url) => {
  if (url === 'https://github.com/login/oauth/access_token') return jsonRes({ access_token: 'ghu_new' });
  if (url === `${GH}/user`) return asked++ < notYet ? jsonRes({ message: 'Bad credentials' }, 401) : jsonRes({ login: 'rosa', id: 7, email: null });
}; };
const callback = (e) => worker.fetch(new Request('https://worker.example/cloud/callback?code=c1&state=s1', { redirect: 'manual', headers: { Cookie: '__Host-kiln_signin=s1' } }), e);

test('dashboard sign-in: GitHub not ready for the new token at the first ask, and the sign-in still finishes', { skip: d1Skip }, async () => {
  const e = env();
  await withFetch(github(1), async (calls) => {
    const res = await callback(e);
    assert.equal(res.status, 302);
    assert.match(res.headers.get("Location"), /^https:\/\/app\.example\/?#kc_token=[0-9a-f-]{36}$/);
    assert.equal(calls.filter(c => c.url === `${GH}/user`).length, 2, 'asked again, once');
    assert.equal([...e.KILN.map.keys()].filter(k => k.startsWith('csess:')).length, 2, 'a dashboard session was made (beside the harness one)');
  });
});

test('dashboard sign-in: when GitHub never confirms, the person is sent back to the dashboard to try again, not left on JSON', { skip: d1Skip }, async () => {
  const e = env();
  await withFetch(github(99), async () => {
    const res = await callback(e);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), 'https://app.example/?signin=again');
  });
});

test('dashboard sign-in: a link used twice, or one that has expired, goes back to the dashboard too', { skip: d1Skip }, async () => {
  const e = env();
  await withFetch(github(0), async () => {
    assert.match((await callback(e)).headers.get('Location'), /#kc_token=/);
    const again = await callback(e);
    assert.equal(again.status, 302);
    assert.equal(again.headers.get('Location'), 'https://app.example/?signin=again');
  });
});

test('ghWithNewToken: asks again on 401 and on a server error, and takes any other answer as final', async () => {
  for (const [answers, expected, asks] of [[[401, 200], 200, 2], [[503, 401, 200], 200, 3], [[404], 404, 1], [[403], 403, 1], [[401, 401, 401, 401], 401, 4]]) {
    let i = 0;
    await withFetch(async () => jsonRes({}, answers[Math.min(i++, answers.length - 1)]), async (calls) => {
      const r = await ghWithNewToken(`${GH}/user`, 'ghu_new', fast);
      assert.equal(r.status, expected, answers.join(','));
      assert.equal(calls.length, asks, answers.join(','));
      assert.equal(calls[0].headers.Authorization, 'Bearer ghu_new');
    });
  }
});

test('an owner signing in to their own site is not turned away because the token was a second old', async () => {
  let asked = 0;
  await withFetch(async (url) => {
    if (url === `${GH}/repos/rosa/bakery`) return asked++ < 1 ? jsonRes({ message: 'Bad credentials' }, 401) : jsonRes({ permissions: { push: true } });
  }, async () => {
    assert.equal(await userCanPush('ghu_new', 'rosa/bakery', { fresh: true }), true);
  });
  // Any other time, one ask is the answer: a token that has ended is not waited for.
  asked = 0;
  await withFetch(async () => jsonRes({ message: 'Bad credentials' }, 401), async (calls) => {
    assert.equal(await userCanPush('ghu_old', 'rosa/bakery'), false);
    assert.equal(calls.length, 1);
  });
});
