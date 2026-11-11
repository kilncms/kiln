/**
 * The editor on a site whose free trial or plan has ended: it asks the worker
 * where the address stands and says so, where it used to say the site could
 * not be reached. Asking must never throw or hold the editor up.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askStanding, planEndedNotice } from '../src/editor/plan-ended.js';

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

test('planEndedNotice: a trial that ran out and a plan that ended each get their own plain sentence and the way out', () => {
  const trial = planEndedNotice({ editable: false, reason: 'trial_ended', dashboard: 'https://app.example' });
  assert.match(trial.text, /^This site’s free trial has ended, so nothing can be changed here until the site’s owner subscribes\./);
  assert.match(trial.text, /everything already published are untouched\.$/);
  assert.match(trial.detail, /^For the owner: open the Kiln dashboard and press Subscribe/);
  assert.equal(trial.button, 'Open the Kiln dashboard');
  assert.equal(trial.link, 'https://app.example/');
  const plan = planEndedNotice({ editable: false, reason: 'plan_ended', dashboard: 'https://app.example' });
  assert.match(plan.text, /^This site’s Kiln plan has ended, so nothing can be changed here until the site’s owner subscribes again\./);
  for (const n of [trial, plan]) for (const w of [n.text, n.detail]) assert.equal(/[—–]| - |!/.test(w), false, w);
});

test('planEndedNotice: says nothing for a site that may be edited, an address the worker does not know, or no answer', () => {
  assert.equal(planEndedNotice({ editable: true }), null);
  assert.equal(planEndedNotice({ editable: false, reason: 'unknown' }), null);
  assert.equal(planEndedNotice({ editable: false }), null);
  assert.equal(planEndedNotice(null), null);
});

test('planEndedNotice: a dashboard address that is no web address is never offered as a button', () => {
  for (const dashboard of ['javascript:alert(1)', 'data:text/html,x', '', undefined, 'not a url']) {
    const n = planEndedNotice({ editable: false, reason: 'trial_ended', dashboard });
    assert.equal(n.link, null, String(dashboard));
    assert.equal(n.button, '');
    assert.equal(n.detail, '');
    assert.ok(n.text);
  }
});

test('wired: the editor asks as it starts, and a start that fails on an ended site shows this notice and not "could not be reached"', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
  assert.match(main, /import \{ askStanding, planEndedNotice \} from '\.\/plan-ended\.js';/);
  const init = main.slice(main.indexOf('async function init() {'), main.indexOf('renderAdminBar();'));
  assert.match(init, /const standing = askStanding\(\{ worker: cfg\.worker, origin: location\.origin \}\);/);
  // before the "could not start" card, the editor looks at what the worker said about this address
  assert.ok(init.indexOf('if (!over.drop && await saidPlanEnded(standing)) return;') > 0);
  assert.ok(init.indexOf('if (!over.drop && await saidPlanEnded(standing)) return;') < init.lastIndexOf('notStarted(over);'));
});
