/**
 * The route the editor saves a picture on: POST /gh/repos/<repo>/git/blobs.
 *
 *  - the blob reaches GitHub as the very text that was sent
 *  - a blob whose declared length is a third of the upload ceiling or less
 *    cannot be refused for what it holds, so its installation token is asked
 *    for before its body is read; any other blob is read and checked first
 *  - every refusal is what it was, and a refused request asks for no token
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { UPLOAD_MAX_BYTES, FILE_MESSAGES } from '../src/file-policy.js';
import { editorEnv, withFetch, jsonRes, REPO, SESSION, ORIGIN } from './worker-harness.js';

const MB = 1024 * 1024;
const THIRD = Math.floor(UPLOAD_MAX_BYTES / 3);
const BLOBS = `/gh/repos/${REPO}/git/blobs`;
const TOO_BIG = { error: FILE_MESSAGES.size, code: 'file_size' };

/** The body of a blob request, as the bytes that arrive. */
const blobOf = (content, encoding = 'base64') => Buffer.concat([
  Buffer.from('{"content":"'), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(`","encoding":"${encoding}"}`)]);
/** A blob request of exactly `total` bytes, its content being the byte `fill` over and over. */
const blobOfLength = (total, fill = 0x41, encoding = 'base64') => blobOf(Buffer.alloc(total - blobOf('', encoding).length, fill), encoding);
const picture = (bytes) => blobOf(Buffer.alloc(bytes, 7).toString('base64'));

/** GitHub taking any blob; `seen` gets the text of each one exactly as it was handed over. */
const github = (seen = []) => async (url, init) => {
  if (init.method !== 'POST' || !url.endsWith('/git/blobs')) return undefined;
  seen.push({ body: init.body, authorization: init.headers.Authorization });
  return jsonRes({ sha: 'b'.repeat(40) }, 201);
};

/**
 * One request to the worker, with two things written down in `order` as they
 * happen: 'token' when the installation token is looked for, 'body' when the
 * first piece of the request's body is read. `declare` is the Content-Length
 * to send: true for the real one, false for none.
 */
function watched(bytes, { env = editorEnv(), declare = true, path = BLOBS, session = SESSION } = {}) {
  const order = [];
  const get = env.KILN.get.bind(env.KILN);
  env.KILN.get = async (key, type) => { if (key.startsWith('itok:')) order.push('token'); return get(key, type); };
  let at = 0;
  const body = new ReadableStream({
    pull(c) {
      if (!at) order.push('body');
      if (at >= bytes.length) { c.close(); return; }
      c.enqueue(new Uint8Array(bytes.subarray(at, at += 256 * 1024)));
    },
  }, { highWaterMark: 0 });
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (session) headers['X-Kiln-Session'] = session;
  if (declare !== false) headers['Content-Length'] = String(declare === true ? bytes.length : declare);
  const send = () => worker.fetch(new Request(`https://worker.example${path}`, { method: 'POST', body, duplex: 'half', headers }), env);
  return { order, send, env };
}

test('picture route: a blob reaches GitHub as the text that was sent', async () => {
  const cases = [
    ['a small picture', picture(200 * 1024), true],
    ['a picture over a third of the ceiling', picture(4 * MB), true],
    ['a picture at the ceiling', picture(UPLOAD_MAX_BYTES), true],
    ['a picture with no declared length', picture(200 * 1024), false],
    ['a text file', blobOf('<h1>Hello</h1>', 'utf-8'), true],
  ];
  for (const [what, bytes, declare] of cases) {
    const seen = [];
    await withFetch(github(seen), async () => {
      const res = await watched(bytes, { declare }).send();
      assert.equal(res.status, 201, what);
      assert.deepEqual(await res.json(), { sha: 'b'.repeat(40) }, what);
    });
    assert.equal(seen.length, 1, what);
    assert.ok(seen[0].body === bytes.toString('utf8'), `${what}: the same text, to the character`);
    assert.equal(seen[0].authorization, 'Bearer installation-token', what);
  }
});

test('picture route: the token is asked for before a blob that cannot be refused is read, and after any other is read and checked', async () => {
  await withFetch(github(), async () => {
    const first = async (what, w, order) => {
      assert.equal((await w.send()).status, 201, what);
      assert.deepEqual(w.order, order, what);
    };
    await first('a small picture', watched(picture(200 * 1024)), ['token', 'body']);
    await first('exactly a third of the ceiling', watched(blobOfLength(THIRD)), ['token', 'body']);
    // Bytes that are not UTF-8 are each read as three; at a third of the ceiling they still fit.
    await first('a third of the ceiling, none of it UTF-8', watched(blobOfLength(THIRD, 0xff, 'utf-8')), ['token', 'body']);
    await first('one byte over a third', watched(blobOfLength(THIRD + 1)), ['body', 'token']);
    await first('no declared length', watched(picture(200 * 1024), { declare: false }), ['body', 'token']);
    await first('a declared length that is no number', watched(picture(200 * 1024), { declare: '12, 12' }), ['body', 'token']);
  });
});

