/**
 * KLR-02 — propagation that cannot surprise a customer.
 *
 * Every consumer here is a temporary git repository (a bare "origin" plus a
 * checkout of it) and so is the kiln repo the bundles come from. The script is
 * always given --consumers and --root: it is never pointed at a real checkout.
 * A canary's "live" address is a file:// path standing in for the deployed site.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { propagate, parseArgs, DEFAULT_CONSUMERS } from '../scripts/propagate-bundles.mjs';

const SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'scripts', 'propagate-bundles.mjs');
const OLD = 'old0001';
const NEW = 'new0002';
const bundle = (stamp) => ({ 'kiln.js': `window.KILN_VERSION="${stamp}";/* shim */`, 'kiln-editor.js': `/* editor ${stamp} */`, 'kiln-features.js': `/* features ${stamp} */` });
const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
const sh = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) sh(dir, 'config', k, v);
}

/** The kiln repo: dist/ built with NEW, committed, and (unless told not to) tagged as released. */
function kilnRepo(base, { tag = 'prod-2026-10-06' } = {}) {
  const dir = path.join(base, 'kiln');
  initRepo(dir);
  mkdirSync(path.join(dir, 'dist'));
  for (const [f, text] of Object.entries(bundle(NEW))) writeFileSync(path.join(dir, 'dist', f), text);
  writeFileSync(path.join(dir, 'dist', 'VERSION'), NEW + '\n');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'build');
  if (tag) sh(dir, 'tag', '-a', tag, '-m', 'release');
  return dir;
}
/** A consumer site: bare origin + checkout, serving OLD bundles from `dest`. */
function consumer(base, name, dest = 'assets') {
  const origin = path.join(base, `${name}.git`);
  const dir = path.join(base, name);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = path.join(base, `${name}-seed`);
  initRepo(seed);
  mkdirSync(path.join(seed, dest), { recursive: true });
  writeFileSync(path.join(seed, 'index.html'), '<h1>Site</h1>');
  for (const [f, text] of Object.entries(bundle(OLD))) writeFileSync(path.join(seed, dest, f), text);
  sh(seed, 'add', '-A'); sh(seed, 'commit', '-q', '-m', 'site');
  sh(seed, 'remote', 'add', 'origin', origin); sh(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, dir]);
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) sh(dir, 'config', k, v);
  const live = path.join(base, `${name}-live-kiln.js`);
  writeFileSync(live, bundle(OLD)['kiln.js']);
  return {
    name, dir, origin, seed, dest, live, liveUrl: pathToFileURL(live).href,
    head: () => sh(dir, 'rev-parse', 'HEAD'),
    originHead: () => sh(origin, 'rev-parse', 'refs/heads/main'),
    served: (f = 'kiln.js') => sh(origin, 'show', `refs/heads/main:${dest}/${f}`),   // what the host would deploy
    deploy: () => writeFileSync(live, sh(origin, 'show', `refs/heads/main:${dest}/kiln.js`)),   // "the host redeployed"
  };
}
/** One kiln repo, one canary (demo) and two customers, wired into a consumers file. */
function world(over = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'kiln-propagate-'));
  scratch.push(base);
  const root = kilnRepo(base, over.kiln);
  const demo = consumer(base, 'demo');
  const first = consumer(base, 'customer-one', 'assets/js');
  const second = consumer(base, 'customer-two');
  const entry = (c, extra = {}) => ({ dir: c.dir, dest: c.dest, live: c.liveUrl, ...extra });
  const file = path.join(base, 'consumers.json');
  const write = (list) => writeFileSync(file, JSON.stringify(list));
  write({ canary: [entry(demo, over.demo)], customers: [entry(first, over.first), entry(second, over.second)] });
  const lines = [];
  const run = (opts = {}) => propagate({ consumers: file, root, ...opts }, (l) => lines.push(l));
  return { base, root, demo, first, second, file, write, entry, lines, run, out: () => lines.join('\n') };
}
const untouched = (c, before) => { assert.equal(c.head(), before.head, `${c.name} checkout moved`); assert.equal(c.originHead(), before.origin, `${c.name} origin moved`); assert.equal(sh(c.dir, 'status', '--porcelain'), '', `${c.name} has changes`); };
const snap = (c) => ({ head: c.head(), origin: c.originHead() });
async function stopped(promise) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, 'expected the run to stop');
  assert.equal(err.message.includes('\n'), false, 'one sentence');
  return err;
}

test('KLR-02 the default run updates the canary only; customer sites are not touched', async () => {
  const w = world();
  const before = { first: snap(w.first), second: snap(w.second) };
  const r = await w.run();
  assert.deepEqual(r.pushed.map(p => p.label), ['demo']);
  assert.equal(w.demo.served(), bundle(NEW)['kiln.js']);
  assert.equal(w.demo.served('kiln-editor.js'), bundle(NEW)['kiln-editor.js']);
  assert.match(sh(w.demo.origin, 'log', '-1', '--format=%s', 'refs/heads/main'), /^chore: refresh Kiln bundles to new0002 \(kilncms\/kiln@[0-9a-f]{7}, prod-2026-10-06\)$/);
  untouched(w.first, before.first); untouched(w.second, before.second);
  assert.equal(w.first.served(), bundle(OLD)['kiln.js']);
  assert.match(w.out(), /Next: wait for the demo to deploy, try it, then `npm run propagate -- --customers`/);
});

test('KLR-02 every pushed commit is printed with its revert command, and that command works as printed', async () => {
  const w = world();
  const r = await w.run();
  const { revert, commit } = r.pushed[0];
  assert.ok(w.out().includes(`to take it back: ${revert}`));
  assert.equal(revert, `git -C ${w.demo.dir} revert --no-edit ${commit.slice(0, 12)} && git -C ${w.demo.dir} push origin HEAD:main`);
  const ran = spawnSync('sh', ['-c', revert], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(w.demo.served(), bundle(OLD)['kiln.js'], 'the site is back on its old bundles');
});

test('KLR-02 --customers refuses until the canary\'s LIVE kiln.js carries the new stamp', async () => {
  const w = world();
  const before = { first: snap(w.first), second: snap(w.second) };
  // 1. Nothing propagated yet: the demo serves the old build.
  let err = await stopped(w.run({ customers: true }));
  assert.match(err.message, /serves build old0001, not new0002, so customer sites are not touched\. Run `npm run propagate`, wait for the demo to deploy, try it, then run this again\.$/);
  // 2. Pushed to the demo's repo, but its host has not deployed it yet.
  await w.run();
  err = await stopped(w.run({ customers: true }));
  assert.match(err.message, /serves build old0001, not new0002/);
  // 3. The live file cannot be read, or says nothing.
  writeFileSync(w.demo.live, 'not a kiln file');
  assert.match((await stopped(w.run({ customers: true }))).message, /serves build unknown, not new0002/);
  rmSync(w.demo.live);
  assert.match((await stopped(w.run({ customers: true }))).message, /could not be read .* so customer sites are not touched/);
  // 4. No canary to check, or no address for it.
  w.write({ canary: [], customers: [w.entry(w.first)] });
  assert.match((await stopped(w.run({ customers: true }))).message, /There is no canary site to check first/);
  w.write({ canary: [{ dir: w.demo.dir, dest: 'assets' }], customers: [w.entry(w.first)] });
  assert.match((await stopped(w.run({ customers: true }))).message, /has no "live" address to check/);
  untouched(w.first, before.first); untouched(w.second, before.second);
});

test('KLR-02 --customers, once the canary is live on the build, updates the customers and leaves the canary alone', async () => {
  const w = world();
  await w.run();
  w.demo.deploy();
  const demoBefore = snap(w.demo);
  const r = await w.run({ customers: true });
  assert.deepEqual(r.pushed.map(p => p.label), ['customer-one', 'customer-two']);
  assert.equal(w.first.served(), bundle(NEW)['kiln.js']);
  assert.equal(w.second.served('kiln-features.js'), bundle(NEW)['kiln-features.js']);
  untouched(w.demo, demoBefore);
  assert.equal(r.pushed.every(p => w.out().includes(p.revert)), true);
  // A second run has nothing to do and pushes nothing.
  const again = await w.run({ customers: true });
  assert.deepEqual(again.pushed, []);
  assert.match(w.out(), /customer-one: already on new0002/);
});

test('KLR-02 stops at the first failure: the second consumer is not touched when the first fails', async () => {
  const w = world();
  await w.run(); w.demo.deploy();
  // The first customer's checkout holds a commit of its own that was never pushed.
  writeFileSync(path.join(w.first.dir, 'draft.html'), 'half-finished');
  sh(w.first.dir, 'add', '-A'); sh(w.first.dir, 'commit', '-q', '-m', 'local work');
  const before = { first: snap(w.first), second: snap(w.second) };
  const err = await stopped(w.run({ customers: true }));
  assert.match(err.message, /^customer-one: the checkout has 1 commit of its own that origin\/main does not \([0-9a-f]{7}\), and pushing the bundles would publish it too\. Push or remove it yourself in .*, then run this again\.$/);
  assert.deepEqual(err.pushed, []);
  untouched(w.first, before.first);
  untouched(w.second, before.second);
  assert.equal(w.second.served(), bundle(OLD)['kiln.js'], 'the second customer still serves what it did');
  assert.doesNotMatch(w.out(), /customer-two/);
});

test('KLR-02 a refused push is undone locally, reported with what already went out, and stops the run', async () => {
  const w = world();
  await w.run(); w.demo.deploy();
  // customer-one succeeds; customer-two's origin refuses the push.
  const hook = path.join(w.second.origin, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n'); chmodSync(hook, 0o755);
  const before = snap(w.second);
  const err = await stopped(w.run({ customers: true }));
  assert.match(err.message, /^customer-two: the push to origin\/main was refused .*the local commit was undone and the site still runs its old bundles/);
  assert.deepEqual(err.pushed.map(p => p.label), ['customer-one'], 'what went out before the stop is listed, with its revert');
  untouched(w.second, before);
  assert.equal(readFileSync(path.join(w.second.dir, 'assets', 'kiln.js'), 'utf8'), bundle(OLD)['kiln.js']);
});

test('KLR-02 the checkout is fetched and fast-forwarded first, so a change made on the site since is kept', async () => {
  const w = world();
  // Someone published an edit through Kiln: origin is one commit ahead of the checkout.
  writeFileSync(path.join(w.demo.seed, 'index.html'), '<h1>Edited on the site</h1>');
  sh(w.demo.seed, 'commit', '-q', '-am', 'Update index.html (via Kiln)'); sh(w.demo.seed, 'push', '-q', 'origin', 'main');
  const r = await w.run();
  assert.equal(r.pushed.length, 1);
  assert.equal(sh(w.demo.origin, 'show', 'refs/heads/main:index.html'), '<h1>Edited on the site</h1>');
  assert.equal(w.demo.served(), bundle(NEW)['kiln.js']);
  assert.equal(sh(w.demo.origin, 'rev-list', '--count', 'refs/heads/main'), '3', 'site, the edit, the bundles: a straight line');
});

test('KLR-02 refuses a checkout that is on another branch, has uncommitted changes, or has diverged', async () => {
  const a = world();
  sh(a.demo.dir, 'switch', '-q', '-c', 'redesign');
  assert.match((await stopped(a.run())).message, /^demo: the checkout is on "redesign", not its default branch "main"\. Run `git -C .* switch main` and run this again\.$/);
  const b = world();
  writeFileSync(path.join(b.demo.dir, 'index.html'), 'edited locally');
  assert.match((await stopped(b.run())).message, /^demo: the checkout has uncommitted changes\. Commit or stash them/);
  assert.equal(b.demo.served(), bundle(OLD)['kiln.js']);
  const c = world();
  writeFileSync(path.join(c.demo.seed, 'index.html'), 'theirs'); sh(c.demo.seed, 'commit', '-q', '-am', 'theirs'); sh(c.demo.seed, 'push', '-q', 'origin', 'main');
  writeFileSync(path.join(c.demo.dir, 'index.html'), 'ours'); sh(c.demo.dir, 'commit', '-q', '-am', 'ours');
  assert.match((await stopped(c.run())).message, /^demo: the checkout has 1 commit of its own/);
  assert.equal(c.demo.served(), bundle(OLD)['kiln.js']);
});

test('KLR-02 refuses bundles that are not a released build', async () => {
  const untagged = world({ kiln: { tag: null } });
  assert.match((await stopped(untagged.run())).message, /has no prod- tag, so it is not a build that was released to production\. Release it first \(`npm run deploy:prod`\)/);
  const dirty = world();
  writeFileSync(path.join(dirty.root, 'dist', 'kiln-editor.js'), '/* rebuilt locally, never released */');
  assert.match((await stopped(dirty.run())).message, /dist\/ has changes that are not committed, so these bundles are not the ones that were released/);
  const mixed = world();
  writeFileSync(path.join(mixed.root, 'dist', 'VERSION'), 'zzz9999\n'); sh(mixed.root, 'commit', '-q', '-am', 'bad'); sh(mixed.root, 'tag', '-a', 'prod-2026-10-07', '-m', 'r');
  assert.match((await stopped(mixed.run())).message, /dist\/kiln\.js does not carry the stamp in dist\/VERSION \(zzz9999\)/);
  for (const w of [untagged, dirty, mixed]) assert.equal(w.demo.served(), bundle(OLD)['kiln.js']);
});

test('KLR-02 hold and pin: a consumer marked either way is never written to', async () => {
  const w = world({ first: { hold: true }, second: { pin: OLD } });
  await w.run(); w.demo.deploy();
  const before = { first: snap(w.first), second: snap(w.second) };
  const r = await w.run({ customers: true });
  assert.deepEqual(r.pushed, []);
  untouched(w.first, before.first); untouched(w.second, before.second);
  assert.match(w.out(), /customer-one: on hold — not touched/);
  assert.match(w.out(), /customer-two: pinned at old0001 — not touched$/m);
  // A pin the site has drifted from is said out loud, and still not "fixed".
  const drift = world({ second: { pin: 'abc0000' } });
  await drift.run(); drift.demo.deploy();
  await drift.run({ customers: true });
  assert.match(drift.out(), /customer-two: pinned at abc0000 — not touched \(it currently has old0001, which is not its pin\)/);
  // A held canary is not asked to vouch for anything.
  const held = world({ demo: { hold: true } });
  assert.match((await stopped(held.run({ customers: true }))).message, /There is no canary site to check first/);
});

test('KLR-02 --dry-run says what it would do and touches nothing: no fetch, no copy, no commit, no push', async () => {
  const w = world();
  writeFileSync(path.join(w.demo.seed, 'index.html'), 'newer'); sh(w.demo.seed, 'commit', '-q', '-am', 'newer'); sh(w.demo.seed, 'push', '-q', 'origin', 'main');
  const before = { head: w.demo.head(), tracking: sh(w.demo.dir, 'rev-parse', 'origin/main'), origin: w.demo.originHead() };
  const r = await w.run({ dryRun: true });
  assert.deepEqual(r.pushed, []);
  assert.equal(w.demo.head(), before.head);
  assert.equal(sh(w.demo.dir, 'rev-parse', 'origin/main'), before.tracking, 'not even a fetch');
  assert.equal(existsSync(path.join(w.demo.dir, '.git', 'FETCH_HEAD')), false);
  assert.equal(w.demo.originHead(), before.origin);
  assert.equal(sh(w.demo.dir, 'status', '--porcelain'), '');
  assert.match(w.out(), /dry run, nothing is touched/);
  assert.match(w.out(), /demo: would fast-forward [0-9a-f]{7} → [0-9a-f]{7} from origin first/);
  assert.match(w.out(), /demo: would copy kiln\.js, kiln-editor\.js, kiln-features\.js into assets\/, commit, and push to origin\/main/);
  assert.match(w.out(), /Dry run: nothing was fetched, copied, committed or pushed\./);
  // The customers' dry run is held to the same canary rule.
  assert.match((await stopped(w.run({ dryRun: true, customers: true }))).message, /serves build old0001, not new0002/);
});

test('KLR-02 a machine with no consumer checkouts gets a note and a clean exit', async () => {
  const w = world();
  w.write({ canary: [{ dir: path.join(w.base, 'nowhere'), dest: 'assets', live: w.demo.liveUrl }], customers: [] });
  const r = await w.run();
  assert.deepEqual(r.pushed, []);
  assert.match(w.out(), /nowhere: no checkout at .* — skipped/);
  assert.match(w.out(), /no consumer checkouts on this machine/);
});

test('KLR-02 the command line: exit 1 with the sentence and what was pushed; unknown options refused; tests cannot reach the real list', () => {
  const w = world();
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const ok = cli('--consumers', w.file, '--root', w.root);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /demo: kiln\.js, kiln-editor\.js, kiln-features\.js → pushed [0-9a-f]{7} to origin\/main/);
  assert.match(ok.stdout, /to take it back: git -C .* revert --no-edit [0-9a-f]{12} && git -C .* push origin HEAD:main/);
  const refused = cli('--consumers', w.file, '--root', w.root, '--customers');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /✗ The canary .* serves build old0001, not new0002/);
  assert.match(refused.stderr, /Nothing was pushed\./);
  assert.equal(cli('--everything').status, 1);
  assert.match(cli('--everything').stderr, /Unknown option --everything/);
  // No --consumers under the test runner: refuses before reading any list.
  const guarded = cli('--dry-run');
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /Under the test runner this script needs --consumers <file>/);
  assert.deepEqual(parseArgs(['--customers', '--dry-run']), { customers: true, dryRun: true, consumers: null, root: null });
});

test('KLR-02, KLR-12 the built-in list: the demo repo is the only canary, customers are a separate list, and demo.kilncms.com is not claimed', () => {
  assert.deepEqual(DEFAULT_CONSUMERS.canary.map(c => c.dir), ['~/repos/kiln-demo']);
  assert.equal(DEFAULT_CONSUMERS.canary[0].live, 'https://kiln-demo.pages.dev/assets/kiln.js');
  assert.equal(DEFAULT_CONSUMERS.canary.some(c => DEFAULT_CONSUMERS.customers.some(k => k.dir === c.dir)), false);
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(src, /demo\.kilncms\.com is NOT here/);
  assert.doesNotMatch(src, /kiln-demo'[^\n]*\/\/ demo\.kilncms\.com/);
});
