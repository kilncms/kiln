/**
 * S4, the site owner's side: `kiln doctor` says when a site still has the
 * members gate that never re-checks the list, and `kiln update` replaces it,
 * but only when the site's worker can answer the new gate's question.
 * The real cli/index.mjs is spawned in a scratch site; the network is the
 * canned table in test/cli-fetch-stub.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'cli', 'index.mjs');
const STUB = path.join(ROOT, 'test', 'cli-fetch-stub.mjs');
const SITE = 'https://club.example';
const WORKER = 'https://worker.example';
const REPO = 'kiln-doctor-test-no-such-owner/club';
const GATE = path.join('functions', 'members', '_middleware.js');
// What the wizard copied before the gate re-checked anything.
const OLD_GATE = "import { verifyToken, getCookie } from '../_kiln.js';\nexport async function onRequest({ next }) { return next(); }\n";

const network = (over = {}) => ({
  [`${WORKER}/healthz`]: { json: { ok: true, modes: ['html', 'source'], memberSessions: true } },
  [`${WORKER}/setup/status`]: { json: { configured: true, slug: 'kiln-test-app' } },
  [`${WORKER}/setup/install-check`]: { json: { installed: true } },
  [`${WORKER}/auth/refresh`]: { status: 204, headers: { 'Access-Control-Allow-Origin': SITE } },
  [`${WORKER}/google/login`]: { status: 403, body: 'Origin not allowed', headers: { 'Content-Type': 'text/html' } },
  'https://github.com/apps/kiln-test-app': { body: 'ok', headers: { 'Content-Type': 'text/html' } },
  [`https://api.github.com/repos/${REPO}`]: { json: { full_name: REPO } },
  [`${SITE}/members/`]: { status: 302, headers: { Location: `${SITE}/members-login.html` } },
  [`${SITE}/assets/kiln.js`]: { body: 'var KILN_VERSION="abc1234";', headers: { 'Content-Type': 'text/javascript' } },
  [SITE]: { body: '', headers: { 'Content-Type': 'text/html' } },
  'https://raw.githubusercontent.com/kilncms/kiln/': { body: 'abc1234\n', headers: { 'Content-Type': 'text/plain' } },
  ...over,
});

/** A scratch site (a git repo with a bare origin) wired to WORKER, with `gate` as its members gate. */
function site(gate) {
  const root = mkdtempSync(path.join(tmpdir(), 'kiln-members-'));
  const dir = path.join(root, 'site');
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['init', '--bare', '-b', 'main', path.join(root, 'origin.git')], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Club</title><h1>Hi</h1>\n<script src="/assets/kiln-config.js"></script><script src="/assets/kiln.js" defer></script>\n');
  writeFileSync(path.join(dir, 'assets', 'kiln-config.js'), `window.KILN_CONFIG = { repo: '${REPO}', worker: '${WORKER}' };\n`);
  writeFileSync(path.join(dir, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n');   // as a site set up today has
  if (gate === 'current') cpSync(path.join(ROOT, 'templates', 'functions'), path.join(dir, 'functions'), { recursive: true });
  else if (gate) { mkdirSync(path.join(dir, 'functions', 'members'), { recursive: true }); writeFileSync(path.join(dir, GATE), gate); }
  git('add', '-A');
  git('commit', '-m', 'site');
  git('remote', 'add', 'origin', path.join(root, 'origin.git'));
  git('push', '-u', 'origin', 'main');
  return { root, dir, git };
}

function run(cwd, args, table, answers = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', STUB, CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', KILN_TEST_FETCH: JSON.stringify(table) } });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    killer.unref();
    let out = ''; let i = 0;
    child.stdout.on('data', (d) => { out += d; if (i < answers.length && /: $/.test(out)) child.stdin.write(answers[i++] + '\n'); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ out, code }); });
  });
}
const doctor = (s, table = network()) => run(s.dir, ['doctor', '--site', SITE, '--repo', REPO, '--worker', WORKER], table);

test('S4 doctor: a site with the old members gate fails, and is told the one command that fixes it', async () => {
  const s = site(OLD_GATE);
  try {
    const { out, code } = await doctor(s);
    assert.equal(code, 1, out);
    assert.match(out, /members gate ends a removed member's sign-in — this site has the old gate/);
    assert.match(out, /npx github:kilncms\/kiln#release update/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('S4 doctor: the current gate passes; a site without a members area is not asked about one', async () => {
  const withGate = site('current');
  const without = site(null);
  try {
    const a = await doctor(withGate);
    assert.match(a.out, /members gate ends a removed member's sign-in — re-checks the list every 5 minutes/);
    assert.equal(a.code, 0, a.out);
    const b = await doctor(without);
    assert.doesNotMatch(b.out, /members gate ends/);
    assert.equal(b.code, 0, b.out);
  } finally { for (const s of [withGate, without]) rmSync(s.root, { recursive: true, force: true }); }
});

test('S4 update: the old gate is replaced by the current one and committed with the editor files', async () => {
  const s = site(OLD_GATE);
  try {
    const { out, code } = await run(s.dir, ['update'], network(), ['y']);
    assert.equal(code, 0, out);
    assert.match(out, /refreshed the members gate/);
    assert.match(out, /every member signs in once more/);
    for (const f of ['_kiln.js', path.join('members', '_middleware.js'), path.join('api', 'member-redeem-google.js')]) {
      assert.equal(readFileSync(path.join(s.dir, 'functions', f), 'utf8'), readFileSync(path.join(ROOT, 'templates', 'functions', f), 'utf8'), f);
    }
    const committed = s.git('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort();
    assert.deepEqual(committed, ['assets/kiln-editor.js', 'assets/kiln-features.js', 'assets/kiln.js',
      'functions/_kiln.js', 'functions/api/member-redeem-google.js', 'functions/members/_middleware.js']);
    assert.equal(s.git('status', '--porcelain').stdout, '');
    // A second run changes nothing in functions/.
    const again = await run(s.dir, ['update'], network(), ['n']);
    assert.equal(again.code, 0, again.out);
    assert.equal(s.git('status', '--porcelain').stdout, '');
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test('S4 update: the gate is left alone when the worker is older than it, or does not answer', async () => {
  for (const [health, said] of [
    [{ json: { ok: true, modes: ['html', 'source'] } }, /your worker is older than the current gate/],
    ['down', /the worker did not answer/],
  ]) {
    const s = site(OLD_GATE);
    try {
      const { out, code } = await run(s.dir, ['update'], network({ [`${WORKER}/healthz`]: health }), ['n']);
      assert.equal(code, 0, out);
      assert.match(out, said);
      assert.equal(readFileSync(path.join(s.dir, GATE), 'utf8'), OLD_GATE, 'untouched');
      assert.equal(existsSync(path.join(s.dir, 'functions', 'api')), false);
    } finally { rmSync(s.root, { recursive: true, force: true }); }
  }
});

test('KLR-18 doctor: site bundle, worker and latest release are printed on one line', async () => {
  const s = site(null);
  try {
    const released = await doctor(s, network({ [`${WORKER}/healthz`]: { json: { ok: true, modes: ['html', 'source'], version: '0.4.0', build: 'def5678' } } }));
    assert.match(released.out, /versions: site bundle abc1234 · worker 0\.4\.0 \(build def5678\) · latest release abc1234/);
    const byHand = await doctor(s, network({ [`${WORKER}/healthz`]: { json: { ok: true, version: '0.4.0' } } }));
    assert.match(byHand.out, /worker 0\.4\.0 \(build not reported\)/);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
