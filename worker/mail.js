/**
 * The few emails Kiln Cloud writes to a customer.
 *
 *   site added       what to do next, and the day the free trial ends
 *   trial ends soon  two days before that day
 *   trial ended      editing is off, and what turns it back on
 *
 * A free trial needs no card, so the payment company knows nothing of it and
 * cannot remind anyone: before these, a trial ended in silence and the owner
 * found out when the editor would not start. Each is sent once, to the address
 * on the dashboard account, about that person's own site. Nothing else is
 * ever sent: no news, no offers.
 *
 * They go out through Cloudflare's own sending service, by the same
 * `send_email` binding the operator's notes use (NOTIFY), from an address of
 * a domain that is set up for sending in the same Cloudflare account. That
 * address is CUSTOMER_MAIL_FROM. Without the binding or without that name
 * nothing is sent and nothing fails: a worker somebody runs themselves, and
 * the staging worker, stay silent.
 *
 * The words are built by pure functions, tested in node; `sendMail` is the
 * only part that touches the binding.
 */

const DAY = 86400 * 1000;
export const TRIAL_NOTICE_DAYS = 2;   // "ends soon" goes out this many days before the end

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** An address a notice may be sent to: one plain address, nothing that could carry a second header. */
export function mailAddress(v) {
  const s = String(v ?? '').trim();
  return s.length <= 254 && /^[^\s@<>,;:"'()\\[\]]+@[^\s@<>,;:"'()\\[\]]+\.[^\s@<>,;:"'()\\[\]]{2,}$/.test(s) ? s : null;
}

