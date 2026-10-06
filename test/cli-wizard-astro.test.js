/**
 * The setup wizard on an Astro site.
 *
 * Astro builds the site from src/ and copies public/ into the result as it
 * is. Nothing else in the repository reaches the built site, so the editor,
 * its config, the sign-in page and the headers file have to be under public/,
 * and the two script tags have to be in the template the pages are built
 * from. The real cli/index.mjs is run here through its Kiln Cloud route on a
 * scratch copy of test/fixtures/astro-min, answering each prompt as it comes.
 * (Building the result with Astro itself is not part of `npm test`: Astro is
 * not a dependency of this repository.)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'cli', 'index.mjs');
const STUB = path.join(ROOT, 'test', 'cli-fetch-stub.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'astro-min');
const PAGE = 'src/pages/index.astro';
const ORIGINAL = readFileSync(path.join(FIXTURE, PAGE), 'utf8');
const KILN_FILES = ['assets/kiln.js', 'assets/kiln-editor.js', 'assets/kiln-features.js', 'assets/kiln-config.js', 'kiln.html', '_headers'];
const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** A scratch copy of the Astro fixture in a git repo whose origin reads as GitHub. */
function astroSite(extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'kiln-wizard-astro-'));
  scratch.push(root);
  const dir = path.join(root, 'site');
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [f, text] of Object.entries(extra)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); }
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-b', 'main');
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) git('config', k, v);
  git('add', '-A'); git('commit', '-m', 'site');
  git('remote', 'add', 'origin', 'https://github.com/acme/site.git');
  const read = (f) => readFileSync(path.join(dir, f), 'utf8');
  const has = (f) => existsSync(path.join(dir, f));
  return { dir, git, read, has, changed: () => git('status', '--porcelain').stdout.trim().split('\n').filter(Boolean).map(l => l.slice(3)).sort() };
}

/** Run the CLI, giving the next answer each time it stops at a prompt. */
function run(cwd, args, answers, table = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', STUB, CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', KILN_TEST_FETCH: JSON.stringify(table) } });
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
// The Cloud route's prompts on an Astro site, in order: route [1], how the site
// is built [2], add the tags [y], auto-tag [n], commit [y].
const wizard = (dir, { tags = '', commit = 'n' } = {}) => run(dir, [], ['', '', tags, '', commit]);

test('wizard on an Astro site: the editor, its config, the sign-in page and the headers go under public/', async () => {
  const s = astroSite();
  const r = await wizard(s.dir);
  assert.equal(r.code, 0, r.out);
  for (const f of KILN_FILES) {
    assert.ok(s.has(`public/${f}`), `public/${f} was written`);
    assert.ok(!s.has(f), `${f} was not written at the top of the repository, where the build would leave it behind`);
  }
  const cfg = s.read('public/assets/kiln-config.js');
  assert.match(cfg, /repo:\s*'acme\/site',/);
  assert.match(cfg, /mode:\s*'source',/);
  assert.match(cfg, /adapter:\s*'astro',/);
  // The sign-in page names the files by the address the built site serves them at.
  assert.match(s.read('public/kiln.html'), /<script src="\/assets\/kiln-config\.js"><\/script>\n<script src="\/assets\/kiln\.js" defer><\/script>/);
  assert.equal(s.read('public/assets/kiln.js'), readFileSync(path.join(ROOT, 'dist', 'kiln.js'), 'utf8'));
});

