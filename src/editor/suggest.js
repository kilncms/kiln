/**
 * Suggest mode + preview links: Google-Docs "suggesting" for websites.
 *
 * A suggest-mode editor's Publish becomes a SUGGESTION — the same field-level
 * edits a live publish sends, parked on the worker until the owner approves
 * (approve = the worker re-applies them by key against the CURRENT page, so
 * interim publishes to other fields survive). Admins get a review queue with
 * per-field before/after; optionally each suggestion also lands on a
 * kiln/suggest-<name> scratch branch so branch-deploy hosts build a preview.
 *
 * Editor chrome only — main.js hands its seams in via initSuggest(deps) (no
 * circular import, same pattern as palette.js). Everything suggester-authored
 * that the review UI shows goes through textContent, never innerHTML.
 */

import { applyEdits, readValues } from '../engine.js';
import { editFile } from '../github.js';

let deps = null;

export function initSuggest(d) {
  if (!deps) deps = d;
}

/**
 * The preview URL for a branch: CF-Pages-style branch-alias sanitization —
 * lowercase, every run of non-alphanumerics → '-', trim '-', cap 28 chars —
 * substituted for {branch} in the template. Pure; exported for tests.
 *   previewUrl('kiln/suggest-Ana', 'https://{branch}.site.pages.dev')
 *     → 'https://kiln-suggest-ana.site.pages.dev'
 */
export function previewUrl(branch, template) {
  const alias = String(branch).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/, '');
  return String(template).replaceAll('{branch}', alias);
}

/** "3 min ago" for the review queue. */
function timeAgo(ts) {
  const m = (Date.now() - (ts || 0)) / 60000;
  if (m < 1.5) return 'just now';
  if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} hr ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Readable text of an HTML fragment (DOMParser is inert — nothing executes). */
function textOf(html) {
  if (html === undefined || html === null) return '';
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  return (doc.body.textContent || '').trim().replace(/\s+/g, ' ');
}

/** Build an element; `text` always goes through textContent (user content!). */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** An "open in new tab" chrome link (never user-supplied hrefs). */
function extLink(href, label) {
  const a = el('a', 'kiln-btn-ghost', label);
  a.href = href; a.target = '_blank'; a.rel = 'noopener';
  return a;
}

// ─── Suggest-mode publishing (the editor's Publish, rerouted) ────────────────

