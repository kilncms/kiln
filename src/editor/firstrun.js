/**
 * The first minute of editing.
 *
 * Small pure helpers behind the always-visible Publish button, plus the
 * three-step guide the public demo shows a first-time visitor (sandbox mode
 * only): click a heading and type → publish it → "That was a Git commit".
 *
 * Editor chrome only — main.js hands its seams in via initGuide(deps), the
 * same pattern as palette.js and suggest.js. Everything the guide shows that
 * came from the page goes through textContent, never innerHTML.
 */

/** Label for a Publish control: "Publish", "Publish 1 edit", "Publish 3 edits". */
export function publishLabel(n, { suggest = false } = {}) {
  if (suggest) return 'Suggest changes';
  return n > 0 ? `Publish ${n} edit${n > 1 ? 's' : ''}` : 'Publish';
}

/** The commit message a page publish gets; `keys` are the edited fields, in order. */
export function editCommitMessage(path, keys) {
  return `Edit ${path}: ${keys.join(', ')} (via Kiln)`;
}

/**
 * Which guide step to show: 1 (make an edit), 2 (publish it), 3 (what just
 * happened), or 0 for nothing. Derived from the page's state rather than
 * counted, so undoing the only edit steps back to 1.
 */
export function guideStep({ done = false, published = false, unpublished = 0 } = {}) {
  if (done) return 0;
  if (published) return 3;
  return unpublished > 0 ? 2 : 1;
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Two texts cut down to the part that differs, for a before/after pair. Short
 * texts come back whole. Long ones (a whole list of cards where one price
 * changed) keep the changed words plus a little of what surrounds them, cut
 * at word boundaries and marked with "…".
 */
export function diffSnippet(before, after, max = 90) {
  const a = squash(before), b = squash(after);
  if (a.length <= max && b.length <= max) return { before: a, after: b };
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // Widen the window to whole words, then by a few words of context each side.
  const context = Math.max(12, Math.floor(max / 4));
  const wordStart = (text, i) => { const j = text.lastIndexOf(' ', Math.max(0, i - 1)); return j === -1 ? 0 : j + 1; };
  const wordEnd = (text, i) => { const j = text.indexOf(' ', i); return j === -1 ? text.length : j; };
  const from = wordStart(a, Math.max(0, wordStart(a, p) - context));
  const cut = (text) => {
    const to = wordEnd(text, Math.min(text.length, wordEnd(text, text.length - s) + context));
    let out = text.slice(from, to);
    if (out.length > max) out = out.slice(0, wordStart(out, max) || max).trimEnd() + '…';
    else if (to < text.length) out += '…';
    return (from > 0 ? '…' : '') + out;
  };
  return { before: cut(a), after: cut(b) };
}

/**
 * Where a tip goes so it points at `target` without leaving the view.
 * All boxes are { left, top, width, height } in the same coordinate space;
 * `view` is the space the tip must stay inside. Returns the tip's left/top,
 * which side of the target it landed on, and how far along the tip its arrow
 * sits so the arrow still points at the target after the tip was nudged.
 */
export function placeTip(target, tip, view, { gap = 12, margin = 8, prefer = 'below' } = {}) {
  const roomBelow = target.top + target.height + gap + tip.height <= view.top + view.height - margin;
  const roomAbove = target.top - gap - tip.height >= view.top + margin;
  const side = prefer === 'above' ? (roomAbove || !roomBelow ? 'above' : 'below') : (roomBelow || !roomAbove ? 'below' : 'above');
  const top = side === 'below' ? target.top + target.height + gap : target.top - gap - tip.height;
  const centre = target.left + target.width / 2;
  const maxLeft = Math.max(view.left + margin, view.left + view.width - tip.width - margin);
  const left = Math.min(Math.max(centre - tip.width / 2, view.left + margin), maxLeft);
  const arrow = Math.min(Math.max(centre - left, 18), Math.max(18, tip.width - 18));
  return { left, top, side, arrow };
}

/**
 * Which side of the heading the first tip takes. `top` and `height` are the
 * heading's box on screen. Kiln's fixed chrome (the pencil, its buttons, the
 * demo banner) occupies a strip along the bottom of the screen: a tip under a
 * heading that sits low on the screen would land on it.
 */
export function sideForHeading(top, height, tipHeight, viewHeight, { gap = 12, strip = 96, head = 64 } = {}) {
  const fitsBelow = top + height + gap + tipHeight <= viewHeight - strip;
  const fitsAbove = top - gap - tipHeight >= head;
  return fitsBelow || !fitsAbove ? 'below' : 'above';
}

// ─── The demo guide (sandbox only) ───────────────────────────────────────────

const GUIDE_KEY = 'kiln_guide';
const START_URL = 'https://kilncms.com/get-started.html';

let deps = null;        // { cfg, mobileMq, unpublished(), publishButton() }
let done = false;       // skipped or finished: nothing more on this page load
let published = null;   // { before, after, message } once the visitor has published
let tip = null;         // the step 1 / step 2 bubble
let tipStep = 0;

/**
 * Start the guide. In the public demo (cfg.sandbox), and for an invited
 * editor's first session on a real site (d.audience === 'editor'); never for
 * the owner. Only the first time this browser sees it: someone who has had
 * the tour is not walked through it again on the next page.
 */
export function initGuide(d) {
  if (deps || !d || !d.cfg || (d.cfg.sandbox !== true && d.audience !== 'editor')) return;
  try { if (localStorage.getItem(GUIDE_KEY)) return; } catch { /* storage blocked: show it, it just can't be remembered */ }
  deps = d;
  const st = document.createElement('style');
  st.setAttribute('data-kiln', '1');
  st.textContent = guideCss(d.mobileMq);
  document.head.appendChild(st);
  window.addEventListener('resize', placeGuideTip);
  // The heading moves when anything above it changes height (images loading,
  // an edit that wraps onto another line): follow it.
  if (typeof ResizeObserver === 'function') new ResizeObserver(placeGuideTip).observe(document.documentElement);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('kiln-guide-card')) finish();
  });
  guideSync();
}

