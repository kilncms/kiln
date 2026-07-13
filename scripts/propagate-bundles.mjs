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
    // Branch guard: `push origin HEAD` publishes WHATEVER branch the checkout is
    // on — a feature branch or unrelated local commits must never land on a
    // customer's default branch, and a side branch push won't deploy anyway.
    let defaultBranch = '';
    try {
      defaultBranch = git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim().replace(/^origin\//, '');
    } catch {
      try {   // origin/HEAD unset locally (fresh/partial clone) — ask the remote once
        git(dir, 'remote', 'set-head', 'origin', '--auto');
        defaultBranch = git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim().replace(/^origin\//, '');
      } catch { /* handled below */ }
    }
    const branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    if (!defaultBranch) {
      failures++;
      bad(`${label}: can't resolve origin's default branch — refusing to push blind. Run: git -C ${dir} remote set-head origin --auto, then re-run`);
      continue;
    }
    if (branch !== defaultBranch) {
      failures++;
      bad(`${label}: checkout is on '${branch}' but origin's default branch is '${defaultBranch}' — refusing to commit/push. Run: git -C ${dir} checkout ${defaultBranch}, then re-run: npm run propagate`);
      continue;
    }
    const stale = BUNDLES.filter(b =>
      !existsSync(path.join(dir, c.dest, b)) || sha(path.join(dir, c.dest, b)) !== sha(path.join(PKG_ROOT, 'dist', b)));
    let committed = false;
    if (stale.length) {
      for (const b of stale) copyFileSync(path.join(PKG_ROOT, 'dist', b), path.join(dir, c.dest, b));
      git(dir, 'add', ...BUNDLES.map(b => path.join(c.dest, b)));
      // Copy may have merely restored local drift back to what's already committed.
      try { git(dir, 'diff', '--cached', '--quiet'); }
      catch {
        git(dir, 'commit', '-q', '-m',
          `chore: refresh Kiln bundles to kilncms/kiln@${kilnSha}\n\n(automated by scripts/propagate-bundles.mjs during deploy:prod)`);
        committed = true;
      }
    }
    // ALWAYS push (idempotent): a prior run may have committed and then failed
    // to push — a worktree-only "already current" check would report green while
    // the remote (and the live site) still runs old bundles. Explicit refspec:
    // upstream tracking is silently dropped by history rewrites (git-filter-repo).
    const out = git(dir, 'push', 'origin', 'HEAD', '--porcelain');
    const pushed = committed || !/^=/m.test(out || '=');
    ok(`${label}: ${committed ? stale.join(', ') + ' refreshed → pushed' : pushed ? 'pushed pending commits' : 'already current'}${pushed ? ' (Pages will redeploy)' : ''}`);
  } catch (err) {
    failures++;
    const detail = `${err.stderr || ''}\n${err.message || err}`;
    const hint = /non-fast-forward|fetch first|\[rejected\]/i.test(detail)
      ? ` — remote has commits this checkout lacks. Run: git -C ${dir} pull --rebase, then: npm run propagate`
      : '';
    bad(`${label}: ${String(err.message || err).split('\n')[0]}${hint} — this site is still running OLD bundles`);
  }
}

if (!found) info('no consumer checkouts on this machine — nothing to propagate');
if (failures) {
  bad(`${failures} consumer site(s) NOT updated — the deploy is incomplete. Fix and re-run: node scripts/propagate-bundles.mjs`);
  process.exit(1);
}
console.log('━━ All consumers current ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
