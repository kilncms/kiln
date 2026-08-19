/**
 * kiln-mcp — pure helpers (no dependencies).
 *
 * Everything the MCP server does that isn't SDK wiring lives here: config
 * parsing, request building, edit-shape validation, HTTP error mapping, result
 * formatting, and the fetch policy (30s timeout, one retry on network failure).
 * The repo's root test run imports this file directly, so it must never pull in
 * @modelcontextprotocol/sdk, zod, or anything else from mcp/node_modules.
 */

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Resolve worker URL + API token from env, with --worker= / --token= argv
 * overrides. Returns { workerUrl, token, warnings } or { error } — the caller
 * decides how to exit. Pure: no process access, no I/O.
 */
export function parseConfig(env = {}, argv = []) {
  let workerUrl = env.KILN_WORKER_URL || '';
  let token = env.KILN_API_TOKEN || '';
  for (const arg of argv) {
    if (arg.startsWith('--worker=')) workerUrl = arg.slice('--worker='.length);
    else if (arg.startsWith('--token=')) token = arg.slice('--token='.length);
  }
  workerUrl = String(workerUrl).trim().replace(/\/+$/, '');
  token = String(token).trim();
  const missing = [];
  if (!workerUrl) missing.push('KILN_WORKER_URL (or --worker=https://auth.example.com)');
  if (!token) missing.push('KILN_API_TOKEN (or --token=<64-hex token>)');
  if (missing.length) {
    return {
      error: `kiln-mcp needs ${missing.join(' and ')}.\n` +
        'The worker URL is your site\'s Kiln auth worker (e.g. https://auth.kilncms.com); ' +
        'the token is minted by the site owner via POST /admin/api-tokens.',
    };
  }
  if (!/^https?:\/\//i.test(workerUrl)) {
    return { error: `KILN_WORKER_URL must be an http(s) URL, got: ${workerUrl}` };
  }
  const warnings = [];
  if (!/^[a-f0-9]{64}$/.test(token)) {
    warnings.push('KILN_API_TOKEN does not look like a Kiln API token (64 hex chars) — expect 401s if it was mistyped.');
  }
  return { workerUrl, token, warnings };
}

/** First 8 chars of the token — enough to identify it, never enough to use it. */
export function redactToken(token) {
  return `${String(token).slice(0, 8)}…`;
}

// ─── Request building ────────────────────────────────────────────────────────

/**
 * Build { url, init } for one API operation against the worker.
 *   pages:  { ref? }                      → GET  /api/v1/pages
 *   fields: { path }                      → GET  /api/v1/fields?path=…
 *   edits:  { path, edits, message? }     → PATCH /api/v1/edits
 */
