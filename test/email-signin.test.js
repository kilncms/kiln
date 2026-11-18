/**
 * Sign-in by email at a site (worker/index.js, "Email sign-in"): a person on
 * the site's list asks for a link at /email/login, Kiln sends a link and a
 * 6-digit code, and the link's Sign in button or the code typed in the
 * asking window signs them in. These drive the real handlers with KV, the
 * mail binding and GitHub played in memory, and check that:
 *
 *   - a link and a code work once, for 15 minutes, and only for their site
 *   - opening the link (a GET) does not use it up: mail scanners open links
 *   - an address not on the list gets the same page, and nothing is sent
 *   - five wrong codes and the code is void, and the link with it
 *   - links asked for one address are limited, whatever its case and spaces
 *   - the session is the one "Continue with Google" gives the same person
 *   - a worker with no mail set up says so, and sends nothing
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { signInLinkMail } from '../worker/mail.js';
import { fakeKV, withFetch, jsonRes, ORIGIN } from './worker-harness.js';

const GH = 'https://api.github.com';
const REPO = 'acme/club';
const ID = 4242;
const OTHER = 'https://other.example';
const ADA = { email: 'ada@example.com', name: 'Ada', role: 'editor', days: 30, paths: ['blog/'], keys: ['news'], features: ['comments'], mode: 'suggest' };
const MAY = { email: 'may@example.com', name: 'May', role: 'member', days: 90 };
const GOOGLE = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' };

const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const PK8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');

/** GitHub, as far as a sign-in asks it: the repository answers as itself. */
async function github(url, init) {
  const u = new URL(url);
  if (u.origin !== GH) return undefined;
  if (/\/installation$/.test(u.pathname)) return jsonRes({ id: 77 });
  if (u.pathname === '/app/installations/77/access_tokens' && init.method === 'POST') return jsonRes({ token: 'ghs_installation' }, 201);
  if (u.pathname.toLowerCase() === `/repos/${REPO}`) return jsonRes({ id: ID, full_name: REPO, default_branch: 'main', permissions: { push: true } });
  return undefined;
}

/** A worker that can send mail (or not), with Ada and May on the list. `sent` collects every message. */
function world({ mail = true } = {}) {
  const kv = fakeKV({
    'app:creds': { app_id: 1, slug: 'kiln-test', client_id: 'c', client_secret: 's', pk8: PK8 },
    [`rid:${ID}`]: { id: ID, name: REPO, at: 1 }, [`rname:${REPO}`]: { id: ID, at: 1 },
    [`people:${REPO}`]: [ADA, MAY],
  });
  const sent = [];
  const env = { ALLOWED_ORIGINS: `${ORIGIN},${OTHER}`, KILN: kv, ...GOOGLE };
  if (mail) Object.assign(env, { CUSTOMER_MAIL_FROM: 'hello@kilncms.com', NOTIFY: { send: async (m) => { sent.push(m); return { messageId: `m${sent.length}` }; } } });
  const json = (k) => (kv.map.has(k) ? JSON.parse(kv.map.get(k)) : null);
  const keys = (prefix) => [...kv.map.keys()].filter(k => k.startsWith(prefix));
  return { env, kv, sent, json, keys };
}

const PLACE = { origin: ORIGIN, return_to: '/', repo: REPO };
async function hit(w, method, path, form) {
  const init = { method };
  if (form) init.body = new URLSearchParams(form);
  return withFetch(github, async () => {
    const res = await worker.fetch(new Request(`https://worker.example${path}`, init), w.env);
    return { status: res.status, res, text: res.headers.get('Location') ? '' : await res.text(), to: res.headers.get('Location') || '' };
  });
}
/** Ask for a link for `email` from the page at ORIGIN. Answers the page, the window's id, and what was sent. */
async function ask(w, email, place = PLACE) {
  const before = w.sent.length;
  const r = await hit(w, 'POST', '/email/login', { ...place, email });
  const req = (r.text.match(/name="req" value="([a-f0-9]{64})"/) || [])[1] || null;
  const mail = w.sent.length > before ? w.sent[w.sent.length - 1] : null;
  const token = mail ? (mail.text.match(/https:\/\/worker\.example\/email\/open\?t=([a-f0-9]{64})/) || [])[1] : null;
  const code = mail ? (mail.text.match(/asked for the link: (\d{6})/) || [])[1] : null;
  return { ...r, req, mail, token, code };
}
const openLink = (w, token) => hit(w, 'GET', `/email/open?t=${token}`);
const pressSignIn = (w, token) => hit(w, 'POST', '/email/open', { t: token });
const typeCode = (w, req, code, place = PLACE) => hit(w, 'POST', '/email/code', { ...place, req, code });
const fragment = (to) => new URLSearchParams(to ? new URL(to).hash.slice(1) : '');

