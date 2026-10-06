/**
 * KLR-20 — each npm package is one command from publishable: it packs, the
 * tarball has a licence, a readme and its bin, the manifest says what npm
 * needs, and packing leaves nothing behind.
 *
 * `npm pack --dry-run` is run for real, in a temporary copy of the repository
 * (packing vendors files into the package folder for a moment, which must not
 * happen under the other tests' feet). Nothing is published.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = (dir) => JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
const copy = mkdtempSync(path.join(tmpdir(), 'kiln-pack-'));
after(() => rmSync(copy, { recursive: true, force: true }));
for (const f of ['LICENSE', 'dist', 'worker', 'src', 'templates', 'scripts', 'cli', 'mcp', 'integrations']) {
  cpSync(path.join(ROOT, f), path.join(copy, f), { recursive: true, filter: (src) => !/node_modules|\.wrangler/.test(src) });
}
function pack(dir) {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: path.join(copy, dir), encoding: 'utf8', env: { ...process.env, npm_config_loglevel: 'error' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('[')))[0];
  return { files: out.files.map(f => f.path).sort(), mode: Object.fromEntries(out.files.map(f => [f.path, f.mode])), name: out.name, left: readdirSync(path.join(copy, dir)).sort() };
}
const gitMode = (file) => spawnSync('git', ['-C', ROOT, 'ls-files', '-s', file], { encoding: 'utf8' }).stdout.slice(0, 6);

test('KLR-20 create-kiln packs with everything the wizard copies, a readme, the licence, and an executable bin', () => {
  const p = pack('cli');
  assert.equal(p.name, 'create-kiln');
  for (const f of ['LICENSE', 'README.md', 'package.json', 'index.mjs', 'new.mjs', 'rescue.mjs', 'dist/kiln.js', 'dist/kiln-editor.js', 'dist/kiln-features.js', 'dist/VERSION',
    'worker/index.js', 'worker/cloud.js', 'worker/source.js', 'worker/sanitize-guard.js', 'src/engine.js', 'src/file-policy.js', 'src/autotag.js',
    'templates/_headers', 'templates/members-login.html', 'templates/functions/_kiln.js', 'templates/functions/members/_middleware.js', 'templates/functions/api/member-redeem-google.js']) {
    assert.ok(p.files.includes(f), `missing from the tarball: ${f}`);
  }
  assert.equal(p.files.some(f => /\.env|\.tgz$|node_modules|wrangler\.toml|\.test\./.test(f)), false);
  assert.equal(gitMode('cli/index.mjs'), '100755', 'the bin is executable in git');
  assert.deepEqual(manifest('cli').bin, { 'create-kiln': 'index.mjs' });
  assert.match(readFileSync(path.join(ROOT, 'cli', 'index.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  // Packing leaves the folder as it was: nothing vendored stays to shadow the repository's own files.
  assert.deepEqual(p.left, ['README.md', 'index.mjs', 'new.mjs', 'package-lock.json', 'package.json', 'prepack.mjs', 'render.mjs', 'rescue.mjs']);
});

test('KLR-20 kiln-mcp and @kilncms/astro pack with licence and readme, and say where they come from', () => {
  const mcp = pack('mcp');
  assert.deepEqual(mcp.files, ['LICENSE', 'README.md', 'index.mjs', 'lib.mjs', 'package.json']);
  assert.equal(mcp.left.includes('LICENSE'), false);
  assert.equal(gitMode('mcp/index.mjs'), '100755');
  const astro = pack('integrations/astro');
  assert.deepEqual(astro.files, ['LICENSE', 'README.md', 'index.mjs', 'package.json']);
  assert.equal(astro.left.includes('LICENSE'), false);
  for (const dir of ['cli', 'mcp', 'integrations/astro']) {
    const m = manifest(dir);
    assert.equal(m.license, 'AGPL-3.0-only', dir);
    assert.deepEqual(m.repository, { type: 'git', url: 'git+https://github.com/kilncms/kiln.git', directory: dir }, dir);
    assert.ok(m.homepage && m.bugs && m.bugs.url, dir);
    assert.equal(m.engines.node, '>=20', dir);
    assert.equal(m.private, undefined, dir);
  }
  // A scoped package is private by default and would be refused on a free account.
  assert.deepEqual(manifest('integrations/astro').publishConfig, { access: 'public' });
  assert.ok(manifest('integrations/astro').peerDependencies.astro);
});

test('KLR-20 the root package cannot be published by mistake, and nothing tells a user to run a stranger\'s `kiln` package', () => {
  const root = manifest('.');
  assert.equal(root.private, true);
  assert.equal(root.repository.url, 'git+https://github.com/kilncms/kiln.git');
  assert.deepEqual(root.bin, { kiln: 'cli/index.mjs' }, 'npx github:kilncms/kiln#release still finds its bin');
  for (const f of ['cli/index.mjs', 'cli/new.mjs', 'README.md', 'docs/for-site-owners.md', 'docs/self-hosting.md', 'docs/PUBLISHING.md', 'ENVIRONMENTS.md']) {
    const text = readFileSync(path.join(ROOT, f), 'utf8').replace(/may ever say `npx kiln …`/, '');
    assert.doesNotMatch(text, /npx kiln(\s|$|`)/m, `${f} says "npx kiln"`);
  }
  assert.equal(existsSync(path.join(ROOT, 'docs', 'PUBLISHING.md')), true);
  assert.match(readFileSync(path.join(ROOT, 'docs', 'PUBLISHING.md'), 'utf8'), /npm publish/);
});
