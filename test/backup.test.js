/**
 * KLR-03 — Kiln Cloud's state can be copied off Cloudflare and put back.
 *
 * scripts/backup-cloud.mjs and scripts/restore-kv.mjs are run for real, with
 * wrangler replaced by test/wrangler-stub.mjs (KILN_WRANGLER). Nothing here
 * reaches Cloudflare, and every backup goes to a temporary directory.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, parseArgs, KV_PREFIXES, BackupError } from '../scripts/backup-cloud.mjs';
import { restore, parseArgs as restoreArgs, RestoreError } from '../scripts/restore-kv.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STUB = path.join(ROOT, 'test', 'wrangler-stub.mjs');
const scratch = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

const SQL = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE accounts (id TEXT PRIMARY KEY, github_login TEXT UNIQUE NOT NULL, email TEXT, ls_customer_id TEXT, created_at INTEGER NOT NULL);
INSERT INTO "accounts" VALUES('a1','ada','ada@example.com',NULL,1);
CREATE TABLE sites (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, repo TEXT NOT NULL, origin TEXT NOT NULL UNIQUE, plan TEXT NOT NULL, status TEXT NOT NULL, ls_subscription_id TEXT, created_at INTEGER NOT NULL, access_until INTEGER);
INSERT INTO "sites" VALUES('s1','a1','ada/club','https://club.example','cloud','active','77',1,NULL);
INSERT INTO "sites" VALUES('s2','a1','ada/shop','https://shop.example','cloud','trialing',NULL,2,NULL);
`;
const FAR = Math.floor(Date.now() / 1000) + 30 * 86400;
const KV = () => ({
  'app:creds': '{"app_id":123,"client_secret":"cs","pk8":"PRIVATE KEY"}',
  'people:ada/club': '[{"email":"m@example.com","role":"member","days":30}]',
  'people:ada/shop': '[]',
  'atok:abc': { value: '{"repo":"ada/club"}', expiration: FAR },
  'cmt:ada/club:%2F:0123456789ab': '{"msgs":[]}',
  'sug:ada/club:1': '{"edits":[]}',
  'sched:1:x': '{"repo":"ada/club"}',
  'firstseen:https://club.example': '1700000000000',
  'rid:4242': '{"id":4242,"name":"ada/club"}',
  'rname:ada/club': '{"id":4242}',
  // Never backed up: sessions (they hold tokens), one-time codes, caches.
  'rsee:ada/club': '{"id":4242,"name":"ada/club"}',
  'csess:tok': '{"gh":"gho_SECRET_TOKEN"}', 'esess:a': '{"email":"e@example.com"}', 'msess:b': '{}', 'sid:c': '{}',
  'itok:ada/club': 'ghs_INSTALLATION_TOKEN', 'gcode:d': '{}', 'cstate:e': '1', 'lsevt:f': '1', 'pres:g': '{}',
});

/** A scratch world: stub state, a call log, an empty HOME, a backup directory. */
function world(over = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'kiln-backup-'));
  scratch.push(base);
  const stateFile = path.join(base, 'state.json');
  const logFile = path.join(base, 'calls.log');
  writeFileSync(stateFile, JSON.stringify({ sql: SQL, kv: KV(), ...over }));
  writeFileSync(logFile, '');
  mkdirSync(path.join(base, 'home'));
  mkdirSync(path.join(base, 'bin'));
  const out = path.join(base, 'backups');
  const env = { ...process.env, KILN_WRANGLER: STUB, KILN_STUB_STATE: stateFile, KILN_STUB_LOG: logFile, HOME: path.join(base, 'home'), KILN_BACKUP_RECIPIENT: '' };
  const lines = [];
  return {
    base, out, env, lines, stateFile,
    calls: () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)),
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')),
    run: (opts = {}, when = new Date(2026, 9, 6, 3, 10, 0)) => backup({ source: 'production', out, keep: 14, ...opts }, { env, log: (l) => lines.push(l), now: when }),
    archives: () => existsSync(out) ? readdirSync(out).sort() : [],
  };
}
function unpack(file) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kiln-unpack-'));
  scratch.push(dir);
  const r = spawnSync('tar', ['-xzf', file, '-C', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { dir, files: readdirSync(dir).sort(), sql: readFileSync(path.join(dir, 'd1.sql'), 'utf8'), kv: JSON.parse(readFileSync(path.join(dir, 'kv.json'), 'utf8')), manifest: JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) };
}
const mode = (p) => (statSync(p).mode & 0o777).toString(8);