/** The same person signing in with Google instead, at the same site. */
async function googleSignIn(w, email, name = 'Someone') {
  w.kv.map.set('gstate:n1', JSON.stringify({ origin: ORIGIN, returnTo: '/', repo: REPO }));
  return withFetch(async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return jsonRes({ id_token: 'idt' });
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) return jsonRes({ aud: 'gid', email_verified: 'true', email, name, sub: 'g-1' });
    return github(url, init);
  }, async () => {
    const res = await worker.fetch(new Request('https://worker.example/google/callback?code=c&state=n1'), w.env);
    return { status: res.status, to: res.headers.get('Location') || '' };
  });
}

test('an invited editor gets a link and a code by email, and the link signs them in once', async () => {
  const w = world();
  const a = await ask(w, '  Ada@Example.com ');
  assert.equal(a.status, 200);
  assert.match(a.text, /Check your email/);
  assert.match(a.text, /If Ada@Example\.com can sign in to site\.example, a link is on its way to it\. The link works once, for 15 minutes\./);
  assert.equal(w.sent.length, 1);
  assert.equal(a.mail.to, 'ada@example.com', 'sent to the address as matched: trimmed and lower-cased');
  assert.equal(a.mail.subject, 'Your sign-in link for site.example');
  assert.ok(a.token && a.code, 'the email carries a link and a code');
  // Nothing secret is stored: no token, no code, no window id.
  const stored = [...w.kv.map.entries()].map(([k, v]) => k + v).join('\n');
  for (const secret of [a.token, a.req]) assert.ok(!stored.includes(secret), 'only hashes are kept');
  assert.ok(!stored.includes(`"${a.code}"`));
  assert.ok(w.keys('elink:').every(k => w.kv.expires.get(k) - Date.now() / 1000 <= 900), 'kept for 15 minutes at most');

  const r = await pressSignIn(w, a.token);
  assert.equal(r.status, 302);
  assert.ok(r.to.startsWith(`${ORIGIN}/#`));
  assert.ok(fragment(r.to).get('kiln-esession'));
  const again = await pressSignIn(w, a.token);
  assert.equal(again.status, 410, 'a link works once');
  assert.match(again.text, /This sign-in link no longer works/);
  assert.equal((await typeCode(w, a.req, a.code)).status, 410, 'and the code in the same email goes with it');
});

