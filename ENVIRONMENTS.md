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
| Worker | `wrangler dev` on `localhost:8787` (KV and D1 are files under `worker/.wrangler/state`) | `kiln-auth-staging.erikkwilder.workers.dev` | `auth.kilncms.com` |
| KV / D1 | local, disposable | **own** KV `KILN_STAGING` + D1 `kiln-cloud-staging` | prod KV `KILN` + D1 `kiln-cloud` |
| Sites | `python3 -m http.server` locally | CF Pages **preview** branch (e.g. `staging.kilncms.com`) | `kilncms.com`, `app.kilncms.com` (git-connected); `demo.kilncms.com` (uploaded by hand) |
| GitHub App | prod app, or a test app | its own staging app (one-click `/setup`) | prod `kiln-cms` app |
| Lemon Squeezy | off | off, until test-mode keys are put on staging | **live** |
| Real customers / money | never | never | yes |
| How you get there | `npm run dev` | `npm run deploy:test` | `npm run deploy:prod` (from `main` only) |

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

# 2. Run the worker locally (no cloud resources touched)
#    Its KV and D1 are files under worker/.wrangler/state and survive restarts.
#    The local database starts with no tables: create them once, or every
#    /cloud/* route and the scheduled job fail.
(cd worker && npx wrangler d1 migrations apply kiln-cloud-local --local)
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
npm run deploy:test        # node scripts/release.mjs --staging
```

It refuses unless the working tree is clean and `dist/` is what the sources
build, so that what runs on staging is a commit. Then it applies any waiting
database migration to the staging database and deploys with the commit recorded:
`curl -s https://kiln-auth-staging.erikkwilder.workers.dev/healthz` shows it as
`build`. Any branch can go to staging.

Wired in `worker/wrangler.toml` under `[env.staging]`:
- `name = "kiln-auth-staging"` → free `*.workers.dev` hostname (never the branded domain)
- **`routes = []`**: staging has no route. The top level has none either, so
  there is nothing to inherit.
- its own `KILN_STAGING` KV (`5900a59c…`) and `kiln-cloud-staging` D1 (`153c3353…`)

### What staging can and cannot exercise

| | On staging |
|---|---|
| The worker's code, config, KV, D1 and cron | yes: the same code path as production, on its own data |
| Database migrations | yes: `deploy:test` applies them to the staging database first |
| Rate limits | yes: the same limiter binding as production |
| Editing through the worker as invited editors (publish, uploads, drafts, versions, every refused write) | yes, as one command, once the two one-time steps below are done: `scripts/e2e.mjs` |
| GitHub sign-in as the site owner | yes, once the staging App exists |
| Google sign-in (editors and members) | no: staging has no Google client. A member being signed out after removal has to be checked by hand, with a Google client added to staging, or on production |
| Kiln Cloud billing | no: staging has no Lemon Squeezy keys. Put test-mode keys on staging to try cancel and remove |
| The Kiln Cloud dashboard | no: `app.kilncms.com` talks to the production worker only |
| `staging.kilncms.com`, `staging-app.kilncms.com` | these names are in the staging config but have no DNS record. Use a `*.pages.dev` address and add it to `ALLOWED_ORIGINS` under `[env.staging.vars]` |

### One-time staging setup (the owner, about 15 minutes)

1. **Register the staging GitHub App.** The staging worker starts with an empty
   KV, so it needs its own App. Open
   `https://kiln-auth-staging.erikkwilder.workers.dev/setup` and click the one
   button: it registers a separate "Kiln CMS (staging)" App and stores its
   credentials in the staging KV.
2. **Make a throwaway test repository.** `npx github:kilncms/kiln#release new kiln-e2e`,
   push it to a private repository, install the staging App on it, and add an
   empty file named `.kiln-e2e` at its root. That file is what allows the
   end-to-end script to write to the repository and to reset it afterwards: a
   repository without it is never written to.
3. Optional: connect that repository to a Pages project so an edit can be
   watched going live, and set `KILN_E2E_SITE` to its address.

### The end-to-end run

