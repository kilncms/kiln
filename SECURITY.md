# Security Policy

Kiln writes to your Git repository and gates members-only content, so we take
security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately using GitHub Security Advisories: go to the repository's
**Security** tab and click **Report a vulnerability** (Private Vulnerability
Reporting). If you cannot use that flow, contact the maintainer directly at
**info@kilncms.com**.

Please include enough detail to reproduce — affected component, steps, and
impact. We aim to acknowledge reports within a few days and will keep you
updated as we investigate and ship a fix.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | yes       |
| < 0.4   | no        |

Security fixes land on the latest release line.

## Security-sensitive surface

If you are reviewing or reporting, these are the areas that matter most:

- **GitHub App OAuth** — sign-in flow, `state` nonces, and the server-side
  session/refresh-token store in Workers KV.
- **Google sign-in for editors and members** — invited people are added to a
  per-repo email allowlist (the "People" list) and authenticate with Google;
  editor sessions are opaque tokens stored in Workers KV, scoped to the repo
  and to the path/section grants for that person. Editors never hold GitHub
  credentials, and the GitHub App installation token never reaches the browser.
- **Commit proxy** — the `kiln-auth` worker holds a GitHub App installation
  token and proxies editor commits behind a strict method+path allowlist
  (one repo, content paths only, no deletes). Bypasses of that allowlist are
  high severity.
- **One repository per session and token** — an editor session, a member's
  sign-in and an API token carry the id of the repository they were made for,
  and are refused when the name they reach it by answers as a different
  repository (a renamed repository whose old name someone else then takes).
  Any way to use one against another repository is high severity.
- **What an editor session may write** — pages and stylesheets, plus an
  explicit list of inert upload types (raster images, PDF, Office documents,
  fonts, audio, video), each under 15 MB and checked by its leading bytes
  (`src/file-policy.js`). SVG, XML, XSL and XHTML are refused outright: a
  browser runs script from them in the site's origin, where the owner's
  GitHub token is stored. HTML written by an editor may add no script, event
  handler or framing that the committed page did not already have
  (`worker/sanitize-guard.js`). Any way for an editor session or an API token
  to land executable content on the site is high severity.
- **Members HMAC gate** — the Cloudflare Pages Function under
  `functions/members/` that validates the HMAC-signed, HttpOnly, Secure cookie
  protecting `/members/` pages and files, and marks what it serves
  `private, no-store`.
- **The worker's one outbound fetch** — AI assist fetches an image URL the
  caller names. Only public hosts are allowed, on every redirect hop.

Forged sessions, allowlist escapes, script execution by an invited editor,
token leakage to the browser, and members-gate bypasses are the
highest-priority classes of issue.
