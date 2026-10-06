/**
 * KLR-24 — the Kiln Cloud database changes only through worker/migrations/.
 * These tests hold the files to the rules ENVIRONMENTS.md states, and run them
 * for real against SQLite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { schemaFiles, fakeD1, d1Skip } from './d1-fake.js';

const files = schemaFiles();
const names = files.map(f => path.basename(f));

test('KLR-24 migrations: numbered 0001, 0002, … with no gap and no repeat, and both environments point at the directory', () => {
  assert.ok(names.length >= 1);
  names.forEach((n, i) => assert.match(n, new RegExp(`^${String(i + 1).padStart(4, '0')}_[a-z0-9_]+\\.sql$`), n));
  assert.equal(names[0], '0001_init.sql');
  const toml = readFileSync(path.join(path.dirname(path.dirname(files[0])), 'wrangler.toml'), 'utf8');
  const blocks = toml.split(/\n(?=\[\[)/).filter(b => /d1_databases\]\]/.test(b.split('\n')[0]));
  assert.ok(blocks.length >= 2, 'a D1 block per environment');
  for (const b of blocks) assert.match(b, /^migrations_dir = "migrations"/m, b.split('\n')[0]);
});

test('KLR-24 migrations: 0001 changes nothing on a database that already has the schema, and keeps its rows', { skip: d1Skip }, () => {
  const d1 = fakeD1({ upTo: 1 });
  d1.exec("INSERT INTO accounts (id, github_login, created_at) VALUES ('a1', 'ada', 1)");
  d1.exec("INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at) VALUES ('s1', 'a1', 'ada/club', 'https://club.example', 'cloud', 'active', 1)");
  d1.db.exec(readFileSync(files[0], 'utf8'));   // the first `migrations apply` on staging and production
  assert.equal(d1.row('SELECT COUNT(*) n FROM accounts').n, 1);
  assert.equal(d1.row('SELECT status FROM sites').status, 'active');
});

test('KLR-24 migrations: every file applies in order on an empty database, and each later one on top of real rows', { skip: d1Skip }, () => {
  for (let upTo = 1; upTo <= files.length; upTo++) {
    const d1 = fakeD1({ upTo: 1 });
    d1.exec("INSERT INTO accounts (id, github_login, created_at) VALUES ('a1', 'ada', 1)");
    d1.exec("INSERT INTO sites (id, account_id, repo, origin, plan, status, created_at) VALUES ('s1', 'a1', 'ada/club', 'https://club.example', 'cloud', 'active', 1)");
    for (const f of files.slice(1, upTo)) d1.db.exec(readFileSync(f, 'utf8'));
    assert.equal(d1.row('SELECT COUNT(*) n FROM sites').n, 1, names[upTo - 1]);
  }
});
