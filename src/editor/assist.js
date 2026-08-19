/**
 * AI assist: scoped, bring-your-own-key AI surfaces for the editor.
 *
 * Three surfaces, all riding the worker's POST /ai/assist (the Anthropic key
 * lives on the worker as a secret — the browser never sees it):
 *   • text fields — Improve / Shorten / Change tone… / Translate… / Custom…
 *     from a ✨ menu on the inline toolbar, with a before/after preview;
 *   • images — "✨ Alt text" on the image toolbar, shown for confirmation
 *     before it stages;
 *   • new post/page — an optional brief the worker turns into draft copy for
 *     the template's fields (wired up inside main.js's newContent).
 *
 * The AI is a suggestion engine, never a side door: every result renders
 * through DOMPurify (SANITIZE) before touching the DOM, applies through the
 * exact staging path a manual edit takes (commitEdit / stagePending), and so
 * hits the same publish-time sanitizers and the worker's content guard as
 * human typing. Editor chrome only — main.js hands its seams in via
 * initAssist(deps), the same leaf-module pattern as suggest.js/palette.js.
 */

import DOMPurify from 'dompurify';
import { SANITIZE } from './sanitize.js';

let deps = null;

export function initAssist(d) {
  if (!deps) deps = d;
}

/** POST to the worker; throws with .notConfigured on 501 so callers can explain. */
async function aiRequest(body) {
  const { cfg, workerAuthHeaders } = deps;
  const res = await fetch(`${cfg.worker}/ai/assist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workerAuthHeaders() },
    body: JSON.stringify({ repo: cfg.repo, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 501) {
    const err = new Error('AI is not set up on this site');
    err.notConfigured = true;
    throw err;
  }
  if (!res.ok) throw new Error(data.error || `failed (${res.status})`);
  return data;
}

/** The 501 explanation: admins get the fix, editors get who to ask. */
function explainNotConfigured() {
  const { mode, setStatus } = deps;
  setStatus(mode === 'admin'
    ? 'AI assist isn’t set up — add your Anthropic key to the worker: wrangler secret put AI_API_KEY'
    : 'AI assist isn’t set up on this site — ask the site owner to enable it', 'error');
}

function sandboxNote() {
  deps.setStatus('The demo has no AI backend — a real Kiln site connects its own API key for AI assist', 'idle');
}

function closeMenu() {
  document.getElementById('kiln-ai-menu')?.remove();
}

const MENU_ITEMS = [
  { kind: 'improve', label: 'Improve writing' },
  { kind: 'shorten', label: 'Shorten' },
  { kind: 'tone', label: 'Change tone…', ph: 'e.g. warmer, more formal' },
  { kind: 'translate', label: 'Translate…', ph: 'e.g. Spanish' },
  { kind: 'custom', label: 'Custom…', ph: 'Tell the AI what to do' },
];

const BTN_CSS = 'display:block;width:100%;text-align:left;background:none;border:0;color:inherit;'
  + 'font:13px/1.4 inherit;padding:7px 12px;cursor:pointer;border-radius:7px';

/** The ✨ menu on the text toolbar: pick an action; the … ones ask one line first. */
export function openAssistMenu(el, key, anchor) {
  const { cfg, escapeHtml } = deps;
  if (cfg.sandbox) { sandboxNote(); return; }
  closeMenu();
  const menu = document.createElement('div');
  menu.id = 'kiln-ai-menu';
  menu.style.cssText = 'position:fixed;z-index:2147483200;background:#1c1c28;color:#e7e7ee;border-radius:10px;'
    + 'padding:5px;min-width:190px;box-shadow:0 10px 34px rgba(0,0,0,.4);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  const list = () => {
    menu.innerHTML = MENU_ITEMS.map((it, i) =>
      `<button data-i="${i}" style="${BTN_CSS}">${escapeHtml(it.label)}</button>`).join('');
    menu.querySelectorAll('button').forEach(b => {
      b.onmouseenter = () => { b.style.background = 'rgba(255,255,255,.12)'; };
      b.onmouseleave = () => { b.style.background = 'none'; };
      b.onclick = (e) => {
        e.stopPropagation();
        const it = MENU_ITEMS[Number(b.dataset.i)];
        if (!it.ph) { close(); runTextAssist(el, key, it.kind); return; }
        // Instruction kinds: swap the menu for a one-line ask.
        menu.innerHTML = `<div style="padding:6px 8px">
          <div style="font-size:12px;opacity:.75;margin-bottom:5px">${escapeHtml(it.label.replace('…', ''))}</div>
          <input type="text" maxlength="200" placeholder="${escapeHtml(it.ph)}" style="width:200px;max-width:60vw;
            background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:7px;color:#fff;
            font:13px inherit;padding:6px 8px">
          <button style="${BTN_CSS};display:inline-block;width:auto;background:#6366f1;color:#fff;margin-left:4px">Go</button>
        </div>`;
        const input = menu.querySelector('input');
        const go = () => {
          const instruction = input.value.trim();
          if (!instruction) { input.focus(); return; }
          close();
          runTextAssist(el, key, it.kind, instruction);
        };
        menu.querySelector('button').onclick = (e2) => { e2.stopPropagation(); go(); };
        input.onkeydown = (e2) => { if (e2.key === 'Enter') { e2.preventDefault(); go(); } if (e2.key === 'Escape') close(); };
        input.focus();
      };
    });
  };
  list();
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 6 + menu.offsetHeight > window.innerHeight ? r.top - menu.offsetHeight - 6 : r.bottom + 6}px`;
  const away = (e) => { if (!menu.contains(e.target)) close(); };
  const close = () => { menu.remove(); document.removeEventListener('click', away, true); };
  setTimeout(() => document.addEventListener('click', away, true), 0);
}

/** Ask the worker to revise the field's HTML, then preview before/after. */
async function runTextAssist(el, key, kind, instruction) {
  const { setStatus } = deps;
  const text = el.innerHTML;
  if (text.length > 8000) {
    setStatus('This section is too long for AI assist (8,000 characters max)', 'error');
    return;
  }
  if (!text.trim()) {
    setStatus('Nothing to work with yet — write a little first', 'idle');
    return;
  }
  setStatus('Asking the AI…', 'saving');
  try {
    const data = await aiRequest({ kind, text, ...(instruction && { instruction }) });
    setStatus('AI suggestion ready — review it', 'idle');
    previewModal(el, key, kind, instruction, text, data.text);
  } catch (err) {
    if (err.notConfigured) explainNotConfigured();
    else setStatus(`AI assist failed: ${err.message}`, 'error');
  }
}

const PANE_CSS = 'border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:10px;'
  + 'max-height:180px;overflow:auto;font-size:13.5px;line-height:1.5';

/**
 * Before/after preview. Nothing stages until Apply, which routes the sanitized
 * result through commitEdit — the EXACT path a hand-typed edit takes, so
 * repeat containers, undo, and publish-time sanitizing all behave identically.
 */
function previewModal(el, key, kind, instruction, beforeHtml, afterRaw) {
  const { modal, setStatus, commitEdit, humanizeKey, escapeHtml } = deps;
  // Both panes render sanitized: the AI result MUST pass through SANITIZE before
  // innerHTML, and running the before-side through the same config keeps the
  // comparison honest (what you see is what would publish).
  const cleanBefore = DOMPurify.sanitize(beforeHtml, SANITIZE);
  let cleanAfter = DOMPurify.sanitize(afterRaw, SANITIZE);
  const m = modal(`
    <h3>✨ ${escapeHtml(humanizeKey(key))}</h3>
    <p class="kiln-dim">Review the suggestion — Apply stages it like any edit (nothing goes live until you Publish).</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:6px 0 2px">
      <div><p class="kiln-dim" style="margin:0 0 4px;font-size:12px">Now</p><div style="${PANE_CSS}" id="kiln-ai-before"></div></div>
      <div><p class="kiln-dim" style="margin:0 0 4px;font-size:12px">AI suggests</p><div style="${PANE_CSS}" id="kiln-ai-after"></div></div>
    </div>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-ghost" id="kiln-ai-retry">Try again</button>
      <button class="kiln-btn-publish" id="kiln-ai-apply">Apply</button>
    </div>`);
  m.querySelector('#kiln-ai-before').innerHTML = cleanBefore;
  m.querySelector('#kiln-ai-after').innerHTML = cleanAfter;
  const retryBtn = m.querySelector('#kiln-ai-retry');
  retryBtn.onclick = async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Thinking…';
    try {
      const data = await aiRequest({ kind, text: beforeHtml, ...(instruction && { instruction }) });
      cleanAfter = DOMPurify.sanitize(data.text, SANITIZE);
      m.querySelector('#kiln-ai-after').innerHTML = cleanAfter;
    } catch (err) {
      setStatus(`AI assist failed: ${err.message}`, 'error');
    }
    retryBtn.disabled = false;
    retryBtn.textContent = 'Try again';
  };
  m.querySelector('#kiln-ai-apply').onclick = () => {
    el.innerHTML = cleanAfter;
    commitEdit(el, key);   // same path as clicking Done: sanitize → stage → publish pipeline
    m.remove();
    setStatus('AI edit staged — Publish to make it live', 'saved');
  };
}