test('picture route: every refusal is what it was, and a refused request asks for no token', async () => {
  await withFetch(github(), async (calls) => {
    const refused = async (what, w, status, words, read) => {
      const res = await w.send();
      assert.equal(res.status, status, what);
      assert.deepEqual(await res.json(), words, what);
      assert.deepEqual(w.order, read, `${what}: no token asked for`);
    };
    const small = picture(200 * 1024);
    // Refused before the body matters: nothing is read and no token is asked for.
    await refused('no session', watched(small, { session: '' }), 401, { error: 'missing session' }, []);
    await refused('a session that is not there', watched(small, { session: 'b'.repeat(64) }), 401, { error: 'session expired' }, []);
    await refused('a session past its time', watched(small, { env: editorEnv({ exp: Date.now() - 1000 }) }), 401, { error: 'session expired' }, []);
    await refused('not an editor session', watched(small, { env: editorEnv({ role: 'owner' }) }), 403, { error: 'not an editor session' }, []);
    await refused('another repository', watched(small, { path: '/gh/repos/acme/other/git/blobs' }), 403, { error: 'path not allowed', path: '/repos/acme/other/git/blobs' }, []);
    await refused('a comment-only session', watched(small, { env: editorEnv({ mode: 'review' }) }), 403, { error: 'review-mode: comment-only access' }, []);
    await refused('a declared length over the largest body', watched(small, { declare: 64 * MB }), 413, TOO_BIG, []);
    // Refused for what the body holds: it is read, and still no token is asked for.
    await refused('a body over the largest, with no declared length', watched(Buffer.alloc(21 * MB, 0x41), { declare: false }), 413, TOO_BIG, ['body']);
    await refused('a picture one byte over the ceiling', watched(picture(UPLOAD_MAX_BYTES + 1)), 413, TOO_BIG, ['body']);
    await refused('text over the ceiling', watched(blobOf('é'.repeat(UPLOAD_MAX_BYTES / 2 + 1), 'utf-8')), 413, TOO_BIG, ['body']);
    // The case that sets the third: each byte that is not UTF-8 counts as three.
    await refused('just over a third of the ceiling, none of it UTF-8', watched(blobOfLength(THIRD + 64, 0xff, 'utf-8')), 413, TOO_BIG, ['body']);
    assert.equal(calls.length, 0, 'nothing was asked of GitHub');
  });
});

test('picture route: with no token to be had the answer is the same 503, small blob or large', async () => {
  const noToken = () => { const env = editorEnv(); env.KILN.map.delete(`itok:${REPO}`); return env; };
  await withFetch(github(), async (calls) => {
    for (const [bytes, order] of [[picture(200 * 1024), ['token']], [blobOfLength(THIRD + 1), ['body', 'token']]]) {
      const w = watched(bytes, { env: noToken() });
      const res = await w.send();
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: 'app not installed on repo', repo: REPO });
      assert.deepEqual(w.order, order);
    }
    assert.equal(calls.length, 0);
  });
});

test('picture route: a suggest-mode session saves a picture as before', async () => {
  const seen = [];
  await withFetch(github(seen), async () => {
    const bytes = picture(200 * 1024);
    const w = watched(bytes, { env: editorEnv({ mode: 'suggest' }) });
    assert.equal((await w.send()).status, 201);
    assert.ok(seen[0].body === bytes.toString('utf8'));
  });
});

// A repository whose own name puts `/contents/` in the path has always had
// the editor's name added to whatever it writes, a blob too. Held here only to
// show that letting the parsed body go leaves such a repository as it was.
test('picture route: a repository named "contents" gets what it got before', async () => {
  const seen = [];
  const env = editorEnv({ repo: 'acme/contents' }, { 'itok:acme/contents': 'installation-token' });
  await withFetch(github(seen), async () => {
    const res = await watched(blobOf('aGVsbG8='), { env, path: '/gh/repos/acme/contents/git/blobs' }).send();
    assert.equal(res.status, 201);
  });
  const sent = JSON.parse(seen[0].body);
  assert.equal(sent.content, 'aGVsbG8=');
  assert.equal(sent.encoding, 'base64');
  assert.match(sent.author.name, /^Sam/);
});
