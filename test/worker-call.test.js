/**
 * Asking the worker with the editor's sign-in (src/editor/worker-call.js):
 * every answer that is not a success is thrown with its status and body, a
 * 403 from a route that answers 403 to someone it does not know is checked
 * once against the transport, and the owner's renewed token is tried again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAsk } from '../src/editor/worker-call.js';
import { readFailure } from '../src/editor/sign-in-ended.js';

const WORKER = 'https://worker.example';
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('not json'); return body; } });

/** A stand-in for fetch: `answers` is a list of answers, or a function of the request. */
function fakeFetch(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    const next = typeof answers === 'function' ? answers(calls.length, { url, ...init }) : answers[Math.min(calls.length - 1, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}
const session = () => ({ 'X-Kiln-Session': 'a'.repeat(64) });
const thrown = async (promise) => { try { await promise; } catch (err) { return err; } assert.fail('nothing was thrown'); };

test('ask: a success is the answer, sent with the sign-in headers and a JSON body', async () => {
  const { calls, fetchImpl } = fakeFetch([answer(200, { ok: true, id: 'x' })]);
  const ask = makeAsk({ worker: WORKER, headers: session, fetchImpl });
  assert.deepEqual(await ask('/schedule', { method: 'POST', body: { repo: 'acme/site', at: 1 } }), { ok: true, id: 'x' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://worker.example/schedule');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].headers, { 'Content-Type': 'application/json', 'X-Kiln-Session': 'a'.repeat(64) });
  assert.equal(calls[0].body, JSON.stringify({ repo: 'acme/site', at: 1 }));
  // reading something sends no body and no content type
  const get = fakeFetch([answer(200, { schedules: [] })]);
  await makeAsk({ worker: WORKER, headers: session, fetchImpl: get.fetchImpl })('/schedules?repo=acme%2Fsite');
  assert.equal(get.calls[0].method, 'GET');
  assert.deepEqual(get.calls[0].headers, session());
  assert.equal('body' in get.calls[0], false);
});

test('ask: a 401 is thrown with its status and body, reads as an ended sign-in, and is reported', async () => {
  for (const body of [{ error: 'unauthorized' }, { error: 'session expired', code: 'repo_changed', message: 'For the owner.' }, undefined]) {
    const seen = [];
    const { fetchImpl } = fakeFetch([answer(401, body)]);
    const err = await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl, ended: (e) => seen.push(e) })('/comments?repo=acme%2Fsite'));
    assert.equal(err.status, 401);
    assert.deepEqual(err.data, body || {});
    assert.equal(readFailure(err).kind, 'ended');
    assert.deepEqual(seen, [err], 'the editor is told once');
  }
  const { fetchImpl } = fakeFetch([answer(401, { error: 'session expired', code: 'repo_changed', message: 'For the owner.' })]);
  const f = readFailure(await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl })('/x')));
  assert.equal(f.ownerMust, true);
  assert.equal(f.message, 'For the owner.');
});

test('ask: an invited editor\'s 401 is not checked again', async () => {
  let checks = 0;
  const { calls, fetchImpl } = fakeFetch([answer(401, { error: 'unauthorized' })]);
  await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl, stands: async () => { checks++; } })('/comments'));
  assert.equal(checks, 0);
  assert.equal(calls.length, 1);
});

test('ask: a 403 from a route that answers 403 to someone it does not know is an ended sign-in when the transport says so', async () => {
  // What the worker's proxy answers to a session it no longer has.
  const over = Object.assign(new Error('GitHub 401: session expired'), { status: 401, data: { error: 'session expired' } });
  const seen = [];
  const { calls, fetchImpl } = fakeFetch([answer(403, { error: 'forbidden' })]);
  const err = await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl, stands: async () => { throw over; }, ended: (e) => seen.push(e) })('/schedule', { method: 'POST', body: {} }));
  assert.equal(err, over, 'the answer that settles it is the one thrown');
  assert.equal(readFailure(err).kind, 'ended');
  assert.deepEqual(seen, [over]);
  assert.equal(calls.length, 1, 'the request is not sent again');
  // …and the proxy's "the owner has something to correct" comes through with it
  const moved = Object.assign(new Error('GitHub 401: session expired'), { status: 401, data: { error: 'session expired', code: 'repo_changed', message: 'Run kiln doctor.' } });
  const f = readFailure(await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl: fakeFetch([answer(403, { error: 'forbidden' })]).fetchImpl, stands: async () => { throw moved; } })('/schedules')));
  assert.deepEqual([f.kind, f.ownerMust, f.message], ['ended', true, 'Run kiln doctor.']);
});

