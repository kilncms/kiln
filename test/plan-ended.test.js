/**
 * The editor on a site whose free trial or plan has ended: it asks the worker
 * where the address stands and says so, where it used to say the site could
 * not be reached. Asking must never throw or hold the editor up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askStanding, endedNotice } from '../src/editor/plan-ended.js';

const answers = (body, { ok = true } = {}) => async (url) => ({ ok, url, json: async () => body });

test('askStanding: asks the worker about this address, and hands back what it says', async () => {
  let asked = '';
  const got = await askStanding({ worker: 'https://auth.example/', origin: 'https://club.example', fetchImpl: async (url) => { asked = url; return { ok: true, json: async () => ({ editable: false, reason: 'trial_ended', dashboard: 'https://app.example' }) }; } });
  assert.equal(asked, 'https://auth.example/standing?origin=https%3A%2F%2Fclub.example');
  assert.deepEqual(got, { editable: false, reason: 'trial_ended', dashboard: 'https://app.example' });
});

test('askStanding: an older worker, a failed request, a body that is not an answer, or nothing to ask with all come back as null', async () => {
  assert.equal(await askStanding({ worker: 'https://auth.example', origin: 'https://club.example', fetchImpl: answers({ error: 'not found' }, { ok: false }) }), null);
  assert.equal(await askStanding({ worker: 'https://auth.example', origin: 'https://club.example', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), null);
  assert.equal(await askStanding({ worker: 'https://auth.example', origin: 'https://club.example', fetchImpl: answers({ ok: true }) }), null);
  assert.equal(await askStanding({ worker: 'https://auth.example', origin: 'https://club.example', fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('not json'); } }) }), null);
  assert.equal(await askStanding({ worker: '', origin: 'https://club.example', fetchImpl: answers({ editable: true }) }), null);
  assert.equal(await askStanding({ worker: 'https://auth.example', origin: '', fetchImpl: answers({ editable: true }) }), null);
});

test('endedNotice: a trial that ran out and a plan that ended each get their own plain sentence and the way out', () => {
  const trial = endedNotice({ editable: false, reason: 'trial_ended', dashboard: 'https://app.example' });
  assert.match(trial.words, /^This site’s free trial has ended, so changes cannot be published until the site’s owner subscribes\./);
  assert.match(trial.words, /everything already published are untouched\.$/);
  assert.equal(trial.link, 'https://app.example/');
  assert.equal(trial.linkWords, 'For the owner: open the Kiln dashboard');
  const plan = endedNotice({ editable: false, reason: 'plan_ended', dashboard: 'https://app.example' });
  assert.match(plan.words, /^This site’s Kiln plan has ended, so changes cannot be published until the site’s owner subscribes again\./);
  for (const n of [trial, plan]) assert.equal(/[—–]| - |!/.test(n.words), false, n.words);
});

test('endedNotice: says nothing for a site that may be edited, an address the worker does not know, or no answer', () => {
  assert.equal(endedNotice({ editable: true }), null);
  assert.equal(endedNotice({ editable: false, reason: 'unknown' }), null);
  assert.equal(endedNotice({ editable: false }), null);
  assert.equal(endedNotice(null), null);
});

test('endedNotice: a dashboard address that is no web address is never offered as a link', () => {
  for (const dashboard of ['javascript:alert(1)', 'data:text/html,x', '', undefined, 'not a url']) {
    const n = endedNotice({ editable: false, reason: 'trial_ended', dashboard });
    assert.equal(n.link, null, String(dashboard));
    assert.equal(n.linkWords, null);
    assert.ok(n.words);
  }
});
