#!/usr/bin/env node
/**
 * kiln-mcp — safe, scoped AI write access to a Kiln-managed website.
 *
 * A stdio MCP server over Kiln's REST API (the site's auth worker). Every
 * write rides a path/field-scoped API token, passes the server-side sanitizer
 * (nothing executable can ever be added), and lands as one attributed,
 * revertible git commit.
 *
 * Config: KILN_WORKER_URL + KILN_API_TOKEN env vars, or --worker= / --token=.
 * All non-SDK logic lives in ./lib.mjs (pure, tested from the repo root too).
 */

import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  parseConfig, buildRequest, validateEditShapes, describeApiError,
  formatPages, formatFields, formatEditResult, formatSiteInfo, apiFetch,
} from './lib.mjs';

const VERSION = '0.1.0';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const errorResult = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

/** Build the McpServer with all four tools. fetchImpl is injectable for tests. */
export function createServer(config, fetchImpl = globalThis.fetch) {
  const server = new McpServer({ name: 'kiln-mcp', version: VERSION });

  // One API call → { ok, status, body } | { networkError }. Never throws.
  async function call(op, params) {
    const { url, init } = buildRequest(config, op, params);
    let res;
    try { res = await apiFetch(url, init, { fetchImpl }); }
    catch (err) { return { networkError: err.message }; }
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  const outcome = (r, format) => {
    if (r.networkError) return errorResult(r.networkError);
    if (!r.ok) return errorResult(describeApiError(r.status, r.body));
    return text(format(r.body));
  };

  server.registerTool('list_pages', {
    title: 'List editable pages',
    description: 'List the HTML pages of the Kiln site that this API token may see and edit. ' +
      'Start here: the returned paths are what get_fields and edit_fields accept. ' +
      'Optionally pass a git ref (branch/tag/SHA) to list pages as of that ref.',
    inputSchema: { ref: z.string().optional().describe('Git ref (branch, tag, or SHA); defaults to the default branch') },
  }, async ({ ref }) => outcome(await call('pages', { ref }), formatPages));

  server.registerTool('get_fields', {
    title: 'Read a page\'s editable fields',
    description: 'Read one page\'s editable fields as {key: {value, kind}}. The keys ARE the schema — ' +
      'there is no other; whatever keys come back are exactly what edit_fields can write. ' +
      'kind is "field" (text/HTML content), "repeat" (repeating item), etc.; attribute-backed values may be null. ' +
      'Path is a URL path ("/", "/about/") or a repo file path ("index.html").',
    inputSchema: { path: z.string().describe('Page path: URL-style ("/about/") or repo file path ("about/index.html")') },
  }, async ({ path }) => outcome(await call('fields', { path }), formatFields));

  server.registerTool('edit_fields', {
    title: 'Edit fields (one revertible commit)',
    description: 'Apply edits to a page\'s fields. The whole batch lands as ONE attributed git commit ' +
      'the site owner can review and revert in a click. Each edit is {key, html} for content or ' +
      '{key, attr, value} for an attribute (e.g. an image src). Content edits take plain text or simple ' +
      'inline HTML (b, i, em, strong, a, br, ul, li); scripts and executable markup are rejected by a ' +
      'server-side sanitizer and can never be added. Use keys from get_fields. ' +
      'Optional message becomes the commit message.',
    inputSchema: {
      path: z.string().describe('Page path, as accepted by get_fields'),
      edits: z.array(z.object({
        key: z.string().describe('Field key from get_fields'),
        html: z.string().optional().describe('New content: plain text or simple inline HTML (b, i, em, strong, a, br, ul, li)'),
        attr: z.string().optional().describe('Attribute name to set instead of content (e.g. "src", "href", "alt")'),
        value: z.string().optional().describe('Attribute value (required with attr)'),
      }).describe('Exactly one shape: {key, html} or {key, attr, value}')).describe('The edits — all applied in one commit'),
      message: z.string().optional().describe('Commit message (defaults to "Kiln API: update <path>")'),
    },
  }, async ({ path, edits, message }) => {
    const shapeError = validateEditShapes(edits);
    if (shapeError) return errorResult(`Invalid edits (nothing sent): ${shapeError}`);
    return outcome(await call('edits', { path, edits, message }), formatEditResult);
  });

  server.registerTool('site_info', {
    title: 'Site + token orientation',
    description: 'One cheap probe to orient yourself: which worker this server talks to, whether the ' +
      'token works, and how many pages fall inside its path scope. Call this first in a new session.',
    inputSchema: {},
  }, async () => {
    const r = await call('pages', {});
    const probe = r.networkError
      ? { ok: false, message: r.networkError }
      : r.ok ? { ok: true, body: r.body } : { ok: false, message: describeApiError(r.status, r.body) };
    const info = formatSiteInfo(config.workerUrl, config.token, probe);
    return probe.ok ? text(info) : errorResult(info);
  });

  return server;
}

async function main() {
  const config = parseConfig(process.env, process.argv.slice(2));
  if (config.error) {
    console.error(config.error);
    process.exit(1);
  }
  for (const w of config.warnings) console.error(`kiln-mcp: ${w}`);
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`kiln-mcp ${VERSION} ready — ${config.workerUrl}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`kiln-mcp fatal: ${err?.message || err}`); process.exit(1); });
}
