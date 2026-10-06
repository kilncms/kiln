#!/usr/bin/env node
/**
 * restore-kv — put the KV keys from a backup back into a namespace.
 *
 *   tar -xzf ~/Backups/kiln/kiln-production-….tar.gz -C /tmp/kiln-restore
 *   node scripts/restore-kv.mjs /tmp/kiln-restore/kv.json --env staging --dry-run
 *   node scripts/restore-kv.mjs /tmp/kiln-restore/kv.json --env staging
 *   node scripts/restore-kv.mjs /tmp/kiln-restore/kv.json --local [--persist-to <dir>]
 *   node scripts/restore-kv.mjs … --env production --i-mean-production
 *     --prefix people:   only keys that start with this (repeatable)
 *
 * This WRITES. Keys in the file replace keys of the same name; keys that are
 * not in the file are left alone. Production is refused unless
 * --i-mean-production is given as well: restore to staging first and look.
 * The database half of a backup is restored with wrangler (ENVIRONMENTS.md).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export class RestoreError extends Error {}
const fail = (sentence) => { throw new RestoreError(sentence); };

export function parseArgs(argv) {
  const opts = { file: null, target: null, persistTo: null, prefixes: [], dryRun: false, meanIt: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) fail(`${a} needs a value.`); return v; };
    if (a === '--local') opts.target = 'local';
    else if (a === '--env') { const e = value(); if (!['production', 'staging'].includes(e)) fail(`--env is production or staging, not "${e}".`); opts.target = e; }
    else if (a === '--persist-to') opts.persistTo = value();
    else if (a === '--prefix') opts.prefixes.push(value());
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--i-mean-production') opts.meanIt = true;
    else if (a.startsWith('--')) fail(`Unknown option ${a}. Use: restore-kv.mjs <kv.json> (--env staging | --env production --i-mean-production | --local) [--prefix p] [--dry-run]`);
    else if (opts.file) fail('Give one kv.json file.');
    else opts.file = a;
  }
  if (!opts.file) fail('Which file? Give the kv.json from an unpacked backup.');
  if (!opts.target) fail('Where to? Say --env staging, --local, or --env production --i-mean-production.');
  if (opts.target === 'production' && !opts.meanIt) {
    fail('Refusing to write to production. Restore to staging first (--env staging) and check it; then add --i-mean-production.');
  }
  if (opts.persistTo && opts.target !== 'local') fail('--persist-to only goes with --local.');
  return opts;
}

export function restore(opts, { env = process.env, log = console.log } = {}) {
  let entries;
  try { entries = JSON.parse(readFileSync(opts.file, 'utf8')); } catch (err) { fail(`${opts.file} could not be read as JSON (${err.message}).`); }
  if (!Array.isArray(entries) || entries.some(e => !e || typeof e.key !== 'string' || typeof e.value !== 'string')) {
    fail(`${opts.file} is not a kv.json from backup-cloud.mjs: it should be a list of { key, value }.`);
  }
  const chosen = opts.prefixes.length ? entries.filter(e => opts.prefixes.some(p => e.key.startsWith(p))) : entries;
  // An expiry that has already passed would be refused by Cloudflare: such a key is simply over.
  const nowSec = Math.floor(Date.now() / 1000);
  const live = chosen.filter(e => !e.expiration || e.expiration > nowSec + 60);
  const byPrefix = {};
  for (const e of live) { const p = e.key.includes(':') ? e.key.slice(0, e.key.indexOf(':') + 1) : e.key; byPrefix[p] = (byPrefix[p] || 0) + 1; }
  const summary = Object.entries(byPrefix).map(([p, n]) => `${p} ${n}`).join(', ') || 'nothing';
  if (opts.dryRun) { log(`Dry run: would write ${live.length} keys to ${opts.target} (${summary}); ${chosen.length - live.length} expired keys skipped. Nothing was written.`); return { written: 0, would: live.length, byPrefix }; }
  if (!live.length) { log('Nothing to write.'); return { written: 0, would: 0, byPrefix }; }
  const where = opts.target === 'local' ? ['--local', ...(opts.persistTo ? ['--persist-to', path.resolve(opts.persistTo)] : [])] : ['--env', opts.target, '--remote'];
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-restore-'));
  try {
    const file = path.join(dir, 'put.json');
    writeFileSync(file, JSON.stringify(live), { mode: 0o600 });
    const bin = env.KILN_WRANGLER || path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const r = spawnSync(process.execPath, [bin, 'kv', 'bulk', 'put', file, '--binding', 'KILN', ...where], {
      cwd: path.join(ROOT, 'worker'), encoding: 'utf8', env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    });
    if (r.status !== 0) fail(`\`wrangler kv bulk put\` failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  log(`Wrote ${live.length} keys to ${opts.target} (${summary}).`);
  return { written: live.length, would: live.length, byPrefix };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { restore(parseArgs(process.argv.slice(2))); }
  catch (err) { console.error(err.message); process.exit(1); }
}
