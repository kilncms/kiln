/**
 * kiln-comments — Figma-style review threads pinned to the live page.
 *
 * Threads are plain data in the worker's KV (worker/index.js "Comments"): this
 * module renders numbered pins for anchored open threads, a per-page panel, an
 * inline composer, and a pin-placement mode. The worker stamps authorship from
 * the session, so identity is never client-claimed.
 *
 * Comment text (and author names) are stored RAW and rendered with textContent
 * ONLY — nothing a commenter types is ever parsed as HTML.
 */

import { notDone } from './plain-failure.js';
import { TYPED } from './saved-edits.js';

let ready = false;
let cfg, state, isAdmin, status, showModal, ask, say, stopped, pagePage, chromeSel;
let threads = [];      // this page's threads (worker order: newest first)
let siteTotal = null;  // open threads site-wide (null until /counts answers)
let layer = null;      // fixed overlay holding the pins (pointer-events:none; pins opt back in)
let pins = [];         // [{ el, target, thread }]
let placing = null;    // teardown fn while pin-placement mode is active
let popClose = null;   // teardown fn while the pin popover is open
let rafPending = false;
let replyBack = null;  // { thread, text }: a reply that was being written when the sign-in ended, back in its box


const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;   // user text ALWAYS lands here, never innerHTML
  return n;
};
const btn = (cls, text, onclick) => {
  const b = h('button', cls, text);
  b.onclick = onclick;
  return b;
};
/** Capture-phase document listener; returns its remover. */
const listen = (ev, fn) => {
  document.addEventListener(ev, fn, true);
  return () => document.removeEventListener(ev, fn, true);
};
/** Esc puts a comment box away, unless a dialog is open over it: then Esc is the dialog's, and what was typed stays. */
const onEsc = (fn) => (e) => { if (e.key === 'Escape' && !document.getElementById('kiln-modal')) { e.stopPropagation(); fn(); } };
/** Viewport-clamped fixed position. */
const place = (el, x, y) => {
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8))}px`;
};

const openThreads = () => threads.filter(t => t.status === 'open');

/** Stable pin number: open threads numbered oldest-first (worker order is newest-first). */
function numOf(t, open) {
  const i = open.indexOf(t);
  return i < 0 ? null : open.length - i;
}

/**
 * POST JSON {repo, …body}, or GET with ?repo&…query, through the editor's one
 * way of asking the worker (main.js `ask`). Throws on non-2xx, with the
 * answer's status and body on the error.
 */
function api(route, body, query) {
  return body
    ? ask(route, { method: 'POST', body: { repo: cfg.repo, ...body } })
    : ask(route + '?' + new URLSearchParams({ repo: cfg.repo, ...query }));
}

function relTime(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Boot ────────────────────────────────────────────────────────────────────

export function initComments(_cfg, mode, _state, door, _modal, _setStatus, hasFeature, kilnChrome) {
  // Demo sandbox has no worker; editors need the grant (admins always pass).
  if (_cfg.sandbox || (mode === 'editor' && !hasFeature('comments'))) return;
  cfg = _cfg;
  state = _state;
  isAdmin = mode === 'admin';
  // main.js's seams for a request and for a failed one: `stopped` says what an
  // answer means (and opens the sign-in dialog), `say` puts that in the status line.
  ({ ask, say, stopped } = door);
  showModal = _modal;
  status = _setStatus;
  chromeSel = kilnChrome;   // main's KILN_CHROME — a placement click must never pin to editor chrome
  pagePage = state.page.path.replace(/^\/+/, '');   // repo file path, no leading slash
  ready = true;
  layer = h('div');
  layer.id = 'kiln-cmt-layer';
  document.body.appendChild(layer);
  window.addEventListener('scroll', scheduleLayout, true);   // capture: inner scrollers too
  window.addEventListener('resize', scheduleLayout);
  refreshThreads().then(refreshCounts);
}

/** Piggybacked on the presence tick (~30s): cheap counts poll; refetch threads only when stale. */
export function commentsTick() {
  if (ready) refreshCounts();
}

/** `asked`: the person opened the panel, so a failure is theirs to know about and is thrown to the caller. */
async function refreshThreads(asked = false) {
  try {
    threads = (await api('/comments', null, { path: pagePage })).threads || [];
    renderPins();
    updateBadge();
  } catch (err) {
    console.warn('[kiln]', err);
    if (asked) throw err;
  }
}

async function refreshCounts() {
  try {
    const data = await api('/comments/counts');
    siteTotal = typeof data.total === 'number' ? data.total : null;
    const c = data.counts || {};
    // typeof-guard: on a plain-JSON object a page named "__proto__" reads Object.prototype.
    const n = typeof c[pagePage] === 'number' ? c[pagePage] : 0;
    if (n !== openThreads().length) await refreshThreads();   // someone else commented/resolved
    else updateBadge();
  } catch { /* badge is advisory */ }
}

function updateBadge() {
  const el = document.getElementById('kiln-comments');
  if (!el) return;
  const n = openThreads().length;
  if (n) el.setAttribute('data-badge', n > 99 ? '99+' : String(n));
  else el.removeAttribute('data-badge');
}

// ─── Pins ────────────────────────────────────────────────────────────────────

/** anchor.key → first [data-cms] match; anchor.sel → querySelector (bad selector = no pin). */
function resolveAnchor(anchor) {
  if (!anchor) return null;
  try {
    if (anchor.key) return document.querySelector(`[data-cms="${CSS.escape(anchor.key)}"]`);
    if (anchor.sel) return document.querySelector(anchor.sel);
  } catch { /* hostile or stale selector — thread stays panel-only */ }
  return null;
}

function renderPins() {
  if (!layer) return;
  layer.textContent = '';
  pins = [];
  const open = openThreads();
  for (const t of open) {
    const target = resolveAnchor(t.anchor);
    if (!target) continue;
    const pin = btn('kiln-cmt-pin', String(numOf(t, open)), (e) => { e.stopPropagation(); openPopover(t.id, pin); });
    layer.appendChild(pin);
    pins.push({ el: pin, target, thread: t });
  }
  layoutPins();
}

function layoutPins() {
  for (const p of pins) {
    // Edits can replace whole subtrees (repeats re-render): re-resolve a detached target.
    if (!p.target?.isConnected) p.target = resolveAnchor(p.thread.anchor);
    const r = p.target?.isConnected && p.target.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { p.el.style.display = 'none'; continue; }
    const a = p.thread.anchor || {};
    p.el.style.display = '';
    p.el.style.left = `${r.left + r.width * ((typeof a.x === 'number' ? a.x : 50) / 100)}px`;
    p.el.style.top = `${r.top + r.height * ((typeof a.y === 'number' ? a.y : 0) / 100)}px`;
  }
}

function scheduleLayout() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; layoutPins(); });
}

// ─── Panel (all threads for this page) ───────────────────────────────────────

export function openComments() {
  if (!ready) return;   // sandbox / ungranted — the button is hidden in those modes anyway
  const m = showModal(`<h3>Comments</h3><p class="kiln-dim" id="kiln-cmt-tally"></p>