/** Re-read the page's state and show the step that fits it. Safe to call any time. */
export function guideSync() {
  if (!deps) return;
  const step = guideStep({ done, published: !!published, unpublished: deps.unpublished() });
  if (step === 3) { removeTip(); showCard(); return; }
  if (step === 0) { removeTip(); return; }
  const target = step === 1 ? firstHeading() : deps.publishButton();
  if (!target || !target.getClientRects().length) { removeTip(); return; }
  showTip(step, target);
}

/** True while the guide is waiting to hear that the person has published. */
export function guideWaiting() {
  return !!deps && !done && !published;
}

/** The visitor published: `info` is { before, after, message } for the last card. */
export function guidePublished(info) {
  if (!deps || done || published) return;
  published = info;
  guideSync();
}

function finish() {
  done = true;
  removeTip();
  document.getElementById('kiln-guide-card')?.remove();
}

function removeTip() {
  tip?.remove();
  tip = null;
  tipStep = 0;
}

/** The first heading on the page a visitor can edit (any first field, failing that). */
function firstHeading() {
  const fields = [...document.querySelectorAll('.kiln-field:not(img)')].filter(el => el.getClientRects().length);
  return fields.find(el => /^H[1-3]$/.test(el.tagName)) || fields[0] || null;
}

function showTip(step, target) {
  // Step 2 follows Publish into the sheet that shows what will change.
  const inSheet = step === 2 && !!target.closest('#kiln-modal');
  if (!tip || tipStep !== step || tip._inSheet !== inSheet) {
    removeTip();
    tip = document.createElement('div');
    tip.id = 'kiln-guide';
    tip.setAttribute('role', 'status');
    const text = document.createElement('span');
    // A phone has no click.
    const touch = window.matchMedia('(hover: none)').matches;
    text.textContent = step === 1 ? (touch ? 'Tap this and type.' : 'Click this and type.')
      : inSheet ? 'This is what changes. Publish it.' : 'Now publish it.';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'kiln-guide-skip';
    skip.textContent = 'Skip';
    skip.setAttribute('aria-label', 'Skip the guide');
    skip.addEventListener('click', (e) => { e.stopPropagation(); finish(); });
    const arrow = document.createElement('i');
    arrow.className = 'kiln-guide-arrow';
    tip.append(text, skip, arrow);
    document.body.appendChild(tip);
    tipStep = step;
    tip._inSheet = inSheet;
    tip.style.zIndex = inSheet ? '10000001' : '';
    // the sheet makes room above its buttons, so the tip covers none of it
    if (inSheet) target.closest('#kiln-modal').classList.add('kiln-guided');
    try { localStorage.setItem(GUIDE_KEY, '1'); } catch { /* storage blocked */ }
  }
  tip._target = target;
  placeGuideTip();
}

