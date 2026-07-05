# Kiln environments — dev, test, prod

Kiln has one stateful backend (the `kiln-auth` Cloudflare Worker) and several static
sites (marketing, demo, cloud dashboard) that deploy from Git. This doc defines three
environments so you can change things safely and only touch real customers/money when
you mean to.

TL;DR of what to say:
- **"run it in dev"** → everything local on your Mac, nothing deployed. `npm run dev`.
- **"put it to test"** → deploy to the isolated staging worker + a preview site. `npm run deploy:test`.
- **"put it to prod"** → the live product real customers use. `npm run deploy:prod`.

---

## The three environments

| | **dev (local)** | **test (staging)** | **prod (live)** |
|---|---|---|---|
| Worker | `wrangler dev` on `localhost:8787` (in-memory KV/D1) | `kiln-auth-staging.erikkwilder.workers.dev` | `auth.kilncms.com` |
| KV / D1 | local, disposable | **own** KV `KILN_STAGING` + D1 `kiln-cloud-staging` | prod KV `KILN` + D1 `kiln-cloud` |
| Sites | `python3 -m http.server` locally | CF Pages **preview** branch (e.g. `staging.kilncms.com`) | `kilncms.com`, `app.kilncms.com`, `demo.kilncms.com` |
| GitHub App | prod app, or a test app | its own staging app (one-click `/setup`) | prod `kiln-cms` app |
| Lemon Squeezy | off | test mode | **live** |
| Real customers / money | never | never | yes |
| How you get there | `npm run dev` | `npm run deploy:test` | `npm run deploy:prod` |

The point of **test** is that it's *real deployed infrastructure* (real URLs, real Worker,
real database) but **completely isolated** from production — its own KV namespace and its
own D1 database, so nothing you do there can touch a paying customer or move real money.
It's where you click through a change like a real user before promoting it.

---

## dev — local, nothing deployed

Everything runs on your Mac. Use this for 95% of work: fast, free, zero risk.

```bash
# 1. Build the editor bundles
npm run build

# 2. Run the worker locally (in-memory KV/D1 — no cloud resources touched)
npm run dev            # → http://localhost:8787

# 3. Serve a site locally, pointed at the local worker
cd ~/repos/kiln-demo && python3 -m http.server 8788
#   (in that site's assets/kiln-config.js, set worker: 'http://localhost:8787')
```

The demo's **sandbox mode** needs no worker at all — every visitor edits a private,
local-only copy in their own browser. That's the fastest way to test editor UX.

---

## test — deployed but isolated (staging)

A full copy of the backend on `kiln-auth-staging.erikkwilder.workers.dev`, with its **own**
KV namespace and D1 database (already created). Deploy to it with:

```bash
npm run deploy:test        # builds, then: wrangler deploy --env staging
```

Wired in `worker/wrangler.toml` under `[env.staging]`:
- `name = "kiln-auth-staging"` → free `*.workers.dev` hostname (never the branded domain)
- **`routes = []`** ← critical. Without this, a named env inherits the top-level
  `[[routes]]` (auth.kilncms.com) and a staging deploy would hijack the production
  domain. Leave it empty. (This bit us once — see the note at the bottom.)
- its own `KILN_STAGING` KV (`5900a59c…`) and `kiln-cloud-staging` D1 (`153c3353…`)

**One-time staging setup (you, ~1 min):** the staging worker starts with an empty KV, so
it needs its own GitHub App. Visit
`https://kiln-auth-staging.erikkwilder.workers.dev/setup` and click the one button — it
registers a separate "Kiln CMS (staging)" app and stores its creds in the staging KV.
Install that app on a throwaway test repo. (Google sign-in and Lemon Squeezy are optional
on staging — GitHub admin sign-in and the editing loop work without them.)

**Staging sites:** push the site repo to a `staging` branch. Cloudflare Pages builds a
preview deployment automatically; point a stable alias (e.g. `staging.kilncms.com`) at it,
or just use the `*.pages.dev` preview URL. The staging worker's `ALLOWED_ORIGINS` already
lists staging + localhost origins.

---

## prod — live

The real product. Deploy the worker with:

```bash
npm run deploy:prod        # builds, runs tests, THEN wrangler deploy (prod)
```

Sites deploy on push to `main` (Cloudflare Pages, git-connected):
`kilncms.com`, `app.kilncms.com`, `demo.kilncms.com`, and customer sites like `npu-i`.

**After any worker deploy, always confirm prod still owns its domain:**
```bash
curl -s https://auth.kilncms.com/setup/status     # must be {"configured":true,...}
```

---

## A safe change, start to finish

1. **dev:** build, `npm run dev`, click through locally (or use the sandbox demo).
2. **test:** `npm run deploy:test`, open the staging worker + a staging site, do the real
   user flow (sign in, edit, upload, publish) on isolated infrastructure.
3. **prod:** `npm run deploy:prod`, then `curl …/setup/status` to confirm, then push the
   site repos' `main`.

`deploy:prod` ends by running `scripts/propagate-bundles.mjs`, which copies the fresh
`dist/` bundles into every consumer checkout that carries its own copies (the demo,
managed customer sites), commits, and pushes them — so their Pages projects redeploy in
the same breath. If a consumer can't be updated, the deploy **exits non-zero**: a green
`deploy:prod` now means the worker AND every bundle-copy site are current. Run it alone
any time with `npm run propagate`. New consumer site? Add one line to the `CONSUMERS`
list at the top of `scripts/propagate-bundles.mjs`.

---

## Resources (canonical instance)

| Resource | dev | test | prod |
|---|---|---|---|
| Worker name | `kiln-auth` (local) | `kiln-auth-staging` | `kiln-auth` |
| KV namespace | in-memory | `KILN_STAGING` `5900a59cba9e48568d9886d975571fd9` | `KILN` `376ca9e637724d9fabebbc24ba149814` |
| D1 database | in-memory | `kiln-cloud-staging` `153c3353-6e1e-4d18-a2b8-9f7b50f517ba` | `kiln-cloud` `a00713f4-3838-49fd-9e53-58961b1feb2e` |

> **Hard-won note:** wrangler named environments inherit the top-level `[[routes]]` unless
> overridden. `[env.staging]` therefore sets `routes = []` on purpose. If you ever add a
> new environment, do the same, and always re-check `auth.kilncms.com/setup/status` right
> after deploying it.
