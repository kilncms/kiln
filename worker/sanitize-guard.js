/**
 * Server-side commit guard for invited (non-admin) editors.
 *
 * Client-side DOMPurify is not a security boundary: an editor holds a valid
 * session token and can bypass the browser, POSTing raw markup straight at the
 * `/gh/*` commit proxy. This module is the server-side enforcement of the SAME
 * policy the editor's DOMPurify config enforces in the browser — no <script>,
 * no event handlers, no javascript:/dangerous-scheme URLs, no framing/form
 * tags, no srcdoc, no meta-refresh.
 *
 * A whole page legitimately contains executable markup the OWNER put there (the
 * Kiln boot <script src>, an analytics snippet, inline CSS). So for EXISTING
 * files we don't ban executable markup outright — we require that a non-admin
 * write introduces NOTHING executable that wasn't already in the committed
 * version (a multiset-subset check against the current source). Editing a
 * headline keeps the owner's scripts intact (they're in both versions) but an
 * injected <script> is new, and rejected.
 *
 * For a BRAND-NEW file (no prior version) the only executable markup allowed is
 * a relative-src external <script> (a reference to an owner-committed file — and
 * editors cannot commit .js/.mjs/etc, those are sensitive paths). Everything
 * else — inline scripts, absolute/protocol-relative script src, handlers,
 * dangerous URLs, frame/form tags — is rejected.
 *
 * For FRAGMENTS (a scheduled field's innerHTML) nothing executable is ever
 * legitimate, so any hit is rejected.
 */

import { parse, parseFragment } from 'parse5';

const FRAMING_TAGS = new Set(['iframe', 'object', 'embed', 'form', 'base', 'frame', 'frameset']);
const URL_ATTRS = /^(href|src|action|formaction|xlink:href|poster|data|background|ping)$/i;
const CONTROL_WS = /[\x00-\x20]/g;

function walk(node, fn) {
  fn(node);
  for (const c of node.childNodes || []) walk(c, fn);
  // Descend into <template> content too — a payload can hide there.
  if (node.content) walk(node.content, fn);
}

function textOf(node) {
  let out = '';
  walk(node, (n) => { if (n.nodeName === '#text') out += n.value; });
  return out;
}

function isDangerousUrl(value) {
  // Strip control chars and whitespace (incl. the classic "java\tscript:")
  const s = String(value).replace(CONTROL_WS, '').toLowerCase();
  return /^javascript:|^vbscript:|^data:text\/html|^data:image\/svg/.test(s);
}

/** Collect normalized "risk tokens" from a parse5 node tree. */
function collect(root) {
  const tokens = [];
  walk(root, (n) => {
    if (!n.tagName) return;
    const tag = n.tagName.toLowerCase();
    const attrs = n.attrs || [];
    if (tag === 'script') {
      const src = attrs.find(a => a.name.toLowerCase() === 'src')?.value;
      if (src != null && String(src).trim() !== '') tokens.push('script-src:' + String(src).trim());
      else tokens.push('script-inline:' + textOf(n).trim());
    } else if (tag === 'style') {
      // Not script execution, but tracked so a NEW inline <style> can't smuggle a
      // CSS payload past a fragment check. In diff mode existing owner CSS is in
      // both versions, so real pages are unaffected.
      tokens.push('style:' + textOf(n).trim());
    } else if (FRAMING_TAGS.has(tag)) {
      const key = attrs.find(a => /^(src|srcdoc|action|data|href)$/i.test(a.name))?.value || '';
      tokens.push('tag:' + tag + ':' + key);
    }
    for (const a of attrs) {
      const name = a.name.toLowerCase();
      if (/^on[a-z]/.test(name)) tokens.push('on:' + name + '=' + a.value);
      else if (name === 'srcdoc') tokens.push('srcdoc:' + a.value);
      else if (name === 'http-equiv' && String(a.value).toLowerCase() === 'refresh') tokens.push('meta-refresh');
      else if (URL_ATTRS.test(name) && isDangerousUrl(a.value)) tokens.push('url:' + String(a.value).trim());
    }
  });
  return tokens;
}

/**
 * Pages this guard can vouch for: files a host serves as text/html, which a
 * browser parses the way parse5 does. `.xhtml` is deliberately NOT one of
 * them — it is served as XML, where `<x:script xmlns:x="…/xhtml">` is a real
 * script element that an HTML parser reads as an unknown tag. Editor sessions
 * and API tokens do not write XML documents at all (src/file-policy.js).
 */
export function isHtmlPath(p) {
  return /\.html?$/i.test(String(p || ''));
}

/**
 * Guard a full-document write. `oldHtml` is the current committed source (or
 * null/'' for a brand-new file). Returns the first offending token string, or
 * null if the write introduces nothing disallowed.
 */
export function checkDocumentWrite(oldHtml, newHtml) {
  const isNew = oldHtml == null || oldHtml === '';
  const oldTokens = isNew ? [] : collect(parse(String(oldHtml)));
  const newTokens = collect(parse(String(newHtml)));
  const counts = new Map();
  for (const t of oldTokens) counts.set(t, (counts.get(t) || 0) + 1);
  for (const t of newTokens) {
    const c = counts.get(t) || 0;
    if (c > 0) { counts.set(t, c - 1); continue; }
    // Token not present in the current version.
    if (isNew && t.startsWith('script-src:')) {
      const src = t.slice('script-src:'.length);
      // Relative, same-origin script include → a reference to an owner file
      // (editors can't commit script files). Absolute or //protocol-relative
      // src could point at an attacker origin — reject.
      if (/^[./]/.test(src) && !/^\/\//.test(src)) continue;
    }
    if (isNew && t.startsWith('style:')) continue; // page-level CSS in a new page is fine
    return t;
  }
  return null;
}

/**
 * Guard a change to a text that may already hold markup (a Markdown body, a
 * Markdown field): the new text may carry the executable markup the current
 * one has (an embed the owner put there survives an edit to another
 * paragraph), and nothing more. Returns the first new token, or null.
 */
export function checkFragmentWrite(oldFragment, newFragment) {
  const counts = new Map();
  for (const t of collect(parseFragment(String(oldFragment ?? '')))) counts.set(t, (counts.get(t) || 0) + 1);
  for (const t of collect(parseFragment(String(newFragment ?? '')))) {
    const c = counts.get(t) || 0;
    if (c > 0) { counts.set(t, c - 1); continue; }
    return t;
  }
  return null;
}

/** Guard a fragment (a field's innerHTML). Any executable markup is rejected. */
export function checkFragment(fragmentHtml) {
  const tokens = collect(parseFragment(String(fragmentHtml)));
  // A fragment may carry inline styles legitimately (image resize writes them as
  // an attribute, not a <style> tag); only flag genuinely executable tokens.
  const bad = tokens.find(t => !t.startsWith('style:'));
  return bad || null;
}
