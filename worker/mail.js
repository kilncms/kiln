/**
 * The few emails Kiln Cloud writes to a customer.
 *
 *   site added       what to do next, and the day the free trial ends
 *   trial ends soon  two days before that day
 *   trial ended      editing is off, and what turns it back on
 *   editing stopped  a site Kiln hosts, when its paid plan has ended: the day
 *                    the site comes down, and what keeps it up
 *   comes down soon  seven days before that day
 *   name servers     a hosted site that is being put on its owner's own
 *                    domain: the two name servers to enter where the domain
 *                    was bought
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

// What a trial that ends means for a site Kiln hosts (cloud.js: HOSTING_AFTER_TRIAL_DAYS).
const HOSTED_AFTER_TRIAL = 'If Kiln hosts the site, it stays up at its temporary address for three more days and then comes down. Your repository keeps every file, and subscribing puts the site back up.';

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
    ...(plan === 'managed' ? [HOSTED_AFTER_TRIAL] : []),
  ], whyLine(host));
}

/** Sent once, when a free trial has run out and nobody subscribed. */
export function trialEndedMail({ origin, plan, dashboard }) {
  const host = hostOf(origin);
  return message(`The Kiln free trial for ${host} has ended`, [
    'Hello,',
    `The free trial for ${host} has ended, so editing through Kiln is switched off for now.`,
    'Your site, its files and everything already published are untouched. Nothing was charged, and nothing will be.',
    ...(plan === 'managed' ? [HOSTED_AFTER_TRIAL] : []),
    `To turn editing back on, press Subscribe on the site's row in your dashboard. ${planOf(plan)} is ${priceOf(plan)} a month for the site. Editing comes back as soon as the payment is confirmed.`,
    dashboard,
    'If Kiln was not right for the site, there is nothing to cancel and nothing to remove. We would be glad to hear what was missing: reply to this email.',
  ], whyLine(host));
}

// How a plan that has ended is taken up again. A plan that was cancelled and
// has run out is subscribed for anew; one whose payment failed still exists,
// so its card is put right under Manage billing (cloud.js: /cloud/checkout).
const takeUpAgain = (plan, pastDue, before = '') => (pastDue
  ? `open Manage billing in your dashboard${before} and update the card.`
  : `press Subscribe on the site's row in your dashboard${before}. ${planOf(plan)} is ${priceOf(plan)} a month for the site.`);

/**
 * Sent once when a site Kiln hosts, and that was paid for, may not be edited
 * any more. `endsAt`: when the site comes down (ms). `pastDue`: a payment
 * failed, as against a plan that was cancelled and has run out.
 */
export function editingStoppedMail({ origin, plan, repo, endsAt, pastDue = false, dashboard }) {
  const host = hostOf(origin), day = dayWords(endsAt);
  return message(`Editing is off for ${host}, and the site stays online until ${day}`, [
    'Hello,',
    pastDue
      ? `The last payment for ${host} has not gone through, so editing through Kiln is switched off for now.`
      : `The Kiln plan for ${host} has ended, so editing through Kiln is switched off for now.`,
    `Kiln still hosts the site. It stays online at its address until ${day}, and then it comes down.`,
    `To turn editing back on and keep the site up, ${takeUpAgain(plan, pastDue)} Editing comes back as soon as the payment is confirmed.`,
    dashboard,
    `Everything on the site is still in your own GitHub repository${repo ? ` (${repo})` : ''}. If you would rather move the site to another host, you can do that at any time.`,
  ], whyLine(host));
}

/** Sent once, seven days before a site Kiln hosts comes down because its paid plan has ended. */
export function hostingEndingMail({ origin, plan, repo, endsAt, pastDue = false, dashboard }) {
  const host = hostOf(origin), day = dayWords(endsAt);
  return message(`${host} comes down on ${day}`, [
    'Hello,',
    pastDue
      ? `Kiln hosts ${host}, and the last payment for it has not gone through. The site comes down on ${day}.`
      : `Kiln hosts ${host}, and its plan has ended. The site comes down on ${day}.`,
    `To keep it up, ${takeUpAgain(plan, pastDue, ' before then')} Editing comes back too, as soon as the payment is confirmed.`,
    dashboard,
    `If you do nothing, the site goes offline on ${day}. Nothing is lost. Every file stays in your own GitHub repository${repo ? ` (${repo})` : ''}, so you can subscribe later and put the site back up, or move it to another host.`,
  ], whyLine(host));
}

