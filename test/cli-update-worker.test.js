/**
 * KLR-11 — `kiln update --worker`: a self-hoster brings the worker the setup
 * wizard made up to the current version with one command.
 *
 * Before this, `kiln update` refreshed only the editor on the pages. The
 * worker's code in kiln-worker/ stayed as the wizard first wrote it: running
 * the wizard again never replaces a file that exists, so the only way forward
 * was to copy files by hand.
 *
 * The real cli/index.mjs runs in a scratch site. `npx` and `npm` are small
 * scripts on a PATH of their own that write down how they were called, so no
 * wrangler runs and nothing is deployed; the network is the fetch stub.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'cli', 'index.mjs');
const STUB = path.join(ROOT, 'test', 'cli-fetch-stub.mjs');
const WORKER = 'https://kiln-auth.example.workers.dev';
const TOML = 'name = "kiln-auth"\nmain = "worker/index.js"\ncompatibility_date = "2026-06-01"\n\n[vars]\nALLOWED_ORIGINS = "https://club.example"\n\n[[kv_namespaces]]\nbinding = "KILN"\nid = "0123456789abcdef"\n';
const CURRENT = readFileSync(path.join(ROOT, 'worker', 'index.js'), 'utf8').match(/const WORKER_VERSION = '([^']+)'/)[1];
const OLD_INDEX = "const WORKER_VERSION = '0.3.0';\nexport default { fetch() { return new Response('old'); } };\n";
const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** A site with a worker folder as an older wizard left it, and stand-ins for npx and npm. */
function site({ worker = true, files = {}, deployFails = false, headers = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'kiln-update-worker-'));
  scratch.push(root);
  const dir = path.join(root, 'site');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'ran.log');
  mkdirSync(dir); mkdirSync(bin);
  const put = (f, text) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); };
  put('index.html', '<!doctype html><body><script src="/assets/kiln-config.js"></script><script src="/assets/kiln.js" defer></script></body>\n');
  put('assets/kiln-config.js', `window.KILN = {\n  repo:   'acme/site',\n  branch: 'main',\n  worker: '${WORKER}',\n  styles: [],\n};\n`);
  if (headers) put('_headers', '/*\n  X-Content-Type-Options: nosniff\n');   // as a site set up today has
  if (worker) {
    put('kiln-worker/wrangler.toml', TOML);
    put('kiln-worker/package.json', JSON.stringify({ name: 'kiln-worker', private: true, type: 'module', dependencies: { parse5: '^8.0.0' } }, null, 2) + '\n');
    put('kiln-worker/worker/index.js', OLD_INDEX);
    put('kiln-worker/worker/cloud.js', '// old cloud\n');
    put('kiln-worker/src/engine.js', readFileSync(path.join(ROOT, 'src', 'engine.js'), 'utf8'));   // one file that is already current
    put('kiln-worker/node_modules/parse5/package.json', '{}');
  }
  for (const [f, text] of Object.entries(files)) put(f, text);
  for (const tool of ['npx', 'npm']) {
    writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $* (in $(basename "$PWD"))" >> "${log}"\n`
      + (tool === 'npx' && deployFails ? 'echo "✘ [ERROR] Authentication error [code: 10000]"; exit 1\n' : 'echo "Deployed kiln-auth"\n'));
    chmodSync(path.join(bin, tool), 0o755);
  }
  const read = (f) => readFileSync(path.join(dir, f), 'utf8');
  return { dir, read, has: (f) => existsSync(path.join(dir, f)), ran: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    env: { ...process.env, NO_COLOR: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}

/** Run the CLI, giving the next answer each time it stops at a prompt. */
function run(s, args, answers, table = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', STUB, CLI, ...args], { cwd: s.dir, env: { ...s.env, KILN_TEST_FETCH: JSON.stringify(table) } });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    killer.unref();
    let out = ''; let seen = 0; let i = 0;
    const asked = [];
    child.stdout.on('data', (d) => {
      out += d;
      if (/: $/.test(out) && out.length > seen) {
        seen = out.length;
        asked.push(out.trimEnd().split('\n').pop().trim());
        if (i < answers.length) child.stdin.write(answers[i++] + '\n'); else child.stdin.end();
      }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ out, code, asked }); });
  });
}
const healthy = { [`${WORKER}/healthz`]: { json: { ok: true, modes: ['html', 'source'], version: CURRENT } } };

/** Every file reachable from `entry` through relative imports, as paths relative to `base`. */
function importsFrom(base, entry) {
  const seen = new Set();
  (function follow(rel) {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = readFileSync(path.join(base, rel), 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) follow(path.normalize(path.join(path.dirname(rel), m[1])));
  })(entry);
  return [...seen].sort();
}

