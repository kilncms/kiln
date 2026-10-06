/**
 * KLR-19 — CI checks what ships. The workflow files are held to what the
 * release path relies on (scripts/release.mjs reads the check runs of a
 * commit), and the link checker is tested on small made-up trees.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { check, slug, linksIn, headingSlugs } from '../scripts/check-links.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WF = path.join(ROOT, '.github', 'workflows');
const load = (f) => YAML.parse(readFileSync(path.join(WF, f), 'utf8'));
const steps = (job) => job.steps.map(s => s.run || s.uses || '');
const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

test('KLR-19 ci.yml runs on every push and every pull request, with read-only permissions and no secret', () => {
  const text = readFileSync(path.join(WF, 'ci.yml'), 'utf8');
  const wf = load('ci.yml');
  assert.deepEqual(Object.keys(wf.on).sort(), ['pull_request', 'push']);
  assert.equal(wf.on.push, null, 'no branch filter: every branch');
  assert.equal(wf.on.pull_request, null);
  assert.deepEqual(wf.permissions, { contents: 'read' });
  assert.doesNotMatch(text, /secrets\./);
});

test('KLR-19 ci.yml: tests on Node 20 and 22; the build; and a job that fails when dist/ does not match the sources', () => {
  const { jobs } = load('ci.yml');
  assert.deepEqual(jobs.test.strategy.matrix.node, [20, 22]);
  assert.ok(steps(jobs.test).includes('npm ci') && steps(jobs.test).includes('npm test'));
  const dist = steps(jobs.dist).join('\n');
  assert.match(dist, /KILN_BUILD_VERSION="\$\(cat dist\/VERSION\)" npm run build/);
  assert.match(dist, /git diff --exit-code --stat -- dist/);
  assert.match(dist, /exit 1/);
});

test('KLR-19 ci.yml: the worker is bundled in all three configurations, mcp tests run, the CLI packs, audits and links are checked', () => {
  const { jobs } = load('ci.yml');
  const worker = jobs.worker.steps.filter(s => s.run && s.run.includes('wrangler')).map(s => s.run);
  assert.deepEqual(worker, ['npx wrangler deploy --dry-run', 'npx wrangler deploy --dry-run --env staging', 'npx wrangler deploy --dry-run --env production']);
  for (const run of worker) assert.match(run, /--dry-run/, 'CI never uploads a worker');
  const pk = jobs.packages.steps;
  assert.ok(pk.some(s => s['working-directory'] === 'mcp' && /npm ci\s+npm test/.test(s.run)));
  assert.ok(pk.some(s => s['working-directory'] === 'cli' && s.run === 'npm pack --dry-run'));
  assert.ok(pk.some(s => /node --check/.test(s.run || '')));
  const audits = jobs.audit.steps.filter(s => s.run);
  assert.deepEqual(audits.map(s => [s.run, s['working-directory'] || '.']), [['npm audit --audit-level=high', '.'], ['npm audit --audit-level=high', 'cli'], ['npm audit --audit-level=high', 'mcp']]);
  assert.ok(steps(jobs.links).includes('node scripts/check-links.mjs'));
});

test('KLR-19 no workflow deploys, publishes or pushes, and every action is pinned to a commit', () => {
  for (const f of readdirSync(WF).filter(n => /\.ya?ml$/.test(n))) {
    const text = readFileSync(path.join(WF, f), 'utf8');
    const wf = YAML.parse(text);
    assert.ok(wf.jobs && Object.keys(wf.jobs).length, f);
    assert.deepEqual(wf.permissions, { contents: 'read' }, f);
    for (const job of Object.values(wf.jobs)) {
      for (const s of job.steps) {
        if (s.uses) assert.match(s.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/, `${f}: ${s.uses} is not pinned to a commit`);
        const run = s.run || '';
        assert.doesNotMatch(run, /npm publish|git push|wrangler (deploy|versions|rollback|secret)(?!.*--dry-run)|release\.mjs|propagate/, `${f}: ${run}`);
        assert.doesNotMatch(run, /--remote/, `${f}: ${run}`);
      }
    }
  }
});

test('KLR-19 weekly.yml: web links and advisories of any severity, on a schedule and by hand', () => {
  const wf = load('weekly.yml');
  assert.match(wf.on.schedule[0].cron, /^\d+ \d+ \* \* \d$/);
  assert.ok('workflow_dispatch' in wf.on);
  assert.ok(steps(wf.jobs.links).includes('node scripts/check-links.mjs --external'));
  assert.ok(steps(wf.jobs.audit).includes('npm audit'));
});

// ─── the link checker ────────────────────────────────────────────────────────

function tree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'kiln-links-'));
  scratch.push(root);
  for (const [f, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), text); }
  return { root, files: Object.keys(files).filter(f => f.endsWith('.md')) };
}

test('KLR-19 link check: a missing file, a missing heading and a broken image are each reported with file and line', async () => {
  const t = tree({
    'README.md': '# Kiln\n\nSee [the guide](docs/guide.md), [setup](docs/guide.md#set-up), [gone](docs/nope.md),\n[no heading](docs/guide.md#not-there) and ![shot](img/missing.png).\n\n## Self-hosting\n\n[up](#kiln) [down](#self-hosting) [bad](#nowhere)\n',
    'docs/guide.md': '# Guide\n\n## Set up\n\nBack to [the readme](../README.md#self-hosting) or [root](/README.md).\n<a href="../img/logo.png">logo</a>\n',
    'img/logo.png': 'x',
  });
  const r = await check(t);
  assert.deepEqual(r.broken, [
    'README.md:3  docs/nope.md  (no such file)',
    'README.md:4  docs/guide.md#not-there  (no heading "#not-there" in docs/guide.md)',
    'README.md:4  img/missing.png  (no such file)',
    'README.md:8  #nowhere  (no heading "#nowhere" in README.md)',
  ]);
});

test('KLR-19 link check: code is not read as links; headings get GitHub\'s anchors', async () => {
  const t = tree({ 'a.md': '# A\n\n```md\n[not a link](nope.md)\n```\n\nInline `[x](nope.md)` too. A real one: [b](b.md#what-s-new-in-0-4).\n', 'b.md': "# B\n\n## What's new in 0.4?\n\n## Dup\n\n## Dup\n" });
  const r = await check(t);
  assert.deepEqual(r.broken, ['a.md:7  b.md#what-s-new-in-0-4  (no heading "#what-s-new-in-0-4" in b.md)'], 'GitHub drops the apostrophe and the dot: the anchor is #whats-new-in-04');
  assert.equal(slug("What's new in 0.4?"), 'whats-new-in-04');
  assert.equal(slug('The `kiln doctor` command'), 'the-kiln-doctor-command');
  assert.equal(slug('dev — local, nothing deployed'), 'dev--local-nothing-deployed');
  assert.deepEqual([...headingSlugs('# Dup\n## Dup\n### Dup')], ['dup', 'dup-1', 'dup-2']);
  assert.deepEqual(linksIn('[a](x.md "title") <img src="y.png"> [ref]: z.md').map(l => l.target), ['x.md', 'y.png']);
});

test('KLR-19 link check: web links are only requested with --external; a dead one fails, a login wall does not, example addresses are skipped', async () => {
  const t = tree({ 'a.md': '[ok](https://ok.test/a) [dead](https://dead.test/x) [wall](https://wall.test/) [down](https://down.test/) [ex](https://example.com/x) [local](http://localhost:8787/healthz)\n' });
  const asked = [];
  const fetchFn = async (url) => { asked.push(url); if (url.includes('down.test')) throw new Error('no route'); return { status: url.includes('dead.test') ? 404 : url.includes('wall.test') ? 403 : 200 }; };
  assert.deepEqual((await check({ ...t, fetchFn })).broken, []);
  assert.deepEqual(asked, [], 'offline by default');
  const r = await check({ ...t, external: true, fetchFn });
  assert.deepEqual(r.broken, ['a.md:1  https://dead.test/x  (answered 404)', 'a.md:1  https://down.test/  (did not answer)']);
  assert.deepEqual(asked.sort(), ['https://dead.test/x', 'https://down.test/', 'https://ok.test/a', 'https://wall.test/']);
});

test('KLR-19 link check: this repository\'s own markdown has no broken link', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-links.mjs')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /every link resolves/);
});