```bash
node scripts/e2e.mjs --smoke          # 12 checks that write nothing; needs no setup
KILN_E2E_REPO=<owner>/kiln-e2e GH_TOKEN=$(gh auth token) node scripts/e2e.mjs                # a plain-HTML site
KILN_E2E_REPO=<owner>/kiln-e2e-astro GH_TOKEN=$(gh auth token) node scripts/e2e-source.mjs   # a site Astro builds (source mode)
```

`e2e-source.mjs` is the same idea for source mode: it publishes two fields of
one content file through `/source/commit`, checks on GitHub that this was one
commit by the editor touching only that file and that exactly the two edited
lines changed, tries what must be refused (text in the page template, a file
outside the editor's folders, the site's configuration, a delete, script
markup, a value of the wrong type, a suggest-only editor), undoes the change
with `/source/revert`, and puts the repository back. Its test repository must
be a source-mode site: content files with `title` and `venue`, and a
`kiln-config.js` that says `mode: 'source', adapter: 'astro'`.

Both scripts make their editor sessions by writing to the staging KV with
wrangler. If wrangler's browser sign-in is refused that write ("Authentication
error [code: 10000]"; it can read the namespace and still not be allowed to
write it), give wrangler a credential that may: `CLOUDFLARE_API_TOKEN` (a token
with "Workers KV Storage: Edit") and `CLOUDFLARE_ACCOUNT_ID`, or
`CLOUDFLARE_API_KEY`, `CLOUDFLARE_EMAIL` and `CLOUDFLARE_ACCOUNT_ID`, in the
environment of the command. Staging allows 20 requests a minute from one
address; the scripts wait and retry when told to slow down.

The full run makes three editor sessions that last 15 minutes (default tools;
New page and Theme granted; suggest-only), by writing them into the staging KV
with wrangler, then drives the worker with them exactly as the editor does:
a text edit and its exact restore, two pictures in one commit, a draft, a named
version, a new page, a stylesheet. It then tries, for real, each write that
must be refused (an SVG, a script in a page, a workflow file, a delete, a
rollback, a forced update, a branch at an unknown commit, a stylesheet and a
new page without their tools, a suggest-only editor publishing directly) and
fails if any gets through. At the end, whatever happened, it ends the sessions,
deletes the branches and tags it made and moves the branch back to where it
started. If someone else committed to the branch meanwhile it resets nothing
and says so. Exit code 0 only if every check passed.

It refuses to run against any worker but staging or a local one (other workers
get `--smoke` at most), and it has no default repository.

---

## prod — live

The real product. There is one way in:

```bash
npm run deploy:prod              # node scripts/release.mjs
npm run deploy:prod -- --dry-run # run every check, change nothing
```

Production lives under `[env.production]` in `worker/wrangler.toml`. The top
level of that file names no production route, KV or D1, so `npx wrangler
deploy` with no `--env` cannot reach it, and no npm script deploys except
through the release script. The script refuses, with one sentence saying what
to do, unless all of these hold:

1. the branch is `main`
2. the working tree is clean
3. `HEAD` is exactly what `origin/main` points at
4. CI passed for that commit
5. `dist/` is what the sources build (rebuilt with the stamp in `dist/VERSION`
   and compared byte for byte)
6. staging `/healthz` reports this same commit as its `build`

Then it applies waiting database migrations to production, tags the commit
`prod-YYYY-MM-DD`, deploys with the commit, the tag and a message attached,
checks that `https://auth.kilncms.com/healthz` now reports the commit, pushes
the tag, and moves the `release` branch forward to the commit. If the deploy
step fails nothing is left behind; if the check after it fails, the message
names the command that goes back.

**The `release` branch** always points at what production runs. `kiln doctor`
and the editor's own "a newer editor exists" notice compare a site's editor
with `release/dist/VERSION`, and the install and update commands in the guides
fetch the tool from that branch (`npx github:kilncms/kiln#release …`). So work
on `main` that has not been released is not offered to anyone as an update,
and `kiln update` does not hand it out. A repository with no `release` branch
(a fork that has never run the release script) falls back to `main`, quietly.

Editors built before this notice moved still read `main`. On a site that has
not updated yet, a `dist/` rebuilt on `main` ahead of a release shows up as "a
newer editor is available". Keep the `dist/` commit and the release together.

It does not touch any site. Bundles go out separately (`npm run propagate`).

