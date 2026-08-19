/**
 * Theme panel: the site's own CSS custom properties as its brand kit.
 *
 * Sites declare design tokens on `:root` in their stylesheets
 * (`--brand-primary: #b8472a`). Kiln discovers them straight from the CSS —
 * no schema, no manifest — shows friendly controls (color pickers, font
 * stacks, sizes), live-previews changes via inline custom properties, and
 * Apply commits exact-offset edits back to the stylesheet file(s): one
 * commit per touched stylesheet, verified live by the publish journal.
 *
 * Editor chrome only — main.js hands its seams in via initTheme(deps), the
 * same leaf-module pattern as suggest.js. Discovery and application are pure
 * and exported for node tests.
 */

import { editFile } from '../github.js';

let deps = null;

export function initTheme(d) {
  if (!deps) deps = d;
}

// ─── Discovery (pure) ────────────────────────────────────────────────────────

// Conservative named-color list: only unambiguous CSS color keywords, so plain
// words like `none`, `auto`, or `bold` never masquerade as colors.
const NAMED_COLORS = new Set(('black white red green blue yellow orange purple pink brown gray grey teal navy'
  + ' maroon olive lime aqua cyan magenta fuchsia silver gold indigo violet coral salmon khaki crimson tan'
  + ' beige ivory lavender plum turquoise tomato rebeccapurple transparent currentcolor').split(' '));

