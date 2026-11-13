/**
 * The page a person sees when the last step of a sign-in fails
 * (worker/signin-trouble.js). Seen for real on 2026-11-12: GitHub answered a
 * sign-in with 429 and the page showed "GitHub OAuth error" over its JSON.
 * These tests hold every such page to plain words, a way back, and nothing
 * that only a developer could read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { fakeKV, withFetch, jsonRes, ORIGIN, REPO } from './worker-harness.js';
import { githubTrouble, googleTrouble, troubleBody, troubleLog, backTo, STALE_SIGN_IN, HALF_A_SIGN_IN, UNCONFIRMED_GOOGLE } from '../worker/signin-trouble.js';

const GITHUB_429 = { code: '429', documentation_url: 'https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting', message: 'Access to this site has been restricted. Please wait a few minutes before you try again.' };
const plain = (t, label) => {
  assert.equal(/[{}]|documentation_url|OAuth|JSON|<pre|undefined|null\b/.test(t), false, `${label}: nothing a developer wrote: ${t}`);
  assert.equal(/—/.test(t), false, `${label}: no em dash`);
};

test('sign-in trouble: GitHub asking everyone to wait is said in plain words, and nobody is told their account is at fault', () => {
  for (const given of [{ status: 429, tok: GITHUB_429 }, { status: 200, tok: GITHUB_429 }, { status: 403, tok: { message: 'You have exceeded a secondary rate limit.' } }]) {
    const t = githubTrouble(given);
    assert.equal(t.code, 'wait');
    assert.equal(t.status, 503);
    assert.equal(t.heading, 'GitHub is asking everyone to wait a few minutes');
    assert.match(t.words, /Nothing is wrong with your account or with the site\. Go back to the site and sign in again in a few minutes\.$/);
    plain(t.heading + t.words, 'wait');
  }
});

test('sign-in trouble: each way GitHub can refuse gets its own words, and what GitHub said is quoted only as a short clean line', () => {
  assert.equal(githubTrouble({ status: 200, tok: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } }).code, 'used');
  assert.match(githubTrouble({ status: 200, tok: { error: 'bad_verification_code' } }).words, /works once and for a few minutes/);
  const setUp = githubTrouble({ status: 200, tok: { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' } });
  assert.equal(setUp.code, 'set_up');
  assert.match(setUp.words, /That is for whoever runs the service to put right, and nothing is wrong with your account\. GitHub said: The client_id and\/or client_secret passed are incorrect\.\.$/);
  assert.equal(githubTrouble({ status: 502, tok: null }).code, 'no_answer');
  assert.equal(githubTrouble({ status: 200, tok: null }).code, 'no_answer', 'an answer that was not JSON');
  const other = githubTrouble({ status: 200, tok: { error: 'access_denied', error_description: 'The user <b>denied</b> {this} request. See https://docs.github.com/x' } });
  assert.equal(other.code, 'refused');
  assert.equal(other.words, 'GitHub did not sign you in this time. GitHub said: The user bdenied/b this request. See. Go back to the site and sign in again.');
  for (const t of [setUp, other, githubTrouble({ status: 500 }), githubTrouble({})]) plain(t.heading + t.words, t.code);
});

test('sign-in trouble: Google\'s last step, the same way', () => {
  assert.equal(googleTrouble({ status: 400, tok: { error: 'invalid_grant', error_description: 'Bad Request' } }).code, 'used');
  assert.equal(googleTrouble({ status: 401, tok: { error: 'invalid_client' } }).code, 'set_up');
  assert.equal(googleTrouble({ status: 429, tok: { error: 'rate_limit_exceeded' } }).code, 'wait');
  assert.equal(googleTrouble({ status: 503, tok: null }).code, 'no_answer');
  assert.equal(googleTrouble({ status: 400, tok: { error: 'something_new' } }).words, 'Google did not sign you in this time. Google said: something_new. Go back to the site and sign in again.');
  for (const t of [googleTrouble({ status: 400, tok: { error: 'invalid_grant' } }), googleTrouble({}), UNCONFIRMED_GOOGLE, STALE_SIGN_IN, HALF_A_SIGN_IN]) plain(t.heading + t.words, t.code);
});

test('sign-in trouble: the way back is the sign-in page of the site the person came from, and only a real web address', () => {
  assert.equal(backTo('https://club.example'), 'https://club.example/kiln');
  assert.equal(backTo('https://club.example/some/page?x=1'), 'https://club.example/kiln');
  assert.equal(backTo('http://localhost:8788'), 'http://localhost:8788/kiln');
  for (const bad of ['http://club.example', 'javascript:alert(1)', 'not an address', '', null, undefined]) assert.equal(backTo(bad), null, String(bad));
  assert.equal(troubleBody(STALE_SIGN_IN, { origin: 'https://club.example' }),
    '<h1>That sign-in is no longer good</h1><p>A sign-in works once and for ten minutes. This one was used already or the time ran out. Go back to the site and sign in again.</p><p><a href="https://club.example/kiln">Back to the sign-in page</a></p>');
  assert.equal(troubleBody(HALF_A_SIGN_IN).includes('<a '), false, 'no link when the site is not known');
  assert.equal(troubleBody({ heading: '<img src=x>', words: '"quoted" & <b>' }).includes('<img'), false, 'whatever it is given is written as text');
});

test('sign-in trouble: the log line keeps what the company said for whoever runs the service, and never a token', () => {
  const line = JSON.parse(troubleLog('github', githubTrouble({ status: 429, tok: GITHUB_429 }), { status: 429, tok: { ...GITHUB_429, access_token: 'ghu_secret', error: 'x' } }));
  assert.deepEqual(Object.keys(line).sort(), ['code', 'detail', 'error', 'evt', 'status', 'who']);
  assert.equal(line.evt, 'signin_trouble');
  assert.equal(line.status, 429);
  assert.equal(JSON.stringify(line).includes('ghu_secret'), false);
});

// ─── Through the service itself ──────────────────────────────────────────────

const env = (seed = {}) => ({
  ALLOWED_ORIGINS: ORIGIN, GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec',
  KILN: fakeKV({ 'app:creds': { app_id: 1, slug: 'kiln-cms', client_id: 'cid', client_secret: 'sec' }, [`rsee:${REPO}`]: { id: 42, name: REPO }, ...seed }),
});
const page = async (res) => { const t = await res.text(); return { status: res.status, type: res.headers.get('Content-Type'), text: t, body: t.slice(t.indexOf('<body')) }; };

test('sign-in trouble, GitHub callback: a 429 from GitHub gives a plain page with the way back, uses up the sign-in, and makes no session', async () => {
  const e = env({ 'state:n1': { origin: ORIGIN, returnTo: '/', keep: 'server', repo: REPO } });
  const out = await withFetch(async (url) => (url === 'https://github.com/login/oauth/access_token' ? jsonRes(GITHUB_429, 429) : undefined), async () =>
    page(await worker.fetch(new Request('https://worker.example/auth/callback?code=c&state=n1'), e)));
  assert.equal(out.status, 503);
  assert.match(out.type, /text\/html/);
  assert.match(out.text, /<title>GitHub is asking everyone to wait a few minutes · Kiln<\/title>/);
  assert.match(out.body, /<h1>GitHub is asking everyone to wait a few minutes<\/h1><p>GitHub is not letting sign-ins through to this site just now/);
  assert.ok(out.body.includes(`<a href="${ORIGIN}/kiln">Back to the sign-in page</a>`));
  plain(out.body.replace(/<style[\s\S]*?<\/style>/g, ''), 'the page');
  assert.equal(e.KILN.map.has('state:n1'), false, 'the sign-in is used up');
  assert.equal([...e.KILN.map.keys()].some(k => k.startsWith('osess:')), false);
});

test('sign-in trouble, GitHub callback: an answer that is not JSON, a used code, a stale sign-in and half a sign-in each get their page', async () => {
  let e = env({ 'state:n1': { origin: ORIGIN, returnTo: '/' } });
  let out = await withFetch(async () => new Response('<html>Bad gateway</html>', { status: 502 }), async () => page(await worker.fetch(new Request('https://worker.example/auth/callback?code=c&state=n1'), e)));
  assert.equal(out.status, 502);
  assert.match(out.body, /<h1>GitHub did not answer just now<\/h1>/);

  e = env({ 'state:n1': { origin: ORIGIN, returnTo: '/' } });
  out = await withFetch(async () => jsonRes({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }), async () => page(await worker.fetch(new Request('https://worker.example/auth/callback?code=c&state=n1'), e)));
  assert.equal(out.status, 400);
  assert.match(out.body, /<h1>That sign-in was already used, or it took too long<\/h1>/);

  out = await page(await worker.fetch(new Request('https://worker.example/auth/callback?code=c&state=gone'), env()));
  assert.equal(out.status, 400);
  assert.match(out.body, /<h1>That sign-in is no longer good<\/h1><p>A sign-in works once and for ten minutes\./);
  out = await page(await worker.fetch(new Request('https://worker.example/auth/callback'), env()));
  assert.match(out.body, /<h1>This is not a whole sign-in<\/h1>/);
  out = await page(await worker.fetch(new Request('https://worker.example/google/callback?state=x'), env()));
  assert.match(out.body, /<h1>This is not a whole sign-in<\/h1>/);
  out = await page(await worker.fetch(new Request('https://worker.example/google/callback?code=c&state=gone'), env()));
  assert.match(out.body, /<h1>That sign-in is no longer good<\/h1>/);
});

test('sign-in trouble, Google callback: a refusal and an unconfirmed address each get a plain page with the way back', async () => {
  const seed = () => ({ 'gstate:n1': { origin: ORIGIN, returnTo: '/', repo: REPO } });
  let out = await withFetch(async (url) => (url === 'https://oauth2.googleapis.com/token' ? jsonRes({ error: 'invalid_grant', error_description: 'Bad Request' }, 400) : undefined), async () =>
    page(await worker.fetch(new Request('https://worker.example/google/callback?code=c&state=n1'), env(seed()))));
  assert.equal(out.status, 400);
  assert.match(out.body, /<h1>That sign-in was already used, or it took too long<\/h1><p>Google’s sign-in step works once/);
  assert.ok(out.body.includes(`<a href="${ORIGIN}/kiln">Back to the sign-in page</a>`));
  plain(out.body.replace(/<style[\s\S]*?<\/style>/g, ''), 'the page');

  out = await withFetch(async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') return jsonRes({ id_token: 'idt' });
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return jsonRes({ aud: 'gid', email: 'a@example.com', email_verified: 'false' });
  }, async () => page(await worker.fetch(new Request('https://worker.example/google/callback?code=c&state=n1'), env(seed()))));
  assert.equal(out.status, 403);
  assert.match(out.body, /<h1>Google could not confirm your account<\/h1>/);
  assert.ok(out.body.includes(`<a href="${ORIGIN}/kiln">Back to the sign-in page</a>`));
});