test('KLR-03 backup: one dated archive, readable only by its owner, holding the database, the KV keys worth keeping and a manifest', async () => {
  const w = world();
  const r = await w.run();
  assert.deepEqual(w.archives(), ['kiln-production-20261006-031000.tar.gz'], 'one file, and no staging directory left');
  assert.equal(r.file, path.join(w.out, 'kiln-production-20261006-031000.tar.gz'));
  assert.equal(mode(r.file), '600');
  assert.equal(mode(w.out), '700');
  const u = unpack(r.file);
  assert.deepEqual(u.files, ['d1.sql', 'kv.json', 'manifest.json']);
  assert.equal(u.sql, SQL, 'the export, byte for byte');
  assert.deepEqual(u.kv.map(e => e.key), ['app:creds', 'people:ada/club', 'people:ada/shop', 'atok:abc', 'cmt:ada/club:%2F:0123456789ab', 'sug:ada/club:1', 'sched:1:x', 'firstseen:https://club.example', 'rid:4242', 'rname:ada/club']);
  assert.equal(u.kv.find(e => e.key === 'app:creds').value, KV()['app:creds']);
  assert.equal(u.kv.find(e => e.key === 'atok:abc').expiration, FAR, 'an expiry travels with its key');
  assert.deepEqual(u.manifest.d1, { database: 'kiln-cloud', rows: { accounts: 1, sites: 2 } });
  assert.equal(u.manifest.kv.keys, 10);
  assert.deepEqual(u.manifest.kv.byPrefix, { 'app:creds': 1, 'people:': 2, 'atok:': 1, 'cmt:': 1, 'sug:': 1, 'sched:': 1, 'firstseen:': 1, 'rid:': 1, 'rname:': 1 });
  assert.equal(u.manifest.source, 'production');
  assert.equal(u.manifest.encrypted, false);
  assert.match(w.lines[0], /^backup ok: .*kiln-production-20261006-031000\.tar\.gz \(\d+ bytes; 1 accounts, 2 sites, 10 KV keys; not encrypted, owner-only\); kept 1, removed 0$/);
});

test('KLR-03 backup: sessions, tokens and caches are not in it', async () => {
  const w = world();
  const u = unpack((await w.run()).file);
  const text = JSON.stringify(u.kv);
  for (const secret of ['gho_SECRET_TOKEN', 'ghs_INSTALLATION_TOKEN']) assert.equal(text.includes(secret), false, secret);
  for (const p of ['csess:', 'esess:', 'msess:', 'sid:', 'itok:', 'gcode:', 'cstate:', 'lsevt:', 'pres:', 'rsee:']) assert.equal(u.kv.some(e => e.key.startsWith(p)), false, p);
  assert.deepEqual(KV_PREFIXES, ['app:creds', 'people:', 'atok:', 'cmt:', 'sug:', 'sched:', 'firstseen:', 'rid:', 'rname:']);
});

test('KLR-03 backup: it only reads from Cloudflare, and says which environment every time', async () => {
  const w = world();
  await w.run();
  const calls = w.calls();
  const verbs = [...new Set(calls.map(c => c.slice(0, 3).join(' ').replace(/ kiln-cloud$/, '')))];
  assert.deepEqual(verbs, ['d1 export', 'kv key list', 'kv bulk get'], 'no put, delete, execute, deploy or secret');
  assert.equal(calls.length, 1 + KV_PREFIXES.length + 1);
  for (const c of calls) { const i = c.indexOf('--env'); assert.deepEqual(c.slice(i, i + 3), ['--env', 'production', '--remote'], c.join(' ')); }
  assert.deepEqual(calls[0].slice(0, 3), ['d1', 'export', 'kiln-cloud']);
  // Staging and local name their own database and never production.
  const s = world(); await s.run({ source: 'staging' });
  assert.equal(s.calls().every(c => c.includes('staging') && !c.includes('production')), true);
  assert.deepEqual(s.calls()[0].slice(0, 3), ['d1', 'export', 'kiln-cloud-staging']);
  assert.deepEqual(s.archives(), ['kiln-staging-20261006-031000.tar.gz']);
  const l = world(); await l.run({ source: 'local' });
  for (const c of l.calls()) { assert.equal(c.includes('--local'), true); assert.equal(c.includes('--remote') || c.includes('--env') || c.includes('--persist-to'), false, c.join(' ')); }
  assert.deepEqual(l.calls()[0].slice(0, 3), ['d1', 'export', 'kiln-cloud-local']);
});

