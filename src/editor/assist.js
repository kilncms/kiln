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
import { notDone, whyNot, said } from './plain-failure.js';
import { demoSays } from './tryout.js';

let deps = null;

export function initAssist(d) {
  if (!deps) deps = d;
}

/** POST to the worker (main.js `ask`); throws with .notConfigured on 501 so callers can explain. */
async function aiRequest(body) {
  const { cfg, ask } = deps;
  try {
    return await ask('/ai/assist', { method: 'POST', body: { repo: cfg.repo, ...body } });
  } catch (err) {
    if (err.status !== 501) throw err;
    const none = said('AI is not set up on this site');
    none.notConfigured = true;
    throw none;
  }
}

/**
 * An AI request that did not come back with a suggestion. An ended sign-in, a
 * refusal and no answer at all are said as everywhere else in the editor. A
 * 5xx here is the worker passing on what the AI service said (its key, its
 * limits) in words of its own: those are shown as they are. `asked` is what
 * the person typed for the AI to do, if anything: it is offered as a copy.
 */
function failed(err, lead, asked = '') {
  const { say, setStatus } = deps;
  console.error('[kiln] ai', err);
  if (err.status >= 500 && err.data?.error) setStatus(`${lead} The answer was: ${err.data.error}`, 'error');
  else say(err, '', notDone(lead, err), asked ? { name: 'what you asked for', text: asked } : null);
}

/** The 501 explanation: admins get the fix, editors get who to ask. */
function explainNotConfigured() {
  const { mode, setStatus } = deps;
  setStatus(mode === 'admin'
    ? 'AI assist isn’t set up — add your Anthropic key to the worker: wrangler secret put AI_API_KEY'
    : 'AI assist isn’t set up on this site — ask the site owner to enable it', 'error');
}

function closeMenu() {
  document.getElementById('kiln-ai-menu')?.remove();
}

const MENU_CSS = 'position:fixed;z-index:2147483200;background:#1c1c28;color:#e7e7ee;border-radius:10px;'
  + 'box-shadow:0 10px 34px rgba(0,0,0,.4);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

/** Put a menu or a note beside the button that opened it: under it when there is room, else over it. */
function placeBy(box, anchor) {
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8))}px`;
  box.style.top = `${r.bottom + 6 + box.offsetHeight > window.innerHeight ? r.top - box.offsetHeight - 6 : r.bottom + 6}px`;
}

/**
 * The demo has no AI behind the ✨. Pressing it used to light the button up
 * and put one line in the status corner, far from where the person was
 * looking, so it read as a button that does nothing. It now says what the
 * button is and where it works, in a note beside the button (the same place,
 * and on a phone the same sheet, as the menu a real site opens). One note at
 * a time; it goes on "Got it" or on a click anywhere else.
 */
function demoNote(anchor, what) {
  closeMenu();
  const note = document.createElement('div');
  note.id = 'kiln-ai-menu';
  note.setAttribute('role', 'status');
  note.style.cssText = `${MENU_CSS};padding:12px 14px;max-width:min(310px,calc(100vw - 16px));box-sizing:border-box`;
  const text = document.createElement('p');
  text.style.cssText = 'margin:0 0 10px;font-size:13px;line-height:1.5';
  text.textContent = demoSays(what);
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.textContent = 'Got it';
  ok.style.cssText = `${BTN_CSS};display:inline-block;width:auto;background:#6366f1;color:#fff;padding:6px 14px`;
  note.append(text, ok);
  document.body.appendChild(note);
  if (anchor?.isConnected) placeBy(note, anchor);
  const away = (e) => { if (!note.contains(e.target)) close(); };
  const close = () => { note.remove(); document.removeEventListener('click', away, true); };
  ok.onclick = (e) => { e.stopPropagation(); close(); };
  setTimeout(() => document.addEventListener('click', away, true), 0);
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
  if (cfg.sandbox) { demoNote(anchor, 'ai'); return; }
  closeMenu();
  const menu = document.createElement('div');
  menu.id = 'kiln-ai-menu';
  menu.style.cssText = `${MENU_CSS};padding:5px;min-width:190px`;
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
  placeBy(menu, anchor);
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
    else failed(err, 'The AI did not come back with a suggestion.', instruction);
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
      failed(err, 'The AI did not come back with a suggestion.', instruction);
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
export async function assistAltText(img, key, altInput, anchor = altInput) {
  const { cfg, modal, setStatus, stagePending, stageContainer, escapeHtml } = deps;
  if (cfg.sandbox) { demoNote(anchor, 'alt'); return; }
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
    else failed(err, 'The description was not written.');
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
    return { error: err.notConfigured ? 'AI is not set up on this site.' : whyNot(err) };
  }
}