<button class="kiln-btn-publish" id="kiln-cmt-new" style="margin:0 0 12px">＋ New comment</button>
<div id="kiln-cmt-list"></div>
<div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);
  m.querySelector('#kiln-cmt-new').onclick = () => {
    m.querySelector('.kiln-modal-x').click();   // modal's own close (removes its key handler)
    enterPlaceMode();
  };
  renderPanel(m);
  refreshThreads(true).then(() => {
    // A reply that came back after signing in again, to a thread that is no longer there: its words go in a new comment's box.
    if (replyBack && !threads.some(t => t.id === replyBack.thread)) {
      const { text } = replyBack;
      replyBack = null;
      if (m.isConnected) m.querySelector('.kiln-modal-x').click();
      openComposer({ x: innerWidth / 2, y: innerHeight / 3 }, null, text);
      return;
    }
    if (m.isConnected) renderPanel(m);
  }).catch((err) => {
    // The comments shown may be out of date: say why, where the count is.
    const line = stopped(err);
    if (line && m.isConnected) m.querySelector('#kiln-cmt-tally').textContent = line;
  });
}

function renderPanel(m) {
  m.querySelector('#kiln-cmt-tally').textContent =
    `${openThreads().length} open on this page` + (siteTotal === null ? '' : ` · ${siteTotal} site-wide`);
  const list = m.querySelector('#kiln-cmt-list');
  list.textContent = '';
  if (!threads.length) {
    list.appendChild(h('p', 'kiln-dim', 'No comments here yet — “＋ New comment” drops a pin anywhere on the page.'));
    return;
  }
  const rerender = () => { if (m.isConnected) renderPanel(m); };
  const open = openThreads();
  for (const t of open) list.appendChild(threadCard(t, numOf(t, open), rerender));
  const done = threads.filter(t => t.status === 'resolved');
  if (done.length) {
    const det = h('details', 'kiln-cmt-resolved');
    det.appendChild(h('summary', '', `Resolved (${done.length})`));
    for (const t of done) det.appendChild(threadCard(t, null, rerender));
    list.appendChild(det);
  }
}

