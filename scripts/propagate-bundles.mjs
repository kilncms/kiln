#!/usr/bin/env node
/**
 * propagate-bundles — copy the released dist/ bundles into the sites that
 * carry their own COPY of them (git-connected Pages projects with their own
 * repos), commit, and push, so that host redeploys.
 *
 * A customer's site must never be the first place a new editor runs, so this
 * is two steps and the second one is explicit:
 *
 *   npm run propagate                  the canary sites only (the demo)
 *   npm run propagate -- --customers   customer sites, and only once every
 *                                      canary's LIVE kiln.js carries the new stamp
 *   … --dry-run                        say what would happen; touch nothing
 *   … --consumers <file.json>          another list (the tests use this)
 *
 * Before a site is touched: the bundles must be a released build (dist/ as
 * committed, on a commit tagged prod-…); the checkout must be on its default
 * branch, clean, and have no commits of its own that origin lacks; it is
 * fetched and fast-forwarded first. A consumer marked { hold: true } or
 * { pin: '<stamp>' } is never written to. The run STOPS at the first failure:
 * sites after it are not touched. Every commit pushed is printed with the
 * exact command that takes it back.
 *
 * Canonical-instance tooling. With no consumer checkouts on the machine it
 * says so and exits cleanly. Not part of deploy:prod: the worker release
 * (scripts/release.mjs) changes no site.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BUNDLES = ['kiln.js', 'kiln-editor.js', 'kiln-features.js'];

// Every repo that carries a copy of the bundles, where they live inside it,
// and the public address of its kiln.js (how "is the canary live?" is checked).
//
//   kiln-demo      → kiln-demo.pages.dev, git-connected: a push deploys it.
//   demo.kilncms.com is NOT here. It is the Pages project kiln-demo-mr, which
//   is uploaded by hand and not connected to git, so a push to its repo deploys
//   nothing. Once that project is git-connected, add it as the first canary.
//
// Per consumer: { hold: true } leaves it alone; { pin: '<stamp>' } leaves it
// on that build (and says so if it has drifted from it).
export const DEFAULT_CONSUMERS = {
  canary: [
    { dir: '~/repos/kiln-demo', dest: 'assets', live: 'https://kiln-demo.pages.dev/assets/kiln.js' },
  ],
  customers: [
    { dir: '~/repos/npu-i', dest: 'assets/js' },
  ],
};

class Stop extends Error {}
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const expand = (d) => path.resolve(String(d).replace(/^~(?=\/)/, homedir()));
const stampIn = (text) => /KILN_VERSION\s*=\s*["']([\w.-]+)["']/.exec(text || '')?.[1] || null;

function gitIn(dir) {
  return (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Fetch a URL as text. file:// is read from disk, which is how the tests stand in for a live site. */
async function fetchText(url) {
  if (url.startsWith('file://')) return readFileSync(fileURLToPath(url), 'utf8');
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return res.text();
}

export function parseArgs(argv) {
  const opts = { customers: false, dryRun: false, consumers: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--customers') opts.customers = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--consumers' || a === '--root') {
      const v = argv[++i];
      if (!v) throw new Stop(`${a} needs a path.`);
      opts[a.slice(2)] = v;
    } else throw new Stop(`Unknown option ${a}. Use: propagate-bundles.mjs [--customers] [--dry-run] [--consumers <file.json>]`);
  }
  return opts;
}

/**
 * Run a propagation. Returns { pushed: [{ label, dir, branch, commit, revert }], skipped: [...] }.
 * Throws Stop (one sentence, what to do) at the first failure; `err.pushed`
 * then lists what had already gone out.
 */