test('ask: a 403 with the sign-in still good is a refusal, with the worker\'s reason', async () => {
  let checks = 0;
  const seen = [];
  const { calls, fetchImpl } = fakeFetch([answer(403, { error: 'your access does not include scheduling', code: 'grant_required', grant: 'schedule' })]);
  const err = await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl, stands: async () => { checks++; }, ended: (e) => seen.push(e) })('/schedule', { method: 'POST', body: {} }));
  assert.equal(checks, 1, 'asked once');
  assert.equal(calls.length, 1, 'the sign-in did not change, so the request is not sent again');
  assert.equal(err.status, 403);
  assert.equal(err.message, 'your access does not include scheduling');
  const f = readFailure(err);
  assert.equal(f.kind, 'refused');
  assert.equal(f.reason, 'your access does not include scheduling');
  assert.deepEqual(seen, []);
});

test('ask: when the check itself meets trouble, the first answer stands', async () => {
  for (const trouble of [new TypeError('Failed to fetch'), Object.assign(new Error('GitHub 502'), { status: 502 }), Object.assign(new Error('GitHub 429'), { status: 429 }),
    Object.assign(new Error('GitHub 401: Bad credentials'), { status: 401, signIn: 'trouble' })]) {
    const seen = [];
    const { fetchImpl } = fakeFetch([answer(403, { error: 'forbidden' })]);
    const err = await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl, stands: async () => { throw trouble; }, ended: (e) => seen.push(e) })('/schedules'));
    assert.equal(err.status, 403);
    assert.equal(readFailure(err).kind, 'refused');
    assert.deepEqual(seen, [], 'nobody is told the sign-in has ended');
  }
});

test('ask: the owner\'s token that ran out is renewed by the check, and the request is sent once more with the new one', async () => {
  let token = 'old';
  const headers = () => ({ Authorization: `Bearer ${token}` });
  for (const first of [401, 403]) {
    token = 'old';
    const { calls, fetchImpl } = fakeFetch((n) => (n === 1 ? answer(first, { error: first === 401 ? 'unauthorized' : 'forbidden' }) : answer(200, { people: [], googleConfigured: true })));
    const seen = [];
    const data = await makeAsk({ worker: WORKER, headers, fetchImpl, renews: true, stands: async () => { token = 'new'; }, ended: (e) => seen.push(e) })('/admin/people?repo=acme%2Fsite');
    assert.deepEqual(data, { people: [], googleConfigured: true });
    assert.deepEqual(calls.map(c => c.headers.Authorization), ['Bearer old', 'Bearer new']);
    assert.deepEqual(seen, []);
  }
});

test('ask: a token renewed by something else while the request was on its way is tried again too', async () => {
  // The request leaves with the old token. Before its 401 is back, another request of the editor's has
  // renewed the token. The check then finds the sign-in good without renewing anything.
  let token = 'old';
  const headers = () => ({ Authorization: `Bearer ${token}` });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.headers.Authorization);
    if (calls.length === 1) { token = 'new'; return answer(401, { error: 'unauthorized' }); }
    return answer(200, { thread: { id: 't1' } });
  };
  const seen = [];
  const data = await makeAsk({ worker: WORKER, headers, fetchImpl, renews: true, stands: async () => {}, ended: (e) => seen.push(e) })('/comments', { method: 'POST', body: { text: 'Yes.' } });
  assert.deepEqual(data, { thread: { id: 't1' } });
  assert.deepEqual(calls, ['Bearer old', 'Bearer new']);
  assert.deepEqual(seen, []);
});