/** What kind of control a token value gets. Conservative: unsure → 'other' (read-only). */
function classifyValue(value) {
  const v = String(value).trim();
  const lower = v.toLowerCase();
  // References and composites are edited at their source token / in real CSS.
  if (lower.startsWith('var(') || lower.includes('gradient(') || lower.includes('url(')) return 'other';
  if (/^#[0-9a-f]+$/.test(lower) && [4, 5, 7, 9].includes(lower.length)) return 'color';
  if (/^(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(/.test(lower)) return 'color';
  if (NAMED_COLORS.has(lower)) return 'color';
  // Fonts: a quoted family name, or a stack ending in a generic family.
  if (/(^|[,\s])(sans-serif|serif|monospace|cursive)$/.test(lower)) return 'font';
  if (/["'][a-z]/i.test(v)) return 'font';
  if (/^-?(\d+\.?\d*|\.\d+)(px|rem|em|%|vw|vh)$/.test(lower)) return 'size';
  return 'other';
}

/**
 * A same-length copy of css where comment bodies and quoted-string CONTENTS
 * become spaces (the quote characters stay). Structure — braces, semicolons,
 * colons, parens — can then be scanned with no comment/string special cases,
 * while every offset still points into the ORIGINAL text.
 */
function maskCss(css) {
  const a = css.split('');   // code units, so offsets match String.slice exactly
  const n = a.length;
  let i = 0;
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      let e = css.indexOf('*/', i + 2);
      e = e === -1 ? n : e + 2;
      while (i < e) a[i++] = ' ';
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && css[i] !== c) {
        a[i] = ' ';
        if (css[i] === '\\' && i + 1 < n) a[++i] = ' ';   // escaped char (incl. \") masks too
        i++;
      }
      i++;   // the closing quote stays, so a quoted value still reads as non-empty
    } else i++;
  }
  return a.join('');
}

/** Custom-property declarations inside one :root body [s, e) — offsets exact. */
function harvest(css, masked, s, e, path, out) {
  let declStart = s;
  let parens = 0;   // url(data:…;base64,…) — a ';' inside parens doesn't split
  let braces = 0;   // nested sub-blocks (CSS nesting) hold no :root declarations
  for (let i = s; i <= e; i++) {
    const c = i === e ? ';' : masked[i];   // virtual terminator: last decl may omit ';'
    if (c === '(') parens++;
    else if (c === ')') { if (parens) parens--; }
    else if (c === '{') braces++;
    else if (c === '}') { if (braces) braces--; declStart = i + 1; }
    else if (c === ';' && !parens && !braces) {
      const decl = masked.slice(declStart, i);
      const m = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*/.exec(decl);
      if (m) {
        const start = declStart + m[0].length;
        let end = i;
        while (end > start && /\s/.test(masked[end - 1])) end--;   // masked comments trim as spaces
        if (end > start) {
          const value = css.slice(start, end);
          out.push({ name: m[1], value, kind: classifyValue(value), start, end, path });
        }
      }
      declStart = i + 1;
    }
  }
}

/**
 * Find every CSS custom property declared in `:root { … }` blocks (multiple
 * blocks, minified one-liners, comments, and @media-nested :root all handled).
 * Returns [{ name, value, kind, start, end, path }] in file order — start/end
 * are the VALUE's exact character offsets in cssText, so an edit can be
 * spliced back byte-for-byte. Pure; exported for tests.
 */
export function discoverTokens(cssText, path = '') {
  const css = String(cssText);
  const masked = maskCss(css);
  const out = [];
  const n = css.length;
  let i = 0;
  let runStart = 0;   // where the current selector/prelude run began
  while (i < n) {
    const c = masked[i];
    if (c === '{') {
      if (masked.slice(runStart, i).split(',').some(s2 => s2.trim() === ':root')) {
        let depth = 1;
        let j = i + 1;
        while (j < n && depth) { if (masked[j] === '{') depth++; else if (masked[j] === '}') depth--; j++; }
        harvest(css, masked, i + 1, depth ? n : j - 1, path, out);
        i = j;
      } else {
        i++;   // @media / other selectors — keep scanning inside for :root
      }
      runStart = i;
    } else if (c === '}' || c === ';') { i++; runStart = i; }
    else i++;
  }
  return out;
}

// ─── Application (pure) ──────────────────────────────────────────────────────

/**
 * Splice new token values into cssText at their recorded offsets.
 * edits: [{ name, value, start, end, newValue }] — `value` is what discovery
 * saw; every edit is verified against the current text FIRST, and any mismatch
 * (the file changed upstream) applies NOTHING: the caller re-fetches,
 * re-discovers, and re-applies by name. Matching edits splice right-to-left so
 * earlier offsets never shift. Returns { css, applied: [names], mismatched: [names] }.
 * Pure; exported for tests.
 */
export function applyTokenEdits(cssText, edits) {
  const css = String(cssText);
  const mismatched = edits.filter(e => css.slice(e.start, e.end) !== e.value).map(e => e.name);
  if (mismatched.length) return { css, applied: [], mismatched };
  let out = css;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.newValue + out.slice(e.end);
  }
  return { css: out, applied: edits.map(e => e.name), mismatched: [] };
}

// ─── Sources ─────────────────────────────────────────────────────────────────

// Per-session stylesheet cache: repoPath → { path, text, tokens }. Refreshed
// after every Apply from the exact text that was committed.
const sheetCache = new Map();

// Staged-but-uncommitted token changes survive closing the panel (the inline
// preview stays on the page, so the staging that explains it must too).
// name → { token, value } — the keys are exactly the inline-previewed props.
const dirty = new Map();

/**
 * The page's same-origin stylesheets, mapped to repo paths and fetched FROM
 * THE REPO (offsets must match the committed file, not whatever the CDN
 * serves). Querystringed hrefs and non-.css pathnames don't map to a repo
 * file unambiguously — skipped; editors only see in-scope files. Sandbox has
 * no repo: fetch over HTTP there (nothing is ever committed in the demo).
 * Unreadable sheets (404 — generated CSS; non-UTF-8) are skipped, not fatal.
 */
async function loadSheets() {
  const { cfg, mode, pageInScope, fetchFile } = deps;
  const seen = new Set();
  const sheets = [];
  for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
    let u;
    try { u = new URL(link.getAttribute('href'), location.href); } catch { continue; }
    if (u.origin !== location.origin || u.search) continue;
    const p = u.pathname.replace(/^\/+/, '');
    if (!p.toLowerCase().endsWith('.css') || seen.has(p)) continue;
    seen.add(p);
    if (mode === 'editor' && !pageInScope(p)) continue;
    if (sheetCache.has(p)) { sheets.push(sheetCache.get(p)); continue; }
    try {
      let text;
      if (cfg.sandbox) {
        const res = await fetch('/' + p, { cache: 'no-store' });
        if (!res.ok) continue;
        text = await res.text();
      } else {
        ({ text } = await fetchFile(p));
      }
      const entry = { path: p, text, tokens: discoverTokens(text, p) };
      sheetCache.set(p, entry);
      sheets.push(entry);
    } catch (err) {
      console.warn('[kiln] theme', p, err);
    }
  }
  return sheets;
}

/** Cascade winners: later stylesheet / later declaration overrides. name → token. */
function winningTokens(sheets) {
  const map = new Map();
  for (const sheet of sheets) for (const t of sheet.tokens) map.set(t.name, t);
  return map;
}

// ─── Panel ───────────────────────────────────────────────────────────────────

const KINDS = [['color', 'Colors'], ['font', 'Fonts'], ['size', 'Sizes'], ['other', 'Other']];