/**
 * One thread's card — used by both the panel and the pin popover.
 * Every user-supplied string (names, text) lands via textContent.
 */
function threadCard(t, num, rerender) {
  const card = h('div', 'kiln-cmt-thread' + (t.status === 'resolved' ? ' kiln-cmt-done' : ''));
  const head = h('div', 'kiln-cmt-head');
  if (num) head.appendChild(h('span', 'kiln-cmt-num', String(num)));
  const first = (t.messages || [])[0] || {};
  head.append(h('strong', '', first.by || 'someone'), h('small', '', relTime(first.ts || t.created)));
  card.appendChild(head);

  (t.messages || []).forEach((msg, i) => {
    const row = h('div', 'kiln-cmt-msg');
    if (i > 0) row.appendChild(h('small', 'kiln-cmt-meta', `${msg.by || 'someone'} · ${relTime(msg.ts)}`));
    row.appendChild(h('div', 'kiln-cmt-text', msg.text || ''));
    card.appendChild(row);
  });
  if (t.status === 'resolved' && t.resolved) {
    card.appendChild(h('small', 'kiln-cmt-meta', `Resolved by ${t.resolved.by || 'someone'} · ${relTime(t.resolved.ts)}`));
  }

  // An action's result updates local state, then every surface it touches.
  const act = async (el, did, fn, typed) => {
    el.disabled = true;
    try { await fn(); renderPins(); updateBadge(); rerender(); }
    catch (err) { console.error('[kiln] comment', err); say(err, did, notDone(`That was not ${did}.`, err), typed); el.disabled = false; }
  };
  const swap = (nt) => { threads = threads.map(x => (x.id === t.id ? nt : x)); };

  const reply = h('div', 'kiln-cmt-reply');
  const input = h('input');
  input.type = 'text';
  input.dataset.thread = t.id;   // typedComment() reads which thread a reply being written belongs to
  input.placeholder = `Reply as ${state.user}…`;
  const send = btn('kiln-btn-ghost', 'Reply', () => {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    act(send, 'posted', async () => {
      swap((await api('/comments', { path: pagePage, thread: t.id, text })).thread);
      if (replyBack?.thread === t.id) replyBack = null;
    // what is in the box now, for the dialog: the saved copy holds it, and it comes back to this thread
    }, () => (input.isConnected && input.value.trim() ? { name: TYPED.reply, text: input.value.trim(), keep: { where: 'reply', thread: t.id } } : null));
  });
  if (replyBack?.thread === t.id) {
    input.value = replyBack.text;
    input.addEventListener('input', () => { if (replyBack?.thread === t.id) replyBack.text = input.value; });
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send.click(); } });
  reply.append(input, send);
  card.appendChild(reply);

  const acts = h('div', 'kiln-cmt-acts');
  const res = btn('kiln-btn-ghost', t.status === 'open' ? 'Resolve ✓' : 'Reopen', () => act(res, 'changed', async () =>
    swap((await api('/comments/resolve', { path: pagePage, thread: t.id, resolved: t.status === 'open' })).thread)));
  acts.appendChild(res);
  if (isAdmin) {
    acts.appendChild(btn('kiln-btn-ghost kiln-cmt-del', 'Delete', function () {
      if (!confirm('Delete this comment thread for everyone?')) return;
      act(this, 'deleted', async () => {
        await api('/comments/delete', { path: pagePage, thread: t.id });
        threads = threads.filter(x => x.id !== t.id);
      });
    }));
  }
  card.appendChild(acts);
  return card;
}