export async function propagate(opts, log = console.log) {
  const root = path.resolve(opts.root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const list = opts.consumers ? JSON.parse(readFileSync(opts.consumers, 'utf8')) : DEFAULT_CONSUMERS;
  const canary = list.canary || [];
  const customers = list.customers || [];
  const kiln = gitIn(root);
  const pushed = [];
  const skipped = [];
  const stop = (sentence) => { const e = new Stop(sentence); e.pushed = pushed; throw e; };
  const verb = opts.dryRun ? 'would' : 'will';

  // ── The bundles must be a released build ──
  for (const b of [...BUNDLES, 'VERSION']) {
    if (!existsSync(path.join(root, 'dist', b))) stop(`dist/${b} is missing. Run \`npm run build\`, commit, release, then run this again.`);
  }
  const stamp = readFileSync(path.join(root, 'dist', 'VERSION'), 'utf8').trim();
  if (stampIn(readFileSync(path.join(root, 'dist', 'kiln.js'), 'utf8')) !== stamp) {
    stop(`dist/kiln.js does not carry the stamp in dist/VERSION (${stamp}): dist/ is from two different builds. Run \`npm run build\`, commit, release, then run this again.`);
  }
  if (kiln('status', '--porcelain', '--', 'dist')) {
    stop('dist/ has changes that are not committed, so these bundles are not the ones that were released. Run `git checkout -- dist` (or commit and release them), then run this again.');
  }
  const head = kiln('rev-parse', '--short', 'HEAD');
  const tags = kiln('tag', '--points-at', 'HEAD', '--list', 'prod-*').split('\n').filter(Boolean);
  if (!tags.length) {
    stop(`This commit (${head}) has no prod- tag, so it is not a build that was released to production. Release it first (\`npm run deploy:prod\`), or check out the released tag, then run this again.`);
  }
  log(`\nPropagating editor build ${stamp} (${tags[0]}, kilncms/kiln@${head}) to ${opts.customers ? 'CUSTOMER sites' : 'canary sites'}${opts.dryRun ? ' — dry run, nothing is touched' : ''}`);

  // ── Customers only after the canary is live on this build ──
  if (opts.customers) {
    const live = canary.filter(c => !c.hold && !c.pin);
    if (!live.length) stop('There is no canary site to check first, so customer sites are not touched. Add one under "canary", propagate to it, then run this again.');
    for (const c of live) {
      const label = path.basename(expand(c.dir));
      if (!c.live) stop(`The canary ${label} has no "live" address to check, so customer sites are not touched. Add it to the consumer list and run this again.`);
      let text = '';
      try { text = await fetchText(c.live); }
      catch (err) { stop(`The canary ${c.live} could not be read (${err.message}), so customer sites are not touched. Check the demo is up, then run this again.`); }
      const serving = stampIn(text);
      if (serving !== stamp) {
        stop(`The canary ${c.live} serves build ${serving || 'unknown'}, not ${stamp}, so customer sites are not touched. Run \`npm run propagate\`, wait for the demo to deploy, try it, then run this again.`);
      }
      log(`  ✓ canary ${label} is live on ${stamp}`);
    }
  }

  let found = 0;
  for (const c of opts.customers ? customers : canary) {
    const dir = expand(c.dir);
    const label = path.basename(dir);
    if (c.hold) { skipped.push({ label, why: 'held' }); log(`  · ${label}: on hold — not touched`); continue; }
    if (!existsSync(path.join(dir, '.git'))) {
      skipped.push({ label, why: 'no checkout' });
      log(`  · ${label}: no checkout at ${c.dir} — skipped (fine on a machine that does not keep one)`);
      continue;
    }
    found++;
    const git = gitIn(dir);
    const destFile = (b) => path.join(dir, c.dest, b);
    if (c.pin) {
      const has = existsSync(destFile('kiln.js')) ? stampIn(readFileSync(destFile('kiln.js'), 'utf8')) : null;
      skipped.push({ label, why: `pinned at ${c.pin}` });
      log(`  · ${label}: pinned at ${c.pin} — not touched${has && has !== c.pin ? ` (it currently has ${has}, which is not its pin)` : ''}`);
      continue;
    }
    try {
      let branch = '';
      try { branch = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, ''); }
      catch { stop(`${label}: origin's default branch is not known in this checkout. Run \`git -C ${dir} remote set-head origin --auto\` and run this again.`); }
      const on = git('rev-parse', '--abbrev-ref', 'HEAD');
      if (on !== branch) stop(`${label}: the checkout is on "${on}", not its default branch "${branch}". Run \`git -C ${dir} switch ${branch}\` and run this again.`);
      if (git('status', '--porcelain')) stop(`${label}: the checkout has uncommitted changes. Commit or stash them in ${dir} and run this again.`);

      // Bring the checkout up to origin, and make sure it holds nothing of its
      // own: a push would publish those commits along with the bundles.
      if (!opts.dryRun) git('fetch', '--quiet', 'origin', branch);
      const remote = opts.dryRun ? (git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/)[0] || '') : git('rev-parse', `origin/${branch}`);
      const local = git('rev-parse', 'HEAD');
      const known = (() => { try { git('cat-file', '-e', `${remote}^{commit}`); return true; } catch { return false; } })();
      const ahead = known ? git('rev-list', `${remote}..HEAD`).split('\n').filter(Boolean) : [];
      if (ahead.length) {
        stop(`${label}: the checkout has ${ahead.length} commit${ahead.length > 1 ? 's' : ''} of its own that origin/${branch} does not (${ahead[0].slice(0, 7)}), and pushing the bundles would publish ${ahead.length > 1 ? 'them' : 'it'} too. Push or remove ${ahead.length > 1 ? 'them' : 'it'} yourself in ${dir}, then run this again.`);
      }
      if (remote !== local) {
        if (opts.dryRun) log(`  · ${label}: would fast-forward ${local.slice(0, 7)} → ${remote.slice(0, 7)} from origin first`);
        else {
          try { git('merge', '--ff-only', '--quiet', `origin/${branch}`); }
          catch { stop(`${label}: the checkout cannot be fast-forwarded to origin/${branch}. Sort that out in ${dir} (git status), then run this again.`); }
        }
      }

      const stale = opts.dryRun && remote !== local ? BUNDLES   // cannot know before the fast-forward
        : BUNDLES.filter(b => !existsSync(destFile(b)) || sha256(destFile(b)) !== sha256(path.join(root, 'dist', b)));
      if (!stale.length) { skipped.push({ label, why: 'already current' }); log(`  ✓ ${label}: already on ${stamp}`); continue; }
      if (opts.dryRun) {
        log(`  · ${label}: ${verb} copy ${stale.join(', ')} into ${c.dest}/, commit, and push to origin/${branch}`);
        continue;
      }
      for (const b of stale) copyFileSync(path.join(root, 'dist', b), destFile(b));
      git('add', '--', ...BUNDLES.map(b => path.join(c.dest, b)));
      git('commit', '-q', '-m', `chore: refresh Kiln bundles to ${stamp} (kilncms/kiln@${head}, ${tags[0]})`, '--', ...BUNDLES.map(b => path.join(c.dest, b)));
      const commit = git('rev-parse', 'HEAD');
      try { git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`); }
      catch (err) {
        // The commit exists only here. Take it back so the checkout is as it was.
        git('reset', '--quiet', '--hard', 'HEAD~1');
        stop(`${label}: the push to origin/${branch} was refused (${String(err.stderr || err.message).trim().split('\n').pop()}); the local commit was undone and the site still runs its old bundles. Look at ${dir}, then run this again.`);
      }
      const revert = `git -C ${dir} revert --no-edit ${commit.slice(0, 12)} && git -C ${dir} push origin HEAD:${branch}`;
      pushed.push({ label, dir, branch, commit, revert });
      log(`  ✓ ${label}: ${stale.join(', ')} → pushed ${commit.slice(0, 7)} to origin/${branch} (its host will redeploy)`);
      log(`      to take it back: ${revert}`);
    } catch (err) {
      if (err instanceof Stop) throw err;
      stop(`${label}: ${String(err.stderr || err.message || err).trim().split('\n')[0]}. Look at ${dir}, then run this again.`);
    }
  }

  if (!found && !skipped.some(s => s.why === 'held')) log('  · no consumer checkouts on this machine — nothing to propagate');
  if (opts.dryRun) log('Dry run: nothing was fetched, copied, committed or pushed.');
  else if (!opts.customers && pushed.length) log(`\nNext: wait for the demo to deploy, try it, then \`npm run propagate -- --customers\`.`);
  return { stamp, pushed, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    // A test run must name its own consumer list: it can never reach the real checkouts.
    if (process.env.NODE_TEST_CONTEXT && !opts.consumers) throw new Stop('Under the test runner this script needs --consumers <file>.');
    await propagate(opts);
  } catch (err) {
    console.error(`\n  ✗ ${err.message}`);
    if (err.pushed && err.pushed.length) {
      console.error('\n  Already pushed before this stopped (later sites were NOT touched):');
      for (const p of err.pushed) console.error(`    ${p.label} ${p.commit.slice(0, 7)} — to take it back: ${p.revert}`);
    } else if (err instanceof Stop) console.error('  Nothing was pushed.');
    process.exit(1);
  }
}
