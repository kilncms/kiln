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
| 0.2.x   | yes       |
| < 0.2   | no        |

Security fixes land on the current `0.2.x` line.

## Security-sensitive surface

If you are reviewing or reporting, these are the areas that matter most:

- **GitHub App OAuth** — sign-in flow, `state` nonces, and the server-side
  session/refresh-token store in Workers KV.
- **Magic-link editor tokens** — single-use invite minting and redemption; the
  editor never holds GitHub credentials directly.
- **Commit proxy** — the `kiln-auth` worker holds a GitHub App installation
  token and proxies editor commits behind a strict method+path allowlist
  (one repo, content paths only, no deletes). Bypasses of that allowlist are
  high severity.
- **Members HMAC gate** — the Cloudflare Pages Function under
  `functions/members/` that validates the HMAC-signed, HttpOnly, Secure cookie
  protecting `/members/` pages and files.

Forged sessions, allowlist escapes, token leakage to the browser, and
members-gate bypasses are the highest-priority classes of issue.