// ─── Pin popover (click a pin) ───────────────────────────────────────────────

function closePopover() { if (popClose) { popClose(); popClose = null; } }

function openPopover(id, pinEl) {
  closePopover();
  const pop = h('div');
  pop.id = 'kiln-cmt-pop';
  pop.appendChild(btn('kiln-modal-x', '✕', closePopover));   // reuse the modal's close-chip look
  const fill = () => {
    pop.querySelector('.kiln-cmt-thread')?.remove();
    const cur = threads.find(v => v.id === id);
    if (!cur) { closePopover(); return; }
    pop.appendChild(threadCard(cur, numOf(cur, openThreads()), fill));
  };
  fill();
  document.body.appendChild(pop);
  const r = pinEl.getBoundingClientRect();
  place(pop, r.right + 10, r.top - 8);
  // A click in a dialog that is open over the popover is not a click away from it.
  const offClick = listen('click', (e) => { if (!pop.contains(e.target) && !(e.target instanceof Element && e.target.closest('#kiln-modal'))) closePopover(); });
  const offKey = listen('keydown', onEsc(closePopover));
  popClose = () => { offClick(); offKey(); pop.remove(); };
  pop.querySelector('.kiln-cmt-reply input')?.focus();
}

// ─── Pin placement ───────────────────────────────────────────────────────────

function enterPlaceMode() {
  if (placing || !ready) return;
  closePopover();
  const hint = h('div');
  hint.id = 'kiln-cmt-hint';
  hint.innerHTML = '<span>Click where you want the comment — <kbd>Esc</kbd> cancels</span>';  // static markup only
  hint.appendChild(btn('', 'Cancel', () => exitPlaceMode()));
  document.body.appendChild(hint);
  document.documentElement.classList.add('kiln-cmt-placing');
  const offClick = listen('click', (e) => {
    if (e.target instanceof Element && e.target.closest(chromeSel)) return;  // never pin to Kiln chrome
    e.preventDefault();
    e.stopPropagation();   // capture phase: the page never sees this click, so no edit starts
    const point = { x: e.clientX, y: e.clientY };
    const anchor = anchorFor(e.target, point);
    exitPlaceMode();
    openComposer(point, anchor);
  });
  const offKey = listen('keydown', onEsc(() => exitPlaceMode()));
  placing = () => {
    offClick();
    offKey();
    hint.remove();
    document.documentElement.classList.remove('kiln-cmt-placing');
  };
}

function exitPlaceMode() { if (placing) { placing(); placing = null; } }

/**
 * Anchor for a click: nearest [data-cms] ancestor → {key,x,y} — but only when
 * that element is the FIRST match for its key (keys repeat across blocks in a
 * list, and key anchors always resolve to the first). Otherwise a short CSS
 * selector → {sel,x,y}. x/y are % of the element's box. Null = panel-only.
 */
function anchorFor(target, point) {
  const pct = (v) => Math.max(0, Math.min(100, Math.round(v * 100) / 100));
  const rel = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: pct(((point.x - r.left) / r.width) * 100), y: pct(((point.y - r.top) / r.height) * 100) };
  };
  const el = target instanceof Element ? target : null;
  const host = el?.closest('[data-cms]');
  if (host) {
    const key = host.getAttribute('data-cms');
    try {
      if (key && key.length <= 200 && document.querySelector(`[data-cms="${CSS.escape(key)}"]`) === host) {
        const p = rel(host);
        if (p) return { key, ...p };
      }
    } catch { /* fall through to a selector anchor */ }
  }
  const sel = el && cssPath(el);
  const p = sel && rel(el);
  return p ? { sel, ...p } : null;
}

