/**
 * KLN-07 — the security headers new sites ship with (templates/_headers), and
 * the wizard step that puts the file in place.
 *
 * Deliberately NOT in the file: any Content-Security-Policy directive that
 * limits scripts, styles or connections. A site's scripts are its owner's
 * business; docs/for-site-owners.md explains how to add one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'templates', '_headers');
const CLI = path.join(ROOT, 'cli', 'index.mjs');

/** Parse a _headers file the way Cloudflare Pages and Netlify do: a path line, then indented "Name: value" lines. */
function parseHeaders(text) {
  const rules = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { current = new Map(); rules.set(line.trim(), current); continue; }
    assert.ok(current, `header line before any path: ${line}`);
    const i = line.indexOf(':');
    assert.ok(i > 0, `not "Name: value": ${line}`);
    current.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return rules;
}

test('KLN-07 templates/_headers: one rule for every path, with the four protections', () => {
  const rules = parseHeaders(readFileSync(TEMPLATE, 'utf8'));
  assert.deepEqual([...rules.keys()], ['/*']);
  const h = rules.get('/*');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(h.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(h.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(h.get('strict-transport-security'), /^max-age=\d+$/);
  assert.ok(Number(h.get('strict-transport-security').split('=')[1]) >= 15552000, 'HSTS lasts at least six months');
});

test('KLN-07 templates/_headers: no policy that limits a site\'s own scripts, styles or connections', () => {
  const text = readFileSync(TEMPLATE, 'utf8');
  const h = parseHeaders(text).get('/*');
  const directives = h.get('content-security-policy').split(';').map(d => d.trim().split(/\s+/)[0]).filter(Boolean);
  assert.deepEqual(directives, ['frame-ancestors'], 'frame-ancestors is the only directive');
  for (const banned of ['script-src', 'default-src', 'style-src', 'connect-src', 'img-src', 'object-src', 'require-trusted-types-for', 'sandbox']) {
    assert.equal(text.includes(banned), false, `${banned} must not ship in a customer's site`);
  }
  // Conservative HSTS: no promise about subdomains, no preload-list commitment.
  assert.equal(/includeSubDomains|preload/i.test(h.get('strict-transport-security')), false);
  assert.equal(h.has('content-security-policy-report-only'), false);
});

test('KLN-07 templates/_headers: well-formed for the hosts that read it', () => {
  const text = readFileSync(TEMPLATE, 'utf8');
  assert.equal(text.includes('\t'), false, 'spaces, not tabs');
  assert.equal(text.includes('\r'), false);
  assert.ok(text.endsWith('\n'));
  for (const line of text.split('\n')) assert.ok(line.length <= 2000, 'Cloudflare Pages caps a line at 2,000 characters');
  assert.ok(parseHeaders(text).get('/*').size <= 10);
  assert.match(text, /docs\/for-site-owners\.md#security-headers/, 'points at the guide');
});

// ─── the wizard puts it in place ─────────────────────────────────────────────

function scratchSite() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-headers-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Site</title><h1>Hi</h1>\n');
  spawnSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/example/site.git'], { cwd: dir, encoding: 'utf8' });
  return dir;
}
/** Answer each prompt as it appears (same driver as cli-source.test.js). */
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

test('KLN-07 wizard: a new site gets the _headers file, byte for byte', async () => {
  const dir = scratchSite();
  try {
    // answers: Cloud → no autotag → no commit/push (stops before anything is deployed)
    const out = await runWizard(dir, ['1', 'n', 'n']);
    assert.match(out, /wrote _headers/);
    assert.equal(readFileSync(path.join(dir, '_headers'), 'utf8'), readFileSync(TEMPLATE, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('KLN-07 wizard: a site that already has a _headers file keeps its own', async () => {
  const dir = scratchSite();
  const mine = '/*\n  X-Robots-Tag: noindex\n';
  writeFileSync(path.join(dir, '_headers'), mine);
  try {
    const out = await runWizard(dir, ['1', 'n', 'n']);
    assert.match(out, /_headers already present \(left untouched\)/);
    assert.equal(readFileSync(path.join(dir, '_headers'), 'utf8'), mine);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('KLN-07 wizard: a generator-built site is told where the file goes instead of getting one at the repo root', async () => {
  const dir = scratchSite();
  writeFileSync(path.join(dir, 'astro.config.mjs'), 'export default {};\n');
  try {
    // answers: Cloud → pages are generated (source mode) → no autotag → no commit/push
    const out = await runWizard(dir, ['1', '2', 'n', 'n']);
    assert.match(out, /security headers: copy Kiln's _headers file into the folder your build publishes/);
    assert.equal(existsSync(path.join(dir, '_headers')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
