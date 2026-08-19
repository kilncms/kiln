/**
 * Integration: all four tools end-to-end over a real MCP client/server pair
 * (InMemoryTransport), with fetch mocked to a canned Kiln worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../index.mjs';

const CONFIG = { workerUrl: 'https://auth.example.com', token: 'a'.repeat(64), warnings: [] };
const COMMIT_URL = 'https://github.com/acme/site/commit/abc123';

/** Canned worker: routes → responses, and a log of every request it saw. */
function mockWorker(routes) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    seen.push({ url: u, init });
    const handler = routes[`${init.method || 'GET'} ${u.pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const { status = 200, body } = typeof handler === 'function' ? handler(u, init) : handler;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, seen };
}

async function connect(fetchImpl) {
  const server = createServer(CONFIG, fetchImpl);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (result) => result.content.map(c => c.text).join('\n');

test('tools/list exposes exactly the four tools', async () => {
  const client = await connect(mockWorker({}).fetchImpl);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['edit_fields', 'get_fields', 'list_pages', 'site_info']);
});

test('list_pages: lists pages, passes ref, sends bearer auth', async () => {
  const worker = mockWorker({
    'GET /api/v1/pages': { body: { pages: ['index.html', 'about/index.html'], truncated: true } },
  });
  const client = await connect(worker.fetchImpl);
  const result = await client.callTool({ name: 'list_pages', arguments: { ref: 'main' } });
  assert.ok(!result.isError);
  const out = textOf(result);
  assert.match(out, /2 editable page\(s\)/);
  assert.match(out, /about\/index\.html/);
  assert.match(out, /truncated/);
  assert.equal(worker.seen[0].url.searchParams.get('ref'), 'main');
  assert.equal(worker.seen[0].init.headers.Authorization, `Bearer ${CONFIG.token}`);
});

test('get_fields: renders keys, kinds, values (null value flagged)', async () => {
  const worker = mockWorker({
    'GET /api/v1/fields': {
      body: { path: 'index.html', fields: { 'hero.title': { value: 'Hi', kind: 'field' }, 'hero.img': { value: null, kind: 'field' } } },
    },
  });
  const client = await connect(worker.fetchImpl);
  const result = await client.callTool({ name: 'get_fields', arguments: { path: '/' } });
  assert.ok(!result.isError);
  const out = textOf(result);
  assert.match(out, /hero\.title \[field\]: "Hi"/);
  assert.match(out, /hero\.img \[field\]: \(no value/);
  assert.equal(worker.seen[0].url.searchParams.get('path'), '/');
});

test('edit_fields: happy path returns the commit URL prominently', async () => {
  const worker = mockWorker({
    'PATCH /api/v1/edits': { body: { ok: true, commit: { sha: 'abc123', url: COMMIT_URL }, applied: ['hero.title'], skipped: [] } },
  });
  const client = await connect(worker.fetchImpl);
  const result = await client.callTool({
    name: 'edit_fields',
    arguments: { path: '/', edits: [{ key: 'hero.title', html: 'New headline' }], message: 'freshen hero' },
  });
  assert.ok(!result.isError);
  const out = textOf(result);
  assert.match(out, new RegExp(`^Committed: ${COMMIT_URL}`.replace(/[/.]/g, '\\$&')));
  assert.match(out, /Applied: hero\.title/);
  const sent = JSON.parse(worker.seen[0].init.body);
  assert.equal(sent.message, 'freshen hero');
  assert.deepEqual(sent.edits, [{ key: 'hero.title', html: 'New headline' }]);
});

test('edit_fields: attr edit shape goes through; unchanged is a clean no-op', async () => {
  const worker = mockWorker({
    'PATCH /api/v1/edits': { body: { ok: true, unchanged: true, commit: null, applied: ['hero.img'], skipped: [] } },
  });
  const client = await connect(worker.fetchImpl);
  const result = await client.callTool({
    name: 'edit_fields',
    arguments: { path: '/', edits: [{ key: 'hero.img', attr: 'src', value: '/img/new.jpg' }] },
  });
  assert.ok(!result.isError);
  assert.match(textOf(result), /No-op/);
});

test('edit_fields: 422 sanitizer rejection explains the policy', async () => {
  const worker = mockWorker({
    'PATCH /api/v1/edits': { status: 422, body: { error: 'edit contains disallowed markup', detail: 'script' } },
  });
  const client = await connect(worker.fetchImpl);
  const result = await client.callTool({
    name: 'edit_fields',
    arguments: { path: '/', edits: [{ key: 'hero.title', html: '<script>x()</script>' }] },
  });
  assert.ok(result.isError);
  const out = textOf(result);
  assert.match(out, /sanitizer/);
  assert.match(out, /edit contains disallowed markup/);
  assert.match(out, /detail: script/);
  assert.match(out, /can never be added/);
});

test('edit_fields: 409 conflict suggests retrying once', async () => {
  const worker = mockWorker({
    'PATCH /api/v1/edits': { status: 409, body: { error: 'conflict: page changed while editing, try again' } },
  });
  const client = await connect(worker.fetchImpl);
  const result = await client.callTool({
    name: 'edit_fields',
    arguments: { path: '/', edits: [{ key: 'k', html: 'v' }] },
  });
  assert.ok(result.isError);
  assert.match(textOf(result), /safe to retry once/);
});

test('edit_fields: malformed batch is rejected client-side, nothing sent', async () => {
  const worker = mockWorker({});
  const client = await connect(worker.fetchImpl);
  const result = await client.callTool({
    name: 'edit_fields',
    arguments: { path: '/', edits: [{ key: 'k', html: 'x', attr: 'src', value: 'y' }] },
  });
  assert.ok(result.isError);
  assert.match(textOf(result), /exactly one shape/);
  assert.equal(worker.seen.length, 0);
});

test('site_info: one pages call, reports count and scope notes', async () => {
  const worker = mockWorker({
    'GET /api/v1/pages': { body: { pages: ['index.html', 'menu/index.html'] } },
  });
  const client = await connect(worker.fetchImpl);
  const result = await client.callTool({ name: 'site_info', arguments: {} });
  assert.ok(!result.isError);
  const out = textOf(result);
  assert.match(out, /auth\.example\.com/);
  assert.match(out, /Token: aaaaaaaa…/);
  assert.match(out, /2 page\(s\)/);
  assert.match(out, /index\.html, menu\/index\.html/);
  assert.equal(worker.seen.length, 1, 'site_info must stay one cheap call');
});

test('site_info: 401 becomes an actionable isError, not a crash', async () => {
  const worker = mockWorker({
    'GET /api/v1/pages': { status: 401, body: { error: 'unauthorized' } },
  });
  const client = await connect(worker.fetchImpl);
  const result = await client.callTool({ name: 'site_info', arguments: {} });
  assert.ok(result.isError);
  assert.match(textOf(result), /Unauthorized/);
  assert.match(textOf(result), /KILN_API_TOKEN/);
});

test('network failure surfaces as isError after the one retry', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('ECONNREFUSED'); };
  const client = await connect(fetchImpl);
  const result = await client.callTool({ name: 'list_pages', arguments: {} });
  assert.ok(result.isError);
  assert.match(textOf(result), /network failure/);
  assert.equal(calls, 2, 'exactly one retry on network failure');
});
