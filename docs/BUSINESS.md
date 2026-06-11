# Kiln — Monetization & Marketplace (locked 2026-06-11)

_Agreed direction, captured verbatim from the working session. Revisit after first ~10 outside users._

## Monetization — the honest take

The principle that protects the moat: **never charge for editing.** CloudCannon charges $45+/mo
for what Kiln does free — that asymmetry **is** the product. Charge for everything around it:

1. **Kiln Cloud (the obvious one):** self-hosting requires deploying a worker, registering a
   GitHub App, and now a Google client. That's the #1 documented pain in this entire category.
   A hosted auth service — one script tag, we run the worker/apps/people-management — at
   **$5–9/mo per site or ~$19/mo for unlimited sites** undercuts everything (Squarespace $16–25,
   CloudCannon $45+) while costing near-zero to operate on Workers. Free tier for
   personal/nonprofit sites seeds adoption — and fits the civic ring.
2. **Setup-as-a-service:** "Send us your site, get it back Kiln-ready" — **$99–299 one-time.**
   KILN_PROMPT.md + an agent does 90% of the work; a human QAs. Agencies charge 10× this for
   WordPress setups.
3. **Team features later** (approval workflows, audit logs, roles beyond editor/member) for
   orgs — only when real orgs ask.

## Marketplace — yes, and there's a cheap way to start

Templates and components map perfectly onto what Kiln already is:

- **Templates** = Kiln-ready GitHub **template repos** (the demo is template #1). "Use this
  template" is a native GitHub button — zero infrastructure. Designers list theirs; we take a
  cut on paid ones (Lemon Squeezy/Stripe links handle payment; the repo invite is the delivery).
- **Components** = copy-paste blocks (pricing tables, galleries, FAQ accordions) pre-annotated
  with `data-cms`/`data-cms-repeat` + their CSS. Delivery v1 is literally a code snippet;
  v2 is an **"Insert block" browser inside the editor** — the splice engine already knows how
  to insert markup, so this is a natural extension, not a rebuild.
- **The bootstrapping trick:** the marketplace site itself should be **built on Kiln** — a
  static site on Cloudflare Pages where each listing is a repeat block. It's the dogfood demo
  and the storefront at once.
- **Sequencing: don't build it yet.** Ship the demo + KILN_PROMPT, get ~10 outside users,
  THEN launch the marketplace with 5 curated free templates so it never looks empty.
  Marketplaces die from emptiness, not from missing features.

## Pricing reference points (verified June 2026)

Squarespace $16–25/mo · Webflow $14–25+/mo · WordPress.com ~$25/mo w/ plugins ·
CloudCannon $45–55+/mo/site · TinaCloud $29–299/mo · the prevailing price of
"a site my client can edit" is **$180–600+/yr per site**. Kiln: $0.

## Google account note

The canonical hosted service's GitHub App and Google OAuth client should live under a
**Kiln-branded account** (kilncms Gmail now; hello@kilncms.com once domain email exists) —
users see the app name on consent screens, and ownership should outlive any one person's
personal account. Self-hosters register their own App + client (their worker = their identity).

## Addendum 2026-06-11: two-product framing + fully-managed tier (Erik decision)

- There is NO free shared-worker offering. Free = Open Source self-host. Hosted = paid
  (Kiln Cloud, $5–9/mo; today an invite-only beta whose sites become founding accounts).
- New planned premium tier — **Kiln Cloud Complete (~$15–19/mo)**: Kiln manages the GitHub
  repo (kilncms-sites org) AND the Cloudflare Pages project; the customer needs zero
  accounts — Google sign-in and edit, that's all. Sold WITH a contractual exit guarantee:
  one-request GitHub repo transfer (native, full history) + hosting handover. The exit
  guarantee is the trust feature that makes full management sellable.