test('KLR-03 backup: more keys than one request carries are fetched in batches, and a key that expires mid-backup is skipped', async () => {
  const kv = KV();
  for (let i = 0; i < 250; i++) kv[`cmt:ada/club:%2Fp${i}:${String(i).padStart(12, '0')}`] = `{"n":${i}}`;
  const w = world({ kv, vanish: ['sched:1:x'] });
  const r = await w.run();
  assert.equal(r.keys, 10 + 250 - 1);
  assert.equal(w.calls().filter(c => c[1] === 'bulk').length, 3, '260 keys in batches of 100');
  const u = unpack(r.file);
  assert.equal(u.manifest.kv.expiredDuringBackup, 1);
  assert.equal(u.kv.some(e => e.key === 'sched:1:x'), false);
  assert.equal(new Set(u.kv.map(e => e.key)).size, u.kv.length);
});

test('KLR-03 retention: the newest 14 are kept per source; other files and other sources are left alone', async () => {
  const w = world();
  mkdirSync(w.out, { recursive: true });
  writeFileSync(path.join(w.out, 'backup.log'), 'log');
  writeFileSync(path.join(w.out, 'kiln-staging-20260101-000000.tar.gz'), 'old staging');
  writeFileSync(path.join(w.out, 'notes.txt'), 'mine');
  for (let day = 1; day <= 16; day++) await w.run({}, new Date(2026, 9, day, 3, 10, 0));
  const prod = w.archives().filter(f => f.startsWith('kiln-production-'));
  assert.equal(prod.length, 14);
  assert.equal(prod[0], 'kiln-production-20261003-031000.tar.gz', 'the two oldest went');
  assert.equal(prod[13], 'kiln-production-20261016-031000.tar.gz');
  for (const f of ['backup.log', 'kiln-staging-20260101-000000.tar.gz', 'notes.txt']) assert.ok(w.archives().includes(f), f);
  assert.match(w.lines.at(-1), /kept 14, removed 1$/);
  const few = world();
  for (let day = 1; day <= 5; day++) await few.run({ keep: 3 }, new Date(2026, 9, day, 3, 10, 0));
  assert.equal(few.archives().length, 3);
});

