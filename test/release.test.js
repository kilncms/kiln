/**
 * KLR-01 — production cannot be reached by accident.
 *
 * scripts/release.mjs is driven here with git, the network and wrangler all
 * stubbed: nothing in these tests can deploy, tag, push or fetch. Each refusal
 * is one sentence that says what to do next.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { release, parseArgs, Refusal, STAGING_URL, PRODUCTION_URL } from '../scripts/release.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHA = 'abc1234def5678900000000000000000000000ff';

/** A world in which a production release is allowed. Override parts per test. */
function world(over = {}) {
  const w = {
    branch: 'main', dirty: '', remote: SHA, origin: 'https://github.com/kilncms/kiln.git',
    checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    drift: [], staging: { ok: true, build: 'abc1234' }, production: { ok: true, build: 'abc1234' },
    tags: [], failOn: null, ...over,
  };
  const ran = [];      // every git write and every command, in order
  const lines = [];
  const io = {
    git: (...a) => {
      const cmd = a.join(' ');
      if (cmd === 'rev-parse --abbrev-ref HEAD') return w.branch;
      if (cmd === 'rev-parse HEAD') return SHA;
      if (cmd === 'status --porcelain') return w.dirty;
      if (a[0] === 'ls-remote') return w.remote ? `${w.remote}\trefs/heads/${w.branch}` : '';
      if (cmd === 'remote get-url origin') return w.origin;
      if (a[0] === 'log') return 'worker: a fix';
      if (a[0] === 'tag' && a[1] === '--list') return w.tags.join('\n');
      ran.push(`git ${cmd}`);
      if (w.failOn && cmd.startsWith(w.failOn)) throw new Error(`git ${a[0]} failed`);
      return '';
    },
    fetchJson: async (url) => {
      if (url.includes('/check-runs')) { if (w.checkRuns === 'down') throw new Error('api.github.com answered 503'); return { check_runs: w.checkRuns }; }
      if (url === `${STAGING_URL}/healthz`) { if (w.staging === 'down') throw new Error('fetch failed'); return w.staging; }
      if (url === `${PRODUCTION_URL}/healthz`) return w.production;
      throw new Error(`unexpected fetch ${url}`);
    },
    run: (cmd, args, cwd) => {
      const line = `${cwd}$ ${cmd} ${args.join(' ')}`;
      ran.push(line);
      if (w.failOn && line.includes(w.failOn)) throw new Error(`${args[1]} failed (exit 1)`);
    },
    distDrift: () => w.drift,
    log: (l) => lines.push(l),
    now: () => new Date('2026-10-06T15:00:00Z'),
    env: {},
  };
  return { io, ran, lines };
}
async function refusal(over, opts = {}) {
  const { io, ran } = world(over);
  let err = null;
  try { await release(io, opts); } catch (e) { err = e; }
  assert.ok(err instanceof Refusal, `expected a refusal, got ${err && err.message}`);
  assert.deepEqual(ran, [], 'a refusal runs nothing: no migration, no tag, no deploy, no push');
  // One plain sentence that ends by saying what to do.
  assert.match(err.message, /^Refusing to release: /);
  assert.match(err.message, /run this again\.$/);
  assert.equal(err.message.includes('\n'), false);
  return err.message;
}

test('KLR-01 refuses: not on main', async () => {
  const m = await refusal({ branch: 'prod-ready-2026-10' });
  assert.match(m, /you are on branch "prod-ready-2026-10", and production is released only from main/);
  assert.match(m, /git switch main/);
});

test('KLR-01 refuses: the working tree is not clean', async () => {
  const m = await refusal({ dirty: ' M worker/index.js\n?? notes.txt' });
  assert.match(m, /2 uncommitted changes \(worker\/index\.js, …\)/);
  assert.match(m, /Commit or stash them/);
});

test('KLR-01 refuses: HEAD is not what origin/main points at (ahead, behind, or never pushed)', async () => {
  const m = await refusal({ remote: 'f'.repeat(40) });
  assert.match(m, /HEAD is abc1234 but origin\/main is fffffff/);
  assert.match(m, /git push origin main/);
  assert.match(await refusal({ remote: '' }), /origin has no branch "main"/);
});