export function suggestChanges() {
  const { state, cfg, modal, setStatus, flattenPending, workerAuthHeaders, retireStaged } = deps;
  if (cfg.sandbox) {
    setStatus('The demo publishes only to your browser — suggesting needs a real Kiln site', 'idle');
    return;
  }
  // Suggestions carry field edits only (same limit as drafts/schedules): a
  // queued image upload or added section can't ride a suggestion, and silently
  // dropping them would publish a broken half. Make the user unwind those first.
  if (state.pendingBinaries.size || state.pendingStructural.length) {
    setStatus('Suggestions carry text edits only — undo new images / added sections first (⌘Z)', 'error');
    return;
  }
  if (!state.pending.size) return;
  const n = state.pending.size;
  const m = modal(`
    <h3>Suggest ${n} change${n > 1 ? 's' : ''}</h3>
    <p class="kiln-dim">Nothing goes live yet — the site owner reviews and approves your suggestion.</p>
    <label>Note for the reviewer (optional) <input type="text" id="kiln-sug-note" maxlength="200" placeholder="What you changed, in a line"></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-sug-go">Send suggestion</button>
    </div>
    <p class="kiln-np-step" id="kiln-sug-status"></p>`);
  const status = m.querySelector('#kiln-sug-status');
  m.querySelector('#kiln-sug-go').onclick = async () => {
    const note = m.querySelector('#kiln-sug-note').value.trim();
    const edits = flattenPending();
    m.querySelector('#kiln-sug-go').disabled = true;
    status.textContent = 'Sending your suggestion…';
    // Best-effort preview branch: the suggestion must go through even when the
    // scratch-branch write fails (no branch-deploy host, network blip, …).
    let branch = null, baseSha = null, previewSkipped = false;
    if (cfg.preview) {
      status.textContent = 'Writing the preview branch…';
      try { ({ branch, baseSha } = await writePreviewBranch(edits)); }
      catch (err) { console.warn('[kiln] suggest preview', err); previewSkipped = true; }
      status.textContent = 'Sending your suggestion…';
    }
    try {
      const body = { repo: cfg.repo, path: state.page.path, edits, note };
      if (branch) { body.branch = branch; body.baseSha = baseSha; }
      const res = await fetch(`${cfg.worker}/suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...workerAuthHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.suggestion) throw new Error(data.error || `failed (${res.status})`);
      // The edits now live in the suggestion on the worker — retire them here,
      // exactly like a schedule handoff (stage + undo history + markers).
      retireStaged();
      m.remove();
      setStatus(previewSkipped
        ? 'Suggested ✓ — awaiting approval (preview skipped)'
        : 'Suggested ✓ — awaiting approval', 'saved');
    } catch (err) {
      console.error('[kiln] suggest', err);
      m.querySelector('#kiln-sug-go').disabled = false;
      status.textContent = `Failed: ${err.message} — your edits are still staged.`;
    }
  };
}

/**
 * Commit the fully-applied page to a kiln/suggest-<name> scratch branch so a
 * branch-deploy host builds a shareable preview. The branch is created from
 * the live head when missing; when it already exists we just commit the page
 * onto it (ref rewinds need force, which editor sessions rightly can't do).
 * Returns { branch, baseSha } — baseSha is the live head this was based on.
 */
async function writePreviewBranch(edits) {
  const { state, cfg, ghRequest } = deps;
  const slug = String(state.user || 'editor').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'editor';
  const branch = `kiln/suggest-${slug}`;
  const head = await ghRequest('GET', `/repos/${cfg.repo}/git/ref/${encodeURIComponent('heads/' + (cfg.branch || 'main'))}`);
  const baseSha = head.object.sha;
  try {
    await ghRequest('POST', `/repos/${cfg.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  } catch { /* already exists — reuse; the page commit below refreshes it */ }
  await editFile(state.gh, cfg.repo, state.page.path, branch,
    () => applyEdits(state.page.text, edits).html,
    `Suggestion preview: ${state.page.path} (via Kiln)`);
  return { branch, baseSha };
}

// ─── Admin review queue ──────────────────────────────────────────────────────

let badgeBusy = false;

/** Lazily refresh the open-suggestions badge (piggybacked on the presence tick). */
export async function refreshSuggestBadge() {
  if (!deps || deps.cfg.sandbox) return;
  const { cfg, workerAuthHeaders } = deps;
  if (badgeBusy) return;
  badgeBusy = true;
  try {
    const res = await fetch(`${cfg.worker}/suggestions?repo=${encodeURIComponent(cfg.repo)}`, { headers: workerAuthHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const n = data.counts?.open || 0;
    const badge = document.getElementById('kiln-sug-badge');
    if (badge) { badge.hidden = !n; badge.textContent = String(n); }
  } catch { /* best-effort, like presence */ }
  finally { badgeBusy = false; }
}

export async function suggestionsPanel() {
  const { cfg, modal } = deps;
  const m = modal(`
    <h3>Suggestions</h3>
    <p class="kiln-dim">Approving merges a suggestion into the live page — it re-applies on top of anything
    published since, and the editor keeps authorship. Declining just records your call.</p>
    <div id="kiln-sug-list" class="kiln-inv-list">Loading…</div>
    <div id="kiln-sug-decided"></div>
    <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);
  if (cfg.sandbox) {
    m.querySelector('#kiln-sug-list').innerHTML =
      '<p class="kiln-dim">Nothing here in the demo — on a real site, “suggest-only” editors’ changes wait here for your approval.</p>';
    return;
  }
  await renderSuggestions(m);
}

async function renderSuggestions(m) {
  const { cfg, workerAuthHeaders } = deps;
  const list = m.querySelector('#kiln-sug-list');
  const decidedBox = m.querySelector('#kiln-sug-decided');
  if (!list) return;   // panel was closed mid-refresh
  let data;
  try {
    const res = await fetch(`${cfg.worker}/suggestions?repo=${encodeURIComponent(cfg.repo)}`, { headers: workerAuthHeaders() });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
  } catch {
    list.innerHTML = '<p class="kiln-dim">Could not load suggestions.</p>';
    return;
  }
  const all = data.suggestions || [];
  const open = all.filter(s => s.status === 'open');
  const decided = all.filter(s => s.status !== 'open').slice(0, 20);

  list.innerHTML = open.length ? '' : '<p class="kiln-dim">Nothing waiting — editors’ suggestions show up here.</p>';
  for (const sug of open) list.appendChild(suggestionRow(m, sug));

  decidedBox.innerHTML = '';
  if (decided.length) {
    const det = el('details', 'kiln-sug-decided');
    det.appendChild(el('summary', '', `Decided (${decided.length}${data.truncated ? '+' : ''})`));
    for (const s of decided) {
      const row = el('div', 'kiln-inv-row');
      const span = el('span');
      span.append(
        el('strong', '', `${s.status === 'approved' ? '✓' : '✕'} ${s.by || 'someone'}`),
        el('small', '', ` ${s.page}${s.note ? ` · “${s.note}”` : ''} · ${s.status} ${s.decided?.ts ? timeAgo(s.decided.ts) : ''}${s.decided?.note ? ` · “${s.decided.note}”` : ''}`),
      );
      row.appendChild(span);
      if (s.commit?.url) row.appendChild(extLink(s.commit.url, 'commit ↗'));
      det.appendChild(row);
    }
    decidedBox.appendChild(det);
  }
}

/** One open suggestion: header row + expandable per-field before/after + actions. */
function suggestionRow(m, sug) {
  const { cfg, setStatus, workerAuthHeaders, fetchFile, humanizeKey } = deps;
  const wrap = el('div', 'kiln-sug-item');
  const head = el('div', 'kiln-inv-row');
  const label = el('span');
  const nEdits = (sug.edits || []).length;
  label.append(
    el('strong', '', sug.by || 'someone'),
    el('small', '', ` ${timeAgo(sug.ts)} · ${sug.page} · ${nEdits} edit${nEdits > 1 ? 's' : ''}${sug.note ? ` · “${sug.note}”` : ''}`),
  );
  head.appendChild(label);

  const actions = el('span', 'kiln-sug-actions');
  const reviewBtn = el('button', 'kiln-btn-ghost', 'Review');
  actions.appendChild(reviewBtn);
  if (sug.branch && cfg.preview) actions.appendChild(extLink(previewUrl(sug.branch, cfg.preview), 'Open preview ↗'));
  const declineBtn = el('button', 'kiln-btn-ghost', 'Decline');
  const approveBtn = el('button', 'kiln-btn-publish', 'Approve');
  actions.append(declineBtn, approveBtn);
  head.appendChild(actions);
  wrap.appendChild(head);

  const err = el('p', 'kiln-sug-err');
  err.hidden = true;
  // Per-field before/after, loaded on first expand: current value (readValues on
  // the fetched live page) beside the suggested one. Plain text on both sides.
  const diff = el('div', 'kiln-sug-diff');
  diff.hidden = true;
  wrap.append(err, diff);
  let loaded = false;
  reviewBtn.onclick = async () => {
    diff.hidden = !diff.hidden;
    reviewBtn.textContent = diff.hidden ? 'Review' : 'Hide';
    if (loaded || diff.hidden) return;
    loaded = true;
    diff.textContent = 'Loading the live page…';
    let values = {}, doc = null;
    try {
      const file = await fetchFile(sug.page);
      values = readValues(file.text);
      doc = new DOMParser().parseFromString(file.text, 'text/html');   // inert
    } catch { /* page unreadable — show the suggested side only */ }
    diff.textContent = '';
    const header = el('div', 'kiln-sug-cols kiln-sug-colhead');
    for (const t of ['Section', 'Now', 'Suggested']) header.appendChild(el('span', '', t));
    diff.appendChild(header);
    for (const e of sug.edits || []) {
      const row = el('div', 'kiln-sug-cols');
      let before, after;
      if (e.attr !== undefined) {
        let cur = null;
        try { cur = doc?.querySelector(`[data-cms="${CSS.escape(e.key)}"]`)?.getAttribute(e.attr); } catch { /* bad key */ }
        before = cur ?? '—';
        after = String(e.value);
      } else {
        before = values[e.key] === undefined ? '—' : textOf(values[e.key]);
        after = textOf(e.html);
        // A markup-only change reads as "no change" in plain text — fall back to
        // the raw source so the reviewer still sees WHAT differs (still inert:
        // both sides render via textContent).
        if (before === after && values[e.key] !== undefined && String(values[e.key]).trim() !== String(e.html).trim()) {
          before = String(values[e.key]);
          after = String(e.html);
        }
      }
      row.append(
        el('span', '', humanizeKey(e.key) + (e.attr ? ` (${e.attr})` : '')),
        el('span', 'kiln-sug-before', before),
        el('span', 'kiln-sug-after', after),
      );
      diff.appendChild(row);
    }
  };

  const decide = async (approve, note) => {
    approveBtn.disabled = declineBtn.disabled = true;
    err.hidden = true;
    try {
      const res = await fetch(`${cfg.worker}/suggestions/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...workerAuthHeaders() },
        body: JSON.stringify({ repo: cfg.repo, id: sug.id, approve, ...(note && { note }) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 (page moved) and 422 (couldn't apply / guard) leave the suggestion
        // open on the worker — keep the row with an inline explanation.
        err.textContent = res.status === 409
          ? 'The page changed while approving — try again.'
          : `Could not ${approve ? 'approve' : 'decline'}: ${data.error || res.status}${data.detail ? ` (${data.detail})` : ''}`;
        err.hidden = false;
        approveBtn.disabled = declineBtn.disabled = false;
        return;
      }
      if (approve) {
        const commit = data.suggestion?.commit;
        if (commit?.url) setStatus('Approved ✓ — view the commit', 'saved', { href: commit.url });
        else setStatus('Approved ✓ — the page already matched', 'saved');
      } else {
        setStatus('Declined — nothing changed', 'idle');
      }
      await renderSuggestions(m);
      refreshSuggestBadge();
    } catch (e2) {
      err.textContent = `Failed: ${e2.message}`;
      err.hidden = false;
      approveBtn.disabled = declineBtn.disabled = false;
    }
  };
  approveBtn.onclick = () => decide(true);
  declineBtn.onclick = () => {
    const note = window.prompt('Note for the editor? (optional — OK declines)', '');
    if (note === null) return;   // cancelled
    decide(false, note.trim());
  };
  return wrap;
}

// ─── Share a preview link (drafts branch) ────────────────────────────────────

export async function sharePreviewPanel() {
  const { state, cfg, modal, setStatus, escapeHtml, saveDraft, journalAdd } = deps;
  const done = '<div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>';
  if (cfg.sandbox) {
    modal(`<h3>Share a preview link</h3>
      <p class="kiln-dim">The demo lives only in your browser — a real Kiln site saves your edits to the
      draft branch and hands you a link your host serves as a preview.</p>${done}`);
    return;
  }
  if (!cfg.preview) {
    // One-line config, spelled out — this is the whole setup.
    modal(`<h3>Share a preview link</h3>
      <p class="kiln-dim">One config line tells Kiln where your host serves branch builds. On
      <strong>Cloudflare Pages</strong> (branch previews are on by default), add to <code>window.KILN</code>:</p>
      <pre>preview: 'https://{branch}.&lt;project&gt;.pages.dev'</pre>
      <p class="kiln-dim"><strong>Netlify</strong>: <code>https://{branch}--&lt;site&gt;.netlify.app</code>
      (enable branch deploys). <code>{branch}</code> becomes the branch's URL-safe alias.</p>${done}`);
    return;
  }
  await saveDraft();               // existing flow: commits the staged edits to kiln-drafts
  if (state.pending.size) return;  // draft failed — saveDraft already said why; no stale link
  const url = previewUrl('kiln-drafts', cfg.preview);
  const m = modal(`<h3>Preview link</h3>
    <p class="kiln-dim">Saved to the draft branch — nothing is live. Your host builds the preview in
    about a minute; the status line reports when it's up.</p>
    <p><a class="kiln-sug-preview-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Close</button>
      <button class="kiln-btn-publish" id="kiln-prev-copy">Copy link</button>
    </div>`);
  m.querySelector('#kiln-prev-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(url); setStatus('Preview link copied', 'saved'); }
    catch { window.prompt('Copy the preview link:', url); }
  };
  // The journal HEAD-probes the URL and announces when the branch build answers.
  journalAdd({ type: 'url', target: url, desc: 'Preview' });
}
