import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGh, getFile, editFile, encodeContent, decodeContent, commitFiles } from '../src/github.js';
import { applyEdits } from '../src/engine.js';

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    for (const r of routes) {
      if (r.match(url, opts)) {
        const out = typeof r.respond === 'function' ? r.respond(url, opts) : r.respond;
        return {
          ok: out.status < 400,
          status: out.status,
          statusText: String(out.status),
          json: async () => out.body,
        };
      }
    }
    return { ok: false, status: 404, statusText: '404', json: async () => ({ message: 'no route' }) };
  };
  fn.calls = calls;
  return fn;
}

test('utf-8 base64 round-trips emoji and accents', () => {
  const s = '© naïve café 日本語 🎉 — done';
  assert.equal(decodeContent(encodeContent(s)), s);
});

test('direct transport hits api.github.com with bearer token', async () => {
  const fetchImpl = mockFetch([
    { match: (u) => u.includes('api.github.com/repos/o/r/contents/index.html'),
      respond: { status: 200, body: { content: encodeContent('<p data-cms="k">v</p>'), sha: 'abc' } } },
  ]);
  const gh = makeGh({ mode: 'direct', token: () => 'T', fetchImpl });
  const file = await getFile(gh, 'o/r', 'index.html', 'main');
  assert.equal(file.sha, 'abc');
  assert.ok(file.text.includes('data-cms'));
});

test('proxy transport routes through worker with session header', async () => {
  let seenHeaders;
  const fetchImpl = async (url, opts) => {
    seenHeaders = opts.headers;
    assert.ok(url.startsWith('https://w.example/gh/repos/o/r/contents/'));
    return { ok: true, status: 200, json: async () => ({ content: encodeContent('x'), sha: 's' }) };
  };
  const gh = makeGh({ mode: 'proxy', worker: 'https://w.example', session: 'S'.repeat(64).toLowerCase(), fetchImpl });
  await getFile(gh, 'o/r', 'index.html', 'main');
  assert.equal(seenHeaders['X-Kiln-Session'], 'S'.repeat(64).toLowerCase());
  assert.equal(seenHeaders.Authorization, undefined, 'no GitHub token leaves the browser in proxy mode');
});

test('editFile retries on sha conflict and merges against fresh source', async () => {
  // Simulates: we read v1; meanwhile someone commits v2 (different field);
  // our PUT 409s; retry reads v2; transform re-applies; PUT succeeds.
  const v1 = '<p data-cms="a">old-a</p><p data-cms="b">old-b</p>';
  const v2 = '<p data-cms="a">other-admin-a</p><p data-cms="b">old-b</p>';
  let reads = 0;
  let puts = 0;
  let finalBody;
  const fetchImpl = mockFetch([
    { match: (u, o) => u.includes('/contents/') && (o.method || 'GET') === 'GET',
      respond: () => ({ status: 200, body: { content: encodeContent(reads++ === 0 ? v1 : v2), sha: `sha${reads}` } }) },
    { match: (u, o) => u.includes('/contents/') && o.method === 'PUT',
      respond: (u, o) => {
        puts++;
        if (puts === 1) return { status: 409, body: { message: 'is at <new> but expected <old>' } };
        finalBody = JSON.parse(o.body);
        return { status: 200, body: { commit: { sha: 'newsha' } } };
      } },
  ]);
  const gh = makeGh({ mode: 'direct', token: () => 'T', fetchImpl });
  const result = await editFile(gh, 'o/r', 'index.html', 'main',
    (text) => applyEdits(text, [{ key: 'b', html: 'NEW-B' }]).html, 'edit b');
  assert.equal(result.unchanged, false);
  assert.equal(puts, 2);
  const committed = decodeContent(finalBody.content);
  assert.ok(committed.includes('other-admin-a'), 'concurrent edit to field a preserved');
  assert.ok(committed.includes('NEW-B'), 'our edit to field b applied');
});

test('editFile returns unchanged when transform is a no-op', async () => {
  const fetchImpl = mockFetch([
    { match: (u, o) => (o.method || 'GET') === 'GET',
      respond: { status: 200, body: { content: encodeContent('same'), sha: 's' } } },
  ]);
  const gh = makeGh({ mode: 'direct', token: () => 'T', fetchImpl });
  const result = await editFile(gh, 'o/r', 'f.html', 'main', (t) => t, 'noop');
  assert.equal(result.unchanged, true);
  assert.equal(fetchImpl.calls.filter(c => c.method === 'PUT').length, 0);
});

test('commitFiles drives the Git Data API in order and updates the ref', async () => {
  const order = [];
  const fetchImpl = mockFetch([
    { match: (u) => u.includes('/git/ref/'), respond: () => { order.push('ref'); return { status: 200, body: { object: { sha: 'base' } } }; } },
    { match: (u) => u.includes('/git/commits/base'), respond: () => { order.push('basecommit'); return { status: 200, body: { tree: { sha: 'btree' } } }; } },
    { match: (u, o) => u.includes('/git/blobs') && o.method === 'POST', respond: () => { order.push('blob'); return { status: 201, body: { sha: 'blob1' } }; } },
    { match: (u, o) => u.includes('/git/trees') && o.method === 'POST', respond: () => { order.push('tree'); return { status: 201, body: { sha: 'tree1' } }; } },
    { match: (u, o) => u.includes('/git/commits') && o.method === 'POST', respond: () => { order.push('commit'); return { status: 201, body: { sha: 'c1' } }; } },
    { match: (u, o) => u.includes('/git/refs/') && o.method === 'PATCH', respond: () => { order.push('update'); return { status: 200, body: {} }; } },
  ]);
  const gh = makeGh({ mode: 'direct', token: () => 'T', fetchImpl });
  const commit = await commitFiles(gh, 'o/r', 'main',
    [{ path: 'blog/p.html', text: '<html/>' }, { path: 'blog/index.html', text: '<html/>' }], 'new post');
  assert.equal(commit.sha, 'c1');
  assert.deepEqual(order, ['ref', 'basecommit', 'blob', 'blob', 'tree', 'commit', 'update']);
});
