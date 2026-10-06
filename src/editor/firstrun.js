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
import { undoMessage } from './undo-publish.js';

/** Label for a Publish control: "Publish", "Publish 1 edit", "Publish 3 edits". */
export function publishLabel(n, { suggest = false } = {}) {
  if (suggest) return 'Suggest changes';
  return n > 0 ? `Publish ${n} edit${n > 1 ? 's' : ''}` : 'Publish';
}

/**
 * The status line while a publish is on its way to the site. The publish
 * itself has already been confirmed ("Published. Undo"), so this must not go
 * back to saying "Publishing": what is still happening is the host building.
 * `waiting` are the journal entries not yet seen on the site ({ desc }).
 */
export function goingLiveLabel(waiting) {
  const what = waiting.length === 1 ? `“${waiting[0].desc}” is` : `${waiting.length} changes are`;
  return `${what} going live… usually under a minute`;
}

/** The commit message a page publish gets; `keys` are the edited fields, in order. */
export function editCommitMessage(path, keys) {
  return `Edit ${path}: ${keys.join(', ')} (via Kiln)`;
}

/**
 * Which guide step to show: 1 (make an edit), 2 (publish it), 3 (what just
 * happened), or 0 for nothing. Derived from the page's state rather than
 * counted, so undoing the only edit steps back to 1.
 *
 * `undone` is a publish taken back with Undo. The last card then says the
 * edit is back, not published, and stays only while that is true: once the
 * edit is published again or dropped, the guide is over.
 */
export function guideStep({ done = false, published = false, undone = false, unpublished = 0 } = {}) {
  if (done) return 0;
  if (published && undone) return unpublished > 0 ? 3 : 0;
  if (published) return 3;
  return unpublished > 0 ? 2 : 1;
}

/**
 * What the last card says. After a publish: what was just saved. After Undo
 * took that publish back: that the edit is on the page again, not published.
 * `invited` is an editor on a real site, who is told what happened to their
 * change, not what Git is or where to get Kiln. `diff` is whether the card
 * shows the before and after texts; `message` is the commit message it shows,
 * or null for none. `edits` is how many edits Undo brought back.
 */
export function guideCardCopy({ invited = false, undone = false, edits = 1, message = '' } = {}) {
  if (undone) {
    const many = edits > 1;
    const title = many ? 'Your edits are back, not published' : 'Your edit is back, not published';
    return invited
      ? { title, diff: false, message: null,
        sub: many ? 'Undo took that publish back. Your changes are on this page again, and you can publish them when they are ready.'
          : 'Undo took that publish back. Your change is on this page again, and you can publish it when it is ready.' }
      : { title, diff: false, message: undoMessage(message),
        sub: 'Undo took that publish back. On your own site, Undo is one more commit that puts the page as it was, so both versions stay in the history.' };
  }
  return invited
    ? { title: 'That is published', diff: true, message: null,
      sub: 'Your change is saved to the site and goes live in about a minute. For ten seconds you can undo it, and every version is kept, so nothing is lost for good.' }
    : { title: 'That was a Git commit', diff: true, message,
      sub: 'A commit is a saved change with a note. On your own site, Kiln saves each edit to your GitHub repo this way, and your host puts it live in about a minute.' };
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
 *
 * `blocked` says whether the tip would lie on something of the page's own to
 * press (a button, a link) on each side: { below, above }. Right under a
 * heading is where a page keeps its buttons, so the tip goes above when that
 * side is free.
 */
export function sideForHeading(top, height, tipHeight, viewHeight, { gap = 12, strip = 96, head = 64, blocked = {} } = {}) {
  const fitsBelow = top + height + gap + tipHeight <= viewHeight - strip;
  const fitsAbove = top - gap - tipHeight >= head;
  if (fitsBelow && !(blocked.below && fitsAbove && !blocked.above)) return 'below';
  return fitsAbove ? 'above' : 'below';
}

// ─── The demo guide (sandbox only) ───────────────────────────────────────────

const GUIDE_KEY = 'kiln_guide';
const START_URL = 'https://kilncms.com/get-started.html';

let deps = null;        // { cfg, mobileMq, unpublished(), publishButton() }
let done = false;       // skipped or finished: nothing more on this page load
let published = null;   // { before, after, message } once the visitor has published
let undone = 0;         // …and then took that publish back with Undo: how many edits came back
let tip = null;         // the step 1 / step 2 bubble
let tipStep = 0;
let cardTimer = null;   // the last card puts itself away after a while

/** How long the last card stays when nobody touches it. Long enough to read twice. */
export const CARD_STAYS = 20000;

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
  // A page's own fade-ins move things without changing its size: a button
  // that slides up as it appears can end under a tip that was placed while it
  // was still on its way. The tip is looked at again while the page settles
  // (settleTip), and whenever one of the page's own transitions ends.
  document.addEventListener('transitionend', settleTip, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('kiln-guide-card')) finish();
  });
  guideSync();
}

