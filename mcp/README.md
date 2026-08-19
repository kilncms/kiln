# kiln-mcp

Give your AI safe write access to your website. `kiln-mcp` is an MCP (Model
Context Protocol) stdio server over [Kiln](https://kilncms.com)'s REST API: an
agent can list a site's pages, read each page's editable fields, and edit them —
and that is *all* it can do.

**The security story in one line:** every write rides an owner-minted token
scoped to specific paths and field keys, passes a server-side sanitizer that
rejects scripts and executable markup outright, and lands as one attributed,
revertible git commit — reviewable and one-click rollbackable by the site owner.

## Tools

| Tool | What it does |
|---|---|
| `site_info` | Orient: worker URL, token validity, pages in scope (one cheap call) |
| `list_pages` | The HTML pages this token may see and edit |
| `get_fields` | One page's editable fields as `{key: {value, kind}}` — the keys are the schema |
| `edit_fields` | Apply `{key, html}` / `{key, attr, value}` edits as one revertible commit |

## Setup

You need two values:

- **`KILN_WORKER_URL`** — your site's Kiln auth worker (e.g. `https://auth.kilncms.com`,
  or your self-hosted worker URL).
- **`KILN_API_TOKEN`** — a 64-hex API token minted by the site owner.

### Minting a token (site owner, one time)

Tokens are minted against the worker with your GitHub token (any token with push
access to the site's repo). Scope it as tightly as the job needs:

```bash
curl -s -X POST "$KILN_WORKER_URL/admin/api-tokens" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "owner/site-repo",
    "name": "menu-bot",
    "paths": ["menu/"],
    "keys": ["menu."],
    "readonly": false,
    "days": 90
  }'
```

The response contains `"token": "<64 hex>"` **once** — only its hash is stored,
so save it now. `paths` limits which files the token can touch, `keys` limits
which field keys (prefix match), `readonly: true` makes it read-only, and `days`
sets expiry (omit for no expiry). Revoke anytime with
`POST /admin/api-tokens/revoke` (`{"repo": "...", "id": "<record id>"}`).

### Claude Code

```bash
claude mcp add kiln-mcp \
  -e KILN_WORKER_URL=https://auth.kilncms.com \
  -e KILN_API_TOKEN=<your 64-hex token> \
  -- npx kiln-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kiln-mcp": {
      "command": "npx",
      "args": ["kiln-mcp"],
      "env": {
        "KILN_WORKER_URL": "https://auth.kilncms.com",
        "KILN_API_TOKEN": "<your 64-hex token>"
      }
    }
  }
}
```

`--worker=` and `--token=` argv flags override the env vars if you prefer args.

## What edits are allowed

Content edits (`{key, html}`) take plain text or simple inline HTML — `b`, `i`,
`em`, `strong`, `a`, `br`, `ul`, `li`. Attribute edits (`{key, attr, value}`)
set things like an image `src` or `alt`. Scripts, event handlers, `javascript:`
URLs, iframes, and anything else executable are rejected server-side (HTTP 422)
no matter what the client sends — the sanitizer is enforced by the worker, not
by this package. Concurrent edits merge field-by-field; a true conflict returns
409 and is safe to retry once.

## Development

```bash
cd mcp && npm install && npm test   # unit + integration + stdio boot tests
KILN_WORKER_URL=… KILN_API_TOKEN=… node index.mjs   # run directly
```

Pure logic lives in `lib.mjs` (zero dependencies); `index.mjs` is thin
`@modelcontextprotocol/sdk` wiring. License: AGPL-3.0-only, same as Kiln.
