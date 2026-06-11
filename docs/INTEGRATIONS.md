# Kiln integrations: company-level vs per-site

Two layers. **Company-level** = done ONCE by whoever operates a Kiln auth worker (Erik for the
canonical service; a self-hoster for their own). **Per-site** = done once per website, by the
site's owner (or the setup wizard / their AI).

## Company level (Kiln-the-product — Erik does these once, under Kiln branding)

| Platform | What | Status | Branding notes |
|---|---|---|---|
| **GitHub App** (`kiln-cms`, id 4024142) | Kiln's identity on GitHub. Site owners install it per-repo; it signs editors' commits (`kiln-cms[bot]`) and powers scheduled publishing. | ✅ Live (currently **private** to erikkurtu) | **TODO:** flip to *public* in App settings so other accounts can install it; set logo + description (users see this on the install screen). Long-term: transfer to a `kilncms` GitHub **organization** so it isn't tied to a personal account. |
| **Cloudflare Worker** (`kiln-auth`) + KV | The auth/proxy/cron service every Kiln site talks to. Costs ~$0 (free tier). | ✅ Live at kiln-auth.erikkwilder.workers.dev | **TODO when domain lands:** route it at `auth.kilncms.com` (workers custom domain) so site configs reference a Kiln-branded URL, not erikkwilder.workers.dev. |
| **Google OAuth client** | Kiln's identity with Google; one client serves ALL sites using this worker. Users see the app name on the consent screen. | ⏳ Waiting on credentials | Create under the **Kiln-branded Google account** (per Erik). Consent screen: name "Kiln", logo, homepage kilncms.com. Redirect URI: `https://kiln-auth.erikkwilder.workers.dev/google/callback` (add the auth.kilncms.com one too once the domain exists). Then `wrangler secret put GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. |
| **kilncms.com** | Product site + future home of the hosted service. | ⏳ Domain not yet connected; site live at kilncms.pages.dev | Buy/transfer domain into the Cloudflare account → attach to the `kilncms` Pages project → add `auth.kilncms.com` worker route → update consent screens/app URLs. |
| **npm package** (`create-kiln` or `kiln-cms`) | Makes the wizard `npx create-kiln`. | ⏳ Optional polish | Needs an npm account (Kiln-branded). Until then `npx github:erikkurtu/kiln` works. |
| **GitHub org + template repo** | `kilncms/kiln` + `kilncms/starter-*` template repos for the future marketplace. | Later | Template repos are the marketplace's zero-infrastructure delivery mechanism. |

**What company-level does NOT include:** anything about a specific website. No site content,
no site repos, no per-site secrets ever live at this layer — only identities (apps/clients)
and the shared worker.

## Per-site level (every user of Kiln, once per website)

With the wizard (`npx github:erikkurtu/kiln`) everything below is automated except three
platform-mandated clicks (marked 🖱). Self-hosters additionally repeat the company-level
GitHub App + worker setup for themselves (the wizard does that too).

| # | Step | Who/what does it | Notes |
|---|---|---|---|
| 1 | GitHub account + site repo (content lives here) | wizard (`gh repo create … --push`) | Free account is fine. |
| 2 | Cloudflare account | human, one signup | Free plan. |
| 3 | Pages project: Connect to Git 🖱 | human click, wizard opens page + polls | First-ever connect grants the Cloudflare↔GitHub integration; later projects can be API-created. No build command, output `/`. |
| 4 | Install the Kiln GitHub App on the repo 🖱 | human click, wizard opens page + polls | "Only select repositories" — the security model. (Self-hosters also do the one-click App *creation* 🖱 at their worker's `/setup`.) |
| 5 | Site wiring: `assets/kiln-config.js`, `kiln.js`, `kiln-editor.js`, script tags, `data-cms` annotations | wizard (config+assets) + **KILN_PROMPT.md via their AI** (annotations, templates) | The AI step is where the site's design gets marked editable. |
| 6 | Members area (optional): functions + 3 Pages secrets | wizard | `KILN_MEMBER_SECRET`, `KILN_REPO`, `KILN_WORKER`. |
| 7 | People: add editor/member emails (Google) or mint link invites | site owner, in the editor (People & access) | No GCP/Google work for users — they just sign in. |
| 8 | Daily use: `yoursite.com/kiln` → sign in → edit → Publish | everyone | Editors/members never touch GitHub, Cloudflare, or Google consoles. |

**The key asymmetry to preserve in all docs/marketing:** owners do a 10-minute setup once;
editors and members do NOTHING but click a link or sign in with Google. All platform pain is
either company-level (ours) or wizard-automated.

## Hosted-service future (Kiln Cloud, per BUSINESS.md)

When Kiln Cloud exists, per-site steps 4's app-creation half and the worker disappear for
customers entirely: they use Kiln's company-level App + worker (this exact architecture
already supports it — ALLOWED_ORIGINS and per-repo installs are the tenancy model). Their
list shrinks to: repo, Pages connect, wiring, people. That's the $5–9/mo product.