/** Re-read the page's state and show the step that fits it. Safe to call any time. */
export function guideSync() {
  if (!deps) return;
  const step = guideStep({ done, published: !!published, undone: undone > 0, unpublished: deps.unpublished() });
  if (step === 3) { removeTip(); showCard(); return; }
  if (step === 0) { finish(); return; }
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

/**
 * Undo took that publish back. The card must stop saying it happened: it now
 * says the edit is on the page again, not published.
 */
export function guideUndone(edits = 1) {
  if (!deps || done || !published || undone) return;
  undone = Math.max(1, edits);
  guideSync();
}

function finish() {
  done = true;
  clearTimeout(cardTimer);
  removeTip();
  document.getElementById('kiln-guide-card')?.remove();
}

/**
 * The last card says what happened and then gets out of the way: it used to
 * sit over the page until someone dismissed it. A pointer moving over it
 * means it is being read, and it waits a little longer. (A pointer resting
 * where it last clicked says nothing: the card opens right under it.)
 */
function closeCardLater(card, wait = CARD_STAYS) {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => {
    if (!card.isConnected) return;
    if (Date.now() - (card._kilnMoved || 0) < 5000) closeCardLater(card, 5000); else finish();
  }, wait);
}

function removeTip() {
  tip?._seen?.disconnect();
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
  const moved = tip._target !== target;
  tip._target = target;
  placeGuideTip();
  if (moved) {
    settleTip();
    // …and when the heading comes onto the screen, where the things around it start to fade in
    if (tipStep === 1 && typeof IntersectionObserver === 'function') {
      tip._seen?.disconnect();
      tip._seen = new IntersectionObserver((seen) => { if (seen.some(e => e.isIntersecting)) settleTip(); });
      tip._seen.observe(target);
    }
  }
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
  const below = fixed ? false : sideForHeading(r.top, r.height, tip.offsetHeight, window.innerHeight, { blocked: pressable(r) }) === 'below';
  const pos = placeTip({ left: r.left + sx, top: r.top + sy, width: r.width, height: r.height },
    { width: tip.offsetWidth, height: tip.offsetHeight }, view, { prefer: below ? 'below' : 'above' });
  tip.style.left = `${Math.round(pos.left)}px`;
  tip.style.top = `${Math.round(pos.top)}px`;
  tip.className = `kiln-guide--${pos.side}`;
  tip.style.setProperty('--kiln-guide-arrow', `${Math.round(pos.arrow)}px`);
}

/**
 * Whether the tip, put under or over the heading at `r`, would lie on
 * something of the page's own that is there to be pressed.
 */
function pressable(r, gap = 12) {
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const centre = r.left + r.width / 2;
  const left = Math.min(Math.max(centre - w / 2, 8), Math.max(8, document.documentElement.clientWidth - w - 8));
  const things = [...document.querySelectorAll('a[href], button, [role="button"], input, select, textarea, summary')]
    .filter(el => !el.closest('[id^="kiln-"], .kiln-item-ctl, .kiln-repeat-add, .kiln-block-gap') && !el.contains(tip._target) && !tip._target.contains(el))
    .map(el => el.getBoundingClientRect()).filter(b => b.width && b.height);
  const on = (top) => things.some(b => b.bottom > top && b.top < top + h && b.right > left && b.left < left + w);
  return { below: on(r.bottom + gap), above: on(r.top - gap - h) };
}

/** Look at the tip's place again a few times over the next seconds: once is not enough on a page that is still moving. */
let settling = [];
function settleTip() {
  settling.forEach(clearTimeout);
  settling = [120, 500, 1100, 2200].map(ms => setTimeout(placeGuideTip, ms));
}

function showCard() {
  const kind = undone ? 'undone' : 'published';
  let card = document.getElementById('kiln-guide-card');
  if (card && card.dataset.kind === kind) return;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const fresh = !card;
  if (fresh) {
    card = el('div');
    card.addEventListener('pointermove', () => { card._kilnMoved = Date.now(); });
    card.id = 'kiln-guide-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'kiln-guide-title');
  }
  card.dataset.kind = kind;
  const invited = deps.audience === 'editor';
  const copy = guideCardCopy({ invited, undone: undone > 0, edits: undone, message: published.message });
  const title = el('h3', null, copy.title);
  title.id = 'kiln-guide-title';
  const parts = [title, el('p', 'kiln-guide-sub', copy.sub)];
  if (copy.diff) {
    const diff = el('div', 'kiln-guide-diff');
    const snip = diffSnippet(published.before, published.after);
    diff.append(el('span', 'kiln-guide-label', 'Before'), el('span', 'kiln-guide-before', snip.before || '(empty)'),
      el('span', 'kiln-guide-label', 'After'), el('span', 'kiln-guide-after', snip.after || '(empty)'));
    parts.push(diff);
  }
  if (copy.message) {
    const msg = el('div', 'kiln-guide-msg');
    msg.append(el('span', 'kiln-guide-label', 'Commit message'), el('code', null, copy.message));
    parts.push(msg);
  }
  const acts = el('div', 'kiln-guide-acts');
  const go = el('a', invited ? 'kiln-btn-ghost' : 'kiln-btn-publish', invited ? 'Read the guide' : 'Put Kiln on my site');
  go.href = invited ? (deps.guideUrl || 'https://kilncms.com/editors') : START_URL;
  go.target = '_blank';
  go.rel = 'noopener';
  go.addEventListener('click', finish);
  const stay = el('button', invited ? 'kiln-btn-publish' : 'kiln-btn-ghost', invited ? 'Got it' : 'Keep exploring');
  stay.type = 'button';
  stay.addEventListener('click', finish);
  if (invited) acts.append(stay, go); else acts.append(go, stay);
  parts.push(acts);
  card.replaceChildren(...parts);
  if (fresh) document.body.appendChild(card);
  stay.focus({ preventScroll: true });
  closeCardLater(card);
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