test('KLR-03 a failed run leaves no archive and removes none of the earlier ones', async () => {
  const cases = {
    'the database export fails': [{ fail: 'd1 export' }, /`wrangler d1 export kiln-cloud` failed: .*Authentication error/],
    'listing KV fails': [{ fail: 'kv key list' }, /`wrangler kv key list` failed/],
    'reading KV values fails': [{ fail: 'kv bulk get' }, /`wrangler kv bulk get/],
    'the export is not this database': [{ sql: 'CREATE TABLE other (id TEXT);\n' }, /does not contain the sites table.*Nothing was kept/],
    'production without the App credentials': [{ kv: { 'people:ada/club': '[]' } }, /does not contain app:creds.*Nothing was kept/],
  };
  for (const [name, [over, message]] of Object.entries(cases)) {
    const w = world();
    for (let day = 1; day <= 3; day++) await w.run({ keep: 3 }, new Date(2026, 9, day, 3, 10, 0));
    const before = w.archives();
    writeFileSync(w.stateFile, JSON.stringify({ sql: SQL, kv: KV(), ...over }));
    await assert.rejects(w.run({ keep: 3 }, new Date(2026, 9, 4, 3, 10, 0)), (e) => e instanceof BackupError && message.test(e.message), name);
    assert.deepEqual(w.archives(), before, `${name}: the three good backups are all still there, and nothing partial`);
  }
  // Staging without app:creds is still a backup of staging.
  const s = world({ kv: { 'people:ada/club': '[]' } });
  assert.equal((await s.run({ source: 'staging' })).keys, 1);
});

test('KLR-03 backups are never written inside the repository', async () => {
  const w = world();
  for (const out of [ROOT, path.join(ROOT, 'backups'), path.join(ROOT, 'worker', '.wrangler', 'x')]) {
    await assert.rejects(w.run({ out }), /is inside the repository/);
  }
  assert.equal(w.calls().length, 0, 'refused before anything was fetched');
  assert.equal(existsSync(path.join(ROOT, 'backups')), false);
});

test('KLR-03 encryption: with a recipient the archive is encrypted with age; if age cannot run, nothing unencrypted is written in its place', async () => {
  const w = world();
  // No `age` on the PATH at all.
  const noAge = { ...w.env, KILN_BACKUP_RECIPIENT: 'age1examplerecipient', PATH: path.join(w.base, 'bin') };
  await assert.rejects(backup({ source: 'production', out: w.out, keep: 14 }, { env: noAge, log: () => {} }), /`age` cannot be run, and an unencrypted archive will not be written/);
  assert.equal(w.calls().length, 0);
  assert.deepEqual(w.archives(), []);
  // A stand-in `age` that "encrypts" by prefixing a line, so the flow can be followed.
  const age = path.join(w.base, 'bin', 'age');
  writeFileSync(age, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v1; exit 0; fi\n[ "$1" = "-r" ] || exit 2\n{ echo "age-encrypted-for:$2"; cat "$5"; } > "$4"\n');
  chmodSync(age, 0o755);
  const withAge = { ...w.env, KILN_BACKUP_RECIPIENT: 'age1examplerecipient', PATH: `${path.join(w.base, 'bin')}:${process.env.PATH}` };
  const lines = [];
  const r = await backup({ source: 'production', out: w.out, keep: 14 }, { env: withAge, log: (l) => lines.push(l), now: new Date(2026, 9, 6, 3, 10, 0) });
  assert.deepEqual(w.archives(), ['kiln-production-20261006-031000.tar.gz.age'], 'the plain archive is gone');
  assert.equal(mode(r.file), '600');
  assert.match(readFileSync(r.file, 'latin1'), /^age-encrypted-for:age1examplerecipient\n/);
  assert.match(lines[0], /; encrypted\)/);
  // The recipient can also come from ~/.keys/kiln-backup.pub; and an encrypted archive counts toward retention.
  mkdirSync(path.join(w.env.HOME, '.keys'));
  writeFileSync(path.join(w.env.HOME, '.keys', 'kiln-backup.pub'), 'age1fromfile\n');
  const fromFile = await backup({ source: 'production', out: w.out, keep: 1 }, { env: { ...withAge, KILN_BACKUP_RECIPIENT: '' }, log: () => {}, now: new Date(2026, 9, 7, 3, 10, 0) });
  assert.match(readFileSync(fromFile.file, 'latin1'), /^age-encrypted-for:age1fromfile\n/);
  assert.deepEqual(w.archives(), ['kiln-production-20261007-031000.tar.gz.age']);
});

test('KLR-03 the command line: options, defaults, and one dated line on failure for the log', () => {
  assert.deepEqual(parseArgs([], { HOME: '/h' }), { source: 'production', out: path.join(process.env.HOME, 'Backups', 'kiln'), keep: 14 });
  assert.deepEqual(parseArgs(['--env', 'staging', '--out', '/x', '--keep', '5'], {}), { source: 'staging', out: '/x', keep: 5 });
  assert.equal(parseArgs([], { KILN_BACKUP_DIR: '/b', KILN_BACKUP_KEEP: '30' }).keep, 30);
  for (const bad of [['--env', 'prod'], ['--keep', '0'], ['--keep', 'many'], ['--persist-to', '/x'], ['--remote'], ['--out']]) assert.throws(() => parseArgs(bad, {}), BackupError, bad.join(' '));
  const w = world({ fail: 'd1 export' });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backup-cloud.mjs'), '--out', w.out], { encoding: 'utf8', env: w.env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^\d{4}-\d\d-\d\dT[\d:.]+Z backup FAILED: `wrangler d1 export kiln-cloud` failed: /);
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backup-cloud.mjs'), '--env', 'staging', '--out', w.out], { encoding: 'utf8', env: { ...w.env, KILN_STUB_STATE: world().stateFile } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^backup ok: /);
});

// ─── restore ─────────────────────────────────────────────────────────────────

test('KLR-03 restore: a backup\'s KV keys go back into an emptied namespace, values and expiries intact', async () => {
  const w = world();
  const u = unpack((await w.run()).file);
  // The namespace is lost.
  writeFileSync(w.stateFile, JSON.stringify({ sql: '', kv: { 'esess:new': '{}' } }));
  const lines = [];
  const r = restore({ file: path.join(u.dir, 'kv.json'), target: 'staging', prefixes: [], dryRun: false, persistTo: null }, { env: w.env, log: (l) => lines.push(l) });
  assert.equal(r.written, 10);
  const kv = w.state().kv;
  assert.equal(kv['app:creds'], KV()['app:creds']);
  assert.equal(kv['people:ada/club'], KV()['people:ada/club']);
  assert.deepEqual(kv['atok:abc'], { value: '{"repo":"ada/club"}', expiration: FAR });
  assert.equal(kv['esess:new'], '{}', 'keys that are not in the backup are left alone');
  assert.match(lines[0], /^Wrote 10 keys to staging \(app: 1, people: 2, atok: 1, cmt: 1, sug: 1, sched: 1, firstseen: 1, rid: 1, rname: 1\)\.$/);
  const put = w.calls().at(-1);
  assert.deepEqual(put.slice(0, 3), ['kv', 'bulk', 'put']);
  assert.deepEqual(put.slice(-5), ['--binding', 'KILN', '--env', 'staging', '--remote']);
});

test('KLR-03 restore: production is refused without --i-mean-production; a dry run writes nothing; a prefix narrows it', async () => {
  assert.throws(() => restoreArgs(['kv.json', '--env', 'production']), /Refusing to write to production\. Restore to staging first/);
  assert.equal(restoreArgs(['kv.json', '--env', 'production', '--i-mean-production']).target, 'production');
  assert.throws(() => restoreArgs(['kv.json']), /Where to\?/);
  assert.throws(() => restoreArgs(['--env', 'staging']), /Which file\?/);
  assert.throws(() => restoreArgs(['kv.json', '--env', 'staging', '--force']), /Unknown option --force/);
  const w = world();
  const u = unpack((await w.run()).file);
  const file = path.join(u.dir, 'kv.json');
  const before = w.calls().length;
  const lines = [];
  const dry = restore({ ...restoreArgs([file, '--env', 'staging', '--dry-run']) }, { env: w.env, log: (l) => lines.push(l) });
  assert.equal(dry.written, 0);
  assert.equal(w.calls().length, before, 'wrangler is not run at all');
  assert.match(lines[0], /^Dry run: would write 10 keys to staging .*Nothing was written\.$/);
  writeFileSync(w.stateFile, JSON.stringify({ sql: '', kv: {} }));
  restore(restoreArgs([file, '--local', '--prefix', 'people:']), { env: w.env, log: () => {} });
  assert.deepEqual(Object.keys(w.state().kv).sort(), ['people:ada/club', 'people:ada/shop']);
  assert.deepEqual(w.calls().at(-1).slice(-1), ['--local']);
  // An expiry already in the past is dropped, not sent to be refused.
  const stale = path.join(w.base, 'stale.json');
  writeFileSync(stale, JSON.stringify([{ key: 'atok:old', value: '{}', expiration: 1000 }, { key: 'people:x/y', value: '[]' }]));
  assert.equal(restore(restoreArgs([stale, '--local']), { env: w.env, log: () => {} }).written, 1);
  writeFileSync(stale, '{"not":"a list"}');
  assert.throws(() => restore(restoreArgs([stale, '--local']), { env: w.env, log: () => {} }), RestoreError);
});

test('KLR-03 the launchd template runs the script nightly as a login agent and embeds no secret', () => {
  const plist = readFileSync(path.join(ROOT, 'scripts', 'com.kilncms.backup.plist'), 'utf8');
  assert.match(plist, /<string>com\.kilncms\.backup<\/string>/);
  assert.match(plist, /scripts\/backup-cloud\.mjs<\/string>/);
  assert.match(plist, /<key>StartCalendarInterval<\/key>/);
  assert.doesNotMatch(plist, /TOKEN|API_KEY|SECRET|RECIPIENT/i);
  assert.doesNotMatch(plist, /--env|--local|--out/, 'defaults only: production, ~/Backups/kiln, 14 kept');
});

test('KLR-03 a value is read from both of wrangler\'s answers: local {value} and Cloudflare\'s bare string', async () => {
  const { kvValue } = await import('../scripts/backup-cloud.mjs');
  assert.equal(kvValue({ value: '{"app_id":1}', metadata: null }), '{"app_id":1}', 'local store');
  assert.equal(kvValue('{"app_id":1}'), '{"app_id":1}', 'Cloudflare');
  assert.equal(kvValue({ value: null }), null, 'a key that expired between list and get');
  assert.equal(kvValue(undefined), undefined, 'a key that was not returned');
});
