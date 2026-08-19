/**
 * kiln-mcp pure helpers — request building, edit-shape validation, error
 * mapping, config parsing, fetch policy. Imports ONLY mcp/lib.mjs (zero
 * dependencies), so the root test run stays green without mcp/node_modules;
 * the SDK-wired entry (mcp/index.mjs) is covered by mcp/'s own test suite.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfig, buildRequest, validateEditShapes, describeApiError,
  formatPages, formatFields, formatEditResult, formatSiteInfo, apiFetch, redactToken,
} from '../mcp/lib.mjs';

const CONFIG = { workerUrl: 'https://auth.example.com', token: 'f'.repeat(64) };

// ─── parseConfig ─────────────────────────────────────────────────────────────

test('parseConfig: env vars, trailing-slash normalization, clean pass', () => {
  const c = parseConfig({ KILN_WORKER_URL: 'https://auth.example.com/', KILN_API_TOKEN: 'a'.repeat(64) }, []);
  assert.equal(c.workerUrl, 'https://auth.example.com');
  assert.equal(c.token, 'a'.repeat(64));
  assert.deepEqual(c.warnings, []);
});

test('parseConfig: argv overrides beat env', () => {
  const c = parseConfig(
    { KILN_WORKER_URL: 'https://old.example.com', KILN_API_TOKEN: 'a'.repeat(64) },
    ['--worker=https://new.example.com', `--token=${'b'.repeat(64)}`],
  );
  assert.equal(c.workerUrl, 'https://new.example.com');
  assert.equal(c.token, 'b'.repeat(64));
});

test('parseConfig: missing pieces produce one helpful error', () => {
  const c = parseConfig({}, []);
  assert.match(c.error, /KILN_WORKER_URL/);
  assert.match(c.error, /KILN_API_TOKEN/);
  assert.match(c.error, /admin\/api-tokens/);
  assert.match(parseConfig({ KILN_API_TOKEN: 'a'.repeat(64) }, []).error, /KILN_WORKER_URL/);
});

test('parseConfig: non-http URL rejected; odd token only warns', () => {
  assert.match(parseConfig({ KILN_WORKER_URL: 'auth.example.com', KILN_API_TOKEN: 'a'.repeat(64) }, []).error, /http\(s\)/);
  const c = parseConfig({ KILN_WORKER_URL: 'https://x.dev', KILN_API_TOKEN: 'not-hex' }, []);
  assert.ok(!c.error);
  assert.equal(c.warnings.length, 1);
});

// ─── buildRequest ────────────────────────────────────────────────────────────

test('buildRequest pages: GET, bearer header, optional ref', () => {
  const bare = buildRequest(CONFIG, 'pages');
  assert.equal(bare.url, 'https://auth.example.com/api/v1/pages');
  assert.equal(bare.init.method, 'GET');
  assert.equal(bare.init.headers.Authorization, `Bearer ${CONFIG.token}`);
  const withRef = buildRequest(CONFIG, 'pages', { ref: 'feat/x' });
  assert.equal(new URL(withRef.url).searchParams.get('ref'), 'feat/x');
});

test('buildRequest fields: path is query-encoded', () => {
  const r = buildRequest(CONFIG, 'fields', { path: '/about us/' });
  assert.equal(new URL(r.url).searchParams.get('path'), '/about us/');
  assert.equal(r.init.method, 'GET');
});

test('buildRequest edits: PATCH with JSON body, message only when given', () => {
  const edits = [{ key: 'hero.title', html: 'Hello' }];
  const r = buildRequest(CONFIG, 'edits', { path: '/', edits, message: 'hi' });
  assert.equal(r.url, 'https://auth.example.com/api/v1/edits');
  assert.equal(r.init.method, 'PATCH');
  assert.equal(r.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(r.init.body), { path: '/', edits, message: 'hi' });
  const noMsg = JSON.parse(buildRequest(CONFIG, 'edits', { path: '/', edits }).init.body);
  assert.ok(!('message' in noMsg));
});

test('buildRequest: unknown op throws (programmer error, not tool error)', () => {
  assert.throws(() => buildRequest(CONFIG, 'nope'), /unknown operation/);
});

// ─── validateEditShapes (mirror of the worker's shape checks) ────────────────

test('validateEditShapes accepts the two legal shapes', () => {
  assert.equal(validateEditShapes([{ key: 'a', html: '<b>x</b>' }]), null);
  assert.equal(validateEditShapes([{ key: 'a', attr: 'src', value: '/x.jpg' }]), null);
  assert.equal(validateEditShapes([{ key: 'a', html: '' }]), null); // clearing a field is legal
});

test('validateEditShapes rejects malformed batches', () => {
  assert.match(validateEditShapes([]), /non-empty/);
  assert.match(validateEditShapes('nope'), /non-empty/);
  assert.match(validateEditShapes([{ html: 'x' }]), /needs a non-empty string "key"/);
  assert.match(validateEditShapes([{ key: 'a' }]), /exactly one shape/);
  assert.match(validateEditShapes([{ key: 'a', html: 'x', attr: 'src', value: 'y' }]), /exactly one shape/);
  assert.match(validateEditShapes([{ key: 'a', attr: 'src' }]), /need a "value"/);
  assert.match(validateEditShapes([{ key: 'a', attr: '1bad', value: 'x' }]), /not a valid attribute/);
  assert.match(validateEditShapes([{ key: 'a', html: 42 }]), /"html" must be a string/);
  assert.match(validateEditShapes(Array.from({ length: 501 }, (_, i) => ({ key: `k${i}`, html: 'x' }))), /max 500/);
});

// ─── describeApiError ────────────────────────────────────────────────────────

test('describeApiError: every documented status maps to an actionable message', () => {
  assert.match(describeApiError(401, { error: 'unauthorized' }), /KILN_API_TOKEN/);
  assert.match(describeApiError(403, { error: 'read-only token' }), /scope/);
  assert.match(describeApiError(404, { error: 'page not found' }), /list_pages/);
  assert.match(describeApiError(409, { error: 'conflict' }), /retry once/);
  assert.match(describeApiError(429, { error: 'rate limited, slow down' }), /Slow down/);
  assert.match(describeApiError(400, { error: 'bad edits' }), /edit shapes/);
  assert.match(describeApiError(502, { error: 'commit failed' }), /transient/);
  assert.match(describeApiError(503, { error: 'app not installed on repo' }), /GitHub App/);
  assert.match(describeApiError(418, {}), /HTTP 418/);
});

test('describeApiError 422: carries error + detail and states the policy', () => {
  const msg = describeApiError(422, { error: 'edit contains disallowed markup', detail: 'onclick' });
  assert.match(msg, /sanitizer/);
  assert.match(msg, /edit contains disallowed markup/);
  assert.match(msg, /detail: onclick/);
  assert.match(msg, /can never be added/);
});

// ─── formatters ──────────────────────────────────────────────────────────────

test('formatPages: list, truncation note, empty-scope hint', () => {
  const out = formatPages({ pages: ['index.html', 'a/index.html'], truncated: true });
  assert.match(out, /2 editable page\(s\)/);
  assert.match(out, /- a\/index\.html/);
  assert.match(out, /truncated/);
  assert.match(formatPages({ pages: [] }), /path scope/);
});

test('formatFields: keys are presented as the schema; null values flagged', () => {
  const out = formatFields({ path: 'index.html', fields: { t: { value: 'x', kind: 'field' }, r: { value: null, kind: 'repeat' } } });
  assert.match(out, /keys are the schema/);
  assert.match(out, /t \[field\]: "x"/);
  assert.match(out, /r \[repeat\]: \(no value/);
});

test('formatEditResult: commit URL leads; skipped and unchanged handled', () => {
  const url = 'https://github.com/o/r/commit/deadbeef';
  const out = formatEditResult({ ok: true, commit: { sha: 'deadbeef', url }, applied: ['a'], skipped: ['b'] });
  assert.ok(out.startsWith(`Committed: ${url}`));
  assert.match(out, /Applied: a/);
  assert.match(out, /Skipped.*: b/);
  assert.match(formatEditResult({ ok: true, unchanged: true, commit: null, applied: ['a'], skipped: [] }), /No-op/);
});

test('formatSiteInfo: ok probe summarizes scope; failed probe passes message through', () => {
  const ok = formatSiteInfo('https://auth.example.com', 'f'.repeat(64), { ok: true, body: { pages: ['index.html'] } });
  assert.match(ok, /Token: ffffffff…/);
  assert.match(ok, /1 page\(s\)/);
  const bad = formatSiteInfo('https://auth.example.com', 'f'.repeat(64), { ok: false, message: 'Unauthorized: nope' });
  assert.match(bad, /Unauthorized: nope/);
});

test('redactToken never leaks more than a prefix', () => {
  assert.equal(redactToken('abcdefgh' + 'x'.repeat(56)), 'abcdefgh…');
});

// ─── apiFetch policy ─────────────────────────────────────────────────────────

test('apiFetch: retries exactly once on network failure, then reports it', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('boom'); };
  await assert.rejects(() => apiFetch('https://x.dev/', {}, { fetchImpl }), /network failure.*2 attempt/);
  assert.equal(calls, 2);
});

test('apiFetch: an HTTP error status is an answer, never retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 500 }; };
  const res = await apiFetch('https://x.dev/', {}, { fetchImpl });
  assert.equal(res.status, 500);
  assert.equal(calls, 1);
});

test('apiFetch: success passes the response through with an abort signal set', async () => {
  let sawSignal = null;
  const fetchImpl = async (url, init) => { sawSignal = init.signal; return { ok: true, status: 200 }; };
  const res = await apiFetch('https://x.dev/', {}, { fetchImpl });
  assert.equal(res.status, 200);
  assert.ok(sawSignal instanceof AbortSignal);
});
