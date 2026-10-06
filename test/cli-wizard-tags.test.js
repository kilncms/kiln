/**
 * KLR-04 — the setup wizard adds the two script tags itself.
 *
 * Before this, the Cloud quick start ended at a site whose pages did not load
 * the editor: sign in at /kiln, land on a plain page, no error. The real
 * cli/index.mjs is run here through its Kiln Cloud route in a scratch site (a
 * git repo whose origin looks like GitHub), answering each prompt as it comes.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'cli', 'index.mjs');
const STUB = path.join(ROOT, 'test', 'cli-fetch-stub.mjs');
const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

const page = (title, extra = '') => `<!doctype html>\n<html>\n<head><title>${title}</title></head>\n<body>\n  <h1>${title}</h1>\n${extra}</body>\n</html>\n`;
const TAGS = '<script src="/assets/kiln-config.js"></script>\n<script src="/assets/kiln.js" defer></script>\n';

/** A plain-HTML site in a git repo. origin reads as GitHub; pushes go to a local bare repo. */
function site(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'kiln-wizard-'));
  scratch.push(root);
  const dir = path.join(root, 'site');
  mkdirSync(dir);
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['init', '--bare', '-b', 'main', path.join(root, 'origin.git')], { encoding: 'utf8' });
  git('init', '-b', 'main');
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) git('config', k, v);
  for (const [f, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); }
  git('add', '-A'); git('commit', '-m', 'site');
  git('remote', 'add', 'origin', 'https://github.com/acme/site.git');
  git('config', 'remote.origin.pushurl', path.join(root, 'origin.git'));
  git('push', '-u', 'origin', 'main');
  return { dir, git, read: (f) => readFileSync(path.join(dir, f), 'utf8'), count: (f) => (readFileSync(path.join(dir, f), 'utf8').match(/kiln\.js/g) || []).length };
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
// The Cloud route's prompts, in order: route [1], add the tags [y], auto-tag [n], commit [y].
const cloud = (dir, { tags = '', commit = 'n' } = {}) => run(dir, [], ['', tags, '', commit]);

test('KLR-04 wizard, Kiln Cloud route: every page that lacks them gets the two script tags, before </body>', async () => {
  const s = site({ 'index.html': page('Home'), 'blog/first.html': page('First post'), 'about/index.html': page('About') });
  const pages = ['index.html', 'blog/first.html', 'about/index.html'];
  assert.deepEqual(pages.map(s.count), [0, 0, 0], 'before: no page loads kiln.js');
  const r = await cloud(s.dir);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.asked.map(q => q.replace(/\s*\[.*$/, '')), ['Choose 1 or 2', 'Add the two script tags to these 3 pages now? (y/n)', 'Run the first-pass auto-tagger now? (review with git diff after) (y/n)', 'Commit and push the Kiln wiring now? (y/n)']);
  assert.deepEqual(pages.map(s.count), [1, 1, 1], 'after: every page loads kiln.js once');
  assert.equal(s.count('kiln.html'), 1, 'the sign-in page the wizard wrote');
  // The files are named before the question, and the tags sit right before </body>.
  for (const f of ['about/index.html', 'blog/first.html', 'index.html']) assert.match(r.out, new RegExp(`^     ${f.replace('.', '\\.')}$`, 'm'));
  assert.match(r.out, /added the two script tags to 3 pages/);
  assert.equal(s.read('index.html'), page('Home').replace('</body>', `${TAGS}</body>`));
  assert.ok(s.read('blog/first.html').indexOf('kiln-config.js') < s.read('blog/first.html').indexOf('kiln.js" defer'), 'config first');
  assert.doesNotMatch(r.out, /No page loads kiln\.js yet/);
});

