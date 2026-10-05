/**
 * `kiln doctor` and `kiln update`, run for real (cli/index.mjs is spawned) with
 * canned network answers preloaded through test/cli-fetch-stub.mjs.
 *
 * KLN-04 (part two): a renamed or transferred repo is a FAILING check.
 * KLN-08: `update` hands git its paths as arguments, never through a shell;
 *         doctor does not call Google sign-in "configured" when the worker
 *         cannot be reached.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'cli', 'index.mjs');
const STUB = pathToFileURL(path.join(HERE, 'cli-fetch-stub.mjs')).href;
const SITE = 'https://site.example';
const WORKER = 'https://worker.example';
// A name no account holds, so doctor's one `gh` lookup (when gh is installed) finds nothing.
const REPO = 'kiln-doctor-test-no-such-owner/site';

/** A healthy install, as the network would describe it. Override entries per test. */
const healthy = (over = {}) => ({
  [`${WORKER}/healthz`]: { json: { ok: true, modes: ['html', 'source'] } },
  [`${WORKER}/setup/status`]: { json: { configured: true, slug: 'kiln-test-app' } },
  [`${WORKER}/setup/install-check`]: { json: { installed: true } },
  [`${WORKER}/auth/refresh`]: { status: 204, headers: { 'Access-Control-Allow-Origin': SITE } },
  [`${WORKER}/google/login`]: { status: 403, body: 'Origin not allowed', headers: { 'Content-Type': 'text/html' } },
  'https://github.com/apps/kiln-test-app': { body: 'ok', headers: { 'Content-Type': 'text/html' } },
  [`https://api.github.com/repos/${REPO}`]: { json: { full_name: REPO } },
  [`${SITE}/members/`]: { status: 302, headers: { Location: `${SITE}/members-login.html` } },
  [`${SITE}/assets/kiln.js`]: { body: 'var KILN_VERSION="abc1234";', headers: { 'Content-Type': 'text/javascript' } },
  [SITE]: { body: '<!doctype html><title>Site</title><script src="/assets/kiln.js" defer></script>', headers: { 'Content-Type': 'text/html' } },
  'https://raw.githubusercontent.com/kilncms/kiln/main/dist/VERSION': { body: 'abc1234\n', headers: { 'Content-Type': 'text/plain' } },
  ...over,
});

function doctor(table, { repo = REPO } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'kiln-doctor-'));
  try {
    const r = spawnSync(process.execPath, ['--import', STUB, CLI, 'doctor', '--site', SITE, '--repo', repo, '--worker', WORKER], {
      cwd, encoding: 'utf8', timeout: 90_000,
      env: { ...process.env, NO_COLOR: '1', KILN_TEST_FETCH: JSON.stringify(table) },
    });
    assert.equal(r.error, undefined, r.error && r.error.message);
    return { out: r.stdout + r.stderr, code: r.status };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

// ─── KLN-04 ──────────────────────────────────────────────────────────────────

test('KLN-04 doctor: a healthy install passes every check, the repo-name check included', () => {
  const { out, code } = doctor(healthy());
  assert.match(out, /✅ repo name matches GitHub/);
  assert.match(out, /Kiln is healthy/);
  assert.equal(code, 0, out);
});

test('KLN-04 doctor: a renamed repo FAILS the run — it is a check, not a warning', () => {
  const { out, code } = doctor(healthy({ [`https://api.github.com/repos/${REPO}`]: { json: { full_name: 'new-owner/new-name' } } }));
  assert.match(out, /❌ repo name matches GitHub/);
  assert.match(out, /GitHub answers as new-owner\/new-name but the config says kiln-doctor-test-no-such-owner\/site/);
  assert.match(out, /set repo to 'new-owner\/new-name' in assets\/kiln-config\.js/);
  assert.match(out, /add your editors again/);
  assert.equal(/Kiln is healthy/.test(out), false, 'never "healthy" with a stale repo name');
  assert.equal(/⚠️ +repo answers as/.test(out), false, 'the old advisory warning is gone');
  assert.equal(code, 1, 'non-zero exit');
  const m = /(\d+)\/(\d+) checks passed/.exec(out);
  assert.ok(m && Number(m[1]) === Number(m[2]) - 1, `exactly one check failed: ${m && m[0]}`);
});

test('KLN-04 doctor: a different letter case is a mismatch too (stored access is keyed to the exact string)', () => {
  const { out, code } = doctor(healthy({ [`https://api.github.com/repos/${REPO}`]: { json: { full_name: REPO.toUpperCase() } } }));
  assert.match(out, /❌ repo name matches GitHub/);
  assert.equal(code, 1);
});

test('KLN-04 doctor: when GitHub cannot be asked, the name check is skipped rather than guessed', () => {
  const table = healthy();
  delete table[`https://api.github.com/repos/${REPO}`];
  const { out, code } = doctor(table);
  assert.equal(/repo name matches GitHub/.test(out), false);
  assert.match(out, /Kiln is healthy/);
  assert.equal(code, 0);
});