**After any worker deploy, confirm prod still owns its domain:**
```bash
curl -s https://auth.kilncms.com/setup/status     # must be {"configured":true,...}
curl -s https://auth.kilncms.com/healthz          # "build" is the commit just released
```

**Going back.** `cd worker && npx wrangler deployments list --env production`,
then `npx wrangler rollback <version id> --env production` with the id of the
version you want. Name the version: a rollback with no id goes back one step,
and until the first release made by the script that step is a build from
before the admin check followed the GitHub rename, which would hand the
operator pages to whoever registers the old username.

---

## A safe change, start to finish

1. **dev:** build, `npm run dev`, click through locally (or use the sandbox demo).
2. **main:** merge the change, push, wait for CI to pass on that commit.
3. **test:** `npm run deploy:test`, open the staging worker + a staging site, do the real
   user flow (sign in, edit, upload, publish) on isolated infrastructure.
4. **prod:** `npm run deploy:prod`. It checks the six conditions above, then deploys
   and tags.
5. **sites:** the worker release changes no site. Sites that carry their own copy of
   the editor get it in two steps, the demo first:

```bash
npm run propagate                  # the canary only: kiln-demo → kiln-demo.pages.dev
#   wait for it to deploy, open it, edit and publish something
npm run propagate -- --customers   # customer sites; refuses unless the canary's
                                   # live kiln.js carries the new build
npm run propagate -- --dry-run     # what would happen; nothing is fetched or pushed
```

`scripts/propagate-bundles.mjs` only sends a released build (`dist/` as
committed, on a commit tagged `prod-…`). For each site it fetches and
fast-forwards the checkout first, refuses if the checkout is on another branch,
has uncommitted changes or holds commits of its own, and **stops at the first
failure**: later sites are not touched. Every commit it pushes is printed with
the command that takes it back. In the list at the top of the script a consumer
can be `{ hold: true }` (skip it) or `{ pin: '<stamp>' }` (leave it on that
build); a new site is one more line under `canary` or `customers`.

**Which demo is which.** `~/repos/kiln-demo` deploys `kiln-demo.pages.dev` from
git and is the canary. `demo.kilncms.com` is a different Pages project,
`kiln-demo-mr`, which is uploaded by hand and not connected to git: a push to
its repo deploys nothing, so it is not in the list and stays on its old editor
until someone uploads a new copy. Connecting that project to git and adding it
as the first canary is an owner step.

---

## Which version is running where

| What | Where to read it |
|---|---|
| The editor a site serves | `KILN_VERSION` in that site's `kiln.js` (the build stamp, also in `dist/VERSION`) |
| The worker | `curl -s https://auth.kilncms.com/healthz` → `version` (the release number) and `build` (the commit it was deployed from) |
| All three side by side | `npx github:kilncms/kiln#release doctor` in the site: `versions: site bundle … · worker … · latest release …` |
| What production ran on a given day | the git tag `prod-YYYY-MM-DD` that the release script makes for every production deploy |

A worker deployed by hand reports no `build`. `v0.4.0` and `prod-2026-08-19`
mark commit `615a436`, the build production has run since 19 August 2026.

## A hotfix, when `main` holds work that is not ready

1. `git fetch --tags && git switch -c hotfix/<what> <the last prod-… tag>`
2. `git cherry-pick <the fix>` (or write it there), `npm test`.
3. Staging: deploy that branch to staging and check the fix there.
4. Production: release the same commit; it is tagged `prod-YYYY-MM-DD`.
5. Merge back: `git switch main && git merge hotfix/<what>`, so the next
   release from `main` contains the fix and does not undo it.

Step 3 is `npm run deploy:test` on the hotfix branch. Step 4 is
`git push origin hotfix/<what>`, wait for CI, then `npm run deploy:prod --
--hotfix`: the same six checks, with `hotfix/<what>` in place of `main`, and
the same tag.

---

## Seeing when it breaks

- **`/healthz`** is a constant 200: it says the worker is running and which
  build it is. It does not say publishing works.
