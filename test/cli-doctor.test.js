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
  // An empty homepage body: the site is "live", and doctor skips its one check
  // that shells out to `gh` (comparing the live page with the repo's).
  [SITE]: { body: '', headers: { 'Content-Type': 'text/html' } },
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

// ─── KLN-08 · doctor ─────────────────────────────────────────────────────────

test('KLN-08 doctor: an unreachable worker is never reported as "Google sign-in — configured"', () => {
  // Nothing answers at the worker's address at all.
  const table = healthy();
  for (const k of Object.keys(table)) if (k.startsWith(WORKER)) delete table[k];
  const { out, code } = doctor(table);
  assert.equal(/Google sign-in — configured/.test(out), false, out);
  assert.match(out, /Google sign-in — could not check \(the worker did not answer\)/);
  assert.match(out, /❌ worker reachable/);
  assert.equal(code, 1);
});

test('KLN-08 doctor: Google sign-in reads "configured" only from a worker that answered', () => {
  // The worker answered and has a Google client (it refuses our empty origin with 403).
  const yes = doctor(healthy());
  assert.match(yes.out, /✅ Google sign-in — configured/);
  // Signed-in redirect also counts as answered.
  assert.match(doctor(healthy({ [`${WORKER}/google/login`]: { status: 302, headers: { Location: 'https://accounts.google.com/' } } })).out, /✅ Google sign-in — configured/);
  // The worker answered: no Google client set.
  const no = doctor(healthy({ [`${WORKER}/google/login`]: { status: 503, body: 'not set up', headers: { 'Content-Type': 'text/html' } } }));
  assert.match(no.out, /Google sign-in — not configured — set GOOGLE_CLIENT_ID\/SECRET/);
  assert.equal(/Google sign-in — configured/.test(no.out), false);
  assert.equal(no.code, 0, 'Google sign-in is optional — its absence does not fail the run');
  // Only the Google route fails to answer: still "could not check", and still optional.
  const down = doctor(healthy({ [`${WORKER}/google/login`]: 'down' }));
  assert.match(down.out, /Google sign-in — could not check/);
  assert.equal(down.code, 0);
});

// ─── KLN-08 · update ─────────────────────────────────────────────────────────

/** A scratch site in git, with a local bare repo as its `origin` so `git push` needs no network. */
function scratchRepo(scriptSrc) {
  const root = mkdtempSync(path.join(tmpdir(), 'kiln-update-'));
  const site = path.join(root, 'site');
  mkdirSync(site);
  const git = (...a) => spawnSync('git', a, { cwd: site, encoding: 'utf8' });
  spawnSync('git', ['init', '--bare', '-b', 'main', path.join(root, 'origin.git')], { encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(site, 'index.html'), `<!doctype html><title>Site</title><h1>Hi</h1>\n<script src="${scriptSrc}" defer></script>\n`);
  git('add', 'index.html');
  git('commit', '-m', 'site');
  git('remote', 'add', 'origin', path.join(root, 'origin.git'));
  git('push', '-u', 'origin', 'main');
  return { root, site, git };
}
/** Run `kiln update`, answering each prompt as it appears. */
function runUpdate(cwd, answers) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'update'], { cwd, env: { ...process.env, NO_COLOR: '1' } });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    killer.unref();
    let out = '';
    let i = 0;
    child.stdout.on('data', (d) => {
      out += d;
      if (i < answers.length && /: $/.test(out)) child.stdin.write(answers[i++] + '\n');
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ out, code }); });
  });
}

test('KLN-08 update: a folder name with shell characters in it reaches git as a path — nothing runs', async () => {
  // The folder is read out of the page's own <script src>. In a shell string,
  // $(touch PWNED) would execute.
  const { root, site, git } = scratchRepo('/assets/x$(touch PWNED)/kiln.js');
  try {
    const { out, code } = await runUpdate(site, ['y']);
    assert.equal(existsSync(path.join(site, 'PWNED')), false, 'the injected command did not run');
    assert.equal(existsSync(path.join(root, 'PWNED')), false);
    assert.match(out, /pushed — your host will redeploy/);
    assert.equal(code, 0, out);
    const committed = git('show', '--stat', '--format=%s', 'HEAD').stdout;
    assert.match(committed, /^Update Kiln editor to latest/);
    for (const f of ['kiln.js', 'kiln-editor.js', 'kiln-features.js']) {
      assert.ok(existsSync(path.join(site, 'assets', 'x$(touch PWNED)', f)), f);
      assert.ok(committed.includes(f), `${f} is in the commit`);
    }
    assert.equal(git('status', '--porcelain').stdout.trim(), '', 'nothing left uncommitted, nothing extra staged');
    assert.equal(git('rev-parse', 'HEAD').stdout, git('rev-parse', 'origin/main').stdout, 'and it was pushed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KLN-08 update: semicolons, quotes, spaces, backticks and a leading dash are all just a folder name', async () => {
  for (const folder of ['a; touch PWNED; b', 'my assets', "it's here", '-rf', 'x`touch PWNED`', 'a && touch PWNED']) {
    const { root, site, git } = scratchRepo(`/${folder}/kiln.js`);
    try {
      const { out, code } = await runUpdate(site, ['y']);
      assert.equal(existsSync(path.join(site, 'PWNED')), false, `no command ran for: ${folder}`);
      assert.equal(code, 0, `${folder}: ${out}`);
      assert.match(out, /pushed — your host will redeploy/, folder);
      assert.ok(existsSync(path.join(site, folder, 'kiln-editor.js')), `${folder}: files landed in that exact folder`);
      assert.match(git('show', '--stat', '--format=%s', 'HEAD').stdout, /kiln-editor\.js/, folder);
      assert.equal(git('status', '--porcelain').stdout.trim(), '', folder);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('KLN-08 update: declining the commit copies the files and stages nothing', async () => {
  const { root, site, git } = scratchRepo('/assets/kiln.js');
  try {
    const { out, code } = await runUpdate(site, ['n']);
    assert.equal(code, 0);
    assert.match(out, /Commit \+ push when ready/);
    assert.equal(readFileSync(path.join(site, 'assets', 'kiln.js'), 'utf8'), readFileSync(path.join(HERE, '..', 'dist', 'kiln.js'), 'utf8'));
    assert.equal(git('diff', '--cached', '--name-only').stdout.trim(), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('KLN-08 update: when git refuses, its own message is shown', async () => {
  const { root, site, git } = scratchRepo('/assets/kiln.js');
  try {
    git('remote', 'set-url', 'origin', path.join(root, 'gone.git'));   // push has nowhere to go
    const { out, code } = await runUpdate(site, ['y']);
    assert.equal(code, 1);
    assert.match(out, /commit\/push didn't complete:/);
    assert.match(out, /gone\.git|repository|does not appear/i, 'git\'s reason is passed on');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