/** "Tuesday, November 17": the day alone, the same for everyone who reads it. */
export function dayWords(ms) {
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

const hostOf = (origin) => { try { return new URL(origin).host; } catch { return String(origin || 'your site'); } };
const priceOf = (plan) => (plan === 'managed' ? '$14.99' : '$4.99');
const planOf = (plan) => (plan === 'managed' ? 'Kiln Cloud + hosting' : 'Kiln Cloud');

/** Paragraphs → the plain text and the simple HTML of one message. A line that is only a web address becomes a link. */
function message(subject, paragraphs, why) {
  const text = `${paragraphs.join('\n\n')}\n\nKiln\n${why}\n`;
  const html = [
    '<div style="font:16px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2330;max-width:560px">',
    ...paragraphs.map(p => (/^https?:\/\/\S+$/.test(p)
      ? `<p style="margin:0 0 16px"><a href="${esc(p)}" style="color:#1d4ed8">${esc(p)}</a></p>`
      : `<p style="margin:0 0 16px">${esc(p)}</p>`)),
    '<p style="margin:24px 0 4px">Kiln</p>',
    `<p style="margin:0;color:#6b7280;font-size:13px">${esc(why)}</p>`,
    '</div>',
  ].join('\n');
  return { subject, text, html };
}

const whyLine = (host) => `You are getting this because ${host} was added to Kiln Cloud with this email address. Reply to this email to reach a person.`;

/** Sent once when a site is added. `endsAt`: when its free trial runs out (ms). */
export function siteAddedMail({ origin, plan, endsAt, dashboard }) {
  const host = hostOf(origin), day = dayWords(endsAt);
  return message(`${host} is on Kiln: what to do next`, [
    'Hello,',
    `${host} is added to Kiln, and its free trial runs until ${day}. No card is needed for the trial.`,
    `To edit the site, open ${String(origin).replace(/\/+$/, '')}/kiln and sign in with GitHub. Click any outlined words or picture, change them, and press Publish.`,
    'To let someone else edit, open the Kiln menu on your site and choose People & access. They sign in with Google and need no GitHub account.',
    `To keep editing after ${day}, press Subscribe on the site's row in your dashboard. ${planOf(plan)} is ${priceOf(plan)} a month for the site, and you can cancel any time.`,
    dashboard,
    'The guide for site owners covers the rest:',
    'https://kilncms.com/owners',
  ], whyLine(host));
}

/** Sent once, TRIAL_NOTICE_DAYS before the free trial runs out. */
export function trialEndingMail({ origin, plan, endsAt, dashboard }) {
  const host = hostOf(origin), day = dayWords(endsAt);
  return message(`The Kiln free trial for ${host} ends on ${day}`, [
    'Hello,',
    `The free trial for ${host} ends on ${day}.`,
    `To keep editing after that, press Subscribe on the site's row in your dashboard before then. ${planOf(plan)} is ${priceOf(plan)} a month for the site, and you can cancel any time.`,
    dashboard,
    `If you do nothing, editing switches off on ${day}. Your site, its files and everything already published stay exactly as they are, and subscribing later turns editing back on.`,
  ], whyLine(host));
}

/** Sent once, when a free trial has run out and nobody subscribed. */
export function trialEndedMail({ origin, plan, dashboard }) {
  const host = hostOf(origin);
  return message(`The Kiln free trial for ${host} has ended`, [
    'Hello,',
    `The free trial for ${host} has ended, so editing through Kiln is switched off for now.`,
    'Your site, its files and everything already published are untouched. Nothing was charged, and nothing will be.',
    `To turn editing back on, press Subscribe on the site's row in your dashboard. ${planOf(plan)} is ${priceOf(plan)} a month for the site. Editing comes back as soon as the payment is confirmed.`,
    dashboard,
    'If Kiln was not right for the site, there is nothing to cancel and nothing to remove. We would be glad to hear what was missing: reply to this email.',
  ], whyLine(host));
}

/** True when this worker is set up to write to customers at all. */
export function customerMailOn(env) {
  return !!(env && env.NOTIFY && typeof env.NOTIFY.send === 'function' && mailAddress(env.CUSTOMER_MAIL_FROM));
}

/**
 * Send one message. Never throws and never fails the request or the cron run
 * it is part of: the answer says whether it went, and a failure leaves a line
 * for the operator.
 */
export async function sendMail(env, to, mail) {
  const address = mailAddress(to);
  if (!customerMailOn(env) || !address || !mail) return { ok: false, reason: !address ? 'no address' : 'mail is off' };
  try {
    const res = await env.NOTIFY.send({
      to: address,
      from: { email: mailAddress(env.CUSTOMER_MAIL_FROM), name: 'Kiln' },
      replyTo: mailAddress(env.CUSTOMER_MAIL_REPLY_TO) || mailAddress(env.CUSTOMER_MAIL_FROM),
      subject: String(mail.subject).replace(/[\r\n]+/g, ' ').slice(0, 200),
      text: mail.text,
      html: mail.html,
    });
    return { ok: true, id: res?.messageId || null };
  } catch (e) {
    console.warn(JSON.stringify({ evt: 'customer_mail_failed', subject: String(mail.subject).slice(0, 80), err: String(e?.message || e).slice(0, 200) }));
    return { ok: false, reason: 'send failed' };
  }
}

/**
 * Send one message once: `key` names it (kind and site), and a marker in KV
 * says it has gone. The marker is written only after a send that worked, so a
 * failure is tried again on a later run; it is kept for 60 days, which is
 * longer than anything here could come round again.
 */
export async function sendOnce(env, key, to, mail) {
  if (!customerMailOn(env) || !mailAddress(to)) return { ok: false, reason: 'not sent' };
  const marker = `mail:${key}`;
  try { if (await env.KILN.get(marker)) return { ok: false, reason: 'already sent' }; } catch { /* a read that fails is not a reason to stay silent */ }
  const sent = await sendMail(env, to, mail);
  if (sent.ok) { try { await env.KILN.put(marker, String(Date.now()), { expirationTtl: 60 * 86400 }); } catch { /* the mail went: at worst it goes once more */ } }
  return sent;
}

export const trialEndsAt = (createdAt, trialDays) => Number(createdAt) + trialDays * DAY;