- **`/healthz?deep=1`** asks the three things publishing depends on and answers
  503 naming the part that failed: `kv` (the namespace answers), `d1` (the
  Kiln Cloud database answers), `app` (the GitHub App's key signs and GitHub
  accepts it). It returns those words only, never an error text or a
  credential, and is rate-limited.

  ```bash
  curl -s 'https://auth.kilncms.com/healthz?deep=1'
  # {"ok":true,…,"checks":{"kv":"ok","d1":"ok","app":"ok"},"failed":[]}
  ```
- **The monitor** (`.github/workflows/monitor.yml`) requests the deep check and
  the two demo sites every 30 minutes and fails if any is down or a demo's home
  page does not load `kiln.js`. A failed scheduled workflow emails the
  repository's owner. It uses no secret. It is a floor, not a pager: GitHub
  starts scheduled runs late when busy and switches a schedule off after 60
  days without a commit. A free external monitor pointed at the same address,
  alerting by push or SMS, is worth the ten minutes.
- **Logs.** `[observability]` is on in every environment, so what the worker
  prints is kept and searchable in the Cloudflare dashboard (Workers → kiln-auth
  → Logs). Each scheduled job prints one line, `{"evt":"cron","job":"schedules"
  |"trials","ok":true|false,"ms":…}`, and one failing no longer stops the other.
  A billing webhook that is refused prints `{"evt":"webhook_rejected",…}`.
- **Storage writes.** An open editor used to write to KV every 30 seconds,
  which alone could use up a free account's 1,000 writes a day and stop
  sign-in until midnight UTC. It now writes on arrival, on moving to another
  page, and every five minutes. Someone who closes the editor is therefore
  listed as present for up to six and a half minutes.

---

## Backups and restore

Everything Kiln Cloud knows is in one D1 database and one KV namespace. If the
KV namespace were emptied, sign-in and publishing would stop for every site,
every site's people list would be gone, and so would every comment, suggestion
and scheduled post. `scripts/backup-cloud.mjs` copies both stores off
Cloudflare every night.

```bash
node scripts/backup-cloud.mjs                 # production → ~/Backups/kiln/
node scripts/backup-cloud.mjs --env staging
node scripts/backup-cloud.mjs --local         # the local database `npm run dev` uses
```

- **What it writes.** One archive per run, `kiln-<source>-YYYYMMDD-HHMMSS.tar.gz`,
  mode 0600 in a 0700 directory, holding `d1.sql` (schema, rows and the
  migration ledger), `kv.json` and `manifest.json` (counts). The 14 newest per
  source are kept (`--keep`, `KILN_BACKUP_KEEP`). `--out` or `KILN_BACKUP_DIR`
  moves the directory; a directory inside this repository is refused.
- **What is in `kv.json`.** Keys starting `app:creds`, `people:`, `atok:`,
  `cmt:`, `sug:`, `sched:`, `firstseen:`, and `rid:` and `rname:` (which
  repository, by its GitHub id, each stored name is). Sessions, one-time codes
  and caches are left out: they hold sign-in tokens, and losing them means
  signing in again.
- **It only reads.** The wrangler commands it runs are `d1 export`,
  `kv key list` and `kv bulk get`. A D1 export blocks other queries to the
  database while it runs; with a database this small that is well under a
  second, and the schedule puts it at 03:10.
