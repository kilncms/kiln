#!/usr/bin/env node
/**
 * release — the only way a build reaches staging or production.
 *
 *   node scripts/release.mjs --staging     deploy this commit to staging
 *   node scripts/release.mjs               deploy it to production
 *   node scripts/release.mjs --dry-run     run every check, change nothing
 *   node scripts/release.mjs --hotfix      production, from a hotfix/* branch
 *
 * Production is refused unless ALL of these hold, checked in this order:
 *   1. the branch is main (or hotfix/* with --hotfix)
 *   2. the working tree is clean
 *   3. HEAD is exactly what origin has for that branch
 *   4. CI passed for that commit
 *   5. dist/ is what these sources build with dist/VERSION as the stamp
 *   6. staging /healthz reports this same commit
 * The first one that fails stops the run with one sentence saying what to do.
 *
 * Then: database migrations on production, an annotated tag prod-YYYY-MM-DD,
 * `wrangler deploy --env production` carrying the commit, the tag and a
 * message, a check that production now reports this commit, and the tag is
 * pushed. Bundles go to sites separately: `npm run propagate`.
 *
 * Everything that touches git, the network or wrangler goes through `io`, so
 * the tests drive this file with all three stubbed (test/release.test.js).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, cpSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STAGING_URL = 'https://kiln-auth-staging.erikkwilder.workers.dev';
export const PRODUCTION_URL = 'https://auth.kilncms.com';
const BUNDLES = ['kiln.js', 'kiln-editor.js', 'kiln-features.js', 'VERSION'];
const D1 = { staging: 'kiln-cloud-staging', production: 'kiln-cloud' };

/** A refusal is not a crash: one sentence, what to do next. */
export class Refusal extends Error {}
const refuse = (sentence) => { throw new Refusal(sentence); };

/** The real git, network and process calls. Tests pass their own. */
export function realIo() {
  return {
    git: (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    fetchJson: async (url, headers = {}) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'kiln-release', ...headers }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return res.json();
    },
    /** Run a command from `cwd` (relative to the repo), inheriting the terminal. Throws when it fails. */
    run: (cmd, args, cwd = '.') => {
      const r = spawnSync(cmd, args, { cwd: path.join(ROOT, cwd), stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
    },
    /** Rebuild with the committed stamp in a scratch copy; return the names of dist/ files that differ. */
    distDrift: () => {
      const stamp = readFileSync(path.join(ROOT, 'dist', 'VERSION'), 'utf8').trim();
      const dir = mkdtempSync(path.join(tmpdir(), 'kiln-release-'));
      try {
        cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
        cpSync(path.join(ROOT, 'scripts', 'build.mjs'), path.join(dir, 'scripts', 'build.mjs'), { recursive: true });
        cpSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
        symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
        const r = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, KILN_BUILD_VERSION: stamp } });
        if (r.status !== 0) throw new Error(`the build failed: ${r.stderr || r.stdout}`);
        return BUNDLES.filter(f => !existsSync(path.join(dir, 'dist', f))
          || !readFileSync(path.join(dir, 'dist', f)).equals(readFileSync(path.join(ROOT, 'dist', f))));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    log: (line) => console.log(line),
    now: () => new Date(),
    env: process.env,
  };
}

function repoSlug(io) {
  const url = io.git('remote', 'get-url', 'origin');
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  if (!m) refuse(`Refusing to release: origin (${url}) is not a GitHub repository this script can ask about CI. Point origin at the kilncms/kiln repository and run this again.`);
  return m[1];
}