test('opening the link only shows a Sign in button: the GET does not use the link up', async () => {
  const w = world();
  const a = await ask(w, 'ada@example.com');
  for (let i = 0; i < 3; i++) {
    const page = await openLink(w, a.token);
    assert.equal(page.status, 200);
    assert.match(page.text, /<form method="post" action="\/email\/open">/);
    assert.match(page.text, /This link signs in ada@example\.com\. Press Sign in to go on\./);
    assert.equal(page.res.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(w.keys('esess:').length, 0, 'nobody is signed in by opening the link');
  assert.equal((await pressSignIn(w, a.token)).status, 302);
  assert.equal((await openLink(w, a.token)).status, 410, 'once used, the link says so');
});

test('an address that is not on the list gets the very same page, and nothing is sent', async () => {
  const w = world();
  const listed = await ask(w, 'ada@example.com');
  const stranger = await ask(w, 'ada@example.org');
  assert.equal(w.sent.length, 1, 'only the address on the list is written to');
  assert.equal(stranger.status, listed.status);
  const same = (r, typed) => r.text.replace(r.req, 'REQ').replace(typed, 'ADDRESS');
  assert.equal(same(stranger, 'ada@example.org'), same(listed, 'ada@example.com'));
  assert.equal(w.keys('elink:').length, 1, 'no link exists for the stranger');
  // A code typed in the stranger's window is answered as a wrong one is in a real one.
  const wrongThere = await typeCode(w, stranger.req, '123456');
  const wrongHere = await typeCode(w, listed.req, listed.code === '123456' ? '654321' : '123456');
  assert.equal(wrongThere.status, wrongHere.status);
  assert.equal(wrongThere.text.replace(stranger.req, 'REQ'), wrongHere.text.replace(listed.req, 'REQ'));
  assert.ok(![...w.kv.map.values()].some(v => v.includes('ada@example.org')), 'the stranger\'s address is not kept');
});

test('a link and a code run out after 15 minutes', async () => {
  const w = world();
  const a = await ask(w, 'ada@example.com');
  for (const k of [...w.keys('elink:'), ...w.keys('ecode:')]) {
    assert.ok(w.kv.expires.get(k) <= Math.floor(Date.now() / 1000) + 900);
    w.kv.map.set(k, JSON.stringify({ ...w.json(k), exp: Date.now() - 1 }));   // as if 15 minutes had passed
  }
  assert.equal((await openLink(w, a.token)).status, 410);
  assert.equal((await typeCode(w, a.req, a.code)).status, 410);
  assert.equal((await pressSignIn(w, a.token)).status, 410);
  assert.equal(w.keys('esess:').length, 0);
});

test('a code is for the site and the page it was asked at: typed for another, it does nothing', async () => {
  const w = world();
  const a = await ask(w, 'ada@example.com');
  const there = await typeCode(w, a.req, a.code, { ...PLACE, origin: OTHER });
  assert.equal(there.status, 410);
  assert.equal((await typeCode(w, a.req, a.code, { ...PLACE, return_to: '/elsewhere' })).status, 410);
  assert.equal(w.keys('esess:').length, 0);
  // A site that is not allowed is refused before anything is sent.
  const refused = await hit(w, 'POST', '/email/login', { ...PLACE, origin: 'https://evil.example', email: 'ada@example.com' });
  assert.notEqual(refused.status, 200);
  assert.equal(w.sent.length, 1);
  // The right site still signs in, and the session goes back to where it was asked.
  const r = await typeCode(w, a.req, a.code);
  assert.equal(r.status, 302);
  assert.ok(r.to.startsWith(`${ORIGIN}/#`));
});

test('five wrong codes and the code is void, and the link in the same email with it', async () => {
  const w = world();
  const a = await ask(w, 'ada@example.com');
  const wrong = a.code === '000000' ? '111111' : '000000';
  for (let left = 4; left >= 1; left--) {
    const r = await typeCode(w, a.req, wrong);
    assert.equal(r.status, 400);
    assert.match(r.text, new RegExp(`That code is not right\\. You can try ${left} more ${left === 1 ? 'time' : 'times'}\\.`));
  }
  const fifth = await typeCode(w, a.req, wrong);
  assert.equal(fifth.status, 403);
  assert.match(fifth.text, /typed wrong 5 times, so it no longer works, and neither does the link in the same email/);
  assert.equal((await typeCode(w, a.req, a.code)).status, 410, 'the right code no longer works either');
  assert.equal((await pressSignIn(w, a.token)).status, 410);
  assert.equal(w.keys('esess:').length, 0);
});

test('the right code, typed in the window that asked, signs in once', async () => {
  const w = world();
  const a = await ask(w, 'ada@example.com');
  const r = await typeCode(w, a.req, ` ${a.code.slice(0, 3)} ${a.code.slice(3)} `);
  assert.equal(r.status, 302);
  assert.ok(fragment(r.to).get('kiln-esession'));
  assert.equal((await typeCode(w, a.req, a.code)).status, 410);
  assert.equal((await pressSignIn(w, a.token)).status, 410, 'the link in the same email is used up too');
});

test('an editor and a member get exactly the session "Continue with Google" gives them', async () => {
  for (const person of [ADA, MAY]) {
    const g = world();
    const google = await googleSignIn(g, person.email, person.name);
    const e = world();
    const a = await ask(e, person.email);
    const mailed = await pressSignIn(e, a.token);
    assert.equal(mailed.status, google.status);
    const gf = fragment(google.to), ef = fragment(mailed.to);
    assert.equal(new URL(mailed.to).pathname, new URL(google.to).pathname);
    if (person.role === 'editor') {
      assert.deepEqual([...ef.keys()].sort(), [...gf.keys()].sort());
      assert.equal(ef.get('kiln-name'), gf.get('kiln-name'));
      assert.equal(ef.get('kiln-repo'), gf.get('kiln-repo'));
      assert.ok(Math.abs(Number(ef.get('kiln-exp')) - Number(gf.get('kiln-exp'))) < 60000);
      const strip = ({ created, exp, ...rest }) => rest;
      const gs = g.json(`esess:${gf.get('kiln-esession')}`), es = e.json(`esess:${ef.get('kiln-esession')}`);
      assert.deepEqual(strip(es), strip(gs));
      assert.deepEqual({ paths: es.paths, keys: es.keys, features: es.features, mode: es.mode, role: es.role }, { paths: ['blog/'], keys: ['news'], features: ['comments'], mode: 'suggest', role: 'editor' });
      assert.ok(Math.abs(es.exp - gs.exp) < 60000);
      assert.equal(e.kv.expires.get(`esess:${ef.get('kiln-esession')}`), g.kv.expires.get(`esess:${gf.get('kiln-esession')}`));
    } else {
      // A member is handed a one-time code the site exchanges (googleClaim), the same one.
      const gc = new URL(google.to).hash.match(/kiln-gcode=([a-f0-9]{32})/)[1];
      const ec = new URL(mailed.to).hash.match(/kiln-gcode=([a-f0-9]{32})/)[1];
      assert.equal(new URL(mailed.to).search, new URL(google.to).search);
      assert.deepEqual(e.json(`gcode:${ec}`), g.json(`gcode:${gc}`));
      const claim = await worker.fetch(new Request('https://worker.example/google/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: ec, origin: ORIGIN }) }), e.env);
      assert.deepEqual(await claim.json(), { ok: true, name: 'May', days: 90 });
    }
  }
});

test('links asked for one address are limited to three in 15 minutes, whatever its case and spaces, on the list or not', async () => {
  for (const address of ['ada@example.com', 'nobody@example.com']) {
    const w = world();
    for (const typed of [address, address.toUpperCase(), ` ${address} `]) assert.equal((await ask(w, typed)).status, 200);
    const fourth = await ask(w, address);
    assert.equal(fourth.status, 429);
    assert.match(fourth.text, /Sign-in links for this address were asked for 3 times in the last 15 minutes, so no more are sent for now\./);
    assert.equal(w.sent.length, address === 'ada@example.com' ? 3 : 0);
    assert.ok(![...w.kv.map.keys()].some(k => k.includes(address)), 'the count is kept under a hash of the address');
    // Another address is not held up by it.
    assert.equal((await ask(w, 'may@example.com')).status, 200);
  }
});

test('a worker that cannot send email says so plainly, and sends nothing', async () => {
  const w = world({ mail: false });
  const page = await hit(w, 'GET', `/email/login?${new URLSearchParams(PLACE)}`);
  assert.equal(page.status, 503);
  assert.match(page.text, /Email sign-in is not set up on this service/);
  const post = await hit(w, 'POST', '/email/login', { ...PLACE, email: 'ada@example.com' });
  assert.equal(post.status, 503);
  assert.equal(w.keys('elink:').length + w.keys('ecode:').length, 0);
  // With mail set up, the page asks for the address.
  const on = await hit(world(), 'GET', `/email/login?${new URLSearchParams(PLACE)}`);
  assert.equal(on.status, 200);
  assert.match(on.text, /Get a sign-in link by email/);
});

test('the email says what to do in plain words', () => {
  const m = signInLinkMail({ site: 'site.example', link: 'https://worker.example/email/open?t=abc', code: '042317' });
  assert.equal(m.subject, 'Your sign-in link for site.example');
  assert.match(m.text, /To sign in to site\.example, open this link and press Sign in:\n\nhttps:\/\/worker\.example\/email\/open\?t=abc/);
  assert.match(m.text, /Or type this code in the window where you asked for the link: 042317/);
  assert.match(m.text, /The link and the code work once, for 15 minutes\./);
  assert.ok(!/[—]|magic|OTP/i.test(m.text + m.html));
  assert.match(m.html, /<a href="https:\/\/worker\.example\/email\/open\?t=abc"/);
});

test('the site\'s sign-in card and the members sign-in page offer the email link under Continue with Google', async () => {
  const { readFileSync } = await import('node:fs');
  const built = readFileSync(new URL('../dist/kiln.js', import.meta.url), 'utf8');
  assert.ok(built.indexOf('Get a sign-in link by email') > built.indexOf('Continue with Google'));
  assert.match(built, /\/email\/login\?/);
  const members = readFileSync(new URL('../templates/members-login.html', import.meta.url), 'utf8');
  assert.ok(members.indexOf('Get a sign-in link by email') > members.indexOf('Continue with Google'));
  assert.match(members, /go\('email'\)/);
});
