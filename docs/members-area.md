# The members area

Back to the [README](../README.md). The guide to send to a member is
[for-members.md](for-members.md); the owner's view is in
[for-site-owners.md](for-site-owners.md#the-members-area).

A static site can have a private section. Everything under `/members/`, pages **and**
files such as PDFs, is checked at the edge by a Cloudflare Pages Function before it is
served. The function reads a signed cookie (HMAC, HttpOnly, Secure), and gated
responses are sent `private, no-store`, so neither a shared cache nor the browser keeps
a copy after a member signs out. There is no database and no per-seat price: members
are entries in the site's People list.

The members area needs Cloudflare Pages, because the gate is a Pages Function. Members
sign in with Google, so the sign-in service needs [Google sign-in](google-sign-in.md)
(sites on Kiln Cloud, with or without hosting, have it already).

## Setup

On a site that already has a members gate, `npx github:kilncms/kiln#release update`
brings these files up to date. To add one by hand, copy from this repository into your
site:

- the whole `templates/functions/` folder into the site's `functions/` folder
  (`_kiln.js`, `_middleware.js`, `members/_middleware.js` and
  `api/member-redeem-google.js`). The top-level `_middleware.js` sends an encoded
  address such as `/%6Dembers/` to its plain form, so it cannot skip the gate;
- `templates/_routes.json` to the site root, which sends only members addresses, and
  addresses with a `%` in them, to the functions;
- `templates/members-login.html` to the site root, the page where members sign in.

Then set the two Pages secrets:

```bash
openssl rand -hex 32 | npx wrangler pages secret put KILN_MEMBER_SECRET --project-name <project>
printf 'https://kiln-auth.you.workers.dev' | npx wrangler pages secret put KILN_WORKER --project-name <project>
```

Those two secrets are all the members area needs: `KILN_MEMBER_SECRET` signs the member
cookie, and `KILN_WORKER` points the sign-in function at your sign-in service.

## Adding members

Open **People & access** in the Kiln menu and add someone by their Google email as a
**Member**, for 1 to 360 days or with no end date. They sign in at
`/members-login.html`. Removing someone ends their access at once.

Two things to know. Every invited editor can read the members-only pages too. And when
a Kiln Cloud plan ends, members who are already signed in lose access within about five
minutes.
