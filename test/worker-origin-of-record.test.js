/**
 * Which addresses the hosted worker trusts for a site it knows by name.
 *
 * A site that moved kept its old address in two places: the list of origins
 * the production worker answers, and the built-in map from an origin to the
 * repository that owns it. An address a site has left can be registered by
 * someone else, so it is trusted nowhere, and the map names the address the
 * site is at now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { fakeKV } from './worker-harness.js';

const LEFT = 'https://npu-i.pages.dev';        // the address the site moved away from
const NOW = 'https://npu-i-site.pages.dev';    // where it is
const CODE = '1'.repeat(32);

function production() {
  const toml = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
  const lines = [...toml.matchAll(/^ALLOWED_ORIGINS = "(.*)"$/gm)].map((m) => m[1].split(','));
  return lines.find((l) => l.includes('https://app.kilncms.com'));
}

async function claim(origin, repo) {
  const env = { ALLOWED_ORIGINS: [LEFT, NOW].join(','), KILN: fakeKV({ [`gcode:${CODE}`]: { name: 'Ada', days: 30, repo, origin, email: 'ada@example.com' } }) };
  const res = await worker.fetch(new Request('https://worker.example/google/claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ code: CODE, origin }),
  }), env);
  return res.status;
}

test('the production worker does not answer the address a site has left', () => {
  const origins = production();
  assert.ok(origins, 'the production list was found');
  assert.equal(origins.includes(LEFT), false);
  assert.equal(origins.includes(NOW), true);
});

test('a sign-in made at the site\'s address for another repository is refused', async () => {
  assert.equal(await claim(NOW, 'someone/else'), 403);
});

test('a sign-in made at the site\'s address for its own repository is taken', async () => {
  assert.equal(await claim(NOW, 'NPU-I/npu-i'), 200);
});

test('the address the site has left is tied to no repository any more', async () => {
  // Nothing is known about it, so the first guard (the code is redeemed by the
  // origin it was made for) is all that speaks, as for any unknown origin.
  assert.equal(await claim(LEFT, 'someone/else'), 200);
});