const count = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Sent once when a hosted site's own domain has been made ready on Kiln's
 * side: the two name servers its owner enters where the domain was bought.
 * `seller` is { name } or null when nobody could say who sold the domain;
 * `helpUrl` a page on changing name servers (the seller's own when Kiln knows
 * it); `records` the records Kiln kept, each with its `kind`; `givesUpAt`
 * (ms) the day the set-up is put away if the name servers are not changed.
 */
export function domainNameServersMail({ origin, name, nameServers = [], seller = null, helpUrl = null, records = [], givesUpAt = null, dashboard }) {
  const host = hostOf(origin);
  const at = seller?.name || 'the company you bought the domain from';
  const mail = records.filter(r => r && r.kind === 'mail').length;
  const others = records.length - mail;
  const noMail = 'If the domain has email, do not change the name servers yet: reply to this email, and we will add the records with you first.';
  const kept = !records.length ? `Kiln found no records to copy for ${name}. ${noMail}`
    : !mail ? `Kiln copied ${count(others, 'record')} of ${name} and saw none for email. ${noMail} The list is on the site's row in your dashboard.`
      : `Kiln copied ${count(mail, 'email record')} and ${count(others, 'other record')} of ${name}, so that email and everything else on the domain keep working after the change. Kiln cannot always see every record, so before you change the name servers, compare the list on the site's row in your dashboard with the list at ${at}.`;
  return message(`Two name servers to enter for ${name}`, [
    'Hello,',
    `Kiln has made everything ready for your site to answer at ${name}. One step is left, and only you can take it: sign in at ${at}, and replace the name servers of ${name} with these two.`,
    ...nameServers,
    ...(helpUrl ? [seller?.name ? `The domain was bought at ${seller.name}. This page explains how to change its name servers:` : 'This page explains how to change a domain\'s name servers:', helpUrl] : []),
    `Until that change takes hold, your site and your email keep working exactly where they are now. It takes from a few minutes to a day. Kiln notices by itself, puts your site at ${name}, and writes to you again when it is live.`,
    kept,
    dashboard,
    ...(givesUpAt ? [`If the name servers are not changed by ${dayWords(givesUpAt)}, Kiln puts this set-up away. Nothing of yours is changed by that, and you can start again any time.`] : []),
  ], whyLine(host));
}

const trimmed = (url) => String(url || '').replace(/\/+$/, '');

/**
 * Sent once when a hosted site has gone live at its owner's domain. `address`
 * is the site's address from now on (https://<name>, or the `www` one),
 * `tempUrl` the address Kiln's hosting gave it, and `oneAddress` true when
 * the other of the two names is sent on to `address` and HTTPS is always on.
 */
export function domainLiveMail({ name, address, tempUrl = null, oneAddress = false, dashboard }) {
  const at = trimmed(address), other = hostOf(at) === name ? `www.${name}` : name;
  return message(`Your site is live at ${name}`, [
    'Hello,',
    `The name servers of ${name} now point at Kiln, and your site is live at its new address.`,
    at,
    ...(oneAddress ? [`A visitor who types ${other} is sent on to that address, and everyone gets the secure https version of it.`] : []),
    ...(tempUrl ? ['The temporary address keeps working, so a link you have already shared still opens the site.', trimmed(tempUrl)] : []),
    `Your email and the other records of ${name} are untouched. They answer the way they did before the change.`,
    `To edit the site, open ${at}/kiln and sign in the way you did before. Click any outlined words or picture, change them, and press Publish.`,
    'The site\'s row in your dashboard shows the domain and the records Kiln keeps for it.',
    dashboard,
  ], whyLine(name));
}

/**
 * Sent once when an address at a hosted site's own domain has begun to reach
 * its owner's inbox: the inbox confirmed, and the rule is made. `address` is
 * the forwarded one (hello@<name>) and `inbox` where its mail arrives.
 */
export function forwardOnMail({ address, inbox, dashboard }) {
  return message(`${address} now reaches ${inbox}`, [
    'Hello,',
    `Mail sent to ${address} now arrives in the inbox ${inbox}. The inbox has confirmed, so there is nothing more for you to do.`,
    `The address only receives mail. To answer a message, reply from ${inbox} as you always do. Your reply is sent from that inbox.`,
    'To send the mail to a different inbox, to change the address, or to stop the forwarding, open your dashboard and use the email line on the site\'s row.',
    dashboard,
  ], whyLine(String(address).split('@')[1]));
}

/**
 * Sent once, 7 days after an address was asked for whose inbox has still not
 * confirmed: whose inbox must press the button, where "Send it again" is, and
 * the day Kiln stops waiting (`givesUpAt`). When it is a change that waits
 * beside an address that works, `keeps` is { address, inbox } of the one that
 * works, and the mail says that it keeps working.
 */
