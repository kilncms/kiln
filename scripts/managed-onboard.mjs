#!/usr/bin/env node
/**
 * Fully-managed onboarding — the ops script for setting up ONE customer.
 * Automates every Cloudflare-side step the API allows; prints an exact
 * checklist for the few that need a human. Run it again safely: every step
 * checks before it creates.
 *
 * Usage:
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node scripts/managed-onboard.mjs \
 *     --domain=customersite.com \
 *     --project=customer-site            # Pages project name
 *     [--forward=hello --to=owner@gmail.com]   # email forwarding rule
 *     [--repo=owner/site]                # for the printed checklist
 *
 * What it automates:
 *   1. Custom domain (+ www) attached to the Pages project
 *   2. Cloudflare Email Routing: enabled on the zone, destination address
 *      created (customer gets ONE verification email to click), and a
 *      forwarding rule hello@domain → their inbox
 * What it prints for a human:
 *   repo prep (npx kiln + kiln tag), Pages git-connect, worker allowlist,
 *   LS subscription check, handoff email template.
 *
 * Token needs: Zone.Read, Zone.Email Routing.Edit, Pages.Edit (account).
 */

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;

const args = Object.fromEntries(process.argv.slice(2)
  .map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));

const die = (m) => { console.error('  ✗ ' + m); process.exit(1); };
const ok = (m) => console.log('  ✓ ' + m);
const info = (m) => console.log('  · ' + m);

if (!TOKEN || !ACCOUNT) die('set CF_API_TOKEN and CF_ACCOUNT_ID');
if (!args.domain || !args.project) die('required: --domain=… --project=…');

async function cf(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    const msg = (data.errors || []).map(e => e.message).join('; ') || res.status;
    const err = new Error(msg); err.status = res.status; err.errors = data.errors; throw err;
  }
  return data.result;
}

const domain = String(args.domain).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

console.log(`\n━━ Managed onboarding: ${domain} ━━━━━━━━━━━━━━━━━━━━━━━━`);

// ── 1. Zone ──────────────────────────────────────────────────────────────────
const zones = await cf('GET', `/zones?name=${domain}`);
if (!zones.length) die(`zone ${domain} isn't on this Cloudflare account — add the site in the CF dashboard (customer updates nameservers) and rerun`);
const zone = zones[0];
if (zone.status !== 'active') info(`zone status is "${zone.status}" — nameserver change may still be propagating (everything below still gets set up)`);
ok(`zone ${domain} (${zone.id})`);

// ── 2. Pages custom domain ───────────────────────────────────────────────────
try {
  const existing = await cf('GET', `/accounts/${ACCOUNT}/pages/projects/${args.project}/domains`);
  for (const d of [domain, `www.${domain}`]) {
    if (existing.some(x => x.name === d)) { ok(`Pages domain ${d} already attached`); continue; }
    await cf('POST', `/accounts/${ACCOUNT}/pages/projects/${args.project}/domains`, { name: d });
    ok(`Pages domain ${d} attached to ${args.project}`);
  }
} catch (e) {
  if (e.status === 404) die(`Pages project "${args.project}" not found — create it first (checklist below)`);
  throw e;
}

// ── 3. Email Routing ─────────────────────────────────────────────────────────
if (args.to) {
  const local = typeof args.forward === 'string' ? args.forward : 'hello';
  const addr = `${local}@${domain}`;

  // 3a. enable routing on the zone (adds the MX/TXT records)
  const routing = await cf('GET', `/zones/${zone.id}/email/routing`);
  if (routing.enabled) ok('email routing already enabled');
  else { await cf('POST', `/zones/${zone.id}/email/routing/enable`); ok('email routing enabled (MX/TXT records added)'); }

  // 3b. destination address (customer clicks ONE verification email)
  const dests = await cf('GET', `/accounts/${ACCOUNT}/email/routing/addresses?per_page=50`);
  let dest = dests.find(d => d.email.toLowerCase() === String(args.to).toLowerCase());
  if (dest) ok(`destination ${args.to} already registered${dest.verified ? ' (verified)' : ' — NOT yet verified'}`);
  else {
    dest = await cf('POST', `/accounts/${ACCOUNT}/email/routing/addresses`, { email: args.to });
    ok(`destination ${args.to} created — verification email sent, customer must click it`);
  }

  // 3c. the forwarding rule
  const rules = await cf('GET', `/zones/${zone.id}/email/routing/rules?per_page=50`);
  if (rules.some(r => r.matchers?.some(m => m.value === addr))) ok(`rule ${addr} → ${args.to} already exists`);
  else {
    await cf('POST', `/zones/${zone.id}/email/routing/rules`, {
      name: `kiln: ${addr}`,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: addr }],
      actions: [{ type: 'forward', value: [String(args.to)] }],
    });
    ok(`forwarding rule ${addr} → ${args.to}`);
  }
} else {
  info('no --to given — skipping email forwarding (rerun with --forward=hello --to=their@inbox.com any time)');
}

// ── 4. The human checklist ───────────────────────────────────────────────────
console.log(`
━━ Remaining manual steps ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. Repo prep (in a clone of ${args.repo || 'their repo'}):
       npx github:kilncms/kiln          # scripts + config (point worker at ours)
       npx github:kilncms/kiln tag      # first-pass tagging — review git diff
       commit + push
  2. Pages project "${args.project}": connect to the GitHub repo in the CF
     dashboard (Workers & Pages → project → Settings → Builds) if not already.
  3. Add ${domain} to the worker's dynamic allowlist / their site record in
     the Kiln Cloud admin (plan: managed).
  4. Confirm their subscription is active in the admin dashboard.
  5. If forwarding was set up: tell the customer to click the Cloudflare
     verification email so ${args.to || 'their inbox'} starts receiving.
  6. Send the handoff: "Your site is live at https://${domain} — sign in to
     edit at https://${domain}/kiln. Add editors under People & access."
`);
