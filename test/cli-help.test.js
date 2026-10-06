/**
 * KLR-21 — the CLI's first-run rough edges.
 *
 * Help exists, matches the commands that exist, and never runs anything:
 * before this, `kiln --help` and any typo started the setup wizard, and
 * `kiln tag --help` rewrote the pages in the current folder. The real
 * cli/index.mjs is spawned in a scratch site for every case.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshBundles } from '../cli/new.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'cli', 'index.mjs');
const STUB = path.join(ROOT, 'test', 'cli-fetch-stub.mjs');
const SOURCE = readFileSync(CLI, 'utf8');
const PAGE = '<!doctype html>\n<html><head><title>Home</title></head>\n<body>\n<h1>Welcome</h1>\n<p>Some text here.</p>\n<img src="a.png" alt="A">\n</body>\n</html>\n';
const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** A scratch site in a git repo, so "did anything change?" is one `git status`. */
function site(files = { 'index.html': PAGE, 'about.html': PAGE }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-help-'));
  scratch.push(dir);
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-b', 'main');
  for (const [k, v] of [['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) git('config', k, v);
  for (const [f, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); }
  git('add', '-A'); git('commit', '-m', 'site');
  return { dir, status: () => git('status', '--porcelain').stdout };
}
/** Run the CLI with NO input at all: anything that prompts fails instead of hanging. */
function kiln(cwd, args, { table } = {}) {
  const r = spawnSync(process.execPath, [...(table ? ['--import', STUB] : []), CLI, ...args], {
    cwd, encoding: 'utf8', input: '', timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', ...(table ? { KILN_TEST_FETCH: JSON.stringify(table) } : {}) },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
const isHelp = (text) => /Usage: npx github:kilncms\/kiln#release \[command\] \[options\]/.test(text);

test('KLR-21 --help, -h and help print the help block, exit 0, ask nothing and change nothing', () => {
  const s = site();
  for (const arg of ['--help', '-h', 'help']) {
    const r = kiln(s.dir, [arg]);
    assert.equal(r.code, 0, `${arg}: ${r.all}`);
    assert.ok(isHelp(r.out), arg);
    assert.doesNotMatch(r.all, /Kiln setup|Choose 1 or 2|Input ended/, `${arg} must not start the wizard`);
    assert.equal(s.status(), '', arg);
  }
  assert.ok(kiln(s.dir, ['--help']).out.split('\n').length <= 40, 'short enough to read');
});

test('KLR-21 an unknown command prints the help and exits 2; the wizard never starts on a typo', () => {
  const s = site();
  for (const typo of ['docter', 'install', 'deploy', '--yes', '-x', 'Doctor']) {
    const r = kiln(s.dir, [typo]);
    assert.equal(r.code, 2, `${typo}: ${r.all}`);
    assert.match(r.err, new RegExp(`Unknown command "${typo}"`));
    assert.ok(isHelp(r.out), typo);
    assert.doesNotMatch(r.all, /Kiln setup|Checking tools|Choose 1 or 2/, typo);
    assert.equal(s.status(), '', `${typo}: nothing was written`);
    assert.deepEqual(readdirSync(s.dir).filter(f => f !== '.git').sort(), ['about.html', 'index.html']);
  }
});

test('KLR-21 <command> --help never runs the command: `kiln tag --help` used to rewrite the pages', () => {
  const s = site();
  const commands = [...SOURCE.slice(SOURCE.indexOf('// ─── main')).matchAll(/cmd === '([a-z][a-z-]*)'/g)].map(m => m[1]).filter(c => c !== 'help');
  assert.ok(commands.includes('tag') && commands.includes('add-site') && commands.includes('update'));
  for (const c of commands) {
    for (const flag of ['--help', '-h']) {
      const r = kiln(s.dir, [c, flag]);
      assert.equal(r.code, 0, `${c} ${flag}: ${r.all}`);
      assert.ok(isHelp(r.out), `${c} ${flag}`);
      assert.equal(s.status(), '', `${c} ${flag} changed a file`);
    }
  }
  assert.equal(readFileSync(path.join(s.dir, 'index.html'), 'utf8'), PAGE, 'no data-cms attributes appeared');
  // And the command itself still works when asked for plainly.
  const tagged = kiln(s.dir, ['tag']);
  assert.equal(tagged.code, 0, tagged.all);
  assert.match(readFileSync(path.join(s.dir, 'index.html'), 'utf8'), /data-cms/);
});

test('KLR-21 the help lists exactly the commands that exist, with the options each one takes', () => {
  const help = kiln(site().dir, ['--help']).out;
  const dispatched = [...new Set([...SOURCE.slice(SOURCE.indexOf('// ─── main')).matchAll(/cmd === '([a-z][a-z-]*)'/g)].map(m => m[1]))].filter(c => c !== 'help').sort();
  const listed = help.split('\n').map(l => /^ {2}([a-z][a-z-]*)(?: [<[].*?)? {2,}\S/.exec(l)?.[1]).filter(Boolean).sort();
  assert.deepEqual(listed, dispatched, 'a command was added or removed without its line in helpText()');
  // Options: what the dispatcher accepts for a command is what the help shows for it.
  const table = Function(`return (${/const KNOWN_FLAGS = (\{[^;]*\});/.exec(SOURCE)[1]})`)();
  const block = (c) => { const lines = help.split('\n'); const i = lines.findIndex(l => new RegExp(`^  ${c}(\\s|$)`).test(l)); let j = i + 1; while (j < lines.length && /^ {10,}/.test(lines[j])) j++; return lines.slice(i, j).join('\n'); };
  for (const [c, flags] of Object.entries(table)) {
    if (!c) continue;
    const shown = [...block(c).matchAll(/--([a-z][a-z-]*)/g)].map(m => m[1]).sort();
    assert.deepEqual(shown, [...flags].sort(), `options of ${c}`);
  }
  assert.match(help, /--max-pages <n>/);
  for (const word of ['repo', 'worker', 'origin', 'KV', 'wrangler']) assert.match(help, new RegExp(`^    ${word}\\s`, 'm'), `"${word}" is explained`);
});

test('KLR-21 an option a command does not have is refused by name, exit 2, before anything is touched', () => {
  const s = site();
  const cases = [
    [['tag', '--dry-run'], /kiln tag has no option --dry-run\. It takes: --dry\./],
    [['tag', '--dry', '--force'], /kiln tag has no option --force/],
    [['doctor', '--sit', 'https://x.example'], /kiln doctor has no option --sit\. It takes: --site, --repo, --worker\./],
    [['update', '--force'], /kiln update has no option --force\. It takes: --worker\./],
    [['add-site', '--open'], /kiln add-site has no option --open/],
    [['new', 'x', '--template', 'a/b'], /kiln new has no option --template\. It takes: --from, --name, --dry\./],
  ];
  for (const [args, message] of cases) {
    const r = kiln(s.dir, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.all}`);
    assert.match(r.err, message);
    assert.equal(s.status(), '', args.join(' '));
  }
  assert.equal(readFileSync(path.join(s.dir, 'index.html'), 'utf8'), PAGE, '`tag --dry-run` did not tag');
  // The real preview flag still previews.
  const dry = kiln(s.dir, ['tag', '--dry']);
  assert.equal(dry.code, 0, dry.all);
  assert.match(dry.out, /dry run — nothing written/);
  assert.equal(s.status(), '');
});

test('KLR-21 --version prints one line', () => {
  const r = kiln(site().dir, ['--version']);
  assert.equal(r.code, 0);
  assert.match(r.out.trim(), /^kiln \d+\.\d+\.\d+ \(editor build [\w.-]+\)$/);
});

test('KLR-21 when input ends at a prompt the exit code is 1, not a quiet 0', () => {
  const s = site();
  // doctor with nothing to go on asks for the site address; there is no one to answer.
  const d = kiln(s.dir, ['doctor']);
  assert.equal(d.code, 1, d.all);
  assert.match(d.err, /Input ended while Kiln was waiting for an answer/);
  // The wizard asks which route.
  const w = kiln(s.dir, []);
  assert.equal(w.code, 1, w.all);
  assert.match(w.err, /Input ended while Kiln was waiting for an answer/);
  assert.equal(s.status(), '');
});

test('KLR-21 doctor never prints "undefined": a site with no worker yet, and a worker with no App yet', () => {
  const s = site({ 'index.html': PAGE, 'assets/kiln-config.js': "window.KILN = {\n  repo:   'YOUR-GITHUB-USER/YOUR-REPO',\n  worker: '',\n};\n" });
  const fresh = kiln(s.dir, ['doctor']);
  assert.match(fresh.out, /worker=not set/);
  assert.match(fresh.out, /not connected to a worker yet — run the setup wizard here first/);
  assert.doesNotMatch(fresh.all, /undefined/);
  const W = 'https://worker.example', S = 'https://site.example', R = 'kiln-doctor-test-no-such-owner/site';
  const noApp = kiln(s.dir, ['doctor', '--site', S, '--repo', R, '--worker', W], { table: {
    [`${W}/healthz`]: { json: { ok: true } }, [`${W}/setup/status`]: { json: { configured: false } }, [`${W}/setup/install-check`]: { json: { installed: false } },
    [`${W}/auth/refresh`]: { status: 204, headers: {} }, [`${W}/google/login`]: { status: 503, body: '' },
    [`https://api.github.com/repos/${R}`]: { json: { full_name: R } }, [`${S}/members/`]: { status: 404, body: '' }, [`${S}/assets/kiln.js`]: { status: 404, body: '' }, [S]: { body: '' },
  } });
  assert.equal(noApp.code, 1);
  assert.match(noApp.out, /App installed on .* — the worker has no GitHub App yet — register it first/);
  assert.doesNotMatch(noApp.all, /undefined/);
});

test('KLR-21 rescue --max-pages 5 (with a space) is five pages, not one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-rescue-')); scratch.push(dir);
  const r = kiln(dir, ['rescue', 'https://example.com', '--dry', '--max-pages', '5', '--delay', '0'], { table: { 'https://example.com': { body: '<html><body><h1>Hi</h1></body></html>', headers: { 'Content-Type': 'text/html' } } } });
  assert.match(r.out, /Crawling https:\/\/example\.com \(max 5 pages, 0ms delay\)/);
  assert.deepEqual(readdirSync(dir), [], 'a dry run');
});

test('KLR-21 kiln new: a new site starts on this tool\'s editor, not the one its template last shipped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-new-')); scratch.push(dir);
  mkdirSync(path.join(dir, 'assets'));
  for (const f of ['kiln.js', 'kiln-editor.js']) writeFileSync(path.join(dir, 'assets', f), 'window.KILN_VERSION="old0000";');
  const replaced = refreshBundles(dir, ROOT);
  assert.deepEqual(replaced.sort(), ['assets/kiln-editor.js', 'assets/kiln.js'], 'only the bundles the template has; nothing is added');
  for (const f of ['kiln.js', 'kiln-editor.js']) assert.equal(readFileSync(path.join(dir, 'assets', f), 'utf8'), readFileSync(path.join(ROOT, 'dist', f), 'utf8'));
  assert.equal(readdirSync(path.join(dir, 'assets')).length, 2);
  const none = mkdtempSync(path.join(tmpdir(), 'kiln-new-')); scratch.push(none);
  assert.deepEqual(refreshBundles(none, ROOT), []);
  // The hand-off no longer describes only the self-hosted route.
  const text = readFileSync(path.join(ROOT, 'cli', 'new.mjs'), 'utf8');
  assert.match(text, /Kiln Cloud \(the default, paid\)/);
  assert.doesNotMatch(text, /it deploys your worker, registers the GitHub App/);
});