test('ask: the owner\'s token that could not be renewed is an ended sign-in', async () => {
  const dead = Object.assign(new Error('GitHub 401: Bad credentials'), { status: 401, data: { message: 'Bad credentials' }, signIn: 'ended' });
  for (const first of [401, 403]) {
    const { calls, fetchImpl } = fakeFetch([answer(first, { error: 'forbidden' })]);
    const seen = [];
    const err = await thrown(makeAsk({ worker: WORKER, headers: () => ({ Authorization: 'Bearer old' }), fetchImpl, renews: true, stands: async () => { throw dead; }, ended: (e) => seen.push(e) })('/schedule', { method: 'POST', body: {} }));
    assert.equal(readFailure(err).kind, 'ended');
    assert.deepEqual(seen, [dead]);
    assert.equal(calls.length, 1);
  }
});

test('ask: a 401 to an owner whose sign-in is good and was not renewed is a refusal, not an ended sign-in', async () => {
  const seen = [];
  const { calls, fetchImpl } = fakeFetch([answer(401, { error: 'unauthorized' })]);
  const err = await thrown(makeAsk({ worker: WORKER, headers: () => ({ Authorization: 'Bearer good' }), fetchImpl, renews: true, stands: async () => {}, ended: (e) => seen.push(e) })('/comments'));
  assert.equal(calls.length, 1);
  assert.equal(err.status, 401);
  const f = readFailure(err);
  assert.equal(f.kind, 'refused', 'signing in again would get the same answer');
  assert.equal(f.reason, 'unauthorized');
  assert.deepEqual(seen, []);
});

test('ask: no answer, a 5xx and a 429 are trouble, never the sign-in, and nothing is checked', async () => {
  let checks = 0;
  const stands = async () => { checks++; };
  const none = fakeFetch([new TypeError('Failed to fetch')]);
  const err = await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl: none.fetchImpl, stands })('/schedule', { method: 'POST', body: {} }));
  assert.deepEqual([readFailure(err).kind, readFailure(err).trouble], ['trouble', 'unreachable']);
  for (const [status, trouble] of [[500, 'failing'], [502, 'failing'], [503, 'failing'], [429, 'busy']]) {
    const { fetchImpl } = fakeFetch([answer(status, { error: status === 429 ? 'rate limited, slow down' : 'internal error' })]);
    const e = await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl, stands })('/comments', { method: 'POST', body: {} }));
    assert.equal(e.status, status);
    assert.deepEqual([readFailure(e).kind, readFailure(e).trouble], ['trouble', trouble]);
  }
  assert.equal(checks, 0);
});

test('ask: other answers keep the worker\'s own words and status for the caller', async () => {
  for (const [status, body, message] of [
    [404, { error: 'not found' }, 'not found'],
    [409, { error: 'conflict: the file changed while saving — try again' }, 'conflict: the file changed while saving — try again'],
    [422, { error: 'no edits could be applied', skipped: [{ key: 'a' }] }, 'no edits could be applied'],
    [400, undefined, 'the request failed (400)'],
  ]) {
    const { fetchImpl } = fakeFetch([answer(status, body)]);
    const err = await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl })('/x', { method: 'POST', body: {} }));
    assert.equal(err.status, status);
    assert.equal(err.message, message);
    assert.deepEqual(err.data, body || {});
    assert.equal(readFailure(err).kind, 'other');
  }
  // "AI assist is not set up" is a 501: the caller tells it by its status, which it still has
  const { fetchImpl } = fakeFetch([answer(501, { error: 'ai not configured' })]);
  assert.equal((await thrown(makeAsk({ worker: WORKER, headers: session, fetchImpl })('/ai/assist', { method: 'POST', body: {} }))).status, 501);
});