/** The checks. Returns what the deploy steps need; throws Refusal at the first failure. */
export async function check(io, { target, hotfix = false }) {
  const branch = io.git('rev-parse', '--abbrev-ref', 'HEAD');
  const sha = io.git('rev-parse', 'HEAD');
  const short = sha.slice(0, 7);
  const dirty = io.git('status', '--porcelain').split('\n').filter(Boolean);

  if (target === 'production') {
    const allowed = branch === 'main' || (hotfix && /^hotfix\/[\w.-]+$/.test(branch));
    if (!allowed) {
      refuse(hotfix
        ? `Refusing to release: --hotfix releases a branch named hotfix/<something>, and you are on "${branch}". Create it from the last prod- tag (see ENVIRONMENTS.md) and run this again.`
        : `Refusing to release: you are on branch "${branch}", and production is released only from main. Merge your work to main, run \`git switch main\`, and run this again.`);
    }
  }
  if (dirty.length) {
    refuse(`Refusing to release: the working tree has ${dirty.length} uncommitted change${dirty.length > 1 ? 's' : ''} (${dirty[0].slice(3)}${dirty.length > 1 ? ', …' : ''}), so the build would not match any commit. Commit or stash them and run this again.`);
  }
  if (target === 'production') {
    // ls-remote asks origin directly: nothing local is trusted or changed.
    const remote = (io.git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/)[0] || '');
    if (remote !== sha) {
      refuse(remote
        ? `Refusing to release: HEAD is ${short} but origin/${branch} is ${remote.slice(0, 7)}. Run \`git push origin ${branch}\` if you are ahead, or \`git pull --ff-only\` if you are behind, and run this again.`
        : `Refusing to release: origin has no branch "${branch}". Run \`git push origin ${branch}\` and run this again.`);
    }
    const slug = repoSlug(io);
    const token = io.env.GITHUB_TOKEN || io.env.GH_TOKEN;
    let runs;
    try {
      runs = (await io.fetchJson(`https://api.github.com/repos/${slug}/commits/${sha}/check-runs?per_page=100`,
        { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) })).check_runs || [];
    } catch (err) {
      refuse(`Refusing to release: GitHub could not be asked whether CI passed for ${short} (${err.message}). Check https://github.com/${slug}/commit/${sha}/checks and, once GitHub answers, run this again.`);
    }
    const passed = (r) => r.status === 'completed' && ['success', 'skipped', 'neutral'].includes(r.conclusion);
    const state = !runs.length ? 'has not run' : runs.some(r => r.status !== 'completed') ? 'is still running'
      : runs.every(passed) ? 'passed' : `failed (${runs.filter(r => !passed(r)).map(r => r.name).join(', ')})`;
    if (state !== 'passed') {
      refuse(`Refusing to release: CI ${state} for ${short}. Wait for it or fix it at https://github.com/${slug}/commit/${sha}/checks and run this again.`);
    }
  }
  const drift = io.distDrift();
  if (drift.length) {
    refuse(`Refusing to release: dist/ is not what these sources build (${drift.join(', ')} differ${drift.length > 1 ? '' : 's'}), so sites would get an editor that matches no commit. Run \`npm run build\`, commit dist/, push, and run this again.`);
  }
  if (target === 'production') {
    let health;
    try { health = await io.fetchJson(`${STAGING_URL}/healthz`); }
    catch (err) {
      refuse(`Refusing to release: staging did not answer (${err.message}), so this build has not been seen running anywhere. Run \`npm run deploy:test\`, check staging, and run this again.`);
    }
    if (!health.build || !sha.startsWith(health.build)) {
      refuse(`Refusing to release: staging runs ${health.build ? `build ${health.build}` : 'a build that does not say what it is'}, not ${short}. Run \`npm run deploy:test\`, check the change on staging, and run this again.`);
    }
  }
  return { branch, sha, short, subject: io.git('log', '-1', '--format=%s') };
}