test('wizard on an Astro site: it says where everything went, and why', async () => {
  const s = astroSite();
  const { out } = await wizard(s.dir);
  assert.match(out, /Astro copies public\/ into the built site as it is, so Kiln's files go there/);
  assert.match(out, /copied kiln\.js \+ kiln-editor\.js \+ kiln-features\.js into public\/assets\//);
  assert.match(out, /wrote public\/assets\/kiln-config\.js \(mode: 'source', adapter: 'astro'\)/);
  assert.match(out, /wrote public\/kiln\.html \(your \/kiln sign-in page\)/);
  assert.match(out, /wrote public\/_headers/);
  assert.doesNotMatch(out, /make sure assets\/ is copied into the build output/, 'the old hint is gone: the wizard did it');
});

test('wizard on an Astro site: the template that closes <body> gets the two script tags, written for Astro', async () => {
  const s = astroSite();
  const r = await wizard(s.dir, { tags: 'y' });
  assert.ok(r.asked.some(q => /^Add the two script tags to it now\?/.test(q)), r.asked.join(' | '));
  assert.match(r.out, /src\/pages\/index\.astro/);
  const page = s.read(PAGE);
  // `is:inline`: without it Astro tries to bundle a script it is meant to leave alone.
  assert.match(page, /\n<script is:inline src="\/assets\/kiln-config\.js"><\/script>\n<script is:inline src="\/assets\/kiln\.js" defer><\/script>\n<\/body>\n<\/html>\n$/);
  // …and nothing else in the template changed.
  assert.equal(page.replace(/<script is:inline [^\n]*\n/g, ''), ORIGINAL);
});

test('wizard on an Astro site: a second run changes nothing', async () => {
  const s = astroSite();
  await wizard(s.dir, { tags: 'y' });
  s.git('add', '-A'); s.git('commit', '-m', 'kiln');
  // The tags are there, so that question is not asked again: route, how built, auto-tag, commit.
  const again = await run(s.dir, [], ['', '', '', 'n']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /your layout already loads kiln\.js — nothing to add/);
  assert.equal(again.asked.some(q => /Add the two script tags/.test(q)), false);
  assert.deepEqual(s.changed(), []);
});

test('wizard on an Astro site: saying no leaves the template alone and says what that means', async () => {
  const s = astroSite();
  const r = await wizard(s.dir, { tags: 'n' });
  assert.equal(s.read(PAGE), ORIGINAL);
  assert.match(r.out, /not added\. Until the built pages have those two lines/);
  assert.ok(s.has('public/assets/kiln.js'), 'the files are still put in place');
});

test('wizard on an Astro site: every file it wrote, and the template, go into its commit', async () => {
  const s = astroSite();
  const r = await wizard(s.dir, { tags: 'y', commit: 'y' });   // the push has nowhere to go; the commit is what is checked
  assert.equal(r.code, 0, r.out);
  const committed = s.git('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort();
  assert.deepEqual(committed, [...KILN_FILES.map(f => `public/${f}`), PAGE, 'src/lib/kiln-astro.mjs'].sort());
});

test('wizard on an Astro site: the helper that marks fields is added as a file, since its package is not on npm', async () => {
  const s = astroSite();
  const r = await wizard(s.dir);
  assert.equal(s.read('src/lib/kiln-astro.mjs'), readFileSync(path.join(ROOT, 'integrations', 'astro', 'index.mjs'), 'utf8'));
  assert.match(r.out, /wrote src\/lib\/kiln-astro\.mjs \(the kilnSource and kilnBody helpers\)/);
  assert.doesNotMatch(r.out, /npm install @kilncms\/astro/, 'no instruction that ends in a 404');
  // One the project already has is the project's.
  const own = astroSite({ 'src/lib/kiln-astro.mjs': '// mine\n' });
  const again = await wizard(own.dir);
  assert.equal(own.read('src/lib/kiln-astro.mjs'), '// mine\n');
  assert.match(again.out, /src\/lib\/kiln-astro\.mjs already present \(left untouched\)/);
});

test('wizard on an Astro site: a publicDir named in astro.config is used instead of public/', async () => {
  const s = astroSite({ 'astro.config.mjs': "export default { publicDir: './static' };\n" });
  const r = await wizard(s.dir);
  assert.equal(r.code, 0, r.out);
  for (const f of KILN_FILES) assert.ok(s.has(`static/${f}`), `static/${f}`);
  assert.ok(!s.has('public'), 'nothing under public/');
  assert.match(r.out, /Astro copies static\/ into the built site as it is/);
});

test('wizard on an Astro site: settings an earlier run left at the top of the repository are carried over, and the old copies are named', async () => {
  const old = "window.KILN = {\n  repo:   'acme/site',\n  branch: 'main',\n  worker: 'https://worker.example',\n  mode:   'source',\n  adapter: 'astro',\n  styles: [{ label: 'Accent', class: 'accent' }],\n};\n";
  const s = astroSite({ 'assets/kiln-config.js': old, 'assets/kiln.js': '// old', 'kiln.html': '<!doctype html>' });
  const r = await wizard(s.dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(s.read('public/assets/kiln-config.js'), old, 'the settings are the owner\'s: copied, not rewritten');
  assert.match(r.out, /copied your settings from assets\/kiln-config\.js to public\/assets\/kiln-config\.js/);
  assert.match(r.out, /an earlier setup left Kiln's files at the top of the repository, where Astro does not publish them/);
  assert.match(r.out, /git rm assets\/kiln\.js assets\/kiln-config\.js kiln\.html/);
  assert.equal(s.read('assets/kiln.js'), '// old', 'nothing is deleted');
});

test('doctor on an Astro site reads the config from public/', async () => {
  const s = astroSite();
  await wizard(s.dir);
  const r = await run(s.dir, ['doctor', '--site', 'https://club.example'], []);
  assert.match(r.out, /read public\/assets\/kiln-config\.js \(repo=acme\/site, worker=https:\/\/auth\.kilncms\.com, mode=source\/astro\)/);
});

test('update on an Astro site refreshes the editor under public/', async () => {
  const s = astroSite();
  await wizard(s.dir);
  writeFileSync(path.join(s.dir, 'public/assets/kiln-editor.js'), '// an older editor');
  const r = await run(s.dir, ['update'], ['n']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /copied the latest kiln\.js \+ kiln-editor\.js \+ kiln-features\.js into public\/assets\//);
  assert.equal(s.read('public/assets/kiln-editor.js'), readFileSync(path.join(ROOT, 'dist', 'kiln-editor.js'), 'utf8'));
  assert.ok(!s.has('assets'), 'nothing is written at the top of the repository');
});
