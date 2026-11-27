/**
 * Daily totals: one line a day for the whole of Kiln (migration 0024), so
 * that the operator can see how it is doing over time: accounts, sites,
 * paying sites, what they bring in a month, and sites on their free days. It
 * names no one.
 *
 * It is switched off until the privacy page says so: nothing here reads or
 * writes anything, and the five-minute schedule does not call it, unless the
 * service's DAILY_TOTALS setting is exactly "on".
 *
 * The five-minute schedule (index.js) calls runDailyTotals on every run. The
 * first run of a day in Eastern time writes that day's line; every later run
 * that day finds it and writes nothing, so a run made twice changes nothing.
 * Money a month is counted as the operator's overview counts it (billing.js
 * monthlyPrice): the prices Stripe holds where they can be read, otherwise
 * the fixed figures. Lines are kept for as long as Kiln runs.
 *
 *   runDailyTotals  the day's line, once
 *   totalsPage      newest first, for the operator (GET /admin/cloud/totals in cloud.js)
 */

import { stripeStoreMode, monthlyPrice } from './billing.js';

export const TOTALS_PAGE_MAX = 400;

export const totalsOn = (env) => String(env?.DAILY_TOTALS || '').trim() === 'on' && !!env?.kiln_cloud;

const EASTERN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The date in Eastern time, YYYY-MM-DD. */
export function easternDay(ms) {
  const p = Object.fromEntries(EASTERN.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * The day's line, written by the first run of the day and by no other.
 * `store` is what stripeStoreMode answers (asked here when it is not given,
 * and only when the line is due). It throws when the database cannot be
 * asked; the schedule's cronJob says so in one log line and goes on.
 */
export async function runDailyTotals(env, { now = Date.now(), store } = {}) {
  if (!totalsOn(env)) return { ran: false };
  const db = env.kiln_cloud;
  const day = easternDay(now);
  if (await db.prepare('SELECT 1 AS y FROM daily_totals WHERE day = ?').bind(day).first()) return { ran: true, day, written: false };
  const n = await db.prepare(`SELECT (SELECT COUNT(*) FROM accounts) AS accounts, COUNT(*) AS sites,
    COALESCE(SUM(status = 'active'), 0) AS paying, COALESCE(SUM(status = 'trialing'), 0) AS trialing FROM sites`).first();
  const active = (await db.prepare("SELECT plan, billing_period, COUNT(*) AS n FROM sites WHERE status = 'active' GROUP BY plan, billing_period").all())?.results || [];
  let prices = store;
  if (prices === undefined) { try { prices = await stripeStoreMode(env); } catch { prices = null; } }
  const cents = Math.round(active.reduce((m, r) => m + monthlyPrice(prices, r.plan, r.billing_period) * Number(r.n), 0) * 100);
  const done = await db.prepare('INSERT OR IGNORE INTO daily_totals (day, at, accounts, sites, paying, mrr_cents, trialing) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(day, now, Number(n?.accounts) || 0, Number(n?.sites) || 0, Number(n?.paying) || 0, cents, Number(n?.trialing) || 0).run();
  return { ran: true, day, written: (done?.meta?.changes ?? 1) > 0 };
}

/** Newest first, at most TOTALS_PAGE_MAX lines. It throws when the table cannot be read (cloud.js says so). */
export async function totalsPage(env, { limit = TOTALS_PAGE_MAX } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || TOTALS_PAGE_MAX, 1), TOTALS_PAGE_MAX);
  return (await env.kiln_cloud.prepare('SELECT day, at, accounts, sites, paying, mrr_cents, trialing FROM daily_totals ORDER BY day DESC LIMIT ?').bind(n).all())?.results || [];
}