/** Shortest selector that uniquely finds `el` (≤200 chars), or null. */
function cssPath(el) {
  const seg = (n) => {
    const tag = n.tagName.toLowerCase();
    if (n.id) return `${tag}#${CSS.escape(n.id)}`;
    let s = tag;
    const cls = [...n.classList].find(c => !/^kiln-/.test(c) && /^[A-Za-z][\w-]*$/.test(c));
    if (cls) s += `.${cls}`;
    const sibs = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [];
    if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(n) + 1})`;
    return s;
  };
  const parts = [];
  for (let n = el; n && n !== document.body && n !== document.documentElement && parts.length < 6; n = n.parentElement) {
    parts.unshift(seg(n));
    const sel = parts.join(' > ');
    if (sel.length > 200) return null;
    try { if (document.querySelector(sel) === el) return sel; } catch { return null; }
    if (n.id) break;   // an id segment is as absolute as it gets — don't climb past it
  }
  return null;
}

// ─── Composer (new thread at a pin) ──────────────────────────────────────────

let composerAnchor = null;   // where the comment being written is pinned (null: nowhere in particular)

/**
 * A comment or a reply that is being written right now, wherever its box is
 * (the composer, the panel, a pin's popover), as main.js's stopped() takes it:
 * { name, text, keep }. null when nothing is. For a sign-in that is found to
 * have ended by something other than Post or Reply.
 */
export function typedComment() {
  const ta = document.querySelector('#kiln-cmt-composer textarea');
  if (ta && ta.value.trim()) return { name: TYPED.comment, text: ta.value.trim(), keep: { where: 'comment', ...(composerAnchor && { anchor: composerAnchor }) } };
  for (const input of document.querySelectorAll('.kiln-cmt-reply input')) {
    if (input.value.trim() && input.dataset.thread) return { name: TYPED.reply, text: input.value.trim(), keep: { where: 'reply', thread: input.dataset.thread } };
  }
  return null;
}

/**
 * After signing in again: put a comment or a reply that was being written
 * back where it was (the saved copy's `typed`, through main.js). A comment
 * opens its box at the place it was pinned to; a reply opens the panel with
 * the words in that thread's box.
 */
export function resumeComment(typed) {
  if (!ready) return;
  if (typed.where === 'reply') {
    replyBack = { thread: typed.thread, text: typed.text };
    openComments();
    return;
  }
  const target = resolveAnchor(typed.anchor);
  let point = { x: innerWidth / 2, y: innerHeight / 3 };
  if (target) {
    target.scrollIntoView({ block: 'center' });
    const r = target.getBoundingClientRect();
    const a = typed.anchor;
    point = { x: r.left + r.width * ((typeof a.x === 'number' ? a.x : 50) / 100), y: r.top + r.height * ((typeof a.y === 'number' ? a.y : 0) / 100) };
  }
  openComposer(point, target ? typed.anchor : null, typed.text);
}

function openComposer(point, anchor, text = '') {
  document.getElementById('kiln-cmt-composer')?.remove();
  composerAnchor = anchor || null;
  const ghost = h('div', 'kiln-cmt-pin kiln-cmt-ghost', '＋');
  ghost.style.left = `${point.x}px`;
  ghost.style.top = `${point.y}px`;
  layer.appendChild(ghost);
  const box = h('div');
  box.id = 'kiln-cmt-composer';
  const ta = h('textarea');
  ta.maxLength = 4000;
  ta.placeholder = 'Leave a comment…';
  ta.value = text;
  const close = () => { box.remove(); ghost.remove(); offKey(); };
  const offKey = listen('keydown', onEsc(close));
  const post = btn('kiln-btn-publish', 'Post', async () => {
    const text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    post.disabled = true;
    try {
      const data = await api('/comments', { path: pagePage, text, ...(anchor && { anchor }) });
      threads = [data.thread, ...threads];
      close();
      renderPins();
      updateBadge();
      status('Comment posted ✓', 'saved');
    } catch (err) {
      post.disabled = false;
      // what is in the box now, for the dialog: the saved copy holds it with the place it is pinned to
      console.error('[kiln] comment', err);
      say(err, 'posted', notDone('Your comment was not posted.', err), () => (ta.isConnected && ta.value.trim()
        ? { name: TYPED.comment, text: ta.value.trim(), keep: { where: 'comment', ...(anchor && { anchor }) } } : null));
    }
  });
  const row = h('div', 'kiln-cmt-acts');
  row.append(post, btn('kiln-btn-ghost', 'Cancel', close));
  box.append(ta, h('small', 'kiln-cmt-as', `Commenting as ${state.user}`), row);
  document.body.appendChild(box);
  place(box, point.x + 16, point.y - 10);
  ta.focus();
}
