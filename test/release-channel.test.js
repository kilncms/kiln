/**
 * KLR-07 — "latest" means released, not whatever is on main.
 *
 * `kiln doctor` compares a site's editor with the stamp on the `release`
 * branch, which scripts/release.mjs moves to each production release. That
 * branch does not exist on GitHub until the first such release: until then the
 * check must fall back quietly, with no false "update available" and no error.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = 'https://club.example';
const WORKER = 'https://worker.example';
const REPO = 'kiln-doctor-test-no-such-owner/club';
const RAW = 'https://raw.githubusercontent.com/kilncms/kiln';
const dir = mkdtempSync(path.join(tmpdir(), 'kiln-channel-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function doctor({ site = 'abc1234', release, main }) {
  const stamp = (v) => (v === undefined ? { status: 404, body: '404: Not Found' } : v === 'down' ? 'down' : { body: `${v}\n`, headers: { 'Content-Type': 'text/plain' } });
  const table = {
    [`${WORKER}/healthz`]: { json: { ok: true, modes: ['html', 'source'], version: '0.4.0' } },
    [`${WORKER}/setup/status`]: { json: { configured: true, slug: 'kiln-test-app' } },
    [`${WORKER}/setup/install-check`]: { json: { installed: true } },
    [`${WORKER}/auth/refresh`]: { status: 204, headers: { 'Access-Control-Allow-Origin': SITE } },
    [`${WORKER}/google/login`]: { status: 403, body: 'x', headers: { 'Content-Type': 'text/html' } },
    'https://github.com/apps/kiln-test-app': { body: 'ok', headers: { 'Content-Type': 'text/html' } },
    [`https://api.github.com/repos/${REPO}`]: { json: { full_name: REPO } },
    [`${SITE}/members/`]: { status: 404, body: '' },
    [`${SITE}/assets/kiln.js`]: { body: `var KILN_VERSION="${site}";`, headers: { 'Content-Type': 'text/javascript' } },
    [SITE]: { body: '', headers: { 'Content-Type': 'text/html' } },
    [`${RAW}/release/dist/VERSION`]: stamp(release),
    [`${RAW}/main/dist/VERSION`]: stamp(main),
  };
  const r = spawnSync(process.execPath, ['--import', path.join(ROOT, 'test', 'cli-fetch-stub.mjs'), path.join(ROOT, 'cli', 'index.mjs'), 'doctor', '--site', SITE, '--repo', REPO, '--worker', WORKER],
    { cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, NO_COLOR: '1', KILN_TEST_FETCH: JSON.stringify(table) } });
  return { out: r.stdout + r.stderr, code: r.status };
}

test('KLR-07 before the release branch exists, the check falls back to main: no false "update available", no error', () => {
  const r = doctor({ site: 'abc1234', release: undefined, main: 'abc1234' });
  assert.match(r.out, /✅ editor is up to date — version abc1234/);
  assert.doesNotMatch(r.out, /404|Not Found|could not|undefined|update available|you have/i);
  assert.equal(r.code, 0, r.out);
  // Unreachable instead of missing behaves the same.
  assert.match(doctor({ site: 'abc1234', release: 'down', main: 'abc1234' }).out, /✅ editor is up to date — version abc1234/);
});

test('KLR-07 once the release branch exists it decides: work on main that is not released is not offered as an update', () => {
  const current = doctor({ site: 'rel1111', release: 'rel1111', main: 'main999' });
  assert.match(current.out, /✅ editor is up to date — version rel1111/);
  assert.match(current.out, /latest release rel1111/);
  assert.doesNotMatch(current.out, /main999/);
  assert.equal(current.code, 0, current.out);
  const behind = doctor({ site: 'old0000', release: 'rel1111', main: 'main999' });
  assert.match(behind.out, /you have old0000, latest is rel1111 — run: npx github:kilncms\/kiln update/);
  assert.equal(behind.code, 0, 'an available update is a notice, not a failure');
});

test('KLR-07 when neither branch answers, or one answers with something that is not a stamp, nothing is claimed', () => {
  for (const world of [{ release: 'down', main: 'down' }, { release: undefined, main: undefined }, { release: '<html>Sign in</html>', main: undefined }]) {
    const r = doctor({ site: 'abc1234', ...world });
    assert.doesNotMatch(r.out, /editor is up to date|you have abc1234|update available/, JSON.stringify(world));
    assert.match(r.out, /latest release unknown/);
    assert.equal(r.code, 0, r.out);
  }
});
