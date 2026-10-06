#!/usr/bin/env node
/**
 * backup-cloud — copy Kiln Cloud's state off Cloudflare.
 *
 * Everything Kiln Cloud knows lives in one D1 database (accounts, sites) and
 * one KV namespace (the GitHub App's credentials, every site's people list,
 * API tokens, comments, suggestions, scheduled posts, trial anchors). This
 * writes both into one dated archive that only its owner can read:
 *
 *   ~/Backups/kiln/kiln-production-20261006-031000.tar.gz
 *     d1.sql          `wrangler d1 export`: schema and rows, as SQL
 *     kv.json         the KV keys worth keeping, in `wrangler kv bulk put` form
 *     manifest.json   when, from where, how many of what
 *
 *   node scripts/backup-cloud.mjs                 production
 *   node scripts/backup-cloud.mjs --env staging   staging
 *   node scripts/backup-cloud.mjs --local         the local database `npm run dev` uses (drills)
 *     --out <dir>    where archives go        (default ~/Backups/kiln, or KILN_BACKUP_DIR)
 *     --keep <n>     how many to keep per source (default 14, or KILN_BACKUP_KEEP)
 *
 * It only READS from Cloudflare: `d1 export`, `kv key list`, `kv bulk get`.
 * Sessions and short-lived keys are left out on purpose: they hold sign-in
 * tokens, and losing them only means signing in again.
 *
 * The archive holds the GitHub App's private key. It is written 0600 inside a
 * 0700 directory, never inside this repository. Set KILN_BACKUP_RECIPIENT (an
 * age public key), or keep one in ~/.keys/kiln-backup.pub, and the archive is
 * encrypted with `age` as well; if a recipient is set and `age` cannot run,
 * the backup fails rather than fall back to an unencrypted file.
 *
 * A run that fails leaves no archive behind and deletes no older one.
 * Restore: ENVIRONMENTS.md, "Backups and restore".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync, statSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The KV keys that cannot be recreated. Everything else in the namespace is a
// session, a one-time code or a cache.
/**
 * One key's value out of `wrangler kv bulk get`. Against a local store wrangler answers
 * `{ key: { value, metadata } }`; against Cloudflare it answers `{ key: "the value" }`.
 * Reading only the first shape made every production key look expired.
 */
export function kvValue(entry) {
  if (entry && typeof entry === 'object' && 'value' in entry) return entry.value;
  return entry;
}

export const KV_PREFIXES = ['app:creds', 'people:', 'atok:', 'cmt:', 'sug:', 'sched:', 'firstseen:'];
const D1_NAME = { production: 'kiln-cloud', staging: 'kiln-cloud-staging', local: 'kiln-cloud-local' };
const CHUNK = 100;   // keys per `kv bulk get`

export class BackupError extends Error {}
const fail = (sentence) => { throw new BackupError(sentence); };

export function parseArgs(argv, env = process.env) {
  const opts = { source: 'production', out: env.KILN_BACKUP_DIR || path.join(homedir(), 'Backups', 'kiln'), keep: Number(env.KILN_BACKUP_KEEP || 14) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) fail(`${a} needs a value.`); return v; };
    if (a === '--local') opts.source = 'local';
    else if (a === '--env') { const e = value(); if (!['production', 'staging'].includes(e)) fail(`--env is production or staging, not "${e}".`); opts.source = e; }
    else if (a === '--out') opts.out = value();
    else if (a === '--keep') opts.keep = Number(value());
    else fail(`Unknown option ${a}. Use: backup-cloud.mjs [--env staging | --local] [--out <dir>] [--keep <n>]`);
  }
  if (!Number.isInteger(opts.keep) || opts.keep < 1) fail('--keep must be a whole number, 1 or more.');
  return opts;
}

/** Run wrangler from worker/ and return its stdout. KILN_WRANGLER names another script to run in its place (tests). */
function wrangler(args, env) {
  const bin = env.KILN_WRANGLER || path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: path.join(ROOT, 'worker'), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
    env: { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  if (r.error) fail(`wrangler could not be started (${r.error.message}). Run \`npm ci\` in ${ROOT} and try again.`);
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim()).filter(l => /error|not found|authenticat|fail/i.test(l))[0] || `exit ${r.status}`;
    fail(`\`wrangler ${args.slice(0, 3).join(' ')}\` failed: ${why}`);
  }
  return r.stdout;
}
/** The JSON in a wrangler answer, which may have a banner or warnings before it. */
function jsonFrom(text, open) {
  const at = text.indexOf(`\n${open}`) >= 0 ? text.indexOf(`\n${open}`) + 1 : text.indexOf(open);
  if (at < 0) fail('wrangler answered with something that is not JSON.');
  try { return JSON.parse(text.slice(at)); } catch { fail('wrangler answered with something that is not JSON.'); }
}