/** A tag name not used yet: prod-2026-10-06, then prod-2026-10-06.2, … */
function nextTag(io) {
  const base = `prod-${io.now().toISOString().slice(0, 10)}`;
  const taken = new Set(io.git('tag', '--list', `${base}*`).split('\n').filter(Boolean));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}.${n}`)) return `${base}.${n}`;
}

export async function release(io, { target = 'production', dryRun = false, hotfix = false } = {}) {
  const c = await check(io, { target, hotfix });
  const tag = target === 'production' ? nextTag(io) : `staging-${c.short}`;
  const message = `${tag}: ${c.subject}`.slice(0, 100);
  const url = target === 'production' ? PRODUCTION_URL : STAGING_URL;
  const wrangler = (...args) => ['npx', ['wrangler', ...args], 'worker'];
  const steps = [
    { say: `apply database migrations to ${target}`, cmd: wrangler('d1', 'migrations', 'apply', D1[target], '--env', target, '--remote') },
    ...(target === 'production' ? [{ say: `tag this commit ${tag}`, git: ['tag', '-a', tag, '-m', `Production release of ${c.short}: ${c.subject}`] }] : []),
    { say: `deploy ${c.short} to ${target}`, cmd: wrangler('deploy', '--env', target, '--var', `KILN_BUILD:${c.short}`, '--tag', tag, '--message', message) },
    { say: `confirm ${url}/healthz reports build ${c.short}`, verify: true },
    ...(target === 'production' ? [{ say: `push the tag ${tag}`, git: ['push', 'origin', tag] }] : []),
  ];
  if (dryRun) {
    io.log(`Every check passed for ${c.short} on ${c.branch}. A real run would:`);
    steps.forEach((s, i) => io.log(`  ${i + 1}. ${s.say}`));
    io.log('Dry run: nothing was changed.');
    return { ...c, tag, steps: steps.map(s => s.say), dryRun: true };
  }
  let tagged = false;
  let deployed = false;
  try {
    for (const s of steps) {
      io.log(`→ ${s.say}`);
      if (s.cmd) { io.run(...s.cmd); if (s.cmd[1][1] === 'deploy') deployed = true; }
      if (s.git) { io.git(...s.git); if (s.git[0] === 'tag') tagged = true; }
      if (s.verify) {
        const health = await io.fetchJson(`${url}/healthz`);
        if (!health.ok || !health.build || !c.sha.startsWith(health.build)) {
          throw new Error(`${url}/healthz reports build ${health.build || 'none'}, not ${c.short}`);
        }
      }
    }
  } catch (err) {
    // A tag must mean "this ran in production". Before the deploy it means nothing yet.
    if (tagged && !deployed) { try { io.git('tag', '-d', tag); } catch { /* leave it */ } }
    const next = deployed
      ? `The ${target} worker WAS replaced. Check ${url}/healthz now. To go back: \`cd worker && npx wrangler deployments list --env ${target}\`, then \`npx wrangler rollback <the version id before this one> --env ${target}\`.`
      : `Nothing was deployed to ${target}.`;
    throw new Error(`The release stopped at a failing step: ${err.message}. ${next}`);
  }
  io.log(`\n${target} now runs ${c.short} (${tag}).`);
  if (target === 'staging') io.log('Check the change on staging, then: npm run deploy:prod');
  else io.log('Sites still serve the editor they had. Next: `npm run propagate` (the demo first), then `npm run propagate -- --customers`.');
  return { ...c, tag, steps: steps.map(s => s.say), dryRun: false };
}

export function parseArgs(argv) {
  const known = new Set(['--staging', '--dry-run', '--hotfix']);
  const unknown = argv.filter(a => !known.has(a));
  if (unknown.length) refuse(`Unknown option ${unknown[0]}. Use: node scripts/release.mjs [--staging] [--dry-run] [--hotfix]`);
  if (argv.includes('--staging') && argv.includes('--hotfix')) refuse('--hotfix is for production: deploy a hotfix branch to staging with --staging alone.');
  return { target: argv.includes('--staging') ? 'staging' : 'production', dryRun: argv.includes('--dry-run'), hotfix: argv.includes('--hotfix') };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await release(realIo(), parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Refusal ? err.message : `✗ ${err.message}`);
    process.exit(err instanceof Refusal ? 2 : 1);
  }
}
