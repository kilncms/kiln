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
npx github:kilncms/kiln#release
```

The wizard walks the whole setup: it deploys the worker to your Cloudflare account,
creates the KV namespace, sets `ALLOWED_ORIGINS` to your site, runs the GitHub App
registration, copies `kiln.js` + `kiln-editor.js` + `kiln-features.js` and the
`kiln.html` entry page into your site, writes `assets/kiln-config.js`, offers to add
the two script tags to every page that lacks them, and offers a first-pass auto-tag
of your HTML. It writes a config the manual steps below would
have produced by hand — so if the wizard worked, you can skip straight to
[Google sign-in](#google-sign-in) and [verifying](#verify-with-kiln-doctor).

## The manual worker deploy

```bash
git clone https://github.com/kilncms/kiln && cd kiln   # or your fork
npm install
cd worker
npx wrangler kv namespace create KILN     # note the id it prints
```

Now make your own configuration from the example. **This step is not optional**:
`worker/wrangler.toml` is the maintainers' file, and its top level holds
placeholders that cannot be deployed.

```bash
cp wrangler.example.toml wrangler.self.toml      # your own config; git ignores it
```

In `wrangler.self.toml`, three values are marked `CHANGE`:

1. **`name`**, for example `kiln-auth`. Your worker lives at
   `<name>.YOUR-SUBDOMAIN.workers.dev` (or a custom domain you own, if you add
   your own route later).
2. **The KV namespace `id`** under `[[kv_namespaces]]`: the id from the create
   command above.
3. **`ALLOWED_ORIGINS`**: your site's address(es), comma-separated, e.g.
   `"https://example.com"`. Sign-in requests from any other address are refused.

The example has no database block (that is Kiln Cloud's billing state, which
self-hosting never touches) and no route. If you never schedule posts you can
delete its `[triggers]` cron.

Every wrangler command below takes `--config wrangler.self.toml`.

Then:

```bash
npx wrangler deploy --config wrangler.self.toml
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
npx wrangler secret put GOOGLE_CLIENT_ID --config wrangler.self.toml
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.self.toml
```

(If the setup wizard made your worker folder, it has its own `wrangler.toml`: leave `--config …` off.)

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
npx github:kilncms/kiln#release doctor
```

It reads `assets/kiln-config.js` and checks the chain end to end: worker reachable,
GitHub App registered and installed on the repo, app public, site live, `kiln.js`
loading, the host actually deploying from the repo (a surprisingly common silent
failure), CORS allowing your origin, and the members gate. Run it after setup and
any time something feels off.

## Upgrading

Two things run your site's editing, and each has its own command. Do the worker
first: a current worker still serves an older editor.

```bash
cd your-site-repo
npx github:kilncms/kiln#release update --worker   # the worker
npx github:kilncms/kiln#release update            # the editor on your pages
```

`update --worker` is for a worker the setup wizard made, which lives in
`kiln-worker/` with a copy of the worker's code. It lists the files that differ
from the current worker, asks, replaces them, and then asks whether to run
`npx wrangler deploy` there. After a deploy it reads the version back from the
worker's `/healthz`. It never touches `kiln-worker/wrangler.toml`, your secrets,
or anything the worker has stored (sign-ins, people lists, app credentials). If
you changed the worker's code yourself, that change is replaced: `git diff` shows
it afterwards. A worker kept in another folder: `update --worker=<folder>`.

`update` re-copies the latest three bundles into your site (wherever your current
`kiln.js` lives) and offers to commit and push. Your host redeploys and everyone
gets the new editor.

A worker deployed from a clone of the Kiln repo, without the wizard, is upgraded
in that clone: pull, then `npx wrangler deploy --config wrangler.self.toml` from
`worker/` again. KV data survives redeploys untouched.

### A site a generator builds (source mode)

Source mode edits the content files an Astro site is built from. Each part of
it needs the worker to say it can, in its `/healthz`, and the editor offers only
what the worker it talks to says; an older worker keeps those parts read-only,
each with a sentence:

| `/healthz` says | What the editor offers |
|---|---|
| `modes` includes `source` | plain words, dates, times, numbers, yes/no in front matter |
| `sourceMarkdown: true` | an entry's formatted text, with the toolbar |
| `sourceMedia: true` | replacing pictures, link addresses |
| `sourceEntries: true` | adding, copying and removing entries, drafts, order, schedules, History and Page settings |

So after an upgrade, deploy the worker as well as the editor, and check
`/healthz`. On the site, `src/lib/kiln-astro.mjs` is the helper file the
wizard copied in. When it is an older copy, `update` says so and asks before
replacing it with the newer one (`kilnEntry`, the `alt` and `href` options,
`kiln()` publishing the schema); a file there that is not Kiln's is left alone. Eleventy, Hugo and Jekyll sites have no source mode yet: Kiln edits
only the HTML files committed in their repositories.

## One worker, many sites

A single worker can serve every site and client you have. This is the agency setup,
and it's mostly just configuration:

- **`ALLOWED_ORIGINS`** lists each site's origin, comma-separated:

  ```toml
  ALLOWED_ORIGINS = "https://client-a.com,https://client-b.com,https://your-own-site.com"
  ```

  Adding a site later means adding its origin here and deploying again.

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
sites. Visitors never touch the worker at all, so the free Workers plan covers
the requests of many sites. The limit to know about is storage writes: the free
plan allows 1,000 KV writes a day, and when they are used up nobody can sign in
until midnight UTC. A sign-in is a few writes, a comment or a People change is
one, and an open editor writes its "who is here" entry once every five minutes
(about 100 a day for one person editing all day). A handful of editors fits; a
busy team, or several sites on one worker, should be on the Workers Paid plan,
which has no daily write limit.

`https://<your worker>/healthz?deep=1` answers 200 when the worker can reach
its storage and GitHub accepts its App key, and 503 naming the part that failed
(`kv`, `d1`, `app`) otherwise. Point any uptime monitor at it.