test('KLR-01 refuses: CI is red, still running, never ran, or cannot be asked', async () => {
  assert.match(await refusal({ checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'dist', status: 'completed', conclusion: 'failure' }] }), /CI failed \(dist\) for abc1234/);
  assert.match(await refusal({ checkRuns: [{ name: 'test', status: 'in_progress', conclusion: null }] }), /CI is still running for abc1234/);
  assert.match(await refusal({ checkRuns: [] }), /CI has not run for abc1234/);
  assert.match(await refusal({ checkRuns: 'down' }), /GitHub could not be asked whether CI passed/);
  assert.match(await refusal({ checkRuns: [] }), /github\.com\/kilncms\/kiln\/commit\/abc1234def5678900000000000000000000000ff\/checks/);
  assert.match(await refusal({ origin: '/tmp/somewhere.git' }), /origin .* is not a GitHub repository/);
});

test('KLR-01 refuses: dist/ was not built from this commit', async () => {
  const m = await refusal({ drift: ['kiln-editor.js'] });
  assert.match(m, /dist\/ is not what these sources build \(kiln-editor\.js differs\)/);
  assert.match(m, /npm run build/);
});

test('KLR-01 refuses: staging does not report the same build, reports none, or does not answer', async () => {
  assert.match(await refusal({ staging: { ok: true, build: '9999999' } }), /staging runs build 9999999, not abc1234/);
  assert.match(await refusal({ staging: { ok: true } }), /a build that does not say what it is/);
  const m = await refusal({ staging: 'down' });
  assert.match(m, /staging did not answer/);
  assert.match(m, /npm run deploy:test/);
});

test('KLR-01 the checks run in order and stop at the first failure', async () => {
  // Everything is wrong at once: only the branch is mentioned.
  const m = await refusal({ branch: 'feature', dirty: ' M x', remote: '', checkRuns: [], drift: ['kiln.js'], staging: 'down' });
  assert.match(m, /you are on branch "feature"/);
  assert.doesNotMatch(m, /uncommitted|origin has no|CI|dist|staging/);
});

test('KLR-01 --dry-run with every check passing lists the steps and changes nothing', async () => {
  const { io, ran, lines } = world();
  const r = await release(io, { dryRun: true });
  assert.deepEqual(ran, []);
  assert.equal(r.tag, 'prod-2026-10-06');
  assert.match(lines.join('\n'), /Every check passed for abc1234 on main/);
  assert.match(lines.join('\n'), /Dry run: nothing was changed\./);
  assert.deepEqual(r.steps, [
    'apply database migrations to production', 'tag this commit prod-2026-10-06', 'deploy abc1234 to production',
    'confirm https://auth.kilncms.com/healthz reports build abc1234', 'push the tag prod-2026-10-06']);
});

test('KLR-01 a release: migrations, tag, deploy with the commit, tag and message, verify, push the tag — in that order', async () => {
  const { io, ran, lines } = world();
  await release(io, {});
  assert.deepEqual(ran, [
    'worker$ npx wrangler d1 migrations apply kiln-cloud --env production --remote',
    'git tag -a prod-2026-10-06 -m Production release of abc1234: worker: a fix',
    'worker$ npx wrangler deploy --env production --var KILN_BUILD:abc1234 --tag prod-2026-10-06 --message prod-2026-10-06: worker: a fix',
    'git push origin prod-2026-10-06',
  ]);
  assert.match(lines.join('\n'), /npm run propagate/);
  assert.equal(ran.some(l => /propagate|push origin main|--force/.test(l)), false, 'no site is touched and no branch is pushed');
});

test('KLR-01 a second release on the same day gets its own tag', async () => {
  const { io, ran } = world({ tags: ['prod-2026-10-06', 'prod-2026-10-06.2'] });
  await release(io, {});
  assert.ok(ran.includes('git push origin prod-2026-10-06.3'));
});

test('KLR-01 when a step fails: before the deploy nothing is left behind; after it the message says how to go back', async () => {
  const mig = world({ failOn: 'd1 migrations apply' });
  await assert.rejects(release(mig.io, {}), /stopped at a failing step.*Nothing was deployed to production\./s);
  assert.equal(mig.ran.length, 1, 'no tag, no deploy');
  const dep = world({ failOn: 'wrangler deploy' });
  await assert.rejects(release(dep.io, {}), /Nothing was deployed to production\./);
  assert.deepEqual(dep.ran.slice(-1), ['git tag -d prod-2026-10-06'], 'the tag is taken back');
  assert.equal(dep.ran.some(l => l.startsWith('git push')), false);
  const wrong = world({ production: { ok: true, build: '0000000' } });
  await assert.rejects(release(wrong.io, {}), /healthz reports build 0000000, not abc1234.*WAS replaced.*wrangler rollback <the version id before this one> --env production/s);
  assert.equal(wrong.ran.some(l => l.startsWith('git push')), false, 'an unverified deploy is not tagged on origin');
});