function placeGuideTip() {
  if (!tip || !tip._target || !tip._target.isConnected) return;
  const r = tip._target.getBoundingClientRect();
  if (!r.width && !r.height) return;
  // Step 1 rides the page (it scrolls with the heading); step 2 rides the
  // screen, like the button it points at.
  const fixed = tipStep === 2;
  tip.style.position = fixed ? 'fixed' : 'absolute';
  const doc = document.documentElement;
  const sx = fixed ? 0 : window.scrollX, sy = fixed ? 0 : window.scrollY;
  const view = fixed
    ? { left: 0, top: 0, width: doc.clientWidth, height: window.innerHeight }
    : { left: 0, top: 0, width: doc.clientWidth, height: Math.max(doc.scrollHeight, window.innerHeight) };
  // Step 2 sits above the Publish button. Step 1 goes under the heading unless
  // that would land it in the strip along the bottom of the screen where the
  // pencil, its buttons and the demo banner live; then it goes above instead.
  const below = fixed ? false : sideForHeading(r.top, r.height, tip.offsetHeight, window.innerHeight) === 'below';
  const pos = placeTip({ left: r.left + sx, top: r.top + sy, width: r.width, height: r.height },
    { width: tip.offsetWidth, height: tip.offsetHeight }, view, { prefer: below ? 'below' : 'above' });
  tip.style.left = `${Math.round(pos.left)}px`;
  tip.style.top = `${Math.round(pos.top)}px`;
  tip.className = `kiln-guide--${pos.side}`;
  tip.style.setProperty('--kiln-guide-arrow', `${Math.round(pos.arrow)}px`);
}

function showCard() {
  if (document.getElementById('kiln-guide-card')) return;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const card = el('div');
  card.id = 'kiln-guide-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-labelledby', 'kiln-guide-title');
  // An invited editor on a real site is told what happened to their change,
  // not what Git is or where to get Kiln.
  const invited = deps.audience === 'editor';
  const title = el('h3', null, invited ? 'That is published' : 'That was a Git commit');
  title.id = 'kiln-guide-title';
  const sub = el('p', 'kiln-guide-sub', invited
    ? 'Your change is saved to the site and goes live in about a minute. For ten seconds you can undo it, and every version is kept, so nothing is lost for good.'
    : 'A commit is a saved change with a note. On your own site, Kiln saves each edit to your GitHub repo this way, and your host puts it live in about a minute.');
  const diff = el('div', 'kiln-guide-diff');
  const snip = diffSnippet(published.before, published.after);
  diff.append(el('span', 'kiln-guide-label', 'Before'), el('span', 'kiln-guide-before', snip.before || '(empty)'),
    el('span', 'kiln-guide-label', 'After'), el('span', 'kiln-guide-after', snip.after || '(empty)'));
  const msg = el('div', 'kiln-guide-msg');
  msg.append(el('span', 'kiln-guide-label', 'Commit message'), el('code', null, published.message));
  const acts = el('div', 'kiln-guide-acts');
  const go = el('a', invited ? 'kiln-btn-ghost' : 'kiln-btn-publish', invited ? 'Read the guide' : 'Put Kiln on my site');
  go.href = invited ? (deps.guideUrl || 'https://kilncms.com/editors') : START_URL;
  go.target = '_blank';
  go.rel = 'noopener';
  go.addEventListener('click', finish);
  const stay = el('button', invited ? 'kiln-btn-publish' : 'kiln-btn-ghost', invited ? 'Got it' : 'Keep exploring');
  stay.type = 'button';
  stay.addEventListener('click', finish);
  if (invited) { acts.append(stay, go); card.append(title, sub, diff, acts); }
  else { acts.append(go, stay); card.append(title, sub, diff, msg, acts); }
  document.body.appendChild(card);
  stay.focus({ preventScroll: true });
}