test('KLR-11 update --worker: the worker folder ends up holding the current worker, file for file', async () => {
  const s = site();
  const r = await run(s, ['update', '--worker'], ['y', 'n']);
  assert.equal(r.code, 0, r.out);
  const needed = importsFrom(ROOT, path.join('worker', 'index.js'));
  assert.ok(needed.length >= 12, `the worker's own imports were followed (${needed.length} files)`);
  for (const f of needed) {
    assert.ok(s.has(path.join('kiln-worker', f)), `kiln-worker/${f} is there: the worker imports it`);
    assert.equal(s.read(path.join('kiln-worker', f)), readFileSync(path.join(ROOT, f), 'utf8'), `kiln-worker/${f} is the current one`);
  }
  // …so the folder is complete by its own imports, not only by this repository's.
  assert.deepEqual(importsFrom(path.join(s.dir, 'kiln-worker'), path.join('worker', 'index.js')), needed);
});

test('KLR-11 update --worker: it names what it will replace and add, and asks before writing', async () => {
  const s = site();
  const r = await run(s, ['update', '--worker'], ['y', 'n']);
  assert.match(r.out, new RegExp(`kiln-worker/ holds worker 0\\.3\\.0; this tool carries worker ${CURRENT.replace(/\./g, '\\.')}\\.`));
  assert.match(r.out, /replace {2}kiln-worker\/worker\/index\.js/);
  assert.match(r.out, /replace {2}kiln-worker\/worker\/cloud\.js/);
  assert.match(r.out, /add {6}kiln-worker\/src\/file-policy\.js/);
  assert.match(r.out, /add {6}kiln-worker\/worker\/sanitize-guard\.js/);
  assert.doesNotMatch(r.out, /kiln-worker\/src\/engine\.js/, 'a file that is already current is not listed');
  assert.match(r.out, /Not touched: kiln-worker\/wrangler\.toml \(your settings\), your secrets/);
  assert.match(r.asked[0], /^Replace these \d+ files with the current worker code\? \(y\/n\) \[y\]:$/);
  assert.match(r.out, new RegExp(`kiln-worker/ now holds worker ${CURRENT.replace(/\./g, '\\.')}`));
});

test('KLR-11 update --worker: wrangler.toml is never touched, and package.json only gains what the worker needs', async () => {
  const s = site();
  await run(s, ['update', '--worker'], ['y', 'n']);
  assert.equal(s.read('kiln-worker/wrangler.toml'), TOML);
  const pj = JSON.parse(s.read('kiln-worker/package.json'));
  assert.deepEqual(pj.dependencies, { parse5: '^8.0.0', yaml: '^2.0.0' }, 'yaml was added; parse5 was left as it was');
  assert.deepEqual(s.ran(), ['npm install --no-audit --no-fund (in kiln-worker)'], 'the new dependency is installed in the worker folder; nothing is deployed');
  // Nothing outside the worker folder changed.
  assert.ok(!s.has('assets/kiln.js'), 'the editor is the other command');
});

test('KLR-11 update --worker: saying no to the files writes nothing and deploys nothing', async () => {
  const s = site();
  const r = await run(s, ['update', '--worker'], ['n']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nothing was changed/);
  assert.equal(s.read('kiln-worker/worker/index.js'), OLD_INDEX);
  assert.ok(!s.has('kiln-worker/src/file-policy.js'));
  assert.deepEqual(s.ran(), []);
  assert.equal(r.asked.length, 1, 'the deploy question is not reached');
});

test('KLR-11 update --worker: saying no to the deploy leaves the running worker alone and says how to deploy later', async () => {
  const s = site();
  const r = await run(s, ['update', '--worker'], ['y', 'n']);
  assert.match(r.asked[1], /^Deploy it now\? \(runs: npx wrangler deploy, in kiln-worker\/\) \(y\/n\) \[y\]:$/);
  assert.match(r.out, /not deployed: your running worker is unchanged\. When you are ready: cd kiln-worker && npx wrangler deploy/);
  assert.equal(s.ran().some(l => /wrangler/.test(l)), false);
});

test('KLR-11 update --worker: a yes deploys from the worker folder, then reads the version back from the worker', async () => {
  const s = site();
  const r = await run(s, ['update', '--worker'], ['y', 'y'], healthy);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(s.ran().filter(l => /^npx/.test(l)), ['npx wrangler deploy (in kiln-worker)']);
  assert.match(r.out, new RegExp(`${WORKER.replace(/\./g, '\\.')}/healthz answers as worker ${CURRENT.replace(/\./g, '\\.')}`));
  assert.match(r.out, /Next, the editor on your pages: npx github:kilncms\/kiln#release update/);
  assert.match(r.out, /Worker first, then the editor/);
});

test('KLR-11 update --worker: a worker that still answers as the old version after the deploy is reported, not called done', async () => {
  const s = site();
  const r = await run(s, ['update', '--worker'], ['y', 'y'], { [`${WORKER}/healthz`]: { json: { ok: true, version: '0.3.0' } } });
  assert.match(r.out, new RegExp(`/healthz answers as worker 0\\.3\\.0, not ${CURRENT.replace(/\./g, '\\.')} yet`));
  const silent = await run(site(), ['update', '--worker'], ['y', 'y'], {});
  assert.match(silent.out, /did not answer \/healthz/);
});

test('KLR-11 update --worker: a deploy that fails exits 1 and says the running worker is unchanged', async () => {
  const s = site({ deployFails: true });
  const r = await run(s, ['update', '--worker'], ['y', 'y'], healthy);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the deploy did not go through, so your running worker is unchanged/);
  assert.match(r.out, /Authentication error/);
  assert.doesNotMatch(r.out, /✅ deployed/);
});