test('KLR-01 staging: any branch, but a clean tree and a matching dist/; deploys with --env staging and never tags', async () => {
  const { io, ran } = world({ branch: 'prod-ready-2026-10', remote: '', checkRuns: [], staging: { ok: true, build: 'abc1234' } });
  await release(io, { target: 'staging' });
  assert.deepEqual(ran, [
    'worker$ npx wrangler d1 migrations apply kiln-cloud-staging --env staging --remote',
    'worker$ npx wrangler deploy --env staging --var KILN_BUILD:abc1234 --tag staging-abc1234 --message staging-abc1234: worker: a fix',
  ]);
  assert.match(await refusal({ dirty: ' M x' }, { target: 'staging' }), /uncommitted change/);
  assert.match(await refusal({ drift: ['VERSION'] }, { target: 'staging' }), /dist\/ is not what these sources build/);
});

test('KLR-01 --hotfix releases a hotfix/* branch through the same checks, and nothing else', async () => {
  const ok = world({ branch: 'hotfix/login' });
  await release(ok.io, { hotfix: true });
  assert.ok(ok.ran.some(l => l.includes('wrangler deploy --env production')));
  assert.match(await refusal({ branch: 'hotfix/login' }), /released only from main/);
  assert.match(await refusal({ branch: 'feature/x' }, { hotfix: true }), /--hotfix releases a branch named hotfix/);
  assert.match(await refusal({ branch: 'hotfix/login', remote: 'f'.repeat(40) }, { hotfix: true }), /origin\/hotfix\/login is fffffff/);
});

test('KLR-01 options: unknown ones are refused by name', () => {
  assert.deepEqual(parseArgs([]), { target: 'production', dryRun: false, hotfix: false });
  assert.deepEqual(parseArgs(['--staging', '--dry-run']), { target: 'staging', dryRun: true, hotfix: false });
  assert.throws(() => parseArgs(['--force']), /Unknown option --force/);
  assert.throws(() => parseArgs(['--staging', '--hotfix']), Refusal);
});

test('KLR-01 on this checkout: `node scripts/release.mjs --dry-run` refuses unless it is a clean, pushed main, and exits 2', () => {
  const r = spawnSync(process.execPath, ['scripts/release.mjs', '--dry-run', '--nope'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown option --nope/);
});

test('KLR-01 package.json: deploy:prod and deploy:test go through the release script; there is no other deploy command', () => {
  const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['deploy:prod'], 'node scripts/release.mjs');
  assert.equal(scripts['deploy:test'], 'node scripts/release.mjs --staging');
  assert.equal('deploy:worker' in scripts, false);
  for (const [name, cmd] of Object.entries(scripts)) assert.doesNotMatch(cmd, /wrangler deploy/, `${name} deploys around the release script`);
});

test('KLR-01 wrangler.toml: the top level names no production route, KV or D1; production exists only under [env.production]', () => {
  const toml = readFileSync(path.join(ROOT, 'worker', 'wrangler.toml'), 'utf8');
  const at = (section) => toml.indexOf(`\n[${section}]\n`);
  const top = toml.slice(0, at('env.staging'));
  const prod = toml.slice(at('env.production'));
  const PROD = ['auth.kilncms.com', '376ca9e637724d9fabebbc24ba149814', 'a00713f4-3838-49fd-9e53-58961b1feb2e'];
  const code = (s) => s.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');   // comments may name them
  for (const id of PROD) {
    assert.equal(code(top).includes(id), false, `top level names ${id}`);
    assert.equal(code(toml.slice(at('env.staging'), at('env.production'))).includes(id), false, `staging names ${id}`);
    assert.equal(code(prod).includes(id), true, `production lacks ${id}`);
  }
  assert.doesNotMatch(code(top), /routes|custom_domain/);
  assert.match(code(top), /^name = "kiln-auth-local"$/m, 'a bare deploy cannot even replace the production script by name');
  assert.match(code(prod), /^name = "kiln-auth"$/m);
  assert.match(code(top), /^id = "0{32}"$/m);
});
