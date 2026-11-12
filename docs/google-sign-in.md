# Google sign-in for editors and members

Back to the [README](../README.md). Sites on Kiln Cloud, with or without hosting, have this set up already: this page is for a sign-in service you run yourself. The rest of self-hosting is in [self-hosting.md](self-hosting.md).

## What it gives you

Open **People & access** in the Kiln menu and add someone by their Google email as an
**Editor** or **Member**, with an access duration you choose (**1–360 days**, or never
expires). Editors can be scoped to specific pages and even specific sections — the picker
shows each section with the first words of its content so you know what you're granting —
and you choose which menu tools they get (drafts, history, new posts, scheduling, the site
menu, find & replace, comments, AI assist, blocks, theme) — plus two publishing modes:
**suggest-only** (their edits become suggestions you approve) and **review-only** (a
comment-only seat that cannot write at all). Leave it all blank for the whole site. They sign in at `yoursite.com/kiln` with their Google account, with no GitHub account
ever and no links to leak. Removing someone revokes their access immediately, including any
active session. Editor commits are authored with their name and committed by your GitHub App's
bot, and the worker enforces a strict allowlist: that one repo, only the paths granted to them,
never CNAME/_redirects/.github, and no deletes.

There's a one-page guide you can send to people you invite:
[docs/for-editors.md](for-editors.md) for editors,
[docs/for-members.md](for-members.md) for members.

## Setup

Google sign-in needs a Google OAuth client on your worker (one-time, ~5 minutes):

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create
   an **OAuth 2.0 Client ID** of type **Web application** (create a project first if you
   don't have one, and configure the consent screen when prompted).
2. Add an **authorized redirect URI**: `https://YOUR-WORKER-URL/google/callback`
   (e.g. `https://kiln-auth.you.workers.dev/google/callback`).
3. Set the two secrets on the worker:
   ```bash
   cd worker
   npx wrangler secret put GOOGLE_CLIENT_ID --config wrangler.self.toml
   npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.self.toml
   ```
   (If the setup wizard made your worker folder, it has its own `wrangler.toml`: leave `--config …` off.)

That's it. Open **People & access** in the Kiln menu and start adding editors and
members by email.