test('KLR-11 update --worker: a second run finds nothing to replace', async () => {
  const s = site();
  await run(s, ['update', '--worker'], ['y', 'n']);
  const again = await run(s, ['update', '--worker'], ['n']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /the worker code in kiln-worker\/ is already the current one — nothing to replace/);
  assert.equal(again.asked.length, 1, 'only the deploy question is asked');
  assert.match(again.asked[0], /^Deploy it now\?/);
});

test('KLR-11 update --worker: with no worker folder it explains itself, changes nothing and exits 1', async () => {
  const s = site({ worker: false });
  const r = await run(s, ['update', '--worker'], []);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /There is no self-hosted worker here: kiln-worker\/wrangler\.toml does not exist\./);
  assert.match(r.out, /On Kiln Cloud there is nothing to update: we run the worker\./);
  assert.ok(!s.has('kiln-worker'));
  assert.deepEqual(s.ran(), []);
});

test('KLR-11 update --worker=<folder>: a worker kept somewhere else is updated there', async () => {
  const s = site({ worker: false, files: { 'infra/auth/wrangler.toml': TOML, 'infra/auth/worker/index.js': OLD_INDEX, 'infra/auth/node_modules/parse5/package.json': '{}', 'infra/auth/node_modules/yaml/package.json': '{}' } });
  const r = await run(s, ['update', '--worker=infra/auth'], ['y', 'n']);
  assert.equal(r.code, 0, r.out);
  assert.equal(s.read('infra/auth/worker/index.js'), readFileSync(path.join(ROOT, 'worker', 'index.js'), 'utf8'));
  assert.ok(!s.has('kiln-worker'));
});

test('KLR-11 update --worker: a worker folder from the first layout is sent to the wizard, untouched', async () => {
  const flat = TOML.replace('main = "worker/index.js"', 'main = "index.js"');
  const s = site({ worker: false, files: { 'kiln-worker/wrangler.toml': flat, 'kiln-worker/index.js': OLD_INDEX } });
  const r = await run(s, ['update', '--worker'], []);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /has the layout of an early setup \(main = "index\.js"\)\. Run the setup wizard here once/);
  assert.equal(s.read('kiln-worker/wrangler.toml'), flat);
  assert.ok(!s.has('kiln-worker/worker'));
});

test('KLR-11 plain `kiln update` is what it was: the editor only, the worker folder untouched', async () => {
  const s = site();
  const r = await run(s, ['update'], ['n']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /copied the latest kiln\.js \+ kiln-editor\.js \+ kiln-features\.js into assets\//);
  assert.equal(s.read('kiln-worker/worker/index.js'), OLD_INDEX);
});

test('KLR-11 the help lists --worker under update, and another option is still refused by name', () => {
  const s = site();
  const kiln = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: s.dir, encoding: 'utf8', input: '', env: s.env });
  assert.match(kiln('--help').stdout, /update .*\n.*\n\s+--worker {2}self-hosted only: bring the worker in kiln-worker\/\n\s+up to date instead, and offer to deploy it/);
  const bad = kiln('update', '--force');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /kiln update has no option --force\. It takes: --worker\./);
});

test('KLN-07 update: a site set up before Kiln wrote a headers file is offered one, and one that has its own keeps it', async () => {
  const bare = site({ worker: false, headers: false });
  const yes = await run(bare, ['update'], ['y', 'n']);
  assert.equal(yes.code, 0, yes.out);
  assert.match(yes.out, /This site has no _headers file\. Kiln's sets security headers on every page: other sites cannot frame yours, and browsers use HTTPS only\./);
  assert.equal(bare.read('_headers'), readFileSync(path.join(ROOT, 'templates', '_headers'), 'utf8'));
  const no = site({ worker: false, headers: false });
  assert.equal((await run(no, ['update'], ['n', 'n'])).code, 0);
  assert.equal(no.has('_headers'), false, 'asked, and answered no: nothing written');
  const own = site({ worker: false, files: { _headers: '/*\n  X-Frame-Options: DENY\n' } });
  const r = await run(own, ['update'], ['n']);
  assert.doesNotMatch(r.out, /no _headers file/);
  assert.equal(own.read('_headers'), '/*\n  X-Frame-Options: DENY\n');
});
