/**
 * Operator notifications — a new site registration and an applied billing
 * webhook each send ONE short mail through the NOTIFY binding; an ignored
 * webhook sends nothing; a missing binding or a failing send changes no
 * behavior. The binding is faked here: production wraps the same fields in
 * cloudflare:email's EmailMessage (that import only exists on Workers).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.js';
import { notifyOwner } from '../worker/cloud.js';
import { fakeKV } from './worker-harness.js';
import { cloudEnv, addSite, d1Skip } from './d1-fake.js';

let events = 0;
/** One signed Stripe notice about a subscription of the site. A `type` that is not about a subscription is one this service does not act on. */
const hook = async (env, { type = 'customer.subscription.updated', status = 'active', site = 'site-1', sub = 'sub_77' } = {}) => {
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: `evt_note_${++events}`, object: 'event', type, created: now,
    data: { object: { id: sub, object: 'subscription', customer: 'cus_1', status, metadata: { site_id: site }, items: { data: [{ current_period_end: now + 30 * 86400, price: { id: 'price_cloud' } }] } } },
  });
  const header = `t=${now},v1=${createHmac('sha256', 'whsec').update(`${now}.${body}`).digest('hex')}`;
  return worker.fetch(new Request('https://worker.example/cloud/webhook/stripe', { method: 'POST', headers: { 'Stripe-Signature': header }, body }), env);
};
const withNotify = (env) => { const sent = []; env.NOTIFY = { send: async (m) => sent.push(m) }; env.NOTIFY_TO = 'owner@example.com'; return sent; };

test('notifyOwner: one plain-text mail; silent without the binding; a failing send never throws', async () => {
  const sent = [];
  await notifyOwner({ NOTIFY: { send: async (m) => sent.push(m) }, NOTIFY_TO: 'owner@example.com' }, 'New Kiln site: a/b', ['Plan: managed']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.match(sent[0].raw, /Subject: New Kiln site: a\/b/);
  assert.match(sent[0].raw, /Plan: managed/);
  assert.match(sent[0].raw, /Content-Type: text\/plain/);
  await notifyOwner({}, 'x', ['y']);   // no binding: nothing happens, nothing throws
  await notifyOwner({ NOTIFY: { send: async () => { throw new Error('smtp down'); } }, NOTIFY_TO: 'o@e.c' }, 'x', ['y']);
});

test('notifyOwner: a subject with line breaks cannot smuggle headers', async () => {
  const sent = [];
  await notifyOwner({ NOTIFY: { send: async (m) => sent.push(m) }, NOTIFY_TO: 'o@e.c' }, 'a\r\nBcc: evil@x', ['body']);
  assert.match(sent[0].raw, /Subject: a Bcc: evil@x/);
  assert.ok(!/^Bcc:/m.test(sent[0].raw), 'no injected header line');
});

test('billing webhook: an applied event notifies the operator, an ignored one does not', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV());
  addSite(env, { status: 'trialing' });
  const sent = withNotify(env);
  const res = await hook(env, { type: 'customer.subscription.created', status: 'active' });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.match(sent[0].raw, /customer\.subscription\.created/);
  assert.match(sent[0].raw, /Status: active/);
  await hook(env, { type: 'invoice.paid', status: 'paid' });   // a kind of event this service does not act on
  assert.equal(sent.length, 1, 'ignored events say nothing');
});

test('billing webhook without the binding: behavior unchanged', { skip: d1Skip }, async () => {
  const env = cloudEnv(fakeKV());
  addSite(env, { status: 'trialing' });
  const res = await hook(env, { type: 'customer.subscription.created', status: 'active' });
  assert.equal(res.status, 200);
  assert.equal((await env.kiln_cloud.row('SELECT status FROM sites WHERE id = ?', 'site-1')).status, 'active');
});
