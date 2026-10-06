/**
 * KLR-16, KLR-23 — a self-hoster has a configuration of their own to copy,
 * and every name the worker reads from its environment is written down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const code = (toml) => toml.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');

test('KLR-23 ENVIRONMENTS.md lists every binding, variable and secret the worker reads, and nothing it does not', () => {
  const read_ = new Set();
  for (const f of ['worker/index.js', 'worker/cloud.js', 'worker/source.js']) for (const m of read(f).matchAll(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g)) read_.add(m[1]);
  const doc = read('ENVIRONMENTS.md');
  const table = doc.slice(doc.indexOf('## Every name the worker reads'), doc.indexOf('## Resources (canonical instance)'));
  const listed = new Set([...table.matchAll(/^\| `([A-Za-z_][A-Za-z0-9_]*)` \| (KV binding|D1 binding|rate-limit binding|version-metadata binding|variable|secret) \|/gm)].map(m => m[1]));
  assert.deepEqual([...read_].filter(n => !listed.has(n)).sort(), [], 'the worker reads a name the table does not have');
  assert.deepEqual([...listed].filter(n => !read_.has(n)).sort(), [], 'the table has a name the worker never reads');
  assert.ok(listed.size >= 18);
  // The things that were written down nowhere before.
  for (const needle of ['/cloud/webhook/ls', 'subscription_cancelled', 'subscription_expired', '/google/callback', '/auth/callback', '/cloud/callback', 'd1 migrations apply']) assert.ok(table.includes(needle), needle);
  // Secrets are named, never valued.
  assert.doesNotMatch(table, /sk_live|sk_test|whsec_|ghp_|gho_|AIza[\w-]{10}/);
});

test('KLR-16 wrangler.example.toml is a self-hoster\'s whole configuration: nothing of the maintainers\', three values to change', () => {
  const toml = read('worker/wrangler.example.toml');
  const live = code(toml);
  for (const theirs of ['auth.kilncms.com', '376ca9e637724d9fabebbc24ba149814', 'a00713f4', '5900a59c', '153c3353', 'erikkwilder', 'kilncms.com', 'npu-i', '[env.', 'd1_databases', 'routes', 'CLOUD_']) {
    assert.equal(live.includes(theirs), false, `the example carries ${theirs}`);
  }
  assert.equal((toml.match(/# CHANGE/g) || []).length, 3);
  assert.match(live, /^name = "kiln-auth"/m);
  assert.match(live, /^main = "index\.js"$/m);
  assert.match(live, /^ALLOWED_ORIGINS = "https:\/\/example\.com"$/m);
  assert.match(live, /^binding = "KILN"$/m);
  assert.match(live, /^\[observability\]\nenabled = true$/m);
  // The guides send a manual self-hoster to it, and to a copy git ignores.
  for (const f of ['README.md', 'docs/self-hosting.md']) {
    assert.match(read(f), /cp wrangler\.example\.toml wrangler\.self\.toml/, f);
    assert.match(read(f), /npx wrangler deploy --config wrangler\.self\.toml/, f);
    assert.doesNotMatch(read(f), /Delete the `\[\[routes\]\]` block/, f);
  }
  assert.match(read('.gitignore'), /^worker\/wrangler\.self\.toml$/m);
});