test('KLR-04 a second run changes nothing', async () => {
  const s = site({ 'index.html': page('Home'), 'blog/first.html': page('First post') });
  await cloud(s.dir);
  s.git('add', '-A'); s.git('commit', '-m', 'kiln');
  const again = await run(s.dir, [], ['', '', 'n']);   // no tag question this time: route, auto-tag, commit
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /all 2 pages already load kiln\.js — nothing to add/);
  assert.equal(again.asked.some(q => /script tags/.test(q)), false, 'nothing to offer');
  assert.equal(s.git('status', '--porcelain').stdout, '', 'not one byte changed');
  assert.deepEqual(['index.html', 'blog/first.html'].map(s.count), [1, 1]);
});

test('KLR-04 a page that already loads kiln.js is never touched, wherever it loads it from', async () => {
  const mine = page('Mine', '  <script src="/static/js/kiln-config.js"></script>\n  <script defer src="/static/js/kiln.js?v=3"></script>\n');
  const s = site({ 'index.html': mine, 'other.html': page('Other'), 'half.html': page('Half', '<script src="/assets/kiln-config.js"></script>\n') });
  const r = await cloud(s.dir);
  assert.equal(s.read('index.html'), mine, 'byte for byte');
  assert.match(r.out, /Add the two script tags to these 2 pages now\?/);
  assert.match(r.out, /1 page already loads kiln\.js — left untouched/);
  assert.equal(s.count('other.html'), 1);
  // A page that has the config line but not the editor gets only the missing one.
  assert.equal((s.read('half.html').match(/kiln-config\.js/g) || []).length, 1);
  assert.equal(s.count('half.html'), 1);
});

test('KLR-04 only the site\'s own pages: not assets, build folders, node_modules, or Kiln\'s own two pages', async () => {
  const s = site({
    'index.html': page('Home'), 'members-login.html': page('Members'), 'assets/widget.html': page('Widget'),
    'node_modules/pkg/demo.html': page('Demo'), 'dist/index.html': page('Built'), '_site/index.html': page('Built'), '.cache/x.html': page('Cache'),
  });
  await cloud(s.dir);
  assert.equal(s.count('index.html'), 1);
  for (const f of ['members-login.html', 'assets/widget.html', 'node_modules/pkg/demo.html', 'dist/index.html', '_site/index.html', '.cache/x.html']) assert.equal(s.count(f), 0, f);
});

test('KLR-04 odd pages: no </body> is reported and left alone; Windows line endings and indentation are kept', async () => {
  const crlf = '<!doctype html>\r\n<html>\r\n<body>\r\n\t<p>Hi</p>\r\n\t</body>\r\n</html>\r\n';
  const inline = '<html><body><p>One line</p></body></html>';
  const s = site({ 'fragment.html': '<h1>No body tag at all</h1>\n', 'crlf.html': crlf, 'inline.html': inline, 'upper.html': '<HTML><BODY>\n<P>Old</P>\n</BODY></HTML>\n' });
  const r = await cloud(s.dir);
  assert.match(r.out, /Add the two script tags to these 3 pages now\?/);
  assert.match(r.out, /1 page has no <\/body> to put them before — add the two lines by hand: fragment\.html/);
  assert.equal(s.read('fragment.html'), '<h1>No body tag at all</h1>\n');
  assert.equal(s.read('crlf.html'), crlf.replace('\t</body>', '\t<script src="/assets/kiln-config.js"></script>\r\n\t<script src="/assets/kiln.js" defer></script>\r\n\t</body>'));
  assert.equal(s.read('inline.html'), `<html><body><p>One line</p>\n${TAGS}</body></html>`);
  assert.equal(s.read('upper.html'), `<HTML><BODY>\n<P>Old</P>\n${TAGS}</BODY></HTML>\n`);
});

test('KLR-04 saying no writes nothing to the pages and says what that means', async () => {
  const s = site({ 'index.html': page('Home') });
  const r = await cloud(s.dir, { tags: 'n' });
  assert.equal(s.read('index.html'), page('Home'));
  assert.match(r.out, /not added\. Until a page has those two lines, signing in at \/kiln brings you back to it with no editor\./);
});

