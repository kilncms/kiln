#!/usr/bin/env node
/**
 * propagate-bundles — push the freshly built dist/ bundles to every site that
 * carries a COPY of them (git-connected Pages projects with their own repos).
 *
 * Why this exists: the demo and customer sites don't reference the kiln repo at
 * run time — they commit their own copies of kiln.js / kiln-editor.js /
 * kiln-features.js. Before this script that refresh was a manual step, which
 * meant "we deployed" and "the demo actually runs the new code" could drift
 * apart for weeks (the demo shipped a known-vulnerable login guard that way).
 *
 * Runs automatically at the end of `npm run deploy:prod`. Exits non-zero if any
 * known consumer could not be brought current, so a deploy that leaves a stale
 * consumer behind REPORTS AS FAILED instead of looking green.
 *
 * This is canonical-instance tooling (like deploy:prod itself). Self-hosters
 * with no consumer checkouts get a clear note and a clean exit.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLES = ['kiln.js', 'kiln-editor.js', 'kiln-features.js'];

// Every repo that carries a copy of the bundles, and where they live inside it.
// Add a line here when a new managed/demo site is onboarded with copied bundles.
const CONSUMERS = [
  { dir: '~/repos/kiln-demo', dest: 'assets' },      // demo.kilncms.com
  { dir: '~/repos/npu-i', dest: 'assets/js' },       // npu-i.pages.dev (managed customer)
];

const ok = (m) => console.log('  ✓ ' + m);
const info = (m) => console.log('  · ' + m);
const bad = (m) => console.error('  ✗ ' + m);

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

for (const b of BUNDLES) {
  if (!existsSync(path.join(PKG_ROOT, 'dist', b))) {
    bad(`dist/${b} missing — run \`npm run build\` first`);
    process.exit(1);
  }
}
const kilnSha = git(PKG_ROOT, 'rev-parse', '--short', 'HEAD').trim();

console.log('\n━━ Propagating bundles to consumer sites ━━━━━━━━━━━━━━');
let failures = 0, found = 0;

for (const c of CONSUMERS) {
  const dir = c.dir.replace(/^~(?=\/)/, homedir());
  const label = path.basename(dir);
  if (!existsSync(path.join(dir, '.git'))) {
    info(`${label}: no checkout at ${c.dir} — skipped (fine on a non-canonical machine)`);
    continue;
  }
  found++;
  try {
    const stale = BUNDLES.filter(b =>
      !existsSync(path.join(dir, c.dest, b)) || sha(path.join(dir, c.dest, b)) !== sha(path.join(PKG_ROOT, 'dist', b)));
    if (!stale.length) { ok(`${label}: already current`); continue; }

    for (const b of stale) copyFileSync(path.join(PKG_ROOT, 'dist', b), path.join(dir, c.dest, b));
    git(dir, 'add', ...BUNDLES.map(b => path.join(c.dest, b)));
    // Copy may have merely restored local drift back to what's already committed.
    try { git(dir, 'diff', '--cached', '--quiet'); ok(`${label}: restored to committed state (nothing to push)`); continue; }
    catch { /* staged changes exist — commit them */ }
    git(dir, 'commit', '-q', '-m',
      `chore: refresh Kiln bundles to kilncms/kiln@${kilnSha}\n\n(automated by scripts/propagate-bundles.mjs during deploy:prod)`);
    git(dir, 'push');
    ok(`${label}: ${stale.join(', ')} refreshed → pushed (Pages will redeploy)`);
  } catch (err) {
    failures++;
    bad(`${label}: ${String(err.message || err).split('\n')[0]} — this site is still running OLD bundles`);
  }
}

if (!found) info('no consumer checkouts on this machine — nothing to propagate');
if (failures) {
  bad(`${failures} consumer site(s) NOT updated — the deploy is incomplete. Fix and re-run: node scripts/propagate-bundles.mjs`);
  process.exit(1);
}
console.log('━━ All consumers current ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
