/**
 * A sign-in is handed only to an address that belongs to the site it is for
 * (security review, 2026-10-22). Anyone can register an address for a Kiln
 * Cloud trial, which puts it on the trusted list; before this, a link through
 * auth.kilncms.com could carry a site owner's GitHub access, or an invited
 * editor's session for another site, to that stranger's address.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

const CREDS = { app_id: 1, slug: 'kiln', client_id: 'Iv1.x', client_secret: 's', pk8: 'k' };
const get = (env, path) => worker.fetch(new Request(`https://auth.example${path}`, { redirect: 'manual' }), env);
const github = (canPush) => async (url) => {
  if (url.startsWith('https://github.com/login/oauth/access_token')) return new Response(JSON.stringify({ access_token: 'ghu_owner', refresh_token: 'ghr_owner', expires_in: 28800 }), { headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('https://api.github.com/repos/ada/club')) {
    return canPush
      ? new Response(JSON.stringify({ full_name: 'ada/club', permissions: { push: true } }), { headers: { 'Content-Type': 'application/json' } })
      : new Response('{"message":"Not Found"}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
};
/** A trial site at an address someone registered for their own repository. */
const trialEnv = () => {
  const env = cloudEnv(fakeKV({ 'app:creds': CREDS }), { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec' });
  addSite(env, { repo: 'ada/club', origin: 'https://club.example', status: 'trialing' });
  return env;
};

test('Google sign-in: a link that sends one site’s editor session to another site’s address is refused', { skip: d1Skip }, async () => {
  const env = trialEnv();
  const res = await get(env, '/google/login?origin=https%3A%2F%2Fclub.example&repo=victim%2Fsite&return_to=%2F');
  assert.equal(res.status, 403);
  assert.match(await res.text(), /different site/);
  const ok = await get(env, '/google/login?origin=https%3A%2F%2Fclub.example&repo=ada%2Fclub&return_to=%2F');
  assert.equal(ok.status, 302, 'the site’s own sign-in still goes to Google');
  assert.match(ok.headers.get('Location'), /^https:\/\/accounts\.google\.com\//);
  const nameCase = await get(env, '/google/login?origin=https%3A%2F%2Fclub.example&repo=ADA%2FClub&return_to=%2F');
  assert.equal(nameCase.status, 302, 'GitHub names ignore case');
});

test('Google sign-in: an operator-listed address with no repository of its own keeps working for any site', async () => {
  const env = { KILN: fakeKV(), ALLOWED_ORIGINS: 'https://demo.example', GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec' };
  const res = await get(env, '/google/login?origin=https%3A%2F%2Fdemo.example&repo=any%2Fsite&return_to=%2F');
  assert.equal(res.status, 302);
});

test('GitHub sign-in: the owner’s access is not handed to an address whose repository they cannot change', { skip: d1Skip }, async () => {
  const env = trialEnv();
  await env.KILN.put('state:n1', JSON.stringify({ origin: 'https://club.example', returnTo: '/' }));
  await withFetch(github(false), async () => {
    const res = await get(env, '/auth/callback?code=c&state=n1');
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Location'), null, 'no redirect at all');
    assert.doesNotMatch(await res.text(), /ghu_owner/, 'the token is not on the page');
  });
  assert.equal([...env.KILN.map.keys()].filter(k => k.startsWith('sid:')).length, 0, 'a refused sign-in stores no refresh id');
  await env.KILN.put('state:n2', JSON.stringify({ origin: 'https://club.example', returnTo: '/' }));
  await withFetch(github(true), async () => {
    const res = await get(env, '/auth/callback?code=c&state=n2');
    assert.equal(res.status, 302, 'the site’s owner signs in as before');
    assert.match(res.headers.get('Location'), /^https:\/\/club\.example\/#kiln-token=ghu_owner/);
  });
});

test('GitHub sign-in: an operator-listed address keeps working without a repository check', async () => {
  const env = { KILN: fakeKV({ 'app:creds': CREDS, 'state:n3': { origin: 'https://demo.example', returnTo: '/' } }), ALLOWED_ORIGINS: 'https://demo.example' };
  await withFetch(github(false), async () => {
    const res = await get(env, '/auth/callback?code=c&state=n3');
    assert.equal(res.status, 302);
    assert.match(res.headers.get('Location'), /^https:\/\/demo\.example\/#kiln-token=/);
  });
});