/**
 * "✨ Alt text" on the image toolbar: the worker looks at the image and drafts
 * alt text; a small editable confirm stages it via the normal attr edit.
 */
export async function assistAltText(img, key, altInput) {
  const { cfg, modal, setStatus, stagePending, stageContainer, escapeHtml } = deps;
  if (cfg.sandbox) { sandboxNote(); return; }
  let abs = null;
  try { abs = new URL(img.currentSrc || img.getAttribute('src') || '', location.href); } catch { /* no usable src */ }
  if (!abs || (abs.protocol !== 'https:' && abs.protocol !== 'http:')) {
    setStatus('This image isn’t published yet — publish it first, then generate alt text', 'idle');
    return;
  }
  setStatus('Looking at the image…', 'saving');
  let alt;
  try {
    ({ alt } = await aiRequest({ kind: 'alt', imageUrl: abs.href }));
    setStatus('Alt text drafted — confirm it', 'idle');
  } catch (err) {
    if (err.notConfigured) explainNotConfigured();
    else setStatus(`Alt text failed: ${err.message}`, 'error');
    return;
  }
  const m = modal(`
    <h3>✨ Alt text</h3>
    <p class="kiln-dim">Read by screen readers and search engines. Edit it if the AI missed the point.</p>
    <label>Alt text <input type="text" id="kiln-ai-alt" maxlength="300" value="${escapeHtml(alt)}"></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-ai-alt-apply">Apply</button>
    </div>`);
  m.querySelector('#kiln-ai-alt-apply').onclick = () => {
    const value = m.querySelector('#kiln-ai-alt').value.trim();
    if (!value) return;
    // The existing attr-edit staging — identical to typing into the alt input.
    img.setAttribute('alt', value);
    img.classList.add('kiln-modified');
    const repeat = img.closest('[data-cms-repeat]');
    if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
    else stagePending(key, { attrs: { alt: value } });
    if (altInput?.isConnected) altInput.value = value;
    m.remove();
    setStatus('Alt text staged — Publish to make it live', 'saved');
  };
}

/**
 * Template-fill for newContent: brief + [{key, hint?}] → { fields } with the
 * drafted text, or { error } (already-toasted 501s included) — the caller
 * degrades to creating the page un-filled either way.
 */
export async function draftFill(brief, fields) {
  try {
    const data = await aiRequest({ kind: 'fill', brief, fields });
    return { fields: data.fields || {} };
  } catch (err) {
    if (err.notConfigured) explainNotConfigured();
    return { error: err.notConfigured ? 'AI isn’t set up on this site' : err.message };
  }
}