export function forwardWaitingMail({ address, inbox, givesUpAt = null, dashboard, keeps = null }) {
  return message(`${address} is waiting for ${inbox} to confirm`, [
    'Hello,',
    `You asked Kiln to forward ${address} to the inbox ${inbox}. That has not started yet, because the inbox has not confirmed.`,
    ...(keeps ? [`Until it does, mail sent to ${keeps.address} keeps arriving in the inbox ${keeps.inbox}, as it does today.`] : []),
    `Cloudflare, the company that carries the mail, sent an email to ${inbox}. Whoever reads that inbox needs to open that email and press the button in it. That is the only step. Kiln then switches the forwarding on by itself and writes to you when it has.`,
    'If the email is not there, look in the spam folder. To have it sent again, open your dashboard and press "Send it again" on the site\'s row.',
    dashboard,
    ...(givesUpAt ? [`If the inbox has not confirmed by ${dayWords(givesUpAt)}, Kiln stops waiting. Nothing of yours is changed by that, and you can ask again from the dashboard any time.`] : []),
  ], whyLine(String(address).split('@')[1]));
}

/**
 * Sent once, 14 days into a set-up whose name servers have not been changed:
 * the two name servers again, the seller's page, and the day the set-up is
 * put away. The fields are the ones domainNameServersMail takes.
 */
export function domainReminderMail({ origin, name, nameServers = [], seller = null, helpUrl = null, givesUpAt = null, dashboard }) {
  const at = seller?.name || 'the company you bought the domain from';
  return message(`${name} is still waiting for its two name servers`, [
    'Hello,',
    `Kiln has everything ready for your site to answer at ${name}, and the name servers of ${name} have not been changed yet. That one step is left, and only you can take it: sign in at ${at}, and replace the name servers of ${name} with these two.`,
    ...nameServers,
    ...(helpUrl ? [seller?.name ? `The domain was bought at ${seller.name}. This page explains how to change its name servers:` : 'This page explains how to change a domain\'s name servers:', helpUrl] : []),
    `Until that change takes hold, your site and your email keep working exactly where they are now. Kiln notices the change by itself and writes to you when your site is live at ${name}.`,
    ...(givesUpAt ? [`If the name servers are not changed by ${dayWords(givesUpAt)}, Kiln puts this set-up away. Nothing of yours is changed by that, and you can start again any time.`] : []),
    `If you no longer want to use ${name}, you can stop the set-up on the site's row in your dashboard.`,
    dashboard,
  ], whyLine(hostOf(origin)));
}

/**
 * Sent once when a set-up that never went live is put away. `reason` says
 * why: 'not_changed' (the name servers were not changed within `waitDays`),
 * 'moved' (they were changed and then changed away again), or anything else
 * for a set-up Kiln's hosting no longer holds.
 */
export function domainPutAwayMail({ origin, name, reason = 'not_changed', waitDays = 25, dashboard }) {
  const site = trimmed(origin);
  const why = reason === 'not_changed' ? `because the name servers of ${name} were not changed within ${waitDays} days`
    : reason === 'moved' ? `because the name servers of ${name} were pointed at Kiln and then pointed somewhere else before your site was live there`
      : 'because Cloudflare, which runs Kiln\'s hosting, no longer holds it';
  return message(`The set-up for ${name} was put away`, [
    'Hello,',
    `Kiln put the set-up for ${name} away, ${why}.`,
    `Kiln changed nothing of yours. ${name}, its email and its other records are where you keep them, and your site is still up at the address it had.`,
    site,
    `To start again, open your dashboard and set up ${name} on the site's row. It takes a minute, and Kiln writes to you again with the two name servers to enter.`,
    dashboard,
  ], whyLine(hostOf(origin)));
}

/**
 * Sent once when a domain that was live has had its name servers pointed
 * away from Kiln. `tempUrl` is the address Kiln's hosting gave the site,
 * which is its address on record again.
 */
export function domainMovedMail({ name, tempUrl, dashboard }) {
  const back = trimmed(tempUrl);
  return message(`${name} was moved away from Kiln`, [
    'Hello,',
    `The name servers of ${name} no longer point at Kiln, so your site does not answer at ${name} any more.`,
    ...(back ? ['Your site is back at its temporary address, and it is still up there.', back] : []),
    `Nothing was deleted. Your pages and your repository are as they were.${back ? ` To edit the site, open ${back}/kiln and sign in the way you did before.` : ''}`,
    `If email at ${name} has stopped arriving, the company whose name servers the domain uses now needs its email records. Reply to this email and we will help you with that.`,
    `To bring ${name} back, open your dashboard and set it up again on the site's row. Kiln writes to you again with the two name servers to enter.`,
    dashboard,
  ], whyLine(name));
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