/** Build an element; `text` goes through textContent (CSS values stay inert). */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** #rgb → #rrggbb (lossless — same color) so <input type=color> can hold it. */
function hexForPicker(v) {
  v = String(v).trim().toLowerCase();
  const m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return '#' + m[1].replace(/./g, '$&$&');
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

/** Families already loadable on this page (via document.fonts), unquoted. */
function loadedFontFamilies() {
  const fams = new Set();
  try {
    for (const f of document.fonts) fams.add(String(f.family).trim().replace(/^["']|["']$/g, ''));
  } catch { /* FontFaceSet unavailable — the current value is still offered */ }
  return [...fams].filter(Boolean).sort();
}

/** A font stack for family F, keeping the current value's generic fallback. */
function fontStackFor(family, currentValue) {
  const generic = (/(sans-serif|serif|monospace|cursive)\s*$/i.exec(currentValue) || [])[1] || 'sans-serif';
  const name = /[^A-Za-z0-9-]/.test(family) ? `'${family}'` : family;
  return `${name}, ${generic.toLowerCase()}`;
}

export async function openThemePanel() {
  const { state, cfg, modal, setStatus, escapeHtml, journalAdd, djb2 } = deps;
  const m = modal(`<h3>Theme</h3>
<p class="kiln-dim">The site's brand kit — its <code>:root</code> CSS custom properties.
Changes preview instantly; <strong>Apply</strong> commits them site-wide.</p>
<div id="kiln-th-body"><p class="kiln-dim">Reading stylesheets…</p></div>
<div class="kiln-modal-actions">
<button class="kiln-btn-ghost" id="kiln-th-revert">Revert</button>
<button class="kiln-btn-ghost" data-close>Close</button>
<button class="kiln-btn-publish" id="kiln-th-apply" disabled>Apply</button>
</div>
<p class="kiln-np-step" id="kiln-th-status"></p>`);
  const body = m.querySelector('#kiln-th-body');
  const applyBtn = m.querySelector('#kiln-th-apply');
  const revertBtn = m.querySelector('#kiln-th-revert');
  const status = m.querySelector('#kiln-th-status');

  const sheets = await loadSheets();
  if (!document.body.contains(m)) return;   // closed while fetching

  function updateButtons() {
    const n = dirty.size;
    applyBtn.disabled = !n;
    applyBtn.textContent = n ? `Apply ${n} change${n > 1 ? 's' : ''}` : 'Apply';
  }

  const rootStyle = document.documentElement.style;

  function stage(token, raw) {
    const v = String(raw).trim();
    if (!v || v === token.value) {   // back to the committed value — no longer staged
      dirty.delete(token.name);
      rootStyle.removeProperty(token.name);
    } else {
      dirty.set(token.name, { token, value: v });
      // Live preview: an inline custom property on <html> outranks every stylesheet.
      rootStyle.setProperty(token.name, v);
    }
    updateButtons();
  }

  function render() {
    const tokens = [...winningTokens(sheets).values()];
    body.textContent = '';
    if (!tokens.length) {
      body.innerHTML = `<p class="kiln-dim">No design tokens found. Declare your brand as custom
properties on <code>:root</code> in your stylesheet and this panel becomes controls:</p>
<pre class="kiln-th-example">:root {
  --brand-primary: #b8472a;
  --font-display: 'Fraunces', serif;
}</pre>
<p class="kiln-dim">Use them via <code>var(--brand-primary)</code> —
<a href="https://github.com/kilncms/kiln/blob/main/docs/for-site-owners.md#theme-tokens" target="_blank" rel="noopener">docs</a>.</p>`;
      applyBtn.disabled = true;
      revertBtn.style.display = 'none';
      return;
    }
    const multiFile = new Set(tokens.map(t => t.path)).size > 1;
    for (const [kind, label] of KINDS) {
      const group = tokens.filter(t => t.kind === kind);
      if (!group.length) continue;
      const wrap = el('div', 'kiln-th-group');
      wrap.appendChild(el('h4', '', label));
      // When several files contribute, say which file defines this group.
      if (multiFile) wrap.appendChild(el('div', 'kiln-th-src', [...new Set(group.map(t => t.path))].join(' · ')));
      for (const token of group) wrap.appendChild(row(token));
      if (kind === 'font') {
        wrap.appendChild(el('p', 'kiln-th-hint',
          'To use a new font, add its <link> or @font-face to the site first.'));
      }
      body.appendChild(wrap);
    }
  }

  // Rows render via innerHTML + escapeHtml, the menuEditor precedent — token
  // values are the site's own stylesheet text (already served to every visitor).
  function row(token) {
    const r = el('div', 'kiln-th-row');
    // Staged-but-uncommitted value (panel reopened mid-edit) shows, not the file's.
    const cur = dirty.get(token.name)?.value ?? token.value;
    const name = `<span class="kiln-th-name">${escapeHtml(token.name)}</span>`;
    if (token.kind === 'color') {
      const hex = hexForPicker(cur);   // non-hex keeps a raw text input — never lossily convert
      // The native picker shows its color itself; text-input colors get a swatch.
      r.innerHTML = name + (hex
        ? `<input type="color" value="${hex}">`
        : `<span class="kiln-th-swatch"></span><input type="text" value="${escapeHtml(cur)}">`);
      const swatch = r.querySelector('.kiln-th-swatch');
      if (swatch) swatch.style.background = cur;
      const input = r.querySelector('input');
      input.oninput = () => { stage(token, input.value); if (swatch) swatch.style.background = input.value; };
    } else if (token.kind === 'font') {
      const options = [token.value];
      for (const fam of loadedFontFamilies()) {
        const stack = fontStackFor(fam, token.value);
        if (!options.includes(stack)) options.push(stack);
      }
      if (!options.includes(cur)) options.push(cur);
      r.innerHTML = name + `<select class="kiln-th-select">${options.map(v =>
        `<option value="${escapeHtml(v)}"${v === cur ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select>`;
      const sel = r.querySelector('select');
      sel.onchange = () => stage(token, sel.value);
    } else if (token.kind === 'size') {
      // Unit preserved — committed exactly as typed.
      r.innerHTML = `${name}<input type="text" value="${escapeHtml(cur)}">`;
      const input = r.querySelector('input');
      input.oninput = () => stage(token, input.value);
    } else {
      r.innerHTML = `${name}<span class="kiln-th-val">${escapeHtml(token.value)}</span>`;
    }
    return r;
  }

  render();
  updateButtons();

  revertBtn.onclick = () => {
    for (const name of dirty.keys()) rootStyle.removeProperty(name);
    dirty.clear();
    render();
    updateButtons();
    status.textContent = '';
  };

  // Apply = commit: one commit per touched stylesheet, journal-verified live.
  applyBtn.onclick = async () => {
    if (cfg.sandbox) {
      const msg = 'The demo previews only in your browser — Apply needs a real Kiln site';
      status.textContent = msg;
      setStatus(msg, 'idle');
      return;
    }
    const byFile = new Map();
    for (const { token, value } of dirty.values()) {
      if (!byFile.has(token.path)) byFile.set(token.path, []);
      byFile.get(token.path).push({ name: token.name, value: token.value, start: token.start, end: token.end, newValue: value });
    }
    applyBtn.disabled = revertBtn.disabled = true;
    const notices = [];
    const failures = [];
    let committed = 0;
    for (const [path, edits] of byFile) {
      status.textContent = `Committing ${path}…`;
      let appliedNames = [];
      let skipped = [];
      try {
        const result = await editFile(state.gh, cfg.repo, path, cfg.branch || 'main', (text) => {
          skipped = [];
          let attempt = applyTokenEdits(text, edits);
          if (attempt.mismatched.length) {
            // The file changed since discovery — re-discover and re-apply by NAME
            // against the fresh text; tokens that vanished are skipped, not guessed.
            const fresh = new Map(discoverTokens(text, path).map(t => [t.name, t]));
            const redone = [];
            for (const e of edits) {
              const t = fresh.get(e.name);
              if (!t) { skipped.push(e.name); continue; }
              redone.push({ name: t.name, value: t.value, start: t.start, end: t.end, newValue: e.newValue });
            }
            attempt = applyTokenEdits(text, redone);
          }
          appliedNames = attempt.applied;
          return attempt.css;
        }, `Theme: ${edits.length} token${edits.length === 1 ? '' : 's'} (via Kiln)`);
        for (const nm of skipped) notices.push(`${nm} vanished — skipped`);
        if (!result.unchanged) {
          committed += appliedNames.length;
          // Mirror menuEditor: the journal probes the live file and reports in the
          // status line ("Theme — live ✓") even after this modal closes.
          journalAdd({ type: 'compare', target: '/' + path, expect: djb2(result.text), desc: 'Theme', sha: result.commit?.sha });
          const entry = { path, text: result.text, tokens: discoverTokens(result.text, path) };
          sheetCache.set(path, entry);
          const idx = sheets.findIndex(s => s.path === path);
          if (idx !== -1) sheets[idx] = entry;
        }
        // The committed CSS takes over from here — drop the inline preview props
        // and the dirty marks for everything that landed (or vanished upstream).
        for (const nm of appliedNames.concat(skipped)) {
          rootStyle.removeProperty(nm);
          dirty.delete(nm);
        }
      } catch (err) {
        console.error('[kiln] theme', err);
        failures.push(`${path}: ${err.message}`);   // its edits stay staged for a retry
      }
    }
    render();
    updateButtons();
    revertBtn.disabled = false;
    const parts = committed
      ? [`Committed ${committed} token${committed > 1 ? 's' : ''} ✓ — live in about a minute.`]
      : failures.length ? [] : ['Nothing to change.'];
    parts.push(...notices);
    if (failures.length) parts.push(`Could not update ${failures.join(' · ')} — still staged.`);
    status.textContent = parts.join(' ');
    // No setStatus on success — journalAdd's first tick already narrates
    // ("Publishing “Theme”…", then "live ✓") in the status line.
    if (!committed && failures.length) setStatus('Theme update failed — see the panel', 'error');
  };
}