export function buildRequest(config, op, params = {}) {
  const headers = { Authorization: `Bearer ${config.token}` };
  if (op === 'pages') {
    const url = new URL(`${config.workerUrl}/api/v1/pages`);
    if (params.ref) url.searchParams.set('ref', params.ref);
    return { url: url.href, init: { method: 'GET', headers } };
  }
  if (op === 'fields') {
    const url = new URL(`${config.workerUrl}/api/v1/fields`);
    url.searchParams.set('path', params.path);
    return { url: url.href, init: { method: 'GET', headers } };
  }
  if (op === 'edits') {
    const body = { path: params.path, edits: params.edits };
    if (params.message) body.message = params.message;
    return {
      url: `${config.workerUrl}/api/v1/edits`,
      init: {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    };
  }
  throw new Error(`unknown operation: ${op}`);
}

// ─── Edit-shape validation ───────────────────────────────────────────────────

/**
 * Client-side mirror of the worker's shape checks (validateApiEdits, minus
 * key-scope and content-guard, which only the server can decide). Catches
 * malformed batches before a round trip. Returns an error string or null.
 */
export function validateEditShapes(edits) {
  if (!Array.isArray(edits) || !edits.length) return 'edits must be a non-empty array';
  if (edits.length > 500) return 'too many edits in one batch (max 500)';
  for (const e of edits) {
    if (!e || typeof e !== 'object') return 'every edit must be an object';
    if (typeof e.key !== 'string' || !e.key) return 'every edit needs a non-empty string "key"';
    const hasHtml = e.html !== undefined, hasAttr = e.attr !== undefined;
    if (hasHtml === hasAttr) {
      return `edit for "${e.key}": use exactly one shape — {key, html} for content, {key, attr, value} for an attribute`;
    }
    if (hasAttr) {
      if (!/^[a-z][a-z-]*$/i.test(String(e.attr))) return `edit for "${e.key}": "${e.attr}" is not a valid attribute name`;
      if (e.value === undefined) return `edit for "${e.key}": attribute edits need a "value"`;
    } else if (typeof e.html !== 'string') {
      return `edit for "${e.key}": "html" must be a string`;
    }
  }
  return null;
}

// ─── Error mapping ───────────────────────────────────────────────────────────

/**
 * Turn a non-2xx API response into an actionable message for the agent.
 * `body` is the parsed JSON error body when available ({} otherwise).
 */
export function describeApiError(status, body = {}) {
  const detail = body.detail !== undefined ? ` (detail: ${body.detail})` : '';
  const said = body.error ? `${body.error}${detail}` : `HTTP ${status}`;
  switch (status) {
    case 401:
      return `Unauthorized: ${said}. The API token is missing, mistyped, revoked, or expired — check KILN_API_TOKEN (the site owner can mint a new one via POST /admin/api-tokens).`;
    case 403:
      return `Forbidden: ${said}. This token's scope does not allow that — it may be read-only, or the path/field key is outside the paths/keys the owner granted it. Work within scope or ask the owner for a broader token.`;
    case 404:
      return `Not found: ${said}. Check the path against list_pages (and the ref, if you passed one).`;
    case 409:
      return `Conflict: ${said}. The page changed while the edit was in flight. This is safe to retry once — re-read with get_fields if you want to confirm current values first.`;
    case 422:
      return `Rejected by the server-side sanitizer: ${said}. Scripts, event handlers, javascript: URLs, and other executable markup can never be added through this API, by design. Rewrite the edit as plain text or simple inline HTML (b, i, em, strong, a, br, ul, li) and try again.`;
    case 429:
      return `Rate limited: ${said}. Slow down and retry after a pause.`;
    case 400:
      return `Bad request: ${said}. Check the path and the edit shapes ({key, html} or {key, attr, value}).`;
    case 502:
      return `Upstream error: ${said}. GitHub or the worker had trouble — usually transient, retry in a moment.`;
    case 503:
      return `Service unavailable: ${said}. The Kiln GitHub App may not be installed on the site's repo — the site owner needs to fix this; retrying won't help until they do.`;
    default:
      return `Unexpected response (HTTP ${status}): ${said}.`;
  }
}

// ─── Result formatting (MCP text blocks) ─────────────────────────────────────

export function formatPages(body) {
  const pages = Array.isArray(body.pages) ? body.pages : [];
  if (!pages.length) {
    return 'No editable pages visible to this token. Its path scope may be narrow, or the site has no HTML pages yet.';
  }
  const lines = pages.map(p => `- ${p}`);
  if (body.truncated) lines.push('(listing truncated — the repo is too large for one pass; some pages may be missing)');
  return `${pages.length} editable page(s):\n${lines.join('\n')}`;
}

export function formatFields(body) {
  const entries = Object.entries(body.fields || {});
  if (!entries.length) {
    return `${body.path}: no editable fields visible to this token. The page may have no data-kiln fields, or the token's key scope excludes them all.`;
  }
  const lines = entries.map(([key, f]) => {
    const value = f.value == null ? '(no value — attribute-backed or empty)' : JSON.stringify(f.value);
    return `- ${key} [${f.kind}]: ${value}`;
  });
  return `${body.path} — ${entries.length} field(s). These keys are the schema; edit them with edit_fields.\n${lines.join('\n')}`;
}

export function formatEditResult(body) {
  const lines = [];
  if (body.unchanged) {
    lines.push('No-op: the edits matched the current content exactly — nothing to commit.');
  } else if (body.commit?.url) {
    lines.push(`Committed: ${body.commit.url}`);
    if (body.commit.sha) lines.push(`Commit SHA: ${body.commit.sha}`);
  } else {
    lines.push('Edits applied.');
  }
  if (Array.isArray(body.applied) && body.applied.length) lines.push(`Applied: ${body.applied.join(', ')}`);
  if (Array.isArray(body.skipped) && body.skipped.length) {
    lines.push(`Skipped (key not found on the page, or attribute not allowed): ${body.skipped.join(', ')}`);
  }
  return lines.join('\n');
}

export function formatSiteInfo(workerUrl, token, outcome) {
  const lines = [
    `Kiln site via ${workerUrl}`,
    `Token: ${redactToken(token)}`,
  ];
  if (outcome.ok) {
    const pages = Array.isArray(outcome.body.pages) ? outcome.body.pages : [];
    lines.push(`Token is valid. ${pages.length} page(s) in its path scope${outcome.body.truncated ? ' (listing truncated)' : ''}.`);
    if (pages.length) {
      lines.push(`Sample: ${pages.slice(0, 10).join(', ')}${pages.length > 10 ? ', …' : ''}`);
    }
    lines.push('Field-key scope and write access are enforced per call — get_fields shows the keys this token can see on a page; a read-only token gets 403 from edit_fields.');
  } else {
    lines.push(`Probe (GET /api/v1/pages) failed — ${outcome.message}`);
  }
  return lines.join('\n');
}

// ─── Fetch policy ────────────────────────────────────────────────────────────

/**
 * fetch with a 30s timeout and ONE retry on network failure (never on an HTTP
 * response — 4xx/5xx are answers, not failures). Returns the Response.
 */
export async function apiFetch(url, init, { fetchImpl = globalThis.fetch, timeoutMs = 30_000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: ctl.signal });
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`network failure reaching the Kiln worker after ${retries + 1} attempt(s): ${lastErr?.message || lastErr}`);
}
