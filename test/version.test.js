/**
 * KLR-18 — one version, visible: the build stamp can be fixed from outside,
 * the worker says which build it is, and doctor shows the versions together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { fakeKV } from './worker-harness.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Build in a scratch copy of the sources (never into this repo's dist/). */
function buildWith(envExtra) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-build-'));
  cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  cpSync(path.join(ROOT, 'scripts', 'build.mjs'), path.join(dir, 'scripts', 'build.mjs'), { recursive: true });
  cpSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  const env = { ...process.env, ...envExtra };
  if (!('KILN_BUILD_VERSION' in envExtra)) delete env.KILN_BUILD_VERSION;
  const r = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8', env });
  const read = (f) => { try { return readFileSync(path.join(dir, 'dist', f), 'utf8'); } catch { return null; } };
  const out = { code: r.status, err: r.stderr, version: read('VERSION'), shim: read('kiln.js'), editor: read('kiln-editor.js'), features: read('kiln-features.js') };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test('KLR-18 build: KILN_BUILD_VERSION is the stamp, in dist/VERSION and inside the bundles', () => {
  const b = buildWith({ KILN_BUILD_VERSION: 'rel-2026.10.1' });
  assert.equal(b.code, 0, b.err);
  assert.equal(b.version, 'rel-2026.10.1\n');
  assert.ok(b.shim.includes('"rel-2026.10.1"'));
  assert.ok(b.editor.includes('rel-2026.10.1'));
});

test('KLR-18 build: the same stamp gives the same bytes, so a release deploys exactly what it built', () => {
  const a = buildWith({ KILN_BUILD_VERSION: 'abc1234' });
  const b = buildWith({ KILN_BUILD_VERSION: 'abc1234' });
  assert.equal(a.code, 0, a.err);
  for (const f of ['version', 'shim', 'editor', 'features']) assert.equal(a[f] === b[f], true, f);
});

test('KLR-18 build: the committed dist/ is what its own stamp builds from these sources', () => {
  const stamp = readFileSync(path.join(ROOT, 'dist', 'VERSION'), 'utf8').trim();
  const b = buildWith({ KILN_BUILD_VERSION: stamp });
  assert.equal(b.code, 0, b.err);
  for (const [key, file] of [['shim', 'kiln.js'], ['editor', 'kiln-editor.js'], ['features', 'kiln-features.js']]) {
    assert.equal(b[key] === readFileSync(path.join(ROOT, 'dist', file), 'utf8'), true, `dist/${file} differs from a rebuild with stamp ${stamp}: run KILN_BUILD_VERSION=${stamp} npm run build, or commit a fresh build`);
  }
});

test('KLR-18 build: a stamp that is not a plain token is refused; without one the stamp is the git sha or "dev"', () => {
  const bad = buildWith({ KILN_BUILD_VERSION: 'a b";alert(1)' });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /KILN_BUILD_VERSION must be/);
  assert.equal(bad.version, null, 'nothing is written');
  const plain = buildWith({});
  assert.equal(plain.code, 0, plain.err);
  assert.match(plain.version, /^([0-9a-f]{7,40}|dev)\n$/);
});

test('KLR-18 /healthz: a plain GET still answers 200 with what it always had, plus the build it was deployed from', async () => {
  const get = async (env) => { const r = await worker.fetch(new Request('https://worker.example/healthz'), { KILN: fakeKV(), ...env }); return { status: r.status, json: await r.json() }; };
  const byHand = await get({});
  assert.equal(byHand.status, 200);
  assert.equal(byHand.json.ok, true);
  assert.deepEqual(byHand.json.modes, ['html', 'source']);
  assert.equal(typeof byHand.json.version, 'string');
  assert.equal('build' in byHand.json, false, 'a worker deployed by hand claims no build');
  const released = await get({ KILN_BUILD: 'abc1234', CF_VERSION_METADATA: { id: 'v-uuid', tag: 'prod-2026-10-06', timestamp: '2026-10-06T10:00:00Z' } });
  assert.equal(released.json.build, 'abc1234');
  assert.deepEqual(released.json.deploy, { id: 'v-uuid', tag: 'prod-2026-10-06', at: '2026-10-06T10:00:00Z' });
  assert.equal('build' in (await get({ KILN_BUILD: '<script>' })).json, false);
  // Nothing from the environment leaks: only these keys.
  const withSecrets = await get({ KILN_BUILD: 'abc1234', LS_API_KEY: 'sk_live_x', GOOGLE_CLIENT_SECRET: 'shh', AI_API_KEY: 'k' });
  assert.deepEqual(Object.keys(withSecrets.json).sort(), ['adapters', 'build', 'memberSessions', 'modes', 'ok', 'renameMovesAll', 'version']);
});