## The two products (canonical framing — use everywhere)

The editor is 100% identical in both. The only difference is who babysits the engine
(auth worker + GitHub App + Google client — holds sign-ins and sessions, never content).

### Kiln Open Source — free forever
Self-host the engine: your own Cloudflare worker (wizard deploys it), your own GitHub App
(one click at /setup), optionally your own Google client. The price of free is ~10 minutes
of configuration. You trust only yourself. This is the open-source promise; it is never
crippled and never gated.

### Kiln Cloud — hosted, paid ($5–9/mo per site)
We run the engine; the customer deploys nothing and maintains nothing. Their content stays
in THEIR GitHub repo, their hosting on THEIR Cloudflare Pages. Trust statement (always
stated plainly): Cloud holds the App token that writes to their repo — like any hosted CMS
backend — and they can switch to Open Source at any time because the content was always theirs.

**Today's status:** Cloud exists as an invite-only free BETA on Erik's worker (sites are
hand-allowlisted). Beta sites become founding accounts at launch. There is no free shared-
worker product: free = self-host, full stop.

### Kiln Cloud Complete — fully managed (planned premium tier, ~$15–19/mo)
For people who want ZERO accounts: Kiln creates and owns the site repo (under a
`kilncms-sites` GitHub org) and runs the Cloudflare Pages project too. The customer only
signs in with Google and edits; their entire "setup" is picking a template and a domain.
**The exit guarantee (non-negotiable, in the marketing):** at any time we transfer the
repo to their GitHub account (native GitHub transfer, full history preserved) and hand
over or re-point the hosting — "your site, boxed up and handed to you, in minutes."
Requires: kilncms GitHub org, acceptable-use terms, a transfer-request flow.

## AI-builder onboarding (Lovable / Claude / v0 / Bolt → Kiln)

All of them share the same bridge: project → GitHub repo → Kiln engine attach. Three artifacts:
1. **Recipe pages** on kilncms.com (`/from/lovable`, `/from/claude`, `/from/v0`): a platform-tuned
   prompt (KILN_PROMPT + "output plain static HTML, no framework") + connect-GitHub step + Kiln
   attach. Lovable/Bolt have native GitHub sync; v0 needs the static-HTML instruction (and its
   Vercel default conflicts with commercial-free hosting — steer to CF Pages). Claude is the
   flagship: Claude Code can run KILN_PROMPT AND the setup wizard itself, end to end.
2. **Kiln-ready starter templates** in each ecosystem: a public template repo users remix IN
   Lovable/v0 so the AI builds on an already-annotated skeleton — retrofit becomes unnecessary.
3. **Cloud Complete intake** (the premium funnel): customer pastes their AI project's repo URL or
   export; Kiln imports into kilncms-sites, an agent applies the Kiln-ready pass, site goes live —
   "from Lovable to client-editable, zero accounts." Formal marketplace listings (Lovable
   integrations, Vercel marketplace) are partnership work for later; recipes don't need permission.
