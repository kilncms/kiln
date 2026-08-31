/**
 * CLI source-mode behavior, end to end: spawn the real cli/index.mjs in a
 * scratch site directory and assert what a user actually sees.
 *
 *  - wizard: §7.2 mode dialogue on a generator tree; choosing source writes
 *    mode/adapter into kiln-config.js and prints the §15 steps; choosing html
 *    with committed build output prints the §7.3 warning.
 *  - doctor: §13 checks — generator build in HTML mode warns with the §7.3
 *    copy; source mode without a source-advertising worker warns.
 *
 * All network targets point at 127.0.0.1 closed ports, so every fetch fails
 * fast and deterministically; the wizard runs its Cloud path, which stops
 * before any deploy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.mjs');
const DEAD = 'https://127.0.0.1:9';   // closed port — every fetch fails immediately

/** Scaffold a scratch Astro-looking site dir. */
function scaffold({ mode, builtOutput } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-cli-source-'));
  writeFileSync(path.join(dir, 'astro.config.mjs'), 'export default {};\n');
  mkdirSync(path.join(dir, 'src', 'content', 'events'), { recursive: true });
  for (const f of ['one.md', 'two.md', 'three.md']) {
    writeFileSync(path.join(dir, 'src', 'content', 'events', f), `---\ntitle: ${f}\n---\nBody.\n`);
  }
  if (builtOutput) {
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html><title>built</title>\n');
  }
  if (mode !== 'none') {
    mkdirSync(path.join(dir, 'assets'), { recursive: true });
    writeFileSync(path.join(dir, 'assets', 'kiln-config.js'), `window.KILN = {
  repo:   'example/site',
  branch: 'main',
  worker: '${DEAD}',
${mode === 'source' ? "  mode:   'source',\n  adapter: 'astro',\n" : ''}  styles: [],
};
`);
  }
  return dir;
}

function runCli(cwd, argv, input) {
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    cwd, input, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(r.error, undefined, r.error && r.error.message);
  return r.stdout + r.stderr;
}

/** Drive the interactive wizard: readline drops lines that arrive while no
 *  question is pending, so each answer is written only when a prompt (output
 *  ending in ': ') shows up — like a human at the keyboard. */
function runWizard(cwd, answers) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { cwd, env: { ...process.env, NO_COLOR: '1' } });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    killer.unref();
    let out = '';
    let i = 0;
    child.stdout.on('data', (d) => {
      out += d;
      if (i < answers.length && /: $/.test(out)) child.stdin.write(answers[i++] + '\n');
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', () => { clearTimeout(killer); resolve(out); });
  });
}

test('doctor §13: generator build + committed output in HTML mode gets the §7.3 warning', () => {
  const dir = scaffold({ mode: 'html', builtOutput: true });
  try {
    const out = runCli(dir, ['doctor', '--site', DEAD, '--repo', 'example/site', '--worker', DEAD]);
    assert.match(out, /looks like a generator build \(Astro\), but the site is in HTML mode/);
    assert.match(out, /Kiln can see dist\/index\.html/);
    assert.match(out, /regenerated on every build/);
    assert.match(out, /Switch to source mode/);
    assert.match(out, /checks passed|❌/, 'doctor ran to its summary');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor §13: source mode against a worker that does not advertise source warns, never fails', () => {
  const dir = scaffold({ mode: 'source' });
  try {
    const out = runCli(dir, ['doctor', '--site', DEAD, '--repo', 'example/site', '--worker', DEAD]);
    assert.match(out, /mode=source\/astro/);
    assert.match(out, /source mode configured — adapter: astro/);
    assert.match(out, /worker doesn't advertise source mode/);
    assert.ok(!/looks like a generator build .* the site is in HTML mode/.test(out), 'no §7.3 warning in source mode');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wizard §7.2: generator tree asks the mode question; choosing source writes mode/adapter + prints §15 steps', async () => {
  const dir = scaffold({ mode: 'none' });
  try {
    spawnSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/example/site.git'], { cwd: dir, encoding: 'utf8' });
    // answers: Cloud → pages-are-generated → no autotag → no commit/push
    const out = await runWizard(dir, ['1', '2', 'n', 'n']);
    assert.match(out, /How is this site built\?/);
    assert.match(out, /Found astro\.config\.mjs and 3 content files — this looks like an Astro site\./);
    assert.match(out, /The pages are generated from content files/);
    assert.match(out, /npm install @kilncms\/astro/);
    assert.match(out, /kilnSource\(entry, 'title'\)/);
    assert.match(out, /auto-deploy/);
    assert.match(out, /Node 18\+/);
    assert.match(out, /source mode is new/);
    const cfg = readFileSync(path.join(dir, 'assets', 'kiln-config.js'), 'utf8');
    assert.match(cfg, /mode:\s*'source',/);
    assert.match(cfg, /adapter:\s*'astro',/);
    assert.match(cfg, /repo:\s*'example\/site',/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wizard §7.3: choosing HTML mode with committed build output prints the guard warning', async () => {
  const dir = scaffold({ mode: 'none', builtOutput: true });
  try {
    spawnSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/example/site.git'], { cwd: dir, encoding: 'utf8' });
    // answers: Cloud → pages-are-files → no autotag → no commit/push
    const out = await runWizard(dir, ['1', '1', 'n', 'n']);
    assert.match(out, /How is this site built\?/);
    assert.match(out, /Kiln can see dist\/index\.html, but this site is built by Astro/);
    assert.match(out, /regenerated on every build/);
    const cfg = readFileSync(path.join(dir, 'assets', 'kiln-config.js'), 'utf8');
    assert.ok(!/mode\s*:/.test(cfg), 'html mode stays implicit — no mode line (§13 default-on-absence)');
    assert.ok(existsSync(path.join(dir, 'kiln.html')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