- **The archive holds the GitHub App's private key.** Treat it like one. To
  encrypt it as well, put an [age](https://age-encryption.org) public key in
  `KILN_BACKUP_RECIPIENT` or in `~/.keys/kiln-backup.pub`; the result is then
  `….tar.gz.age`. With a recipient set, the backup fails if `age` cannot run:
  it never falls back to an unencrypted file.
- **A failed run** leaves no archive, removes none of the earlier ones, exits 1
  and writes one line, `<time> backup FAILED: <why>`.
- **Nightly.** `scripts/com.kilncms.backup.plist` is a launchd template; the
  install commands are in its first lines. Check `~/Backups/kiln/backup.log`.

### Restoring

Always into staging first. Unpack the archive somewhere private:

```bash
mkdir -m 700 /tmp/kiln-restore && tar -xzf ~/Backups/kiln/kiln-production-….tar.gz -C /tmp/kiln-restore
cat /tmp/kiln-restore/manifest.json
```

**KV** (people lists, App credentials, comments…). Keys in the file replace
keys of the same name; keys not in the file are left alone.

```bash
node scripts/restore-kv.mjs /tmp/kiln-restore/kv.json --env staging --dry-run
node scripts/restore-kv.mjs /tmp/kiln-restore/kv.json --env staging
node scripts/restore-kv.mjs /tmp/kiln-restore/kv.json --env production --i-mean-production
node scripts/restore-kv.mjs /tmp/kiln-restore/kv.json --env production --i-mean-production --prefix people:
```

Production is refused without `--i-mean-production`. `--prefix` restores only
part, for example one lost people list (`--prefix people:owner/repo`).

**D1, something went wrong in the last 30 days:** use D1's own history first.
It is faster and loses nothing after the moment you pick.

```bash
cd worker
npx wrangler d1 time-travel info kiln-cloud --env production --timestamp 2026-10-06T02:00:00Z
npx wrangler d1 time-travel restore kiln-cloud --env production --bookmark <id from info>
```

**D1, the database is gone or older than that:** load the export into an empty
database. The export creates the tables, so the target must not have them.

```bash
npx wrangler d1 create kiln-cloud-restored          # note the id it prints
#   point [env.production] database_id at it in wrangler.toml, then:
npx wrangler d1 execute kiln-cloud --env production --remote --file /tmp/kiln-restore/d1.sql
npx wrangler d1 migrations list kiln-cloud --env production --remote    # "No migrations to apply"
```

Then release the worker again so it binds the new database, and
`rm -rf /tmp/kiln-restore`.

This was drilled against a local database with the real wrangler: back up,
load `d1.sql` and `kv.json` into an empty copy, read the rows and keys back.
Restoring both took two seconds there. It has not been drilled on staging.

---

## Database changes

The Kiln Cloud database (D1) changes only through numbered files in
`worker/migrations/`. Wrangler keeps a ledger of which files a database has had
(a `d1_migrations` table in that database), so a change is applied once, in
order, and the same way to staging and to production.

```bash
cd worker
npx wrangler d1 migrations list  kiln-cloud-staging --env staging --remote   # what is waiting
npx wrangler d1 migrations apply kiln-cloud-staging --env staging --remote   # staging first
npx wrangler d1 migrations apply kiln-cloud         --env production --remote
npx wrangler d1 migrations apply kiln-cloud --local                          # your machine
```

- **A new change** is a new file, `NNNN_what_it_does.sql`, one number up. Never
  edit a file that has been applied anywhere.
- **Write changes the running worker survives.** The migration is applied
  before the worker that needs it is deployed, so for a few minutes the old
  worker runs against the new schema: add columns as nullable, do not rename or
  drop in the same release as the code change.
- **The two databases that already exist** (staging and production were created
  from the schema by hand before there was a ledger) need no special step.
  `0001_init.sql` is that same schema, written with `CREATE … IF NOT EXISTS`:
  the first `migrations apply` runs it, changes nothing, and records it. This
  was checked on a local database that already had the tables and a row in
  them: the row was still there afterwards and `migrations list` reported
  nothing left to apply.
- **Going back**: D1 keeps 30 days of history. `npx wrangler d1 time-travel
  info kiln-cloud --env production` gives a bookmark for "now" before a
  migration; `time-travel restore --bookmark <id>` returns to it. See
  "Backups and restore" above.

---

## Every name the worker reads

Bindings and variables live in `worker/wrangler.toml` (per environment);
secrets are set with `npx wrangler secret put <NAME> --env <staging|production>`
and are never in a file. A self-hosted worker needs only the rows marked
"self-host" (`worker/wrangler.example.toml` has them).

| Name | Kind | What it is for | Where the value comes from | Needed in |
|---|---|---|---|---|
| `KILN` | KV binding | the App's credentials, sign-ins, people lists, comments, scheduled posts | `npx wrangler kv namespace create KILN` | everywhere (self-host too) |
| `kiln_cloud` | D1 binding | Kiln Cloud accounts and sites | `npx wrangler d1 create …`, then `d1 migrations apply` | staging, production |
| `RL` | rate-limit binding | per-address limit on sign-in routes and the deep health check | declared in the config; no value | optional everywhere; the worker does not limit without it |
| `CF_VERSION_METADATA` | version-metadata binding | lets `/healthz` show Cloudflare's record of the upload | declared in the config | staging, production |
| `ALLOWED_ORIGINS` | variable | the site addresses allowed to sign in (comma-separated). Kiln Cloud sites are allowed from the database instead | you write it | everywhere (self-host too) |
| `CLOUD_DASHBOARD` | variable | where `/cloud/callback` sends a customer after sign-in | the dashboard's address | staging, production |
| `CLOUD_ADMIN` | variable | GitHub login of the operator, compared only when `CLOUD_ADMIN_ID` is not set | the owner's login | staging, production |
| `CLOUD_ADMIN_ID` | variable | numeric GitHub id of the operator; when set, it alone decides | `gh api user --jq .id` | staging, production |
| `AI_MODEL` | variable | overrides the model AI assist uses | optional | where AI assist is on |
| `KILN_BUILD` | variable | the commit the worker was deployed from, shown by `/healthz` | `scripts/release.mjs` passes it at deploy; never set by hand | staging, production |
| `GOOGLE_CLIENT_ID` | secret | Google sign-in for invited editors and members | Google Cloud console → Credentials → OAuth client (web). Redirect URI: `<worker>/google/callback` | production; optional for self-host and staging |
| `GOOGLE_CLIENT_SECRET` | secret | the same client's secret | same place | with the id |
| `AI_API_KEY` | secret | AI assist (the owner's own Anthropic key) | console.anthropic.com | optional; without it `/ai/assist` answers 501 |
| `LS_API_KEY` | secret | creates checkouts, reads and cancels subscriptions | Lemon Squeezy → Settings → API | production (test-mode key on staging) |
| `LS_STORE_ID` | secret | the store checkouts belong to | Lemon Squeezy → Settings → Stores | with the API key |
| `LS_VARIANT_CLOUD` | secret | the variant id of the Kiln Cloud plan | Lemon Squeezy → the product → variant | with the API key |
| `LS_VARIANT_MANAGED` | secret | the variant id of the managed plan | same | with the API key |
| `LS_WEBHOOK_SECRET` | secret | verifies that a webhook came from Lemon Squeezy | you choose it when creating the webhook | with the API key |

Without the `LS_*` secrets the worker still runs: sites register as trialing
and checkout answers "billing not configured".

**The Lemon Squeezy webhook.** URL: `<worker>/cloud/webhook/ls`, signing secret:
the value of `LS_WEBHOOK_SECRET`. Events: `subscription_created`,
`subscription_updated`, `subscription_cancelled`, `subscription_resumed`,
`subscription_expired`, `subscription_paused`, `subscription_unpaused`. The
worker ignores everything else (order and payment events).

**Addresses to register with the sign-in providers.** GitHub App callback URLs:
`<worker>/auth/callback` (site owners) and `<worker>/cloud/callback` (the
dashboard). Google OAuth redirect URI: `<worker>/google/callback`. For
production `<worker>` is `https://auth.kilncms.com`.

**A new database.** `npx wrangler d1 create <name>`, put its id under the
environment's `[[d1_databases]]`, then
`npx wrangler d1 migrations apply <name> --env <environment> --remote`
(see "Database changes").

---

## Resources (canonical instance)

| Resource | dev | test | prod |
|---|---|---|---|
| Worker name | `kiln-auth-local` (never deployed) | `kiln-auth-staging` | `kiln-auth` |
| KV namespace | a file under `worker/.wrangler/state` | `KILN_STAGING` `5900a59cba9e48568d9886d975571fd9` | `KILN` `376ca9e637724d9fabebbc24ba149814` |
| D1 database | `kiln-cloud-local`, a file under `worker/.wrangler/state` | `kiln-cloud-staging` `153c3353-6e1e-4d18-a2b8-9f7b50f517ba` | `kiln-cloud` `a00713f4-3838-49fd-9e53-58961b1feb2e` |

> **Hard-won note:** a staging deploy once took over the production domain, because
> wrangler named environments inherit top-level `[[routes]]`. The top level of
> `worker/wrangler.toml` now has no route and no production id, and
> `test/release.test.js` fails if one comes back. `vars`, KV, D1 and the rate limiter
> are not inherited at all: a new environment must state its own.
