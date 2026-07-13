# Self-hosting Kiln

The complete deploy guide for running your own Kiln backend, whether that's one site
or an agency's worth of client sites. Self-hosting is free and unrestricted; the paid
tiers exist for people who'd rather not do this page.

If you're deciding between routes, or looking for day-to-day admin (people, drafts,
history), that's [for-site-owners.md](for-site-owners.md). This page is the plumbing.

## The two pieces

1. **The `kiln-auth` worker** — a Cloudflare Worker you deploy once, on the free
   tier. It handles GitHub and Google sign-in, holds all tokens server-side in
   Workers KV, and proxies editor commits behind a path allowlist. This is the only
   thing you operate.
2. **Your site** — a static site in a GitHub repo, served by any host that redeploys
   on push (Cloudflare Pages recommended; free tier allows commercial use). The Kiln
   script tags and editor bundles live inside the site itself.

There is no third piece. No database to run, no server to patch.

## The fast path: the wizard

```bash
cd your-site-repo
npx github:kilncms/kiln
```

The wizard walks the whole setup: it deploys the worker to your Cloudflare account,
creates the KV namespace, sets `ALLOWED_ORIGINS` to your site, runs the GitHub App
registration, copies `kiln.js` + `kiln-editor.js` + `kiln-features.js` and the
`kiln.html` entry page into your site, writes `assets/kiln-config.js`, and offers a
first-pass auto-tag of your HTML. It writes a config the manual steps below would
have produced by hand — so if the wizard worked, you can skip straight to
[Google sign-in](#google-sign-in) and [verifying](#verify-with-kiln-doctor).

## The manual worker deploy

```bash
git clone https://github.com/kilncms/kiln && cd kiln   # or your fork
npm install
cd worker
npx wrangler kv namespace create KILN     # note the id it prints
```

Now edit `worker/wrangler.toml`. **This step is not optional.** The shipped file is
the maintainer's production config, and a different Cloudflare account cannot deploy
it unchanged:

1. **Delete the `[[routes]]` block.** It binds the `auth.kilncms.com` custom domain,
   which you don't own; Cloudflare will refuse the deploy. Your worker lives at
   `kiln-auth.YOUR-SUBDOMAIN.workers.dev` (or a custom domain you own, if you add
   your own route later).
2. **Delete the `[[d1_databases]]` block.** D1 stores Kiln Cloud billing state.
   Self-host never touches it, and you don't have this database.
3. **Set the KV namespace `id`** under `[[kv_namespaces]]` to the id from the create
   command above.
4. **Set `ALLOWED_ORIGINS`** to your site's origin(s), comma-separated, e.g.
   `"https://example.com"`. Sign-in requests from any other origin are refused.

You can also delete the `[env.staging]` section (the maintainer's isolated test
environment) and, if you never schedule posts, the `[triggers]` cron. Both are
harmless to keep.

Then:

```bash
npx wrangler deploy
```

## Register the GitHub App

Open `https://YOUR-WORKER-URL/setup` in a browser and press the button. This uses
GitHub's app-manifest flow: it registers a GitHub App under your account and the
worker captures the credentials directly — you never copy a secret anywhere.

Then install the app on your site's repo. Choose **Only select repositories** and
pick the repo, not "All repositories". The app only ever needs the repos Kiln edits,
and adding more later is one click on the same install page.

One check worth doing now: the app must be **public** (GitHub App settings → "Make
this GitHub App public") if you'll ever invite editors or serve other people's repos.
`kiln doctor` flags this.

## Google sign-in

Needed if you'll invite editors or members (both sign in with Google). Skip it if
you're the only person who'll ever touch the site.

Follow [Google sign-in setup in the README](../README.md#google-sign-in). Short
version: create a Google OAuth 2.0 Client ID (Web application), add the redirect URI
`https://YOUR-WORKER-URL/google/callback`, then:

```bash
cd worker
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

## Members area (optional)

Gates everything under `/members/` — pages and files — at the edge, on Cloudflare
Pages. Copy the entire `templates/functions/` directory (3 files) into your site's
`functions/` and `templates/members-login.html` to the site root, then set the two
Pages secrets:

```bash
openssl rand -hex 32 | npx wrangler pages secret put KILN_MEMBER_SECRET --project-name <project>
printf 'https://YOUR-WORKER-URL' | npx wrangler pages secret put KILN_WORKER --project-name <project>
```

`KILN_MEMBER_SECRET` signs the member cookie; `KILN_WORKER` lets the redeem function
talk to your worker's Google sign-in. That's the whole configuration.

## Verify with kiln doctor

```bash
cd your-site-repo
npx github:kilncms/kiln doctor
```

It reads `assets/kiln-config.js` and checks the chain end to end: worker reachable,
GitHub App registered and installed on the repo, app public, site live, `kiln.js`
loading, the host actually deploying from the repo (a surprisingly common silent
failure), CORS allowing your origin, and the members gate. Run it after setup and
any time something feels off.

## Upgrading

```bash
cd your-site-repo
npx github:kilncms/kiln update
```

This re-copies the latest three bundles into your site (wherever your current
`kiln.js` lives) and offers to commit and push. Your host redeploys and everyone gets
the new editor. Upgrade the worker by pulling the Kiln repo and running
`npx wrangler deploy` from `worker/` again; KV data (sessions, people lists, app
credentials) survives redeploys untouched.

## One worker, many sites

A single worker can serve every site and client you have. This is the agency setup,
and it's mostly just configuration:

- **`ALLOWED_ORIGINS`** lists each site's origin, comma-separated:

  ```toml
  ALLOWED_ORIGINS = "https://client-a.com,https://client-b.com,https://your-own-site.com"
  ```

  Adding a site later means adding its origin here and running `npx wrangler deploy`.

- **Each site's `kiln-config.js`** names its own repo and points `worker:` at the
  same worker URL.

- **The GitHub App install** covers whichever repos you select. For your own repos,
  add each one to the existing install. A client's repo under their GitHub account
  installs the same app on their account (this is why the app must be public).

- **People are kept per repo.** The editor and member allowlists are stored keyed by
  repository, so client A's editors have no path to client B's site. Owner actions
  on a People list are verified against push access to that specific repo.

- **Sessions and grants are scoped per repo too** — an editor session is bound to
  one repo and to the paths granted in it.

The worker's rate limiting on sign-in routes is on by default and shared across all
sites; the free Workers tier comfortably covers editing traffic for many sites,
since visitors never touch the worker at all.