function guideCss(mobileMq) {
  return `
#kiln-guide{z-index:999997;display:flex;align-items:center;gap:10px;box-sizing:border-box;max-width:calc(100vw - 16px);
  background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);color:#fff;
  font:600 13.5px/1.3 var(--kiln-font);padding:8px 8px 8px 15px;border-radius:999px;white-space:nowrap;
  border:1px solid rgba(255,255,255,.09);box-shadow:0 10px 32px rgba(0,0,0,.35);animation:kilnguidein .25s ease}
@keyframes kilnguidein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.kiln-guide-skip{background:rgba(255,255,255,.08);color:#d6d8e1;border:none;border-radius:999px;padding:5px 12px;
  font:600 12px var(--kiln-font);cursor:pointer}
.kiln-guide-skip:hover,.kiln-guide-skip:focus-visible{background:rgba(255,255,255,.18);color:#fff}
.kiln-guide-arrow{position:absolute;left:var(--kiln-guide-arrow,50%);width:12px;height:12px;margin-left:-6px;
  background:rgb(16,16,25);transform:rotate(45deg);border:1px solid rgba(255,255,255,.09)}
.kiln-guide--below .kiln-guide-arrow{top:-6px;border-right:none;border-bottom:none}
.kiln-guide--above .kiln-guide-arrow{bottom:-6px;border-left:none;border-top:none}
/* A field's toolbar or the menu owns the screen while it is open. */
.kiln-tb-open #kiln-guide,.kiln-menu-open #kiln-guide{display:none}
#kiln-guide-card{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:9999990;box-sizing:border-box;
  width:min(410px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow-y:auto;background:var(--kiln-bg);
  -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);color:#d6d8e1;font:13.5px/1.5 var(--kiln-font);
  padding:20px;border-radius:16px;border:1px solid rgba(255,255,255,.09);box-shadow:0 18px 50px rgba(0,0,0,.4);
  text-align:left;animation:kilnguidecard .25s ease}
@keyframes kilnguidecard{from{opacity:0}to{opacity:1}}
#kiln-guide-card h3{margin:0 0 6px;font:700 17px/1.3 var(--kiln-font);letter-spacing:-.01em;color:#fff}
.kiln-guide-sub{margin:0 0 14px;color:#9ca3af;font-size:13px;line-height:1.5}
.kiln-guide-diff{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:baseline;margin:0 0 12px}
.kiln-guide-label{font:600 9.5px var(--kiln-font);letter-spacing:.09em;text-transform:uppercase;color:#9ca3af;white-space:nowrap}
.kiln-guide-before{color:#9ca3af;text-decoration:line-through;overflow-wrap:anywhere}
.kiln-guide-after{color:#fff;font-weight:600;overflow-wrap:anywhere}
.kiln-guide-msg{display:flex;flex-direction:column;gap:5px;margin:0 0 16px}
.kiln-guide-msg code{display:block;background:rgba(255,255,255,.08);color:#d6d8e1;border-radius:9px;padding:9px 11px;
  font:12px/1.45 ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
.kiln-guide-acts{display:flex;flex-wrap:wrap;gap:8px}
#kiln-guide-card a.kiln-btn-publish{display:inline-flex;align-items:center;color:#fff;text-decoration:none}
#kiln-guide-card a.kiln-btn-ghost{display:inline-flex;align-items:center;text-decoration:none}
#kiln-guide-card .kiln-btn-publish,#kiln-guide-card .kiln-btn-ghost{font-size:13px;padding:8px 16px}
@media (prefers-reduced-motion: reduce){#kiln-guide,#kiln-guide-card{animation:none}}
@media ${mobileMq}{
#kiln-guide{font-size:14.5px;padding:7px 7px 7px 16px}
.kiln-guide-skip{min-height:36px;padding:5px 14px;font-size:13px}
#kiln-guide-card .kiln-btn-publish,#kiln-guide-card .kiln-btn-ghost{min-height:44px;font-size:14px;flex:1 1 auto;justify-content:center}
}`;
}