const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export async function backup(opts, { env = process.env, log = console.log, now = new Date() } = {}) {
  const out = path.resolve(opts.out);
  if (out === ROOT || out.startsWith(ROOT + path.sep)) {
    fail(`The backup directory (${out}) is inside the repository. Backups hold credentials and must live outside it: pass --out or set KILN_BACKUP_DIR.`);
  }
  // Decide about encryption before anything is fetched.
  const keyFile = path.join(env.HOME || homedir(), '.keys', 'kiln-backup.pub');
  const recipient = (env.KILN_BACKUP_RECIPIENT || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : '')).trim();
  if (recipient && spawnSync('age', ['--version'], { env, encoding: 'utf8' }).status !== 0) {
    fail('A backup recipient is set but `age` cannot be run, and an unencrypted archive will not be written in its place. Install age (`brew install age`) and try again.');
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);

  // `--local` is wrangler's own local state (worker/.wrangler): `d1 export`
  // can read no other local database.
  const where = opts.source === 'local' ? ['--local'] : ['--env', opts.source, '--remote'];
  const name = `kiln-${opts.source}-${stampOf(now)}`;
  const stage = mkdtempSync(path.join(out, '.partial-'));   // 0700; removed whatever happens
  const archive = path.join(out, `${name}.tar.gz`);
  try {
    // ── D1 ──
    wrangler(['d1', 'export', D1_NAME[opts.source], ...where, '--output', path.join(stage, 'd1.sql')], env);
    const sql = existsSync(path.join(stage, 'd1.sql')) ? readFileSync(path.join(stage, 'd1.sql'), 'utf8') : '';
    if (!/CREATE TABLE[^;]*\bsites\b/i.test(sql)) {
      fail(`The database export does not contain the sites table, so it is not a backup of ${D1_NAME[opts.source]}. Nothing was kept.`);
    }
    const rows = { accounts: (sql.match(/INSERT INTO "?accounts"?/gi) || []).length, sites: (sql.match(/INSERT INTO "?sites"?/gi) || []).length };

    // ── KV ──
    const listed = [];
    const counts = {};
    for (const prefix of KV_PREFIXES) {
      const keys = jsonFrom(wrangler(['kv', 'key', 'list', '--binding', 'KILN', ...where, '--prefix', prefix], env), '[');
      counts[prefix] = keys.length;
      listed.push(...keys);
    }
    const entries = [];
    let vanished = 0;
    for (let i = 0; i < listed.length; i += CHUNK) {
      const chunk = listed.slice(i, i + CHUNK);
      const want = path.join(stage, 'keys.json');
      writeFileSync(want, JSON.stringify(chunk.map(k => k.name)), { mode: 0o600 });
      const got = jsonFrom(wrangler(['kv', 'bulk', 'get', want, '--binding', 'KILN', ...where], env), '{');
      for (const k of chunk) {
        const value = kvValue(got[k.name]);
        if (value === null || value === undefined) { vanished++; continue; }   // expired between list and get
        entries.push({ key: k.name, value: typeof value === 'string' ? value : JSON.stringify(value),
          ...(k.expiration ? { expiration: k.expiration } : {}), ...(k.metadata ? { metadata: k.metadata } : {}) });
      }
      rmSync(want, { force: true });
    }
    if (opts.source === 'production' && !entries.some(e => e.key === 'app:creds')) {
      fail('The KV export does not contain app:creds, the GitHub App credentials every site depends on, so this is not a usable backup of production. Nothing was kept.');
    }
    writeFileSync(path.join(stage, 'kv.json'), JSON.stringify(entries, null, 1), { mode: 0o600 });
    writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
      created: now.toISOString(), source: opts.source, d1: { database: D1_NAME[opts.source], rows },
      kv: { keys: entries.length, byPrefix: counts, expiredDuringBackup: vanished, prefixes: KV_PREFIXES },
      encrypted: !!recipient,
    }, null, 2) + '\n', { mode: 0o600 });

    // ── One archive, owner-only ──
    const tar = spawnSync('tar', ['-czf', archive, '-C', stage, 'd1.sql', 'kv.json', 'manifest.json'], { encoding: 'utf8' });
    if (tar.status !== 0) fail(`tar could not write the archive: ${(tar.stderr || '').trim()}`);
    chmodSync(archive, 0o600);
    let final = archive;
    if (recipient) {
      final = `${archive}.age`;
      const enc = spawnSync('age', ['-r', recipient, '-o', final, archive], { env, encoding: 'utf8' });
      rmSync(archive, { force: true });
      if (enc.status !== 0) { rmSync(final, { force: true }); fail(`age could not encrypt the archive: ${(enc.stderr || '').trim()}`); }
      chmodSync(final, 0o600);
    }

    // ── Keep the newest N for this source; only after a good run ──
    const mine = readdirSync(out).filter(f => new RegExp(`^kiln-${opts.source}-\\d{8}-\\d{6}\\.tar\\.gz(\\.age)?$`).test(f)).sort();
    const drop = mine.slice(0, Math.max(0, mine.length - opts.keep));
    for (const f of drop) rmSync(path.join(out, f), { force: true });

    log(`backup ok: ${final} (${statSync(final).size} bytes; ${rows.accounts} accounts, ${rows.sites} sites, ${entries.length} KV keys${recipient ? '; encrypted' : '; not encrypted, owner-only'}); kept ${mine.length - drop.length}, removed ${drop.length}`);
    return { file: final, rows, keys: entries.length, counts, removed: drop };
  } catch (err) {
    rmSync(archive, { force: true });
    throw err;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    await backup(parseArgs(process.argv.slice(2)));
  } catch (err) {
    // One line with a time, so a launchd log reads as a list of nights.
    console.error(`${new Date().toISOString()} backup FAILED: ${err.message}`);
    process.exit(1);
  }
}