test('KLR-04 the pages go into the wizard\'s commit with the rest of the Kiln files', async () => {
  const s = site({ 'index.html': page('Home'), 'blog/first.html': page('First post'), 'notes.txt': 'mine' });
  writeFileSync(path.join(s.dir, 'secret.env'), 'TOKEN=1');   // a stray file: never swept into the commit
  const r = await cloud(s.dir, { commit: 'y' });
  assert.equal(r.code, 0, r.out);
  const committed = s.git('show', '--name-only', '--format=%s', 'HEAD').stdout.trim().split('\n');
  assert.equal(committed[0], 'Add Kiln (Cloud)');
  for (const f of ['index.html', 'blog/first.html', 'kiln.html', 'assets/kiln.js', 'assets/kiln-config.js']) assert.ok(committed.includes(f), f);
  assert.equal(committed.includes('secret.env'), false);
  assert.match(s.git('status', '--porcelain').stdout, /^\?\? secret\.env$/m);
});

test('KLR-04 a site built by a generator is told where the tags go instead of having built pages edited', async () => {
  const s = site({ 'astro.config.mjs': 'export default {};\n', 'src/content/blog/a.md': '---\ntitle: A\n---\nHi\n', 'src/pages/index.astro': '<h1>Hi</h1>\n', 'package.json': '{"dependencies":{"astro":"^5.0.0"}}\n' });
  // route [1], then the "how is this site built" question is answered with its default, then auto-tag and commit.
  const r = await run(s.dir, [], ['', '', '', 'n']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /mode: 'source'/, 'the wizard took this for a generated site');
  assert.match(r.out, /put them in your base layout so every generated page loads them/);
  assert.equal(r.asked.some(q => /Add the two script tags/.test(q)), false);
  assert.equal(existsSync(path.join(s.dir, 'src/pages/index.astro')), true);
  assert.equal(readFileSync(path.join(s.dir, 'src/pages/index.astro'), 'utf8'), '<h1>Hi</h1>\n');
});

// ─── doctor ──────────────────────────────────────────────────────────────────

const SITE = 'https://club.example';
const WORKER = 'https://worker.example';
const REPO = 'kiln-doctor-test-no-such-owner/club';
const network = (home) => ({
  [`${WORKER}/healthz`]: { json: { ok: true, modes: ['html', 'source'] } },
  [`${WORKER}/setup/status`]: { json: { configured: true, slug: 'kiln-test-app' } },
  [`${WORKER}/setup/install-check`]: { json: { installed: true } },
  [`${WORKER}/auth/refresh`]: { status: 204, headers: { 'Access-Control-Allow-Origin': SITE } },
  [`${WORKER}/google/login`]: { status: 403, body: 'x', headers: { 'Content-Type': 'text/html' } },
  'https://github.com/apps/kiln-test-app': { body: 'ok', headers: { 'Content-Type': 'text/html' } },
  [`https://api.github.com/repos/${REPO}`]: { json: { full_name: REPO } },
  [`${SITE}/members/`]: { status: 404, body: '' },
  [`${SITE}/assets/kiln.js`]: { body: 'var KILN_VERSION="abc1234";', headers: { 'Content-Type': 'text/javascript' } },
  [SITE]: { body: home, headers: { 'Content-Type': 'text/html' } },
  'https://raw.githubusercontent.com/kilncms/kiln/': { body: 'abc1234\n', headers: { 'Content-Type': 'text/plain' } },
});

test('KLR-04 doctor fails when the home page does not load kiln.js, even though the file is on the server', async () => {
  const s = site({ 'index.html': page('Home') });
  const args = ['doctor', '--site', SITE, '--repo', REPO, '--worker', WORKER];
  const bad = await run(s.dir, args, [], network(page('Home')));
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /❌ home page loads kiln\.js — the home page has no <script> for kiln\.js, so the editor never starts\./);
  assert.match(bad.out, /<script src="\/assets\/kiln\.js" defer><\/script>/);
  const good = await run(s.dir, args, [], network(page('Home').replace('</body>', `${TAGS}</body>`)));
  assert.match(good.out, /✅ home page loads kiln\.js/);
  assert.doesNotMatch(good.out, /❌ home page loads kiln\.js/);
});
