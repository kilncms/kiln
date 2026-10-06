/**
 * `kiln update` copies the editor next to wherever the site's page says
 * kiln.js lives. That folder name comes out of the site's own HTML, so it is
 * only ever a folder of the site: a page that names somewhere above the site,
 * or another address altogether, gets nothing written anywhere.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'cli', 'index.mjs');
const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** A site folder inside a scratch parent, whose page loads kiln.js from `src`. */
function site(src) {
  const parent = mkdtempSync(path.join(tmpdir(), 'kiln-update-folder-'));
  scratch.push(parent);
  const dir = path.join(parent, 'site');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'index.html'), `<!doctype html><body><h1>Hi</h1><script src="${src}" defer></script></body>\n`);
  const update = () => spawnSync(process.execPath, [CLI, 'update'], { cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, NO_COLOR: '1' } });
  return { parent, dir, update };
}

test('update: a page that names a folder above the site gets nothing written, there or anywhere', () => {
  for (const src of ['../kiln.js', '../shared/assets/kiln.js', '../../kiln.js', 'assets/../../elsewhere/kiln.js']) {
    const s = site(src);
    const r = s.update();
    assert.equal(r.status, 1, `${src}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /names a folder outside this site for kiln\.js .*so nothing was written/);
    assert.deepEqual(readdirSync(s.parent), ['site'], `${src}: nothing beside the site`);
    assert.deepEqual(readdirSync(s.dir), ['index.html'], `${src}: nothing in the site`);
  }
});

test('update: a page that loads kiln.js from another address is told so, and no folder named after the address is made', () => {
  for (const src of ['https://cdn.example.com/kiln/kiln.js', '//cdn.example.com/kiln/kiln.js', 'http://localhost:8080/assets/kiln.js']) {
    const s = site(src);
    const r = s.update();
    assert.equal(r.status, 1, `${src}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /loads kiln\.js from another address \(.*kiln\.js\), not from a file in this folder/);
    assert.deepEqual(readdirSync(s.dir), ['index.html'], src);
  }
});

test('update: a folder of the site is still written to, however the page spells it', () => {
  for (const [src, folder] of [['/assets/kiln.js', 'assets'], ['assets/js/kiln.js', 'assets/js'], ['./kiln.js', '.'], ['assets/x/../kiln.js', 'assets']]) {
    const s = site(src);
    const r = s.update();   // input ends at "Commit and push now?": the copy has already happened
    assert.match(r.stdout, /copied the latest kiln\.js \+ kiln-editor\.js \+ kiln-features\.js into /, `${src}: ${r.stdout}`);
    assert.ok(existsSync(path.join(s.dir, folder, 'kiln-editor.js')), `${src} → ${folder}/kiln-editor.js`);
    assert.deepEqual(readdirSync(s.parent), ['site']);
  }
});
