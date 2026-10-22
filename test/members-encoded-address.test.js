/**
 * Members pages cannot be reached through an encoded address (security review,
 * 2026-10-22, confirmed live on kiln-demo.pages.dev: /%6Dembers/ served the
 * members page signed out). Pages decides whether a function runs from the
 * address as written and decodes it only when it finds the file, so the gate
 * never ran. _routes.json now sends every address with a %-code to the root
 * middleware, which sends one that decodes into /members to its plain form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../templates/functions/_middleware.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const passed = new Response('next');
const ask = (pathname) => onRequest({ request: new Request('https://club.example' + pathname), next: async () => passed });

test('an encoded address into the members area is sent to its plain form, where the gate runs', async () => {
  for (const [asked, plain] of [
    ['/%6Dembers/', '/members/'],
    ['/%6dembers/files/budget.pdf', '/members/files/budget.pdf'],
    ['/members%2Findex.html', '/members/index.html'],
    ['/m%65mbers/minutes/', '/members/minutes/'],
    ['/%4Dembers/', '/members/'],
    ['/%6Dembers', '/members'],
  ]) {
    const res = await ask(asked);
    assert.equal(res.status, 308, asked);
    assert.equal(new URL(res.headers.get('Location')).pathname, plain, asked);
  }
});

test('every other address, and a plain members address, goes on unchanged', async () => {
  for (const p of ['/members/', '/members/a%20b.pdf', '/about%20us/', '/news/%E2%9C%93/', '/memberships/']) {
    assert.equal(await ask(p), passed, p);
  }
});

test('a broken %-code is refused, not passed on', async () => {
  const res = await ask('/%E0%A4%A');
  assert.equal(res.status, 400);
});

test('_routes.json sends members addresses, the sign-in hand-off and every %-address to functions, and nothing else', () => {
  const routes = JSON.parse(readFileSync(path.join(ROOT, 'templates', '_routes.json'), 'utf8'));
  assert.deepEqual(routes.include, ['/members/*', '/api/member-redeem-google', '/*%*']);
  // The same translation Cloudflare's own Pages tooling makes of a rule.
  const rx = (rule) => new RegExp(`^${(rule.endsWith('/*') ? `${rule.slice(0, -2)}(/*)?` : rule).replaceAll('.', '\\.').replaceAll('*', '.*')}$`);
  const routed = (p) => routes.include.some(r => rx(r).test(p));
  for (const p of ['/%6Dembers/', '/members%2Findex.html', '/members/', '/members', '/api/member-redeem-google']) assert.ok(routed(p), p);
  for (const p of ['/', '/about/', '/assets/site.css', '/members-login.html']) assert.ok(!routed(p), `${p} stays a plain file, no function`);
});

test('the setup tool installs the routing file wherever it installs the members gate', () => {
  const cli = readFileSync(path.join(ROOT, 'cli', 'index.mjs'), 'utf8');
  assert.equal((cli.match(/installRoutes\(\)/g) || []).length, 3, 'defined once, called by setup and by update');
  assert.match(cli, /path\.join\('functions', '_middleware\.js'\)/);
});
