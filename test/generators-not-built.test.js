// Eleventy, Hugo and Jekyll: Kiln has no source mode for them yet. What the
// editor, the setup wizard and `kiln doctor` say on such a site is true: no
// advice to switch to a source mode that does not exist for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildOutputCopy, SOURCE_GENERATORS } from '../src/editor/source-fields.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'index.mjs');
const DEAD = 'http://127.0.0.1:9';
const plain = (s) => !/[!—–]| - /.test(s);

test('the editor on a page that is build output: source mode where there is one, the truth where there is not', () => {
  assert.deepEqual(SOURCE_GENERATORS, ['astro']);
  const astro = buildOutputCopy({ path: 'dist/index.html', gen: 'Astro', id: 'astro' });
  assert.equal(astro.title, 'This page is build output');
  assert.match(astro.body.join(' '), /made again on every build/);
  assert.match(astro.body.join(' '), /Switch this site to source mode/);
  for (const [gen, id] of [['Hugo', 'hugo'], ['Eleventy', 'eleventy'], ['Jekyll', 'jekyll']]) {
    const c = buildOutputCopy({ path: '_site/index.html', gen, id });
    const words = c.body.join(' ');
    assert.doesNotMatch(words, /source mode/i, gen);
    assert.match(words, new RegExp(`Kiln can’t edit ${gen} content files yet`), gen);
    assert.match(words, /Astro is the one generator it edits today/, gen);
    assert.ok(plain(words), words);
  }
  assert.ok(plain(astro.body.join(' ')));
});

function site(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-gen-'));
  for (const [f, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); }
  return dir;
}
const config = "window.KILN = {\n  repo:   'example/site',\n  branch: 'main',\n  worker: '" + DEAD + "',\n  styles: [],\n};\n";
const run = (cwd, argv, input) => {
  const r = spawnSync(process.execPath, [CLI, ...argv], { cwd, input, encoding: 'utf8', timeout: 90_000, env: { ...process.env, NO_COLOR: '1' } });
  return r.stdout + r.stderr;
};

test('kiln doctor on a Jekyll site in HTML mode: what HTML mode can and cannot do, and no source mode to switch to', () => {
  const dir = site({ '_config.yml': 'title: Fair\n', '_posts/2026-05-02-fair.md': '---\ntitle: Fair\n---\nHi.\n', '_site/index.html': '<!doctype html><title>x</title>\n', 'assets/kiln-config.js': config });
  try {
    const out = run(dir, ['doctor', '--site', DEAD, '--repo', 'example/site', '--worker', DEAD]);
    assert.match(out, /looks like a generator build \(Jekyll\)/);
    assert.match(out, /Kiln can't edit Jekyll content files yet/);
    assert.doesNotMatch(out, /Switch to source mode/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

