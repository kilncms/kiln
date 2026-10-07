/**
 * kiln-editor — loaded only for authenticated admins and invited editors.
 *
 * Admin mode:  GitHub App user token, browser → api.github.com directly.
 * Editor mode: invited-editor (Google) session, browser → kiln-auth worker /gh/* proxy
 *              (the worker holds the installation token; no GitHub account needed).
 *
 * The page's HTML file in the repo is the source of truth. Edits are spliced
 * into the raw file at parse5 source offsets and committed; the host rebuilds.
 */

import DOMPurify from 'dompurify';
import { indexHtml, applyEdits, pageFileCandidates, editHead, readHead, readValues, findNthTag, annotateNthTag, appendIntoNthTag, insertAfterNthTag, removeAnnotations, removeKilnSection } from '../engine.js';
import {
  makeGh, getFile, resolvePageFile, editFile, putFile, putBinaryFile, commitFiles, deployState,
} from '../github.js';
import { SOURCE_ATTR, parseSourceRef } from '../adapters/pointer.js';
import { uploadProblem, fileRefusalText, UPLOAD_MAX_BYTES, FILE_MESSAGES } from '../file-policy.js';
import { generatorSignals } from '../adapters/detect.js';
import {
  scanSourceRefs, groupSourceEdits, matchAppliedRefs, matchSkippedRefs, resolveBuildState,
  revertRequest, parseSourceCapabilities, saveSummary, friendlyRef, STILL_BUILDING_COPY,
  sourceLabel, typedValue, keptText, typeHint, isBody, plainBody, lockReason, skipSentence, refusalSentence,
  readAs, changedRefs, theirsText, theirsOrMine, isMarkdownField,
  SAVED_BUILDING_COPY, BUILD_FAILED_COPY, BUILD_WATCH_MS, buildRecord, buildStanding, resumePlan,
} from './source-fields.js';
import {
  prepare as richPrepare, plan as richPlan, prepSentence, planSentence, keepSentence, sheetWords, KEEP_ATTR,
} from './source-rich.js';
import { initPalette, openPalette } from './palette.js';
import { builtPages } from './site-pages.js';
import { initSuggest, suggestChanges, sendSuggestion, suggestionsPanel, sharePreviewPanel, refreshSuggestBadge } from './suggest.js';
import { initTheme, openThemePanel } from './theme.js';
import { initComments, openComments, commentsTick, resumeComment, typedComment } from './comments.js';
import { initAssist, openAssistMenu, assistAltText, draftFill } from './assist.js';
import { initBlocks } from './blocks.js';
import { publishLabel, editCommitMessage, goingLiveLabel, initGuide, guideSync, guidePublished, guideUndone, guideWaiting, START_URL, START_LABEL } from './firstrun.js';
import { revertPublish, publishRecord, restage } from './undo-publish.js';
import { latestStamp, isStale, UPDATE_COMMAND } from './update-check.js';
import { hasGrant, offersMakeEditable, helpUrl, startLine } from './grants.js';
import { keepFile, forgetFiles, keptFiles, filesToRestore, siteAddress, syncPlan } from './pending-files.js';
import { openImagePicker, chooseSiteImage, clearImageCache, imagePickerCss } from './image-picker.js';
import { openPublishSheet, publishSheetCss, previewOff, setPreviewOff, noteMessage, listChanges, countChanges, plainText,
  imageSources, linkProblems, itemWarnings } from './publish-sheet.js';
import { draftRecord, readDraft, draftHolds, TYPED } from './saved-edits.js';
import { onLoadFailure, endedNotice, signInUrl, readFailure, whatSurvives, publishEnded, publishRefused, publishTrouble, readRefused, editsAsText, backAfterSignIn } from './sign-in-ended.js';
import { makeAsk } from './worker-call.js';
import { writeBlocks, keepAside, forgetBlocks } from './keep-blocks.js';
import { noteList, noteCopy, fileTrue, noteInside, noteAs, beginInside, settleInside, insideAsFile, asFileHtml,
  beginOn, endOn, ownStyle, settleOn, showStyle } from './file-state.js';
import { writeInside, rememberInside } from './keep-inside.js';
import { takeBase, readAttrs } from './baselines.js';
import { notDone, whyNot, said } from './plain-failure.js';
import { plainName, readableName } from './names.js';
import { linkDialogCopy, LINK_NEEDS_WORDS } from './link-dialog.js';
import { askFirst, askWhich, ownDialogCopy } from './own-dialogs.js';
import { coverBottom, isUnder, isSiteBar } from './under-bar.js';
import { whereTo } from './in-view.js';
import { findTwin, notHereWords } from './not-here.js';
import { missingEvent, missingPerson, scheduleTitle, pickBarWords, removedHold, PEOPLE_WORDS, tooBigForDemo, headingVars, ADDED_CSS } from './first-edits.js';
import { demoSays, demoShort, DEMO_DRAFT_SAVED, DEMO_HISTORY_EMPTY, DEMO_HISTORY_NOTE,
  historyEntry, withEntry, undoChanges, goBackChanges, partVersions, hasPublished } from './tryout.js';

const cfg = window.KILN || {};
const mode = window.__KILN_MODE || 'admin';
const ADMIN_KEY = 'kiln_admin';
const EDITOR_KEY = 'kiln_editor';
const PAUSE_KEY = 'kiln_pause';
// Declared here (not beside the sandbox helpers below) so they are initialized
// before init() runs at module load — initSandbox reads them synchronously.
const SANDBOX_KEY = 'kiln_sandbox';
const SANDBOX_TTL = 24 * 3600 * 1000;
const SANDBOX_FULL = 'This browser has no room left for the demo. Drop a picture you have added, or press “Start over” to clear it.';
const UNDO_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.6-8.4L3 7"/></svg>';
// Phone-first chrome: ONE media query decides "phone" — shared verbatim by the
// CSS in injectStyles() and the few JS behavior forks (menu/toolbar positioning,
// FAB + toolbar dragging). Declared above the init() call because esbuild hoists
// const→var, so anything read during boot must already be initialized.
const MOBILE_MQ = '(max-width: 700px), (pointer: coarse) and (max-width: 820px)';
function isMobileEditor() { return window.matchMedia(MOBILE_MQ).matches; }
/** A screen that is touched, with no pointer to hover and most likely no keyboard. */
function isTouch() { return window.matchMedia('(hover: none)').matches; }
// True once the pencil and the status line exist (declared up here for the same reason).
let chromeDrawn = false;
// Settled once "Pick up where you left off?" has been answered or put away
// (at once when there is nothing to ask). A saved draft is offered after it,
// never over it: the second question used to take the first one's place, and
// the edits it was asking about were then lost with the next change.
let restoreAsked = Promise.resolve();
// Fields that already have their click handler. A list that is written again
// keeps the blocks it had (keep-blocks.js), and those must not get a second one.
const decorated = new WeakSet();
// Keys History is showing an earlier version of, not yet kept: the page is not their baseline.
const previewing = new Set();
// Try-out mode: this page had nothing stored when it opened, so there is nothing an earlier editor left to mend.
let sandboxWasEmpty = false;
// The status line's timer. Declared up here because the demo draws its first
// line while this module is still being read: declared further down, the
// timer of that first line was forgotten when the declaration was reached, and
// went off four seconds later on whatever line was showing by then. That is
// how "Removed. Undo" could vanish after a second or two.
let statusHideTimer = null;
// How many lines the status line has shown: a timer that was set for one line
// leaves a later one alone.
let statusShown = 0;
let statusPlaced = false;   // the line follows the site's bars as the page scrolls, once it has been shown on a phone
// The line that says the sign-in has ended, with its way back in, once there
// is one (opts.signIn). Other news is still shown, and this line comes back
// after it: it is the one thing the person has to act on.
let signInLine = null;
// True once the person has pressed "Sign in again": the page is about to be left on purpose.
let leavingToSignIn = false;
// What a request found out about the sign-in, once one has found it ended; null until then.
let signInOver = null;
const BACK_KEY = 'kiln_signin_back';   // sessionStorage: this tab left through "Sign in again"

import { SANITIZE, CONTAINER_SANITIZE, BLOCK_SANITIZE } from './sanitize.js';

// Any anchor opening a new tab gets rel="noopener" so the opened page can't
// reach back through window.opener (reverse tabnabbing).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
    const rel = (node.getAttribute('rel') || '').split(/\s+/).filter(Boolean);
    if (!rel.includes('noopener')) rel.push('noopener');
    node.setAttribute('rel', rel.join(' '));
  }
});

const state = {
  gh: null,
  user: null,
  page: null,            // { path, text, sha }
  fields: null,          // indexHtml() of page.text
  pending: new Map(),    // key → { html?, attrs?: {name: value} }
  active: null,
  // Binary uploads (images/docs) queued for the NEXT Publish, so nothing is
  // committed to the repo until you actually publish (Discard leaves no orphans).
  // repoPath → base64
  pendingBinaries: new Map(),
  // Structural changes from "Make things editable" (annotate/unannotate the HTML),
  // applied to the source at Publish time — so they're pending like everything else.
  // [{ op:'annotate', tag, nth, attrs } | { op:'remove', key }]
  pendingStructural: [],
  // What each field/container held before this session's unpublished changes,
  // as the page's file would hold it. Taken whenever the person begins to
  // change a part that has no change waiting (baselines.js), never only when
  // the editor starts: the page is still animating in then. Updated after each
  // publish. The undo stack uses these to put the DOM back when un-staging a
  // change. (NOT state.baseline — that is the publish-conflict snapshot set by
  // loadPageSource.)
  undoBase: new Map(),        // key → inner HTML as the file would hold it
  undoBaseAttrs: new Map(),   // key → { attrName: value }
  // Source mode (§4.3): fields whose value lives in a content FILE, not this
  // page's HTML. Keyed by the FULL data-kiln-source ref string. None of this is
  // touched unless the page actually carries [data-kiln-source] (§13).
  pendingSource: new Map(),   // ref → { value, type? } staged for /source/commit
  sourceFields: null,         // ref → { parsed, els: [Element] } from the boot scan
  sourceBase: new Map(),      // ref → pre-edit text (undo baseline; updated on publish)
  sourceTheirs: new Map(),    // ref → what the worker said the file holds, once the person chose their own words over it
  // What was being typed into a panel when a request found the sign-in ended,
  // while the person is being told: it goes into the saved copy with the edits
  // (saved-edits.js `typed`) and is put back after signing in again.
  typed: null,
};

// ─── Session undo/redo (⌘Z / ⌘⇧Z) ───────────────────────────────────────────
// Every staged change (text commit, block add/move/remove, image swap, restore
// from history) is one entry; undo un-stages it and puts the page back, redo
// re-applies. Typing INSIDE a field still uses the browser's native undo — this
// stack works at the "committed change" level, like Canva's.
const editHistory = { undo: [], redo: [] };
let undoBucket = null;   // when set, stagePending records into this composite entry
let activeOriginalHtml = null;   // the currently-edited element's own pre-edit HTML, as the file would hold it (for Esc)

/** Group several stagePending calls into ONE undo entry (e.g. a multi-section restore). */
function undoGroup(fn) {
  const mine = !undoBucket;
  if (mine) undoBucket = { steps: [] };
  try { fn(); } finally {
    if (mine) {
      const b = undoBucket; undoBucket = null;
      if (b.steps.length) pushUndoEntry(b);
    }
  }
}

function pushUndoEntry(entry) {
  // "Removed. Undo" is the way back while the removal is the last change made.
  // After another change its button would undo that one instead: put it away.
  const line = document.getElementById('kiln-status');
  if (line?.dataset.tag === 'removed') line.hidden = true;
  editHistory.undo.push(entry);
  if (editHistory.undo.length > 100) editHistory.undo.shift();
  editHistory.redo.length = 0;
  updateUndoUi();
}

/** A publish, a draft, a schedule or a suggestion is a boundary: Undo does not reach back past it. */
function forgetEditHistory() {
  editHistory.undo.length = 0;
  editHistory.redo.length = 0;
  forgetBlocks();
  updateUndoUi();
}

/** Queue a binary to be committed with the next Publish (not immediately). Returns nothing. */
function stageBinary(repoPath, base64) {
  state.pendingBinaries.set(repoPath, base64);
  refreshPublishButton();
}

init().catch(err => {
  console.error('[kiln]', err);
  if (err.kilnFriendly) {
    // A known, explainable failure (e.g. generated site): show it in-page.
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:2147483647;'
      + 'max-width:460px;background:#1c1c28;color:#e7e7ee;font:14px/1.55 -apple-system,sans-serif;'
      + 'padding:18px 20px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.4)';
    box.innerHTML = `<strong style="color:#fff">Kiln couldn’t open this page</strong><br>`
      + err.kilnFriendly.replace(/</g, '&lt;')
      + `<br><button style="margin-top:12px;background:#6366f1;color:#fff;border:0;border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit">Dismiss</button>`;
    box.querySelector('button').onclick = () => box.remove();
    document.body.appendChild(box);
  } else {
    setStatus('Editing could not start on this page. Reloading it usually helps.', 'error');
  }
});

async function init() {
  if (cfg.sandbox) return initSandbox();
  if (!cfg.repo || !cfg.worker) {
    console.error('[kiln] window.KILN.repo and .worker are required');
    return;
  }
  // The stored sign-in ran out by this browser's own clock, and the boot shim
  // dropped it as this page loaded (it loads this bundle to say so, and leaves
  // this marker). The page gets the card a sign-in the worker has ended gets,
  // and nothing else of the editor. Once: the next page has no sign-in to drop.
  if (window.__KILN_OVER) {
    showNotice(endedNotice({ way: signInWay(), draft: draftWaits() }), signInAgain);
    return;
  }
  injectStyles();

  if (mode === 'admin') {
    const stored = JSON.parse(localStorage.getItem(ADMIN_KEY));
    state.gh = watched(withAutoRefresh(makeGh({ mode: 'direct', token: () => JSON.parse(localStorage.getItem(ADMIN_KEY)).token }), stored));
    try {
      const user = await state.gh.request('GET', '/user');
      state.user = user.login;
    } catch (err) {
      // Only a real auth rejection should sign the owner out. A network or worker
      // blip (no HTTP status) must NOT nuke a valid session — that would log them
      // out every time their wifi hiccups. Surface it and let a reload recover.
      const over = onLoadFailure(err, { mode, draft: draftWaits(), asking: 'who' });
      if (over) {
        console.warn(over.drop ? '[kiln] the sign-in has ended' : '[kiln] could not verify session (offline?)', err);
        notStarted(over);
        return;
      }
      console.warn('[kiln] could not verify session (offline?)', err);
      setStatus('Can’t reach GitHub right now — check your connection and reload.', 'error');
      return;
    }
  } else {
    const sess = JSON.parse(localStorage.getItem(EDITOR_KEY));
    if (!sess) { localStorage.removeItem(EDITOR_KEY); location.reload(); return; }
    if (sess.repo !== cfg.repo) {
      // The sign-in was made under another repository name than the one the
      // site's config has now (the owner corrected it after a rename or a
      // move). It is of no use here: say so, instead of a silent reload.
      notStarted(onLoadFailure({ status: 401 }, { mode, draft: draftWaits() }));
      return;
    }
    state.gh = watched(makeGh({ mode: 'proxy', worker: cfg.worker, session: sess.session }));
    state.user = sess.name;
  }

  try {
    await loadPageSource();
  } catch (err) {
    // The worker no longer knows this sign-in (any 401, whatever it says).
    // The editor does not start: the stored sign-in is dropped, so /kiln
    // shows the sign-in again, and the page says what happened.
    // Trouble (no answer, a 5xx, a 429) and a 403 drop nothing: the page says
    // editing could not start and that the person is still signed in.
    const over = onLoadFailure(err, { mode, draft: draftWaits() });
    if (over) {
      console.warn(over.drop ? '[kiln] the sign-in has ended' : '[kiln] the page could not be read', err);
      notStarted(over);
      return;
    }
    // Source-mode pages are GENERATED — the URL usually has no committed HTML
    // file, and that must not kill the editor (§13). Boot with an empty page
    // index instead; HTML-mode editing simply has nothing to decorate, while
    // [data-kiln-source] fields still work. Everything else stays fatal.
    const sourcey = cfg.mode === 'source' || document.querySelector(`[${SOURCE_ATTR}]`);
    if (err.status !== 404 || !sourcey) throw err;
    state.page = { path: '', text: '', sha: null };
    state.fields = indexHtml('');
    state.baseline = {};
  }
  // Editors: learn our path/section scope BEFORE decorating, so out-of-scope
  // content never grows an edit handle (best-effort — offline means no scope data).
  if (mode === 'editor' && !cfg.sandbox) await presencePing();
  renderAdminBar();
  chromeDrawn = true;
  // §7.3: an html-mode page that resolved to committed BUILD OUTPUT gets a
  // blocking explanation instead of edit handles — editing it is silent data
  // loss (the next build erases the edit). Nothing else is withheld.
  if (await wrongModeGuard()) {
    setStatus('Editing is off — this page is build output (see the notice)', 'error');
  } else {
    decorateFields();
    await initSourceFields();
    revealFields();
    offerPendingRestore();
  }
  if (journalAll().length) runJournal();
  checkForDraft();
  startPresence();
  // A comment is filed under the page's file. A page the site builds from
  // content files has none, and the worker would refuse every comment on it.
  if (state.page?.path) initComments(cfg, mode, state, { ask, say, stopped }, modal, setStatus, hasFeature, KILN_CHROME);
  bootBlocks();
  // An invited editor's first session: the same three steps the demo shows,
  // once per browser. Only for someone who can publish this page themselves.
  if (mode === 'editor' && !isSuggestMode() && state.scope?.mode !== 'review' && pageInScope()) {
    initGuide({ cfg, audience: 'editor', mobileMq: MOBILE_MQ, guideUrl: helpLink(),
      unpublished: () => state.pending.size + state.pendingSource.size + state.pendingBinaries.size + state.pendingStructural.length,
      publishButton: () => document.getElementById('kiln-pubsheet-go') || document.getElementById('kiln-publish-quick') || document.getElementById('kiln-publish') });
  }
  // Owner-only: quietly check whether a newer editor build exists.
  if (mode === 'admin' && !cfg.sandbox) checkForUpdate();
  startedUp = true;
  for (const open of onceStarted.splice(0)) open();

  window.addEventListener('beforeunload', (e) => {
    // Leaving to sign in again was chosen in a dialog that said what is kept.
    if (leavingToSignIn) return;
    if (state.pending.size || state.pendingBinaries.size || state.pendingStructural.length
      || state.pendingSource.size) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ─── A sign-in that has ended ────────────────────────────────────────────────
// What a failed request means, and every sentence shown, is in
// sign-in-ended.js. Here: drop the stored sign-in and put the sentence on the
// page.

/** Unpublished edits to this page are saved in this browser (see "Crash-proof pending edits"). */
function draftWaits() {
  try {
    for (const p of [...pageFileCandidates(location.pathname, cfg.root || ''), location.pathname]) {
      if (readDraft(JSON.parse(localStorage.getItem(`kiln_pending:${cfg.repo}:${p}`)))?.count) return true;
    }
  } catch { /* unreadable: nothing is promised */ }
  return false;
}

/** The worker's own sign-in, coming back to this page, where saved edits are put back without asking. */
function signInAgain() {
  leavingToSignIn = true;
  // Still here in a few seconds (the sign-in could not be reached, or the person came straight back): warn again on leaving.
  setTimeout(() => { leavingToSignIn = false; }, 5000);
  try { sessionStorage.setItem(BACK_KEY, '1'); } catch { /* private mode: the edits are offered back instead */ }
  location.href = signInUrl({ worker: cfg.worker, origin: location.origin, path: location.pathname + location.search,
    repo: cfg.repo, way: mode === 'admin' ? 'github' : 'google' });
}

/**
 * The page loaded and the editor cannot start: the sign-in is over (it is
 * dropped), or the page could not be read (it is kept). The editor has drawn
 * nothing yet and draws nothing: the page is what a signed-out visitor sees,
 * plus one sentence at the bottom of the screen (clear of a site's own
 * navigation) that can be put away.
 */
function notStarted(over) {
  if (over.drop) localStorage.removeItem(mode === 'admin' ? ADMIN_KEY : EDITOR_KEY);
  document.querySelectorAll('style[data-kiln]').forEach(st => st.remove());   // every sheet the editor put in the page
  showNotice(over.notice, over.action === 'reload' ? () => location.reload() : signInAgain);
}

// ─── …found out while editing ────────────────────────────────────────────────
// Nothing staged is touched and nothing is reloaded. The unpublished edits are
// already saved in this browser ("Crash-proof pending edits"), and signing in
// again comes back to this page, where they are put back.

/** The saved copy in this browser holds every text edit staged right now (written, then read back). */
function draftSaved() {
  savePendingToStorage();
  try { return draftHolds(JSON.parse(localStorage.getItem(pendingStorageKey())), state.pending, state.pendingSource, state.typed); } catch { return false; }
}

/** The unpublished text, for "Copy my text": each edit as a person reads it on the page. */
function unpublishedText() {
  const items = [];
  for (const [key, v] of state.pending) {
    if (v.html !== undefined) items.push({ label: humanizeKey(key), text: renderedText(key, v.html) });
    if (v.attrs && 'alt' in v.attrs) items.push({ label: `${humanizeKey(key)} (picture description)`, text: v.attrs.alt });
    if (v.attrs && 'href' in v.attrs) items.push({ label: `${humanizeKey(key)} (link goes to)`, text: v.attrs.href });
  }
  for (const [ref, v] of state.pendingSource) items.push({ label: sourceName(ref), text: v.value });
  return editsAsText(items);
}

/**
 * What a request found out, as a dialog: where the edits stand, and what can
 * be done. `did` is the word for what was being done (see stopped()); true
 * and false are Publish and "nothing in particular". `typedNow` reads what
 * the person had typed into the panel they were in (see typedIn). Returns the
 * status line.
 *
 * The dialog goes over that panel and gives it back as it was when it is put
 * away, so nothing typed there is lost by being told.
 */
function stoppedDialog(f, did, typedNow = null) {
  if (did === true) did = 'published';
  did = did || '';
  const over = f.kind === 'ended';
  // Words still being typed into a field are part of what is kept: stage them, as Publish does.
  if (over) {
    if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));
    if (sourceActive) commitSourceEdit();
  }
  // What was typed into the panel, read off the screen now. When the saved
  // copy can hold it, it is written there with the edits and read back before
  // anything is promised about it.
  const typed = (typeof typedNow === 'function' ? typedNow() : typedNow) || typedAnywhere();
  state.typed = over && typed?.keep ? { ...typed.keep, text: typed.text } : null;
  const counts = stagedCounts();
  const way = signInWay();
  const saved = over ? draftSaved() : false;
  const told = typed ? { name: typed.name, kept: !!state.typed && saved } : null;
  const d = !over
    ? publishRefused({ way, reason: f.reason, counts, did: did || 'changed', typed: told })
    : publishEnded({ way, ownerMust: f.ownerMust, message: f.message, counts, did, typed: told,
      survives: whatSurvives(counts, { saved, filesKept: [...state.pendingBinaries.keys()].filter(p => keptHere.has(p)).length }) });
  const again = () => stoppedDialog(f, did, typedNow);
  setStatus(d.status, 'error', { sticky: true, signIn: over, action: { label: d.signIn ? 'Sign in again' : 'What now', title: 'What happened, and what is kept', run: again } });
  // Staying on the page: what was typed is on screen again, in its panel, and
  // is not left in the saved copy to be offered back another day.
  const stays = () => { if (!leavingToSignIn && state.typed) { state.typed = null; savePendingToStorage(); } };
  const m = modal(`
    <h3>${escapeHtml(d.title)}</h3>
    <p style="margin:0;font-size:14.5px;line-height:1.55;color:#1c1c28">${escapeHtml(d.text)}</p>
    ${d.detail ? `<p style="margin:12px 0 0;border-left:2px solid #d5d8e0;padding-left:10px;font-size:13px;line-height:1.5;color:#4b5563">${escapeHtml(d.detail)}</p>` : ''}
    <textarea id="kiln-stop-text" readonly hidden rows="6" style="width:100%;box-sizing:border-box;font:13px/1.45 ui-monospace,Menlo,monospace;margin-top:4px"></textarea>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>${d.signIn ? 'Not now' : 'Close'}</button>
      ${d.copy ? `<button class="${d.signIn && !d.copyFirst ? 'kiln-btn-ghost' : 'kiln-btn-publish'}" id="kiln-stop-copy">Copy my text</button>` : ''}
      ${d.signIn ? `<button class="${d.copyFirst ? 'kiln-btn-ghost' : 'kiln-btn-publish'}" id="kiln-stop-go">Sign in again</button>` : ''}
    </div>`, { over: true, onClose: stays });
  const copy = m.querySelector('#kiln-stop-copy');
  if (copy) copy.onclick = async () => {
    // What was typed in the panel first, then the unpublished edits.
    const text = [typed ? editsAsText([{ label: typed.name.charAt(0).toUpperCase() + typed.name.slice(1), text: typed.text }]) : '', unpublishedText()].filter(Boolean).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    } catch {
      // No clipboard here: show the text, selected, to copy by hand.
      const box = m.querySelector('#kiln-stop-text');
      box.value = text; box.hidden = false; box.focus(); box.select();
    }
  };
  const go = m.querySelector('#kiln-stop-go');
  if (go) go.onclick = signInAgain;
  return d.status;
}

// ─── …on every other path that asks the worker ───────────────────────────────
// Publish was the first to say it. Everything else the editor asks with the
// person's sign-in (History, drafts, suggestions, comments, schedules, the
// picture list, AI assist, People, the site menu…) goes through one of two
// doors, and both are watched: the GitHub transport (the worker's proxy for an
// invited editor) and `ask` for the worker's own routes.

/**
 * A request, whoever made it, was answered that the sign-in has ended. The
 * first time, the status line says so and offers the way back in: that is all
 * a request the editor made on its own (who else is editing, comment counts,
 * whether a publish is live yet) ever shows. Something the person asked for
 * also opens the dialog, through stopped().
 */
function signInGone(err) {
  if (!chromeDrawn) return;   // while the editor is starting, init() says so on the page
  const f = readFailure(err);
  if (f.kind !== 'ended') return;
  const first = !signInOver;
  signInOver = f;
  // Asking who else is editing would only be refused again every half minute.
  clearInterval(presenceTimer);
  if (first) {
    setStatus('Your sign-in has ended.', 'error', { sticky: true, signIn: true,
      action: { label: f.ownerMust ? 'What now' : 'Sign in again', title: 'What happened, and what is kept', run: () => stoppedDialog(f, false) } });
  }
}

/** The GitHub transport, with every failed answer looked at for an ended sign-in. */
function watched(gh) {
  return {
    async request(method, path, body) {
      try { return await gh.request(method, path, body); } catch (err) { signInGone(err); throw err; }
    },
  };
}

/**
 * Whether the sign-in still stands, asked through the transport: the worker's
 * proxy answers an ended one with 401 whatever is asked (an invited editor),
 * and for the owner GitHub is asked, which renews a token that has run out.
 */
function signInStands() {
  return mode === 'admin'
    ? state.gh.request('GET', '/user')
    : state.gh.request('GET', `/repos/${cfg.repo}/git/ref/${encodeURIComponent('heads/' + (cfg.branch || 'main'))}`);
}

/** The worker's own routes, asked with the sign-in (worker-call.js): JSON back, or an error with the answer's status and body. */
const ask = makeAsk({
  worker: cfg.worker, headers: workerAuthHeaders, stands: signInStands, renews: mode === 'admin', ended: signInGone,
  fetchImpl: (url, init) => fetch(url, init),
});

function signInWay() { return mode === 'admin' ? 'github' : 'google'; }   // a declaration: init() uses it before this line is reached
const stagedCounts = () => ({ edits: state.pending.size, source: state.pendingSource.size, structural: state.pendingStructural.length, files: state.pendingBinaries.size });

/**
 * Something the person asked for was stopped by the answer it got. `did` is
 * the word for what they were doing ('saved', 'scheduled', 'posted'…; '' when
 * something was only being read). As at Publish: an ended sign-in (401) and,
 * when something was being changed, a change the sign-in does not allow (403)
 * open the dialog; trouble on the way (no answer, a 5xx, a 429) is one line
 * that says nothing was lost and to try again.
 *
 * Returns that line, for the place the person is looking at, or '' when the
 * answer is about something else and the caller keeps its own words.
 */
function stopped(err, did = '', typed = null) {
  const f = readFailure(err);
  if (f.kind === 'ended' || (f.kind === 'refused' && did)) return stoppedDialog(f, did, typed);
  if (f.kind === 'refused') return readRefused({ way: signInWay(), reason: f.reason });
  if (f.kind === 'trouble') return publishTrouble(f, stagedCounts(), did);
  return '';
}

/**
 * Everything typed into a panel's boxes, for stopped(): each box's label and
 * its words, as text to copy. The saved copy does not hold these, so the
 * dialog says they will need typing again and puts the copy first.
 * A box still holding what the panel put in it (a page's present title) was
 * not typed; `all` takes every box, for a panel that redraws its boxes with
 * what was typed (the site menu's rows).
 */
function typedIn(panel, all = false) {
  return () => {
    if (!panel.isConnected) return null;
    const items = [];
    for (const box of panel.querySelectorAll('input[type="text"], input[type="email"], input:not([type]), textarea')) {
      if (!box.value.trim() || box.readOnly || box.closest('[hidden]')) continue;
      if (!all && box.value === box.defaultValue) continue;
      const label = (box.closest('label')?.textContent || box.getAttribute('aria-label') || box.placeholder || '').replace(/\s+/g, ' ').trim();
      items.push({ label, text: box.value });
    }
    return items.length ? { name: 'what you typed here', text: editsAsText(items) } : null;
  };
}

/**
 * What is being typed somewhere on screen right now, for when the thing that
 * was stopped had no words of its own (Publish, a list being read, the editor
 * finding out by itself): a comment or a reply first, then the boxes of
 * whatever panel is open.
 */
function typedAnywhere() {
  const panel = document.getElementById('kiln-modal');
  return typedComment() || (panel && !panel.dataset.over ? typedIn(panel)() : null);
}

/** The same, for a failure that is told in the status line: what stopped() says, or the caller's own words. */
function say(err, did, own, typed = null) {
  const line = stopped(err, did, typed);
  const kind = readFailure(err).kind;
  if (kind === 'ended' || (kind === 'refused' && did)) return;   // the dialog has set its own line
  setStatus(line || own, 'error');
}

/** One sentence, at most one button, and a way to put it away. Styled inline: the editor's own styles are not on the page. */
function showNotice(notice, onButton) {
  document.getElementById('kiln-notice')?.remove();
  const box = document.createElement('div');
  box.id = 'kiln-notice';
  box.setAttribute('role', 'status');
  box.style.cssText = 'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);'
    + 'z-index:2147483000;box-sizing:border-box;width:max-content;max-width:min(560px,calc(100vw - 24px));'
    + 'background:#1c1c28;color:#f1f1f6;font:400 14.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
    + 'padding:14px 44px 14px 16px;border:1px solid rgba(255,255,255,.14);border-radius:14px;'
    + 'box-shadow:0 12px 40px rgba(0,0,0,.38);text-align:left;letter-spacing:normal;text-transform:none';
  const text = document.createElement('p');
  text.textContent = notice.text;
  text.style.cssText = 'margin:0;color:inherit;font:inherit';
  box.appendChild(text);
  if (notice.detail) {
    const detail = document.createElement('p');
    detail.textContent = notice.detail;
    detail.style.cssText = 'margin:10px 0 0;padding-left:10px;border-left:2px solid rgba(255,255,255,.28);color:#c3c5d2;font:inherit;font-size:13px';
    box.appendChild(detail);
  }
  if (notice.button) {
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = notice.button;
    go.style.cssText = 'display:block;margin:12px 0 0;background:#fff;color:#1c1c28;border:0;border-radius:9px;'
      + 'padding:9px 16px;min-height:40px;font-family:inherit;font-size:14px;font-weight:600;line-height:1.2;cursor:pointer';
    go.onclick = onButton;
    box.appendChild(go);
  }
  const x = document.createElement('button');
  x.type = 'button';
  x.setAttribute('aria-label', 'Dismiss');
  x.textContent = '✕';
  x.style.cssText = 'position:absolute;top:6px;right:6px;width:36px;height:36px;background:transparent;color:#c3c5d2;'
    + 'border:0;border-radius:8px;font-family:inherit;font-size:15px;font-weight:400;line-height:1;cursor:pointer';
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  x.onclick = close;
  document.addEventListener('keydown', onKey, true);
  box.appendChild(x);
  document.body.appendChild(box);
}

// ─── Update check (owner only) ───────────────────────────────────────────────
// Compare this bundle's build stamp (__KILN_VERSION__, injected by build.mjs)
// against the latest released one on GitHub (update-check.js: the `release`
// branch, not main). If a newer editor exists, show a
// dismissible notice pointing at `kiln update`. Throttled to once per 6h per
// browser, dismissal is remembered per-version, and it fails SILENTLY on any
// network/rate-limit error — a version check must never disrupt editing.
async function checkForUpdate() {
  const mine = (typeof __KILN_VERSION__ !== 'undefined') ? String(__KILN_VERSION__) : 'dev';
  if (mine === 'dev') return;
  const readLS = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  try {
    const cached = JSON.parse(readLS('kiln_update_check') || 'null');
    if (cached && Date.now() - cached.at < 6 * 3600 * 1000) {
      if (cached.stale && cached.latest !== readLS('kiln_update_dismissed')) showUpdateNotice(cached.latest);
      return;
    }
    // What was released (the `release` branch), not whatever is on main.
    const latest = await latestStamp();
    if (!latest) return;
    const stale = isStale(mine, latest);
    try { localStorage.setItem('kiln_update_check', JSON.stringify({ at: Date.now(), latest, stale })); } catch { /* private mode */ }
    if (stale && latest !== readLS('kiln_update_dismissed')) showUpdateNotice(latest);
  } catch { /* offline / rate-limited — never bother the user */ }
}

function showUpdateNotice(latest) {
  if (document.getElementById('kiln-update-note')) return;
  const st = document.createElement('style');
  st.textContent = '#kiln-update-note{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147482100;'
    + 'display:flex;align-items:center;gap:12px;max-width:92vw;background:#1c1c28;color:#fff;border-radius:10px;'
    + 'padding:9px 10px 9px 15px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.32)}'
    + '#kiln-update-note code{background:rgba(255,255,255,.14);padding:1px 6px;border-radius:5px;font-size:12px}'
    + '#kiln-update-note button{background:transparent;color:#fff;border:0;font-size:15px;cursor:pointer;padding:2px 4px;opacity:.7}'
    + '#kiln-update-note button:hover{opacity:1}';
  document.head.appendChild(st);
  const el = document.createElement('div');
  el.id = 'kiln-update-note';
  el.innerHTML = `<span>A newer Kiln editor is available. Update: <code>${escapeHtml(UPDATE_COMMAND)}</code></span>`
    + '<button id="kiln-update-x" aria-label="Dismiss">✕</button>';
  document.body.appendChild(el);
  el.querySelector('#kiln-update-x').onclick = () => {
    try { localStorage.setItem('kiln_update_dismissed', latest); } catch { /* private mode */ }
    el.remove();
  };
}

/** Admin tokens expire after 8h; refresh through the worker-held refresh token. */
function withAutoRefresh(gh, stored) {
  return {
    async request(method, path, body) {
      try {
        return await gh.request(method, path, body);
      } catch (err) {
        if (err.status !== 401 || !stored?.sid) throw err;
        const res = await fetch(`${cfg.worker}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sid: stored.sid }),
        });
        const data = await res.json().catch(() => ({}));
        if (!data.token) {
          // Sign out ONLY when the worker says the refresh token is dead (401).
          // A transient 5xx/network failure must not destroy a session that will
          // work again once the worker recovers — just fail this one request.
          if (res.status >= 500 || res.status === 429) err.signIn = 'trouble';   // the renewal could not be had: not a sign-out
          // While the editor is starting, init() says so on the page. Once it
          // is running, nothing is reloaded under the person's edits: the
          // status line says so (signInGone), and the dialog what is kept.
          if (res.status === 401) err.signIn = 'ended';
          throw err;
        }
        localStorage.setItem(ADMIN_KEY, JSON.stringify({ ...stored, token: data.token, exp: data.exp }));
        return gh.request(method, path, body);
      }
    },
  };
}

// ─── Page source ─────────────────────────────────────────────────────────────

async function loadPageSource() {
  const candidates = pageFileCandidates(location.pathname, cfg.root || '');
  try {
    state.page = await resolvePageFile(state.gh, cfg.repo, candidates, cfg.branch || 'main');
  } catch (err) {
    if (err.status === 404) {
      // The URL doesn't map to an HTML file in the repo — almost always a site
      // built by a generator (Hugo/Jekyll/11ty/Next export) where the served
      // page has no matching source file. Explain it instead of a dead console error.
      err.kilnFriendly = `Kiln edits the HTML file for this page in your repo, but couldn't find one`
        + ` (looked for: ${candidates.join(', ')}). This usually means the site is produced by a`
        + ` build tool, so the page you see isn't committed as-is. Kiln works on sites whose pages`
        + ` are committed as HTML. See the docs.`;
    }
    throw err;
  }
  state.fields = indexHtml(state.page.text);
  // Snapshot every field's source value: publish uses this to detect when
  // ANOTHER editor changed the same field while we were editing (see publish()).
  state.baseline = readValues(state.page.text);
  for (const w of state.fields.warnings) console.warn('[kiln]', w);
  noteFileLists();
  noteFileFields();
}

/** Auth headers for worker endpoints, whichever way this session signed in. */
function workerAuthHeaders() {
  if (mode === 'admin') {
    const a = JSON.parse(localStorage.getItem(ADMIN_KEY) || 'null');
    return a ? { Authorization: `Bearer ${a.token}` } : {};
  }
  const e = JSON.parse(localStorage.getItem(EDITOR_KEY) || 'null');
  return e ? { 'X-Kiln-Session': e.session } : {};
}

// ─── Presence: who else is editing this page ─────────────────────────────────
// Advisory awareness, not locking — Kiln merges different-field edits cleanly
// at publish time, and same-field overwrites are gated by a confirm in publish().

let presenceTimer = null;
let presenceTickN = 0;
let presenceRefused = false;   // signed in, and the worker will not list this person: not asked again
async function presencePing() {
  if (signInOver) return;   // nobody is signed in to be shown
  if (!presenceRefused) try {
    // An ended sign-in is answered 403 here; `ask` finds out which it is, and the status line says so.
    const data = await ask('/presence', { method: 'POST', body: { repo: cfg.repo, path: location.pathname, name: state.user } });
    if (data.scope) state.scope = data.scope;   // editor path/section grants (see decorateFields)
    // A suggest-mode grant can arrive on a later tick (first ping offline) or
    // change mid-session — keep the Publish button and gating honest. Both are
    // idempotent and null-guarded before the bar renders.
    refreshPublishButton();
    applyFeatureGating();
    // One row per person (an older worker sent one row per page they'd visited).
    const seen = new Map();
    for (const o of data.online || []) if (!seen.has(o.name)) seen.set(o.name, o);
    state.online = [...seen.values()];
    updatePresenceUI(data.others || []);
    updateOnlineChip();
    // Open-suggestions badge (admins): piggyback on the presence heartbeat, but
    // lazily — every 3rd tick (~90s), a review-queue count doesn't need realtime.
    presenceTickN++;
    if (mode === 'admin' && presenceTickN % 3 === 1) refreshSuggestBadge();
  } catch (err) {
    // offline blip — presence is best-effort
    if (readFailure(err).kind === 'refused') presenceRefused = true;
  }
  if (signInOver) return;
  commentsTick();   // comment badge/pins ride the same 30s tick (no second timer)
}

/** A small "who's online" pill in the Kiln menu header — everyone editing the site now. */
function updateOnlineChip() {
  const host = document.querySelector('#kiln-fab-menu .kiln-fab-head') || document.getElementById('kiln-topbar');
  if (!host) return;
  let chip = document.getElementById('kiln-online');
  const others = state.online || [];
  if (!others.length) { chip?.remove(); return; }
  if (!chip) {
    chip = document.createElement('button');
    chip.id = 'kiln-online';
    chip.type = 'button';
    host.appendChild(chip);
    chip.onclick = (e) => { e.stopPropagation(); whoIsOnlinePanel(); };
  }
  chip.innerHTML = `<span class="kiln-online-dot"></span>${others.length} online`;
  chip.title = 'See who else is editing the site';
}

function whoIsOnlinePanel() {
  const rows = (state.online || []).map(o => {
    const where = o.page && o.page !== location.pathname ? `<small>editing ${escapeHtml(o.page)}</small>` : '<small>on this page</small>';
    return `<div class="kiln-inv-row"><span><strong>${escapeHtml(o.name)}</strong> ${where}</span>
      <small class="kiln-dim">${escapeHtml(o.role || 'editor')}</small></div>`;
  }).join('');
  modal(`<h3>Editing right now</h3>
    <p class="kiln-dim">People signed into Kiln on this site in the last minute or so.</p>
    <div class="kiln-inv-list">${rows || '<p class="kiln-dim">Just you.</p>'}</div>
    <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);
}

// ─── Editing scope (invited editors) ─────────────────────────────────────────
// Admins set per-person paths (enforced by the worker on every write) and
// optional section prefixes (data-cms key prefixes; guides the UI so editors
// only see handles on what they're meant to touch).

function pageInScope(path = state.page.path) {
  const ps = state.scope?.paths;
  if (!ps || !ps.length || ps.some(p => p === '' || p === '*' || p === '**')) return true;
  const f = String(path).replace(/^\/+/, '');
  return ps.some(p => {
    const pre = String(p).replace(/^\/+/, '').replace(/\/+$/, '');
    return !pre || f === pre || f.startsWith(pre + '/');
  });
}

function keyInScope(key) {
  const ks = state.scope?.keys;
  if (!ks || !ks.length) return true;
  return ks.some(p => key === p || key.startsWith(p));
}

/** Suggest-mode editor: their Publish proposes instead of committing (worker-enforced). */
function isSuggestMode() {
  return mode === 'editor' && !cfg.sandbox && state.scope?.mode === 'suggest';
}

/** Whether the current editor may use a given menu feature. Admins get everything. */
function hasFeature(feature) {
  return hasGrant({ mode, sandbox: !!cfg.sandbox, features: state.scope?.features }, feature);
}

/** The guide for whoever is signed in, and the menu's "Help" that opens it in a new tab. */
function helpLink() {
  return helpUrl({ mode, sandbox: !!cfg.sandbox, role: state.scope?.role || null });
}
function openHelp() {
  window.open(helpLink(), '_blank', 'noopener');
}

/** The two structure tools: granted, on a page this person can write, by someone who publishes. */
function canMakeEditable() {
  return offersMakeEditable({ mode, sandbox: !!cfg.sandbox, features: state.scope?.features,
    scopeMode: state.scope?.mode || null, pageInScope: mode === 'editor' && !cfg.sandbox ? pageInScope() : true });
}

/** Hide menu items an invited editor hasn't been granted (applied after the bar renders). */
function applyFeatureGating() {
  // Comments are filed under the page's file, and a page the site builds from
  // content files has none: not offered there, to anyone (startLine says so
  // to the person who came only to comment).
  if (!cfg.sandbox && state.page && !state.page.path) { const c = document.getElementById('kiln-comments'); if (c) c.style.display = 'none'; }
  if (mode === 'admin' || cfg.sandbox) { hideEmptyGroups(); return; }
  // 'suggestreview' is deliberately not in the worker's GRANTABLE_FEATURES, so
  // no invited editor ever has it — the review queue stays admin-only.
  const map = { 'kiln-menu': 'menu', 'kiln-theme': 'theme', 'kiln-findreplace': 'findreplace', 'kiln-newpost': 'newpost',
    'kiln-pagesettings': 'pagesettings', 'kiln-history': 'history', 'kiln-makeblock': 'makeeditable', 'kiln-addsection': 'makeeditable',
    'kiln-suggestions': 'suggestreview', 'kiln-comments': 'comments', 'kiln-ai': 'ai', 'kiln-blocks-layer': 'blocks' };
  for (const [id, feat] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el && !hasFeature(feat)) el.style.display = 'none';
  }
  // Draft/Schedule/Share-preview live in the pending-edits group; gate them too.
  // Suggest-mode editors lose Schedule (a schedule fires as a direct commit —
  // the worker rejects it anyway) and Share preview (their preview branch is
  // written per-suggestion instead); drafts stay — kiln-drafts never goes live.
  if (!hasFeature('draft')) { const d = document.getElementById('kiln-draft'); if (d) d.dataset.gated = '1'; }
  // Suggest-mode editors also lose Theme: its Apply writes stylesheets to the
  // live branch directly, which the worker refuses for suggest sessions anyway.
  if (isSuggestMode()) { const t = document.getElementById('kiln-theme'); if (t) t.style.display = 'none'; }
  if (!hasFeature('schedule') || isSuggestMode()) { const s = document.getElementById('kiln-schedule'); if (s) s.dataset.gated = '1'; }
  if (!hasFeature('draft') || isSuggestMode()) { const p = document.getElementById('kiln-sharepreview'); if (p) p.dataset.gated = '1'; }
  hideEmptyGroups();
}

/** A group of the menu with none of its items on offer does not keep its heading. */
function hideEmptyGroups() {
  for (const g of document.querySelectorAll('#kiln-fab-menu .kiln-fab-group:not(#kiln-grp-edits)')) {
    g.hidden = ![...g.querySelectorAll('button')].some(b => b.style.display !== 'none' && !b.hidden);
  }
}

function renderScopeNote() {
  if (document.getElementById('kiln-scope-note')) return;
  const paths = (state.scope?.paths || []).filter(p => p && p !== '**' && p !== '*');
  const note = document.createElement('div');
  note.id = 'kiln-scope-note';
  note.innerHTML = `<span class="kiln-presence-dot"></span>Read-only here. Your editing access covers: <strong>${paths.map(escapeHtml).join(', ') || 'other pages'}</strong>`;
  document.body.appendChild(note);
}

function startPresence() {
  if (cfg.sandbox || presenceTimer) return;
  presencePing();
  presenceTimer = setInterval(presencePing, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') presencePing();
  });
}

function updatePresenceUI(others) {
  state.othersEditing = others;
  let chip = document.getElementById('kiln-presence');
  if (!others.length) { chip?.remove(); return; }
  const label = others.length === 1
    ? `${others[0].name} is also editing this page`
    : `${others.map(o => o.name).join(', ')} are also editing this page`;
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'kiln-presence';
    document.body.appendChild(chip);
  }
  chip.innerHTML = `<span class="kiln-presence-dot"></span>${escapeHtml(label)} — your edits merge unless you change the same text`;
}

// ─── Field decoration + inline editing ───────────────────────────────────────

function decorateFields() {
  // Out-of-scope page for this editor: leave everything read-only, say why.
  // (A page built from content files has no file of its own: what this person
  // may edit on it is decided field by field, in initSourceFields.)
  if (mode === 'editor' && state.page.path && !pageInScope()) { renderScopeNote(); return; }
  // Review-mode seats comment; they never see edit affordances.
  if (mode === 'editor' && state.scope?.mode === 'review') return;

  document.querySelectorAll('[data-cms]').forEach((el) => {
    // §4.3 precedence: an element carrying BOTH data-cms and data-kiln-source
    // is a source field — never guess silently (initSourceFields warns once).
    if (el.hasAttribute(SOURCE_ATTR)) return;
    const key = el.getAttribute('data-cms');
    const source = state.fields.fields.get(key);
    const inRepeat = !!el.closest('[data-cms-repeat]');
    if (!source && !inRepeat) {
      console.warn(`[kiln] "${key}" is on the page but not in ${state.page.path}`);
      return;
    }
    if (source && (source.kind === 'list' || source.kind === 'menu')) return; // structural, never inline-editable
    // Fields inside a repeat publish through their container, so the CONTAINER's
    // scope governs them. Never set a per-field title inside a repeat — it would
    // be committed into the container HTML on the next reorder/edit.
    if (inRepeat) {
      if (keyInScope(el.closest('[data-cms-repeat]').getAttribute('data-cms-repeat'))) decorateField(el, key);
      return;
    }
    if (!keyInScope(key)) { el.title = 'Not in your editing scope'; return; }
    decorateField(el, key);
  });

  document.querySelectorAll('[data-cms-repeat]').forEach((container) => {
    const key = container.getAttribute('data-cms-repeat');
    if (!state.fields.fields.has(key)) {
      console.warn(`[kiln] repeat "${key}" not found in ${state.page.path}`);
      return;
    }
    if (!keyInScope(key)) { container.title = 'Not in your editing scope'; return; }
    setupRepeat(container, key);
  });

  watchBar();

  // Clicking away SAVES your edit (staged for Publish). Esc reverts it.
  // The image popover and its drag handle are body-level editor chrome, NOT
  // outside clicks — committing on them rewrote the field's innerHTML mid-
  // resize, detaching the very image the handle was resizing (drags after the
  // first then moved an orphaned element, and the in-flight resample corrupted
  // the staged-upload map).
  document.addEventListener('click', (e) => {
    if (state.active && !state.active.contains(e.target)
      && !e.target.closest('#kiln-toolbar, #kiln-imgpop, #kiln-ai-menu, .kiln-img-handle, .kiln-keeps-edit')) {
      commitEdit(state.active, state.active.getAttribute('data-cms'));
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.active) cancelEditing();
  });

  // Clicking an image INSIDE a field being edited opens size/remove controls
  // for that one image (the style survives commit — the sanitizer allows it).
  document.addEventListener('click', (e) => {
    if (state.active && e.target.tagName === 'IMG' && state.active.contains(e.target)) {
      e.preventDefault();
      inlineImgPopover(e.target);
    }
  });
}

// ─── A block's buttons under the site's own bar (under-bar.js) ───────────────
// A header the site keeps at the top of the screen covers what scrolls under
// it. A block's buttons are stacked above the whole page, so they are hidden
// for as long as any part of them is under such a bar.

let barFrame = 0;
let barWatched = false;
function barSoon() {
  if (barFrame) return;
  barFrame = requestAnimationFrame(() => { barFrame = 0; hideUnderBar(); });
}

function hideUnderBar() {
  const ctls = document.querySelectorAll('.kiln-item-ctl');
  if (!ctls.length) return;
  // The box of the fixed or sticky element that `el` is, or is inside.
  const pinned = (el) => {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; }
    }
    return null;
  };
  // What is painted along the top edge of the screen, at a few places across it.
  let cover = 0;
  for (const y of [2, 18]) {
    for (const part of [0.25, 0.5, 0.75]) {
      const x = Math.round(window.innerWidth * part);
      const first = document.elementsFromPoint(x, y).find(el => !isKilnChrome(el));   // Kiln's own are above it: look through them
      if (first) cover = Math.max(cover, coverBottom([{ kiln: false, pinned: pinned(first) }], window.innerHeight));
    }
  }
  for (const ctl of ctls) ctl.classList.toggle('kiln-under-bar', isUnder(ctl.getBoundingClientRect(), cover));
}

/** Look whenever the page moves: at most once a frame, and only on a page that has lists. */
function watchBar() {
  if (barWatched || !document.querySelector('.kiln-item-ctl')) return;
  barWatched = true;
  window.addEventListener('scroll', barSoon, { passive: true, capture: true });
  window.addEventListener('resize', barSoon);
  barSoon();
}

/**
 * Nothing on a page looks editable until the pointer happens to be over it, and
 * a phone has no pointer. So when editing starts, every field shows its outline
 * for a moment and fades back (CSS: .kiln-reveal). Touch devices also keep a
 * faint outline at rest. Under prefers-reduced-motion there is no fade: the
 * outlines show, then go.
 */
function revealFields() {
  const root = document.documentElement;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('kiln-reveal');
  setTimeout(() => root.classList.remove('kiln-reveal'), still ? 1500 : 2100);
}

/** Mini popover for an image inside a rich-text field: width presets + remove. */
function inlineImgPopover(img) {
  document.getElementById('kiln-imgpop')?.remove();
  const pop = document.createElement('div');
  pop.id = 'kiln-imgpop';
  pop.innerHTML = `<span class="kiln-tb-label">image</span>
    ${['25%', '50%', '75%', '100%'].map(s => `<button class="kiln-tb-fmt" data-w="${s}">${s}</button>`).join('')}
    <button class="kiln-tb-fmt" data-w="orig" title="Original size">Auto</button>
    <button class="kiln-tb-fmt" data-x="1" title="Remove this image">✕</button>`;
  document.body.appendChild(pop);
  const r = img.getBoundingClientRect();
  const above = r.top - pop.offsetHeight - 8;
  pop.style.top = `${(above >= 8 ? above : r.bottom + 8) + window.scrollY}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + window.scrollX}px`;
  pop.querySelectorAll('button').forEach(b => {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the field's selection
    b.onclick = (e) => {
      e.stopPropagation(); e.preventDefault();
      if (b.dataset.x) { img.remove(); handle.remove(); pop.remove(); return; }
      if (b.dataset.w === 'orig') { img.style.removeProperty('width'); img.style.removeProperty('height'); }
      else { img.style.width = b.dataset.w; img.style.height = 'auto'; }
      window.dispatchEvent(new Event('resize')); // nudge the handle back into place
    };
  });
  // Inline images get the same corner drag handle as swappable ones (stage=false:
  // the surrounding field's commit persists the change).
  const handle = enableImageDragResize(img, null, false);
  const away = (e) => {
    if (!pop.contains(e.target) && e.target !== img && !e.target.closest('.kiln-img-handle')) {
      pop.remove(); handle.remove(); document.removeEventListener('click', away, true);
    }
  };
  setTimeout(() => document.addEventListener('click', away, true), 0);
}

function decorateField(el, key) {
  if (el.hasAttribute(SOURCE_ATTR)) return;   // §4.3: data-kiln-source wins, on every decorate path
  el.classList.add('kiln-field');
  el.title = fieldHint(key);
  // A first baseline, so that there always is one (keys inside repeats stage
  // via their container, so they have none of their own). It is what the file
  // would hold, and it is taken again when the person begins (beginKey): the
  // page is still arriving now, and this copy must never be the one Undo shows.
  if (!el.closest('[data-cms-repeat]') && elementForKey(key) === el) takeBase(state, key, { html: baseHtml(el), attrs: readAttrs(el, ownStyle(el)) });
  // One click handler per element, however often it is decorated: a list that
  // is written again keeps its blocks, and a part can be made editable, un-made
  // and made editable again. The handler reads the field's name as it is now.
  if (decorated.has(el)) return;
  decorated.add(el);
  el.addEventListener('click', (e) => {
    const key = el.getAttribute('data-cms');
    if (!key) return;   // no longer editable: an ordinary part of the page again
    // Cmd/Ctrl+click on a link follows it even in edit mode.
    if ((e.metaKey || e.ctrlKey) && e.target.closest('a')) return;
    if (el.getAttribute('data-cms-attr') === 'src' && el.tagName === 'IMG') {
      e.preventDefault(); e.stopPropagation();
      imageToolbar(el, key);
      return;
    }
    e.preventDefault(); e.stopPropagation();
    if (state.active !== el) startEditing(el, key);
    // An image inside this rich-text field: open its size/remove popover right
    // here. The document-level fallback (init's IMG click listener) never sees
    // this click because of the stopPropagation above — which used to make
    // inline images un-resizable once their insert-time popover closed.
    if (state.active === el && e.target.tagName === 'IMG' && e.target !== el) inlineImgPopover(e.target);
  });
}

/**
 * The person begins to change a part: what Undo goes back to is what the part
 * holds now, unless a change to it is already waiting (baselines.js). `el` is
 * the field, or anything in a list.
 */
function beginKey(key, el) {
  const picture = el.tagName === 'IMG' && el.hasAttribute('data-cms');
  const list = el.closest('[data-cms-repeat]');
  if (list) {
    if (picture) beginOn(el);
    const k = list.getAttribute('data-cms-repeat');
    // Not while a field of the list is being typed in: that edit began with the list as it was.
    if (!state.pending.has(k) && !previewing.has(k) && !(state.active && list.contains(state.active))) state.undoBase.set(k, containerCleanHtml(list).innerHTML);
    return;
  }
  if (state.active === el || previewing.has(key)) return;
  takeBase(state, key, { html: baseHtml(el), attrs: readAttrs(el, ownStyle(el)) });
  if (picture) beginOn(el);   // from here on, a change to its size is the person's
}

/** A press anywhere on an editable part or a list, before any handler acts on it. */
function beginUnder(e) {
  const at = e.target instanceof Element ? e.target : null;
  if (!at || (state.active && state.active.contains(at)) || at.closest('#kiln-modal, #kiln-toolbar')) return;
  const add = at.closest('.kiln-repeat-add[data-kiln-add]');
  const list = add ? document.querySelector(`[data-cms-repeat="${CSS.escape(add.dataset.kilnAdd)}"]`) : at.closest('[data-cms-repeat]');
  if (list) { if (list.classList.contains('kiln-repeat')) beginKey(null, at.closest('img[data-cms]') || list); return; }
  const field = at.closest('[data-cms]');
  if (field && decorated.has(field) && field.hasAttribute('data-cms')) beginKey(field.getAttribute('data-cms'), field);
}
document.addEventListener('pointerdown', beginUnder, true);

/**
 * What hovering an editable part says: its name as a person reads it. The
 * owner, who gave the field its name, sees that name beside it.
 */
function fieldHint(key) {
  return mode === 'admin' ? `Edit: ${readableName(key)} (${key})` : `Edit: ${readableName(key)}`;
}

// ─── A tap on something that cannot be changed here (not-here.js) ────────────

/** Every editable part of the page, as findTwin reads them. */
function twinFields() {
  const out = [];
  for (const el of document.querySelectorAll('.kiln-field[data-cms]')) {
    if (isKilnChrome(el) || el.classList.contains('kiln-source-locked')) continue;
    const link = el.closest('a[href]');
    out.push({ el, key: el.getAttribute('data-cms'), list: el.closest('[data-cms-repeat]')?.getAttribute('data-cms-repeat') || null,
      words: el.tagName === 'IMG' ? '' : el.innerText, href: link ? link.href : null });
  }
  return out;
}

/**
 * A press on a part of the page that is not editable. Nothing happens to it
 * here. Where the editor can tell it shows the same thing as a part that can
 * be changed, the line says so and offers to go there; a link is held back
 * only then, and only when the very words are the same (Ctrl or ⌘ and a click
 * still follows it). An unmarked part of an editable block is said to be
 * that. Everything else is the page's own, as it was.
 */
function tapNotHere(e) {
  if (state.active || sourceActive || pickMode || e.metaKey || e.ctrlKey) return;
  const at = e.target instanceof Element ? e.target : null;
  if (!at || !document.getElementById('kiln-status') || document.documentElement.classList.contains('kiln-cmt-placing')) return;
  if (at.closest(KILN_CHROME) || at.closest('[data-cms], [data-kiln-source], input, textarea, select, button, label, summary, [contenteditable="true"]')) return;
  if (!document.querySelector('.kiln-field')) return;   // nothing on this page is this person's to change
  const picture = /^(IMG|PICTURE|VIDEO|CANVAS)$/.test(at.tagName) || !!at.closest('svg');
  // What was pressed: a picture, or an element with words of its own (not a whole section).
  const own = [...at.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim());
  const words = !picture && own ? at.innerText : '';
  if (!picture && !words) return;
  // An unmarked part of a block whose other parts are editable: said to be that. The page's own behaviour stays.
  if (at.closest('.kiln-repeat-item')) { setStatus(notHereWords({ inBlock: true, picture }), 'idle', { hold: 9000 }); return; }
  const link = at.closest('a[href]');
  const nav = !!at.closest('nav, header, footer, [role="navigation"], [role="menu"], [role="menubar"]');
  const twin = findTwin({ words, href: link ? link.href : null, nav }, twinFields());
  if (twin) {
    const where = twin.same === 'place' ? (twin.field.el.closest('.kiln-repeat-item') || twin.field.el) : twin.field.el;
    if (twin.same === 'words') {
      // The same words, where they can be changed: the person is sent there, not to wherever the link goes.
      e.preventDefault();
      e.stopPropagation();
    }
    setStatus(notHereWords({ same: twin.same, name: readableName(twin.field.key), list: twin.field.list ? readableName(twin.field.list) : null }), 'idle',
      { hold: 12000, action: { label: 'Show me', title: 'Go to the part that can be changed', run: () => showChanged(where, 1600) } });
  }
}
document.addEventListener('click', tapNotHere, true);

// ─── Repeatable blocks ───────────────────────────────────────────────────────

function setupRepeat(container, key) {
  container.classList.add('kiln-repeat');
  // Re-runnable: drop this list's add/options buttons from a previous setup.
  // They're matched by key, NOT by scope — for tables the add button is parked
  // AFTER the table, so a scope-only cleanup let them pile up on every undo.
  document.querySelectorAll(`.kiln-repeat-add[data-kiln-add="${CSS.escape(key)}"]`).forEach(n => n.remove());
  container.querySelectorAll(':scope > .kiln-repeat-add').forEach(n => n.remove());
  if (!state.undoBase.has(key)) state.undoBase.set(key, containerCleanHtml(container).innerHTML);
  [...container.children].forEach((item) => attachItemControls(container, key, item));
  renderTagPreview(container);   // show filter pills if any block is already tagged

  // A visible "+ Add" so adding a card/document doesn't depend on discovering
  // the hover controls. It clones the last block, ready to edit.
  const add = document.createElement('button');
  add.className = 'kiln-repeat-add';
  add.dataset.kilnAdd = key;
  add.textContent = '+ Add block';
  add.onclick = (e) => {
    e.stopPropagation();
    const last = [...container.children].filter(c => !c.classList.contains('kiln-repeat-add')).pop();
    if (!last) return;
    const clone = last.cloneNode(true);
    noteCopy(last, clone);   // published as the file has the block it was copied from
    clone.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, #kiln-toolbar').forEach(n => n.remove());
    clone.classList.remove('kiln-repeat-item');
    clone.querySelectorAll('[data-cms]').forEach(n => {
      n.classList.remove('kiln-field', 'kiln-editing', 'kiln-modified');
      n.removeAttribute('contenteditable');
    });
    if (add.parentElement === container) container.insertBefore(clone, add);
    else container.appendChild(clone);
    clone.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
    attachItemControls(container, key, clone);
    stageContainer(container, key);
    clone.scrollIntoView({ behavior: 'smooth', block: 'center' });
    clone.classList.add('kiln-flash');
    setTimeout(() => clone.classList.remove('kiln-flash'), 1600);
    setStatus('Block added — click its text to edit, then Publish', 'saved');
  };
  // Galleries and event lists are specialized repeats: adding gets a native
  // flow (multi-photo picker / structured event form) instead of clone-the-last.
  if (container.hasAttribute('data-kiln-gallery')) {
    // The visitor runtime (features.js) applies the thumbnail grid, but it
    // stands down during editing sessions — so the editor applies it itself,
    // or editors would see every photo full-size.
    container.classList.add('kiln-gallery-grid');
    applyGalleryThumb(container);
    add.textContent = '+ Add photos';
    add.onclick = (e) => { e.stopPropagation(); addGalleryPhotos(container, key, add); };
    const opts = document.createElement('button');
    opts.type = 'button';
    opts.className = 'kiln-repeat-add kiln-gallery-opts';
    opts.dataset.kilnAdd = key;
    opts.textContent = '⚙ Gallery options';
    opts.onclick = (e) => { e.stopPropagation(); galleryOptionsPanel(container, key); };
    container.appendChild(opts);
  } else if (container.hasAttribute('data-kiln-events')) {
    add.textContent = '+ Add event';
    add.onclick = (e) => { e.stopPropagation(); eventForm(container, key, null); };
  }

  // A <button> is not valid table content — for table-section repeats (e.g.
  // <tbody data-cms-repeat>) park the add button after the table itself so the
  // browser doesn't foster-parent it out of position.
  if (['TBODY', 'THEAD', 'TFOOT', 'TABLE', 'TR'].includes(container.tagName)) {
    const table = container.closest('table') || container;
    table.after(add);
  } else {
    container.appendChild(add);
  }
}

function attachItemControls(container, key, item) {
  if (item.querySelector(':scope > .kiln-item-ctl, :scope > .kiln-ctl-cell')) return;
  item.classList.add('kiln-repeat-item');
  const ctl = document.createElement('div');
  ctl.className = 'kiln-item-ctl';
  const isEvents = container.hasAttribute('data-kiln-events');
  ctl.innerHTML = `<button title="Move up">↑</button><button title="Move down">↓</button>`
    + `<button title="Duplicate this block">＋</button>`
    + (isEvents ? '<button title="Edit event details (date, time, location…)">📅</button>' : '')
    + `<button title="Tags — visitors get filter buttons for tagged lists">🏷</button>`
    + `<button title="Remove this block">✕</button>`;
  // A block is often a link (a product card that opens its page). Pressing one
  // of its buttons must not follow that link too: stopping the click on its
  // way up does not stop the browser from opening the address.
  ctl.addEventListener('click', (e) => e.preventDefault(), true);
  const btns = ctl.querySelectorAll('button');
  const [up, down, dup] = btns;
  const evBtn = isEvents ? btns[3] : null;
  const tagBtn = btns[isEvents ? 4 : 3];
  const del = btns[btns.length - 1];
  if (evBtn) evBtn.onclick = (e) => { e.stopPropagation(); eventForm(container, key, item); };
  tagBtn.onclick = (e) => { e.stopPropagation(); editItemTags(container, key, item); };
  const realSiblings = () => [...container.children].filter(c => !c.classList.contains('kiln-repeat-add'));
  up.onclick = (e) => {
    e.stopPropagation();
    const prev = item.previousElementSibling;
    if (prev && !prev.classList.contains('kiln-repeat-add')) {
      container.insertBefore(item, prev);
      stageContainer(container, key);
    }
  };
  down.onclick = (e) => {
    e.stopPropagation();
    const sibs = realSiblings();
    const next = item.nextElementSibling;
    if (next && sibs.includes(next)) {
      container.insertBefore(next, item);
      stageContainer(container, key);
    }
  };
  dup.onclick = (e) => {
    e.stopPropagation();
    const clone = item.cloneNode(true);
    noteCopy(item, clone);   // published as the file has the block it was copied from
    clone.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, #kiln-toolbar').forEach(n => n.remove());
    clone.classList.remove('kiln-repeat-item');
    clone.querySelectorAll('[data-cms]').forEach(n => {
      n.classList.remove('kiln-field', 'kiln-editing', 'kiln-modified');
      n.removeAttribute('contenteditable');
    });
    item.after(clone);
    clone.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
    attachItemControls(container, key, clone);
    stageContainer(container, key);
  };
  del.onclick = (e) => {
    e.stopPropagation();
    if (realSiblings().length <= 1) { setStatus('A list keeps at least one block. Change this one instead.', 'error'); return; }
    // No question first: the block is gone at once, and one press brings it
    // back, as "Published. Undo" does for a publish. (The browser's own box
    // used to ask here, and told people the way back was to leave the page.)
    closeItemControls();          // it comes back with its buttons folded away, as it was found
    item.remove();
    keepAside(container, item);   // Undo puts this very block back
    stageContainer(container, key);
    setStatus('Removed.', 'saved', { hold: removedHold(), tag: 'removed', action: { label: 'Undo', title: 'Put the block back', run: undoEdit } });
  };
  // Phones: five thumb-sized buttons on every card buries the page under
  // controls, and on a two-column grid they would not even fit. There each
  // block shows one "more" button, and its bar opens on a tap — one bar at a
  // time. (Added after the buttons above were picked out by position; the
  // stylesheet hides it on desktop, where the bar appears on hover.)
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'kiln-ctl-more';
  more.title = 'Block options';
  more.setAttribute('aria-label', 'Block options');
  more.setAttribute('aria-expanded', 'false');
  more.textContent = '⋯';
  more.onclick = (e) => {
    e.stopPropagation(); e.preventDefault();
    const open = !ctl.classList.contains('kiln-ctl-open');
    closeItemControls();
    ctl.classList.toggle('kiln-ctl-open', open);
    // A row of its own under the block's words, unless the block lays its
    // children out side by side on one line: a full-width row would crush them.
    const cs = getComputedStyle(item);
    const oneLine = /flex/.test(cs.display) && !cs.flexDirection.startsWith('column') && cs.flexWrap === 'nowrap';
    ctl.classList.toggle('kiln-ctl-flow', open && item.tagName !== 'TR' && !oneLine);
    more.setAttribute('aria-expanded', String(open));
  };
  ctl.prepend(more);
  // A <div> is not valid inside <tr> — anchor the controls in the row's last
  // cell instead so table rows get working move/duplicate/remove buttons too.
  if (item.tagName === 'TR') {
    // Never put controls inside a cell — the last cell is usually an editable
    // field, so the buttons would cover the text being typed and their glyphs
    // (↑↓＋🏷✕) would be swept into the committed value. A dedicated cell keeps
    // them out of every field; containerCleanHtml strips it before staging.
    const cell = document.createElement('td');
    cell.className = 'kiln-ctl-cell';
    cell.appendChild(ctl);
    item.appendChild(cell);
  } else {
    item.appendChild(ctl);
  }

  // Drag to reorder (↑↓ still work; this is for mouse users)
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    if (state.active) { e.preventDefault(); return; }
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('kiln-dragging');
  });
  item.addEventListener('dragend', () => item.classList.remove('kiln-dragging'));
  item.addEventListener('dragover', (e) => {
    e.preventDefault();
    const dragging = container.querySelector('.kiln-dragging');
    if (!dragging || dragging === item) return;
    const r = item.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    container.insertBefore(dragging, before ? item : item.nextSibling);
  });
  item.addEventListener('drop', (e) => {
    e.preventDefault();
    stageContainer(container, key);
  });
}

/** Fold every block's control bar back to its "more" button (phones). */
function closeItemControls() {
  document.querySelectorAll('.kiln-item-ctl.kiln-ctl-open').forEach((c) => {
    c.classList.remove('kiln-ctl-open', 'kiln-ctl-flow');
    c.querySelector('.kiln-ctl-more')?.setAttribute('aria-expanded', 'false');
  });
}
// A tap anywhere else folds an open bar away. Capture phase: a tap on a field
// is stopped by the field's own handler before it could bubble up to here.
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.kiln-item-ctl')) closeItemControls();
}, true);

/** Comma-tags on a repeat block → visitors get automatic filter pills. */
function editItemTags(container, key, item) {
  const cur = item.getAttribute('data-kiln-tags') || '';
  const m = modal(`
    <h3>Tags for this block</h3>
    <p class="kiln-dim">Comma-separated, e.g. <code>new, used, upcoming</code>. As soon as any block
    in this list has tags, visitors see filter buttons above the list — “All” plus one per tag.</p>
    <label>Tags <input type="text" id="kiln-tags-in" value="${escapeHtml(cur)}" placeholder="new, used, upcoming"></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-tags-go">Save tags</button>
    </div>`);
  m.querySelector('#kiln-tags-go').onclick = () => {
    const v = m.querySelector('#kiln-tags-in').value.split(',').map(s => s.trim()).filter(Boolean).join(', ');
    if (v) item.setAttribute('data-kiln-tags', v);
    else item.removeAttribute('data-kiln-tags');
    stageContainer(container, key);
    renderTagPreview(container);   // pills appear/update immediately
    m.remove();
    setStatus(v ? `Tagged “${v}” — filter buttons preview above the list. Publish to make them live for visitors.` : 'Tags removed — Publish to make it live', 'saved');
  };
}

/**
 * Live preview of the visitor-side filter pills while editing. Real visitors get
 * these from kiln-features.js after publish; the editor (and every always-editing
 * demo visitor) needs to SEE them appear the moment a block is tagged, so we
 * render an editor-owned bar here. It sits OUTSIDE the repeat container, so
 * stageContainer never captures it, and it's rebuilt on every tag change.
 */
function renderTagPreview(container) {
  const anchor = container.closest('table') || container;
  const parent = anchor.parentElement;
  if (!parent) return;
  const existing = parent.querySelector(':scope > .kiln-filterbar-preview');
  const items = [...container.children].filter(c => !c.classList.contains('kiln-repeat-add'));
  const tags = [];
  for (const it of items) for (const t of (it.getAttribute('data-kiln-tags') || '').split(',').map(s => s.trim()).filter(Boolean)) {
    if (!tags.includes(t)) tags.push(t);
  }
  if (!tags.length) { existing?.remove(); return; }
  const bar = existing || document.createElement('div');
  bar.className = 'kiln-filterbar-preview';
  bar.innerHTML = `<span class="kiln-fp-label">Filter preview</span>`;
  const mk = (label, tag) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'kiln-fp-pill'; b.textContent = label;
    if (tag === null) b.classList.add('kiln-fp-on');
    b.onclick = (e) => {
      e.stopPropagation();
      bar.querySelectorAll('.kiln-fp-pill').forEach(p => p.classList.remove('kiln-fp-on'));
      b.classList.add('kiln-fp-on');
      for (const it of items) {
        const mine = (it.getAttribute('data-kiln-tags') || '').split(',').map(s => s.trim());
        it.style.display = (!tag || mine.includes(tag)) ? '' : 'none';
      }
    };
    return b;
  };
  bar.appendChild(mk('All', null));
  tags.forEach(t => bar.appendChild(mk(t, t)));
  if (!existing) parent.insertBefore(bar, anchor);
}

/** Gallery repeats get a native multi-photo picker instead of clone-the-last-block. */
/** Gallery thumbnail size lives on the container as data-kiln-thumb (px). */
function applyGalleryThumb(container) {
  const t = parseInt(container.getAttribute('data-kiln-thumb'), 10);
  if (t) container.style.setProperty('--kiln-thumb', t + 'px');
  else container.style.removeProperty('--kiln-thumb');
}

function galleryOptionsPanel(container, key) {
  const cur = parseInt(container.getAttribute('data-kiln-thumb'), 10) || 180;
  const SIZES = [
    { v: 120, label: 'Small', hint: 'more photos per row' },
    { v: 180, label: 'Medium', hint: 'the default' },
    { v: 260, label: 'Large', hint: 'fewer, bigger thumbnails' },
  ];
  const m = modal(`
    <h3>Gallery options</h3>
    <p class="kiln-dim">Photos always show as a grid of thumbnails — visitors click one to open it
    full-screen with next/previous arrows.</p>
    <div class="kiln-roles">
      ${SIZES.map(s => `<label class="kiln-role"><input type="radio" name="kiln-gal-thumb" value="${s.v}" ${s.v === cur ? 'checked' : ''}>
        <span><strong>${s.label} thumbnails</strong><br><small>${s.hint}</small></span></label>`).join('')}
    </div>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-gal-go">Apply</button>
    </div>`);
  m.querySelector('#kiln-gal-go').onclick = () => {
    // A hand-set data-kiln-thumb (e.g. 200) matches no preset, so nothing is
    // checked — fall back to the current value instead of dereferencing null.
    const checked = m.querySelector('input[name="kiln-gal-thumb"]:checked');
    const v = checked ? checked.value : String(cur);
    container.setAttribute('data-kiln-thumb', v);
    applyGalleryThumb(container);
    if (!cfg.sandbox) stagePending(key, { attrs: { 'data-kiln-thumb': v } });
    m.remove();
    setStatus(cfg.sandbox ? 'Thumbnail size changed' : 'Thumbnail size changed — Publish to make it live', 'saved');
  };
}

function addGalleryPhotos(container, key, add) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    try {
      for (let i = 0; i < files.length; i++) {
        setStatus(`Uploading photo ${i + 1}/${files.length}…`, 'saving');
        const scaled = await downscale(files[i]);
        const fig = document.createElement('figure');
        const img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        if (cfg.sandbox) {
          if (refusedByDemo(scaled)) return;
          img.src = `data:${scaled.type};base64,${scaled.base64}`;
        } else {
          const slug = files[i].name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'photo';
          const name = `${slug}-${Date.now().toString(36)}-${i}.${scaled.ext}`;
          const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
          stageBinary(repoPath, scaled.base64);   // committed with Publish, not now
          img.src = URL.createObjectURL(scaled.blob);
          img.setAttribute('data-kiln-src', `/assets/uploads/${name}`);
        }
        const cap = document.createElement('figcaption');
        cap.setAttribute('data-cms', 'gallery_caption');
        fig.appendChild(img);
        fig.appendChild(cap);
        if (add.parentElement === container) container.insertBefore(fig, add);
        else container.appendChild(fig);
        decorateField(cap, 'gallery_caption');
        attachItemControls(container, key, fig);
      }
      stageContainer(container, key);
      setStatus(`${files.length} photo${files.length > 1 ? 's' : ''} added — Publish to put them live`, 'saved');
    } catch (err) {
      console.error('[kiln] gallery upload', err);
      setStatus('Photo upload failed', 'error');
    }
  };
  input.click();
}

/** Structured add/edit for events — writes the canonical event block markup. */
function eventForm(container, key, item) {
  const cur = { title: '', date: '', start: '', end: '', loc: '', link: '', desc: '' };
  if (item) {
    const times = item.querySelectorAll('time[datetime]');
    const dt = times[0]?.getAttribute('datetime') || '';
    cur.date = dt.slice(0, 10);
    cur.start = dt.slice(11, 16);
    cur.end = (times[1]?.getAttribute('datetime') || '').slice(11, 16);
    cur.title = item.querySelector('.kiln-ev-title, h1, h2, h3, h4')?.textContent.trim() || '';
    cur.loc = item.querySelector('.kiln-ev-loc')?.textContent.trim() || '';
    cur.link = item.querySelector('a.kiln-ev-link')?.getAttribute('href') || '';
    cur.desc = item.querySelector('.kiln-ev-desc')?.textContent.trim() || '';
  }
  const m = modal(`
    <h3>${item ? 'Edit event' : 'New event'}</h3>
    <label>Title <input type="text" id="kiln-ev-title" value="${escapeHtml(cur.title)}" placeholder="What's happening?"></label>
    <div class="kiln-2col">
      <label>Date <input type="date" id="kiln-ev-date" value="${cur.date}"></label>
      <label>Start time <input type="time" id="kiln-ev-start" value="${cur.start}"></label>
    </div>
    <div class="kiln-2col">
      <label>End time (optional) <input type="time" id="kiln-ev-end" value="${cur.end}"></label>
      <label>Location <input type="text" id="kiln-ev-loc" value="${escapeHtml(cur.loc)}" placeholder="Where?"></label>
    </div>
    <label>Link (tickets, Zoom, details — optional) <input type="text" id="kiln-ev-link" value="${escapeHtml(cur.link)}" placeholder="https://…"></label>
    <label>Details (optional) <input type="text" id="kiln-ev-desc" value="${escapeHtml(cur.desc)}"></label>
    <p class="kiln-np-step" id="kiln-ev-status" role="status"></p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-ev-go">${item ? 'Save event' : 'Add event'}</button>
    </div>`);
  m.querySelector('#kiln-ev-go').onclick = () => {
    const v = (id) => m.querySelector('#kiln-ev-' + id).value.trim();
    const title = v('title'), date = v('date'), start = v('start');
    // Something is missing: say what, and put the cursor there. It used to do nothing at all.
    const lacks = missingEvent({ title, date });
    if (lacks) {
      m.querySelector('#kiln-ev-status').textContent = lacks.say;
      m.querySelector('#kiln-ev-' + lacks.at).focus();
      return;
    }
    const startIso = `${date}T${start || '00:00'}`;
    // No start time → an all-day event. Emit a DATE-ONLY datetime so the visitor
    // calendar renders it as all-day; a "…T00:00" value would show a bogus
    // "12:00 AM" chip (features.js only treats date-only values as all-day).
    const startAttr = start ? startIso : date;
    const endIso = v('end') ? `${date}T${v('end')}` : '';
    const dateLabel = new Date(startIso).toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const timeLabel = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const when = `<time datetime="${startAttr}">${escapeHtml(dateLabel)}${start ? ' · ' + escapeHtml(timeLabel(startIso)) : ''}</time>`
      + (endIso ? ` – <time datetime="${endIso}">${escapeHtml(timeLabel(endIso))}</time>` : '');
    const html = `
      <h3 class="kiln-ev-title" data-cms="ev_title">${escapeHtml(title)}</h3>
      <p class="kiln-ev-when">${when}</p>
      ${v('loc') ? `<p class="kiln-ev-loc" data-cms="ev_loc">${escapeHtml(v('loc'))}</p>` : ''}
      ${v('desc') ? `<p class="kiln-ev-desc" data-cms="ev_desc">${escapeHtml(v('desc'))}</p>` : ''}
      ${v('link') ? `<p><a class="kiln-ev-link" href="${escapeHtml(safeUrl(v('link')))}">More info →</a></p>` : ''}`;
    let target = item;
    if (!target) {
      target = document.createElement('article');
      target.className = 'kiln-event';
      // Insert in date order among existing events (list view shows DOM order).
      const startDate = new Date(startIso);
      const siblings = [...container.children].filter(c => !c.classList.contains('kiln-repeat-add'));
      const after = siblings.find(s => {
        const t = s.querySelector('time[datetime]');
        return t && new Date(t.getAttribute('datetime')) > startDate;
      });
      if (after) container.insertBefore(target, after);
      else {
        const add = [...container.children].find(c => c.classList?.contains('kiln-repeat-add'));
        if (add) container.insertBefore(target, add); else container.appendChild(target);
      }
    }
    target.innerHTML = html;
    target.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
    attachItemControls(container, key, target);
    stageContainer(container, key);
    m.remove();
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('kiln-flash');
    setTimeout(() => target.classList.remove('kiln-flash'), 1600);
    setStatus(`Event ${item ? 'updated' : 'added'} — Publish to make it live`, 'saved');
  };
}

/** Stage a repeat container's full cleaned innerHTML as one pending edit. */
/** A repeat container's content with every Kiln editing artifact stripped —
 *  the exact HTML that staging/publishing would write for it. */
function containerCleanHtml(container) {
  // As the file has each block, plus what the editor changed: not what the
  // site's own scripts have done to it since the page opened (file-state.js).
  const copy = container.cloneNode(true);
  fileTrue(copy, container);
  return cleanBlocks(copy);
}

/**
 * Note, for every list on the page, what the page's file says of its blocks.
 * Run whenever the file is read: when editing starts, and after each publish
 * and each undo of one, when the file has just become what was published.
 */
function noteFileLists() {
  for (const list of document.querySelectorAll('[data-cms-repeat]')) {
    if (isKilnChrome(list)) continue;
    const f = state.fields.fields.get(list.getAttribute('data-cms-repeat'));
    if (f?.inner) noteList(list, state.page.text.slice(f.inner.start, f.inner.end));
  }
}

/** The fields of this page that are not in a list, once each. */
function loneFields() {
  const seen = new Set(), out = [];
  for (const el of document.querySelectorAll('[data-cms]')) {
    const key = el.getAttribute('data-cms');
    if (seen.has(key) || isKilnChrome(el) || el.hasAttribute(SOURCE_ATTR) || el.closest('[data-cms-repeat]')) continue;
    seen.add(key);
    out.push([key, el]);
  }
  return out;
}

/**
 * The same for every field that is not in a list: what the file says is
 * inside it. A field with a change waiting, or being typed in, keeps what was
 * noted for it: that is what its change is measured against.
 */
function noteFileFields() {
  for (const [key, el] of loneFields()) {
    if (state.pending.has(key) || state.active === el) continue;
    const f = state.fields.fields.get(key);
    if (f?.inner) noteInside(el, state.page.text.slice(f.inner.start, f.inner.end));
    else if (f?.range && el.tagName === 'IMG') noteOwn(el, state.page.text.slice(f.range.start, f.range.end));
  }
}

/** What the file says of a picture that is a field: its own tag, as the file has it. */
function noteOwn(el, tagHtml, style) {
  const t = document.createElement('template');
  t.innerHTML = tagHtml;
  const as = t.content.firstElementChild;
  if (!as || as.tagName !== el.tagName) return;
  if (style !== undefined) { if (style) as.setAttribute('style', style); else as.removeAttribute('style'); }
  noteAs(el, as.cloneNode(false));
}

/**
 * The demo has no repository. Its "file" is the page as the site serves it
 * (read once), or, for a part this visitor has published in the demo, what
 * that publish holds.
 */
let servedPage = null;
async function readServedPage() {
  try {
    if (!servedPage) {
      const res = await fetch(location.pathname + location.search);
      if (!res.ok) return null;
      const text = await res.text();
      servedPage = { text, fields: indexHtml(text).fields };
    }
  } catch { return null; }   // the page could not be read again: parts are published as they are on the page, as before
  return servedPage;
}
async function noteSandboxLists() {
  if (!await readServedPage()) return;
  const mine = sandboxStore().pages?.[sandboxPath()] || {};
  for (const list of document.querySelectorAll('[data-cms-repeat]')) {
    if (isKilnChrome(list)) continue;
    const key = list.getAttribute('data-cms-repeat');
    const f = servedPage.fields.get(key);
    const html = mine[key]?.html ?? (f?.inner ? servedPage.text.slice(f.inner.start, f.inner.end) : null);
    if (html == null || !noteList(list, html)) continue;
    // What Undo goes back to is the list as the file has it, too.
    if (!state.pending.has(key)) state.undoBase.set(key, containerCleanHtml(list).innerHTML);
  }
  for (const [key, el] of loneFields()) {
    if (state.pending.has(key) || state.active === el) continue;
    const f = servedPage.fields.get(key);
    const html = mine[key]?.html ?? (f?.inner ? servedPage.text.slice(f.inner.start, f.inner.end) : null);
    if (html != null && noteInside(el, html)) takeBase(state, key, { html: baseHtml(el) });
    if (!f?.inner && f?.range && el.tagName === 'IMG') {
      noteOwn(el, servedPage.text.slice(f.range.start, f.range.end), mine[key]?.attrs?.style);
      takeBase(state, key, { attrs: readAttrs(el, ownStyle(el)) });
    }
  }
}

/**
 * A demo an earlier editor stored. That editor kept a field's HTML as it was
 * on the page, with what the site's scripts had put on it: a headline could
 * be stored at the start of its entrance animation, which is invisible, and
 * was then shown that way at every visit. Once per page, before anything
 * stored is put on the page, each stored field (and what the demo's History
 * holds of it) is read as the page's file would have it.
 */
async function healSandboxStore() {
  const path = sandboxPath();
  if (sandboxWasEmpty || sandboxStore()._asFile?.[path]) return;
  // Not for long: on a line too slow to read the page again, the demo opens as it was stored.
  if (!await Promise.race([readServedPage(), new Promise(resolve => setTimeout(() => resolve(null), 2500))])) return;
  const s = sandboxStore();
  const mend = (key, html) => {
    const el = elementForKey(key), f = servedPage.fields.get(key);
    if (!el || el.getAttribute('data-cms') !== key || el.closest('[data-cms-repeat]') || !f?.inner || typeof html !== 'string') return html;
    return asFileHtml(el, html, servedPage.text.slice(f.inner.start, f.inner.end));
  };
  for (const [key, v] of Object.entries(s.pages?.[path] || {})) if (v && typeof v.html === 'string') v.html = mend(key, v.html);
  for (const entry of s.history?.[path] || []) {
    for (const [key, was] of Object.entries(entry.before || {})) if (typeof was?.html === 'string') was.html = mend(key, was.html);
  }
  s._asFile = { ...(s._asFile || {}), [path]: 1 };
  sandboxSave(s);
}

/** The same, on a detached copy, in place. */
function cleanBlocks(clone) {
  clone.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, #kiln-toolbar, .kiln-repeat-add').forEach(n => n.remove());
  clone.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
  clone.querySelectorAll('.kiln-field, .kiln-editing, .kiln-modified, .kiln-repeat-item, .kiln-row-editing, .kiln-flash, .kiln-dragging').forEach(n => {
    n.classList.remove('kiln-field', 'kiln-editing', 'kiln-modified', 'kiln-repeat-item', 'kiln-row-editing', 'kiln-flash', 'kiln-dragging');
    if (n.getAttribute('class') === '') n.removeAttribute('class');
    if (n.hasAttribute('data-cms')) n.removeAttribute('title');
    n.removeAttribute('draggable');
  });
  // Any leftover Kiln scope-note title (set on non-decorated out-of-scope nodes).
  clone.querySelectorAll('[title="Not in your editing scope"]').forEach(n => n.removeAttribute('title'));
  clone.querySelectorAll('img[data-kiln-src]').forEach(img => {
    img.setAttribute('src', img.getAttribute('data-kiln-src'));
    img.removeAttribute('data-kiln-src');
  });
  return clone;
}

/** A detached copy of a list, left the way its HTML is staged: cleaned, then sanitized. */
function tidyBlocks(box) {
  cleanBlocks(box);
  DOMPurify.sanitize(box, { ...CONTAINER_SANITIZE, IN_PLACE: true });
}

function stageContainer(container, key) {
  const clone = containerCleanHtml(container);
  // Sanitize the cloned NODE in place rather than round-tripping through a
  // string: DOMPurify's string mode re-parses the fragment in <body> context,
  // where the HTML parser itself drops table tags (<tr>, <td>…) before the
  // allowlist is even consulted — that's what flattened a customer's
  // <tbody data-cms-repeat> schedule. IN_PLACE keeps the real tree.
  const hadChildren = clone.children.length;
  DOMPurify.sanitize(clone, { ...CONTAINER_SANITIZE, IN_PLACE: true });
  const html = clone.innerHTML;

  // Guard: if sanitizing still dropped the block's element structure (an
  // allowlist gap — e.g. a tag we didn't anticipate), REFUSE to stage rather
  // than publish flattened text that would permanently destroy the block.
  if (hadChildren && !clone.children.length) {
    console.error('[kiln] refusing to stage: sanitizing flattened block structure', { key, html });
    setStatus('This block uses markup Kiln couldn’t safely keep — edit NOT staged. Please report this.', 'error');
    return;
  }

  container.classList.add('kiln-modified');
  stagePending(key, { html });
}

function startEditing(el, key) {
  // COMMIT the previous field, don't cancel it. Clicking from one field straight
  // into another never reaches the document-level click-away commit (the new
  // field's handler stops propagation), so cancelling here silently REVERTED the
  // first field's edit. Click-away semantics are "save"; Esc is the revert.
  if (state.active && state.active !== el) commitEdit(state.active, state.active.getAttribute('data-cms'));
  // Same rule for an in-progress source-field edit (its own click-away never
  // fires either — this handler stopped propagation).
  if (sourceActive) commitSourceEdit({ away: true });
  // What Undo goes back to is the part as it is now, when the person begins
  // (not as it was when the editor started, mid-animation), and from here on
  // a change to an element inside it is the person's, not a script's.
  beginKey(key, el);
  beginInside(el);
  rememberInside(el);
  state.active = el;
  // THIS element's own pre-edit content, for a correct Esc/cancel. A name
  // repeats across the blocks of a list, so a map keyed by it would paste a
  // sibling block's text into this one.
  activeOriginalHtml = baseHtml(el);
  // Keep this row's floating controls out of the way while typing in it.
  el.closest('.kiln-repeat-item')?.classList.add('kiln-row-editing');
  el.classList.add('kiln-editing');
  el.contentEditable = 'true';
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  renderToolbar(el, key);
}

function cancelEditing() {
  const el = state.active;
  if (!el) return;
  const key = el.getAttribute('data-cms');
  el.contentEditable = 'false';
  el.classList.remove('kiln-editing');
  el.closest('.kiln-repeat-item')?.classList.remove('kiln-row-editing');
  // Restore THIS element's own content: its pending value if it isn't inside a
  // repeat (repeat fields stage under the container, never their own key), else
  // its captured pre-edit HTML — never the shared-key map, which holds a
  // sibling block's text.
  const inRepeat = !!el.closest('[data-cms-repeat]');
  const pendingEdit = inRepeat ? null : state.pending.get(key);
  const back = pendingEdit?.html ?? activeOriginalHtml;
  // Not innerHTML: the elements that are there stay, with what the site's
  // scripts did to them, and one typed away comes back as itself (keep-inside.js).
  if (back != null) writeInside(el, back);
  state.active = null;
  activeOriginalHtml = null;
  removeToolbar();
}

function stagePending(key, patch, opts = {}) {
  const prev = state.pending.get(key);
  // Undo step: exact pending-map state before/after, plus the DOM values to
  // show for each direction (before = last staged value, else the baseline).
  let step = null;
  if (!opts.noUndo) {
    step = { key, prevEntry: prev ? JSON.parse(JSON.stringify(prev)) : undefined };
    if (patch.html !== undefined) {
      step.beforeHtml = prev?.html !== undefined ? prev.html : state.undoBase.get(key);
      step.afterHtml = patch.html;
    }
    if (patch.attrs) {
      const base = state.undoBaseAttrs.get(key) || {};
      step.attrsBefore = {}; step.attrsAfter = {};
      for (const [a, v] of Object.entries(patch.attrs)) {
        step.attrsBefore[a] = prev?.attrs?.[a] !== undefined ? prev.attrs[a] : base[a];
        step.attrsAfter[a] = v;
      }
    }
  }
  const cur = prev || {};
  if (patch.html !== undefined) cur.html = patch.html;
  if (patch.attrs) cur.attrs = { ...(cur.attrs || {}), ...patch.attrs };
  state.pending.set(key, cur);
  if (step) {
    step.nextEntry = JSON.parse(JSON.stringify(cur));
    if (undoBucket) undoBucket.steps.push(step);
    else pushUndoEntry({ steps: [step] });
  }
  refreshPublishButton();
}

let cameBack = null;   // the block the last write of a list put on the page (applyKeyDom), if there was one

/** Set a field/container's live DOM to `html` and re-wire editing handles. */
function applyKeyDom(key, html) {
  if (html === undefined) return null;
  const esc = CSS.escape(key);
  const rep = document.querySelector(`[data-cms-repeat="${esc}"]`);
  cameBack = null;
  if (rep) {
    const had = new Set(rep.children);
    // Not innerHTML: the blocks that are already there stay the elements they
    // are, with what the site's own scripts did to them (keep-blocks.js).
    writeBlocks(rep, html, tidyBlocks);
    setupRepeat(rep, key);
    rep.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
    // The block that is on the page now and was not: the one to show the person.
    cameBack = [...rep.children].find(c => !had.has(c) && c.classList.contains('kiln-repeat-item')) || null;
    return rep;
  }
  const el = document.querySelector(`[data-cms="${esc}"]`);
  // The same for a field: its elements stay the ones the site's scripts know (keep-inside.js).
  if (el) writeInside(el, html);
  return el;
}

function applyUndoStep(s, dir) {
  if (s.srcRef) {   // a source-mode field edit (only exists once source fields staged)
    const entry = dir === 'before' ? s.prevEntry : s.nextEntry;
    if (entry === undefined) state.pendingSource.delete(s.srcRef);
    else state.pendingSource.set(s.srcRef, { ...entry });
    syncSourceDom(s.srcRef);
    return state.sourceFields?.get(s.srcRef)?.els[0] || null;
  }
  if (s.structural) {   // a section that was added (gallery/events/blocks) — or removed
    // For an ADD, "before" = section gone; for a REMOVAL it's the mirror image.
    // `unstaged` = a pending insert withdrawn via ✕: node AND its insert op
    // travel together (both present "before", both gone "after").
    const wantPresent = (s.structural.removed || s.structural.unstaged) ? dir === 'before' : dir === 'after';
    if (wantPresent) {
      if (s.structural.place) s.structural.place();
      else (document.querySelector('main') || document.body).appendChild(s.structural.node);
    } else {
      s.structural.node.remove();
    }
    const opWanted = s.structural.removed ? !wantPresent : wantPresent;
    const i = s.structural.op ? state.pendingStructural.indexOf(s.structural.op)
      : state.pendingStructural.findIndex(op => op.html === s.structural.html);
    if (opWanted) { if (!cfg.sandbox && s.structural.op && i === -1) state.pendingStructural.push(s.structural.op); }
    else if (i !== -1) state.pendingStructural.splice(i, 1);
    return s.structural.node;
  }
  const entry = dir === 'before' ? s.prevEntry : s.nextEntry;
  if (entry === undefined) state.pending.delete(s.key);
  else state.pending.set(s.key, JSON.parse(JSON.stringify(entry)));
  const el = applyKeyDom(s.key, dir === 'before' ? s.beforeHtml : s.afterHtml);
  const attrs = dir === 'before' ? s.attrsBefore : s.attrsAfter;
  if (attrs) {
    document.querySelectorAll(`[data-cms="${CSS.escape(s.key)}"]`).forEach(n => {
      for (const [a, v] of Object.entries(attrs)) {
        // Undefined "before" for an image-swap attr means it didn't exist —
        // REMOVE it (don't skip), so an undone swap can't leave data-kiln-src
        // behind to be re-committed later. Also retire the orphaned upload.
        if (v === undefined) {
          // (the same for the full-size original a new picture brought with it: dropping the change frees what it held)
          if (a === 'data-kiln-src' || a === 'data-kiln-master') {
            const orphan = n.getAttribute(a);
            if (orphan) for (const p of [...state.pendingBinaries.keys()]) if (p.endsWith(orphan.replace(/^\//, ''))) state.pendingBinaries.delete(p);
            if (orphan) masterBitmaps.delete(orphan);
            n.removeAttribute(a);
          }
        } else if (a === 'style') showStyle(n, v);   // a size put back, with what the site's scripts put on the picture left on it
        else {
          // The demo: another picture is going in this place, and the original held in memory for the one leaving goes with it.
          const held = a === 'src' ? n.getAttribute('data-kiln-master') || '' : '';
          if (held.startsWith('/kiln-demo-master-')) { masterBitmaps.delete(held); n.removeAttribute('data-kiln-master'); }
          n.setAttribute(a, v);
        }
      }
    });
  }
  const modified = state.pending.has(s.key);
  const esc = CSS.escape(s.key);
  document.querySelectorAll(`[data-cms="${esc}"],[data-cms-repeat="${esc}"]`)
    .forEach(n => n.classList.toggle('kiln-modified', modified));
  return el || document.querySelector(`[data-cms="${esc}"],[data-cms-repeat="${esc}"]`);
}

/**
 * Show the person the part that changed: flash it, and move the page only as
 * far as it takes to see it (in-view.js). On a phone the editor's own buttons
 * lie along the bottom and its line of words along the top.
 */
function showChanged(el, ms = 1200) {
  const r = el.getBoundingClientRect();
  const how = whereTo({ top: r.top, bottom: r.bottom }, window.innerHeight, isMobileEditor() ? { top: 56, bottom: 140 } : {});
  if (how !== 'stay') el.scrollIntoView({ behavior: 'smooth', block: how });
  el.classList.add('kiln-flash');
  setTimeout(() => el.classList.remove('kiln-flash'), ms);
}

function undoEdit() {
  // Mid-edit? Commit the field first so the in-progress change becomes the top
  // undo entry — then this undo takes the field back to how it was.
  if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));
  const entry = editHistory.undo.pop();
  if (!entry) { setStatus('Nothing to undo', 'idle'); return; }
  let el = null, block = null;
  for (const s of [...entry.steps].reverse()) { el = applyUndoStep(s, 'before') || el; block = cameBack || block; }
  editHistory.redo.push(entry);
  refreshPublishButton(); updateUndoUi();
  // A block that came back is shown where it is; the page does not go to the middle of its list.
  if (block || el) showChanged(block || el);
  setStatus('Undone', 'saved');
}

function redoEdit() {
  const entry = editHistory.redo.pop();
  if (!entry) { setStatus('Nothing to redo', 'idle'); return; }
  let el = null, block = null;
  for (const s of entry.steps) { el = applyUndoStep(s, 'after') || el; block = cameBack || block; }
  editHistory.undo.push(entry);
  refreshPublishButton(); updateUndoUi();
  if (block || el) showChanged(block || el);
  setStatus('Redone', 'saved');
}

function updateUndoUi() {
  const wrap = document.getElementById('kiln-undo-wrap');
  if (!wrap) return;
  const canUndo = editHistory.undo.length > 0, canRedo = editHistory.redo.length > 0;
  wrap.hidden = !canUndo && !canRedo;
  const u = wrap.querySelector('#kiln-undo-btn'), r = wrap.querySelector('#kiln-redo-btn');
  if (u) u.disabled = !canUndo;
  if (r) r.disabled = !canRedo;
  placeQuickRow();
}

// ⌘Z / ⌘⇧Z (Ctrl+Z / Ctrl+Y on Windows). While TYPING in a field or input the
// browser's native undo applies; this only fires between edits.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k !== 'z' && !(k === 'y' && e.ctrlKey)) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (document.getElementById('kiln-modal')) return;   // a dialog is open — leave keys alone
  e.preventDefault();
  if (k === 'y' || e.shiftKey) redoEdit(); else undoEdit();
});

/** The committed value of a field's HTML (sanitized rich text, or escaped plain text). */
function fieldValue(html, plain) {
  // Editing chrome can sit inside a field's DOM (row controls, the toolbar).
  // Remove it as ELEMENTS first — sanitizing alone strips the tags but keeps
  // their text, which is how ↑↓＋🏷✕ once ended up inside a table cell's value.
  const d = document.createElement('div');
  d.innerHTML = html;
  d.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, .kiln-repeat-add, #kiln-toolbar').forEach(n => n.remove());
  if (plain) return escapeHtml(d.textContent);
  return DOMPurify.sanitize(d.innerHTML, SANITIZE);
}

function commitEdit(el, key) {
  const plain = el.hasAttribute('data-cms-plain');
  // What the file would now say of each element inside: the file's own class
  // and style plus what the person changed, never what a script put there.
  settleInside(el);
  const html = committedHtml(el, plain);
  // The page shows what will be published: what the sanitizer does not keep goes now.
  if (fieldValue(el.innerHTML, plain) !== el.innerHTML) writeInside(el, html);
  el.contentEditable = 'false';
  el.classList.remove('kiln-editing');
  el.closest('.kiln-repeat-item')?.classList.remove('kiln-row-editing');

  // Link elements: apply the toolbar's href before staging (scheme-sanitized).
  // Exclude the image toolbar's alt-text input, which shares the styling class
  // but is NOT an href — otherwise editing a link while an image toolbar is
  // open would write the alt text into the link's href.
  const hrefInput = el.tagName === 'A' ? document.querySelector('#kiln-toolbar .kiln-href-input:not([data-act="alt"])') : null;
  const hrefValue = hrefInput ? safeUrl(hrefInput.value) : null;
  const hrefChanged = hrefInput && hrefValue !== el.getAttribute('href');

  const repeat = el.closest('[data-cms-repeat]');

  // Clicking into a field and back out WITHOUT changing anything must not create
  // a phantom edit (which would light up the badge and enable Publish/Discard).
  // Crucially, if an edit was staged earlier this session and the field is now
  // back to its original value, we must DROP the staged edit — otherwise Publish
  // commits that stale intermediate value while the page shows the original.
  // (Repeat fields share keys and stage as a whole container, so they never take
  // this path; they always re-stage from the current DOM below.)
  // Unchanged is "reads as its baseline does", both as the file would hold them:
  // an animation that moved on while the field was open is not a change.
  const base = state.undoBase.get(key);
  const unchanged = !repeat && base !== undefined && fieldValue(base, plain) === html && !hrefChanged;
  if (unchanged) {
    if (state.pending.has(key)) {
      const prev = state.pending.get(key);
      state.pending.delete(key);
      el.classList.remove('kiln-modified');
      // Record the un-stage as a normal undo step so ⌘Z still restores it.
      pushUndoEntry({ steps: [{ key, prevEntry: JSON.parse(JSON.stringify(prev)), nextEntry: undefined,
        beforeHtml: prev.html, afterHtml: base }] });
      refreshPublishButton();
    }
    state.active = null;
    removeToolbar();
    return;
  }

  el.classList.add('kiln-modified');
  if (hrefChanged) el.setAttribute('href', hrefValue);

  if (repeat) {
    // Fields inside repeatable blocks publish as the whole container,
    // so duplicated blocks (with duplicate keys) stay unambiguous.
    stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
  } else {
    undoGroup(() => {
      stagePending(key, { html });
      if (hrefChanged) stagePending(key, { attrs: { href: hrefValue } });
    });
  }
  state.active = null;
  removeToolbar();
}

/**
 * The HTML to commit for a field: its inside as the page's file would hold it
 * (file-state.js), not as the site's scripts have left it on this visit, with
 * blob previews swapped for their real repo paths.
 */
function committedHtml(el, plain = el.hasAttribute('data-cms-plain')) {
  const clone = el.cloneNode(true);
  insideAsFile(clone, el);
  clone.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, .kiln-repeat-add, #kiln-toolbar').forEach(n => n.remove());
  if (plain) return escapeHtml(clone.textContent);
  clone.querySelectorAll('img[data-kiln-src]').forEach(img => {
    img.setAttribute('src', img.getAttribute('data-kiln-src'));
    img.removeAttribute('data-kiln-src');
  });
  return DOMPurify.sanitize(clone.innerHTML, SANITIZE);
}

/**
 * A field's inside as the file would hold it, whole: what Undo, Esc and Drop
 * put back. Not through the sanitizer, so that markup the file has and the
 * editor would not write itself is not lost from the page by an Undo.
 */
function baseHtml(el) {
  const clone = el.cloneNode(true);
  insideAsFile(clone, el);
  clone.querySelectorAll('.kiln-item-ctl, .kiln-ctl-cell, .kiln-repeat-add, #kiln-toolbar').forEach(n => n.remove());
  return clone.innerHTML;
}

// ─── Images ──────────────────────────────────────────────────────────────────

/** Mini toolbar for images: replace, alt text, done. */
function imageToolbar(img, key) {
  beginKey(key, img);   // what Undo goes back to: the picture showing now, which a lazy loader may have put there since the editor started
  removeToolbar();
  const tb = document.createElement('div');
  tb.id = 'kiln-toolbar';
  tb.innerHTML = `
    ${TB_GRIP}
    <span class="kiln-tb-label" title="${escapeHtml(key)}">${escapeHtml(readableName(key))}</span>
    <button class="kiln-tb-fmt kiln-tb-attach" data-act="replace">Replace image…</button>
    <span class="kiln-tb-hint">drag the ● corner to resize</span>
    <input class="kiln-href-input" data-act="alt" type="text" value="${escapeHtml(img.getAttribute('alt') || '')}"
      placeholder="Describe this image (alt text)" title="Alt text — read by screen readers and search engines">
    ${hasFeature('ai') ? '<button class="kiln-tb-fmt" id="kiln-ai" data-act="ai-alt" title="Describe this image with AI">✨ Alt text</button>' : ''}
    <button class="kiln-tb-save" data-act="done">Done</button>`;
  document.body.appendChild(tb);
  positionToolbar(tb, img);
  makeToolbarDraggable(tb);

  const altInput = tb.querySelector('[data-act="alt"]');
  const finish = () => {
    if (altInput.value !== (img.getAttribute('alt') || '')) {
      img.setAttribute('alt', altInput.value);
      img.classList.add('kiln-modified');
      const repeat = img.closest('[data-cms-repeat]');
      if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
      else stagePending(key, { attrs: { alt: altInput.value } });
    }
    endOn(img);
    tb.remove();
  };
  tb.querySelector('[data-act="replace"]').onclick = (e) => { e.stopPropagation(); replaceImage(img, key); };
  const aiAltBtn = tb.querySelector('[data-act="ai-alt"]');
  if (aiAltBtn) aiAltBtn.onclick = (e) => { e.stopPropagation(); assistAltText(img, key, altInput, aiAltBtn); };

  const handle = enableImageDragResize(img, key);
  // Match ANY current handle, not the one captured above: "Replace image…"
  // spawns a fresh handle (showResizeNow), and treating it as an outside click
  // closed this toolbar after the first drag.
  const removeHandles = () => document.querySelectorAll('.kiln-img-handle').forEach(h => h.remove());
  tb.querySelector('[data-act="done"]').onclick = (e) => { e.stopPropagation(); finish(); removeHandles(); };
  const away = (e) => {
    // the picture chooser is part of this toolbar's work: it stays for the description
    if (!tb.contains(e.target) && e.target !== img && !e.target.closest('.kiln-img-handle, #kiln-modal')) {
      finish(); removeHandles(); document.removeEventListener('click', away);
    }
  };
  setTimeout(() => document.addEventListener('click', away), 0);
}

/**
 * A bottom-right drag handle on an editable image. Dragging live-resizes how the
 * image DISPLAYS; on release the file is resampled to be web-ready at that size,
 * while the largest version we have is retained (data-kiln-master) so you can
 * drag back up later without quality loss.
 */
function enableImageDragResize(img, key, stage = true) {
  document.querySelectorAll('.kiln-img-handle').forEach(h => h.remove());   // one at a time
  const handle = document.createElement('div');
  handle.className = 'kiln-img-handle';
  handle.title = 'Drag to resize — the file is re-sampled to fit';
  document.body.appendChild(handle);
  const place = () => {
    const r = img.getBoundingClientRect();
    // Centred on the image's corner, but never past the edge of the page: on a
    // full-width image it would hang outside and make the whole page scroll sideways.
    const size = handle.offsetWidth || 22;
    const left = Math.min(r.right - size / 2, document.documentElement.clientWidth - size - 2);
    handle.style.left = `${left + window.scrollX}px`;
    handle.style.top = `${r.bottom + window.scrollY - size / 2}px`;
  };
  place();
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
  handle.remove = ((orig) => function () {
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
    orig.call(handle);
  })(handle.remove);

  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    drag = { startX: e.clientX, startW: img.getBoundingClientRect().width };
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('kiln-img-handle-on');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = Math.max(40, Math.round(drag.startW + (e.clientX - drag.startX)));
    const maxW = (img.parentElement?.getBoundingClientRect().width) || window.innerWidth;
    img.style.width = `${Math.min(w, Math.round(maxW))}px`;
    img.style.height = 'auto';
    place();
  });
  handle.addEventListener('pointerup', async (e) => {
    if (!drag) return;
    const finalW = img.getBoundingClientRect().width;
    drag = null;
    handle.classList.remove('kiln-img-handle-on');
    await resampleToDisplay(img, key, Math.round(finalW), stage);
    place();
  });
  return handle;
}

/** Load any URL (data:, blob:, /path) into an ImageBitmap. */
async function urlToBitmap(url) {
  const res = await fetch(url, { cache: 'no-store' });
  return createImageBitmap(await res.blob());
}

/**
 * Resample the retained master image to ~DPR×cssWidth and set it as the src.
 * `stage` false = the image lives inside a rich-text field being edited, so the
 * field's own commit persists it (no separate keyed staging).
 */
async function resampleToDisplay(img, key, cssWidth, stage = true) {
  try {
    // The master is the largest version we hold. First resize captures it.
    let master = img.getAttribute('data-kiln-master')
      || img.getAttribute('data-kiln-src') || img.getAttribute('src');
    master = safeUrl(master);
    // SVGs are vector — they scale losslessly, so there's nothing to re-sample.
    // Just set the display width and stage it.
    if (/\.svg(\?|#|$)/i.test(master) || /^data:image\/svg/i.test(master)) {
      img.style.width = `${cssWidth}px`;
      img.style.height = 'auto';
      img.removeAttribute('data-kiln-master');
      if (stage) stageImageEl(img, key);
      setStatus(`Sized to ${cssWidth}px — Publish to keep it`, 'saved');
      return;
    }
    img.setAttribute('data-kiln-master', master);
    setStatus('Re-sampling to fit…', 'saving');
    // Prefer the in-memory master bitmap (set when the image was added) so a
    // resize BEFORE publish resamples from the original, not a URL that isn't live.
    let bmp = masterBitmaps.get(master);
    if (!bmp) {
      // The master path may not be live yet (upload queued for the next
      // Publish) — fall back to what the image is showing right now.
      try { bmp = await urlToBitmap(master); }
      catch { bmp = await urlToBitmap(img.currentSrc || img.src); }
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(1, Math.min(Math.round(cssWidth * dpr), bmp.width, 2400));
    const scaled = await bitmapToScaled(bmp, targetW);
    const blob = scaled.blob, base64 = scaled.base64;

    // The awaits above yield to other handlers — if anything replaced this
    // element meanwhile (e.g. a field commit rewrote its innerHTML), finishing
    // would resize a detached node and, worse, retire the LIVE image's queued
    // upload from pendingBinaries (publishing a page that references a file
    // that never gets committed). Bail instead.
    if (!img.isConnected) {
      setStatus('That image changed while re-sampling — click it and resize again', 'error');
      return;
    }

    if (refusedByDemo(scaled)) return;
    img.style.width = `${cssWidth}px`;
    img.style.height = 'auto';
    if (cfg.sandbox) {
      img.src = `data:${scaled.type};base64,${base64}`;
      if (stage) stageImageEl(img, key);
      setStatus(`Sized to ${cssWidth}px and re-sampled (${Math.round(blob.size / 1024)} KB) — Publish to keep it`, 'saved');
      return;
    }
    // Repeated drag-resizes supersede each other: drop the previous (uncommitted)
    // intermediate so we don't commit a pile of throwaway sizes on Publish.
    const prev = img.getAttribute('data-kiln-src');
    if (prev) state.pendingBinaries.delete((cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + prev.replace(/^\//, ''));
    const name = `img-${Date.now().toString(36)}.${scaled.ext}`;
    const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
    stageBinary(repoPath, base64);   // committed with Publish, not now
    img.src = URL.createObjectURL(blob);
    img.setAttribute('data-kiln-src', `/assets/uploads/${name}`);
    if (stage) stageImageEl(img, key);
    setStatus(`Sized to ${cssWidth}px and re-sampled (${Math.round(blob.size / 1024)} KB) — Publish to put it live`, 'saved');
  } catch (err) {
    console.error('[kiln] resize', err);
    setStatus(notDone('The picture was not resized.', err), 'error');
  }
}

/** Stage an image element's current state (src/style/attrs) — container or single field. */
function stageImageEl(img, key) {
  img.classList.add('kiln-modified');
  const repeat = img.closest('[data-cms-repeat]');
  if (repeat) { stageContainer(repeat, repeat.getAttribute('data-cms-repeat')); settleOn(img); return; }
  // Its style as the file would hold it: the size it was dragged to, and nothing a script put on it.
  const attrs = { style: ownStyle(img) || '' };
  settleOn(img);
  // The demo keeps the picture that is shown, and not the original it was made from (see addImageWithMaster).
  if (cfg.sandbox) attrs.src = img.getAttribute('src');
  else {
    attrs['data-kiln-master'] = img.getAttribute('data-kiln-master') || '';
    attrs.src = safeUrl(img.getAttribute('data-kiln-src') || img.getAttribute('src'));
  }
  stagePending(key, { attrs });
}

/** The pictures on this page that live on this site: their address, name and size. */
function pageImages() {
  const seen = new Set(), out = [];
  for (const i of document.images) {
    if (i.closest(KILN_CHROME)) continue;
    let u;
    try { u = new URL(i.currentSrc || i.src, location.href); } catch { continue; }
    if (u.origin !== location.origin || !/^https?:$/.test(u.protocol) || seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    out.push({ url: u.pathname, path: u.pathname.slice(1), name: decodeURIComponent(u.pathname.split('/').pop() || 'picture'),
      size: performance.getEntriesByName(u.href)[0]?.encodedBodySize || 0 });
  }
  return out;
}

/** "Replace image…": upload a new picture, or choose one that is already on the site. */
function replaceImage(img, key) {
  openImagePicker({
    modal,
    upload: () => pickImage(img, key),
    choose: (image) => {
      if (!chooseSiteImage(img, key, image.url, { stagePending, stageContainer, safeUrl })) return;
      setStatus(cfg.sandbox ? `“${image.name}” is in place. Publish to save it to your demo` : `“${image.name}” is in place. Publish to put it live`, 'saved');
    },
    request: cfg.sandbox ? null : (method, path) => state.gh.request(method, path),
    stopped,
    repo: cfg.repo, branch: cfg.branch || 'main', root: cfg.root || '',
    paths: mode === 'editor' ? (state.scope?.paths || null) : null,
    pageImages,
  });
}

function pickImage(img, key) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      setStatus('Adding image…', 'saving');
      await addImageWithMaster(img, key, file);
    } catch (err) {
      console.error('[kiln] image upload', err);
      setStatus('Image upload failed', 'error');
    }
  };
  input.click();
}

// In-memory master bitmaps (url → ImageBitmap) so drag-resize can resample from
// the ORIGINAL even before it's been published (its repo URL isn't live yet).
const masterBitmaps = new Map();

/** Whether any of a canvas is see-through, looked at on a small copy of it. */
function seeThrough(canvas) {
  const small = document.createElement('canvas');
  small.width = small.height = 96;
  const c = small.getContext('2d');
  c.drawImage(canvas, 0, 0, 96, 96);
  const px = c.getImageData(0, 0, 96, 96).data;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) return true;
  return false;
}

/**
 * A canvas as a picture file for the web. WebP where the browser can write
 * it. One that cannot (Safari) hands back PNG whatever was asked for, and a
 * photograph as PNG is ten times the size: there it is JPEG, unless the
 * picture has see-through parts, which only PNG keeps.
 * Returns { blob, base64, ext, type }, named for what was actually made.
 */
async function canvasToFile(canvas, quality = 0.85) {
  const as = (type) => new Promise(r => canvas.toBlob(r, type, quality));
  let blob = await as('image/webp');
  if (!blob || blob.type !== 'image/webp') {
    const jpeg = seeThrough(canvas) ? null : await as('image/jpeg');
    blob = (jpeg && jpeg.type === 'image/jpeg' ? jpeg : null) || blob || await as('image/png');
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const ext = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' }[blob.type] || 'png';
  return { blob, base64: btoa(bin), ext, type: blob.type || 'image/png' };
}

/** Re-encode a bitmap, web-optimized, at a target width. Returns { blob, base64, ext, type }. */
async function bitmapToScaled(bmp, targetW) {
  const w = Math.max(1, Math.min(Math.round(targetW), bmp.width));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = Math.round(bmp.height * (w / bmp.width));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvasToFile(canvas);
}

/**
 * The demo keeps a picture in this browser, and a browser gives a site little
 * room. One too big to keep is refused here, with its size and the limit,
 * before anything of it is kept. Returns true when it was refused.
 */
function refusedByDemo(file) {
  const no = cfg.sandbox ? tooBigForDemo(file.blob.size) : null;
  if (no) setStatus(no, 'error');
  return !!no;
}

/**
 * Add/replace an image the way the workflow wants: keep a high-res MASTER
 * (≤2400px, web-optimized) as the original, and display a web-optimized COPY
 * sized to how the image shows on the page. Dragging the corner later makes a
 * fresh copy from the master (so up-sizing stays sharp; the master is never
 * thrown away).
 */
async function addImageWithMaster(img, key, file) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.round(img.getBoundingClientRect().width) || 600;
  const bmp = await createImageBitmap(file);
  const masterW = Math.min(bmp.width, 2400);
  const displayW = Math.min(Math.round(cssW * dpr), masterW);

  if (cfg.sandbox) {
    // Demo: no repo. The copy that is shown is kept in this browser, as a data
    // URL. The full-size original is held in memory for this visit only (for
    // dragging the picture bigger): kept in the browser too, as it used to be,
    // it took most of the room there is and a second picture rarely fitted.
    const display = await bitmapToScaled(bmp, displayW);
    if (refusedByDemo(display)) return;
    const master = `/kiln-demo-master-${Date.now().toString(36)}`;   // a name for the picture in memory, not an address
    masterBitmaps.set(master, bmp);
    img.setAttribute('data-kiln-master', master);
    img.src = `data:${display.type};base64,${display.base64}`;
    img.classList.add('kiln-modified');
    const rpt = img.closest('[data-cms-repeat]');
    if (rpt) stageContainer(rpt, rpt.getAttribute('data-cms-repeat'));
    else stagePending(key, { attrs: { src: img.src } });
    showResizeNow(img, key);
    setStatus('Image added — drag its ● corner to resize, then Publish', 'saved');
    return;
  }

  const stamp = Date.now().toString(36);
  const root = cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '';
  // Master (kept forever, referenced by data-kiln-master).
  const master = await bitmapToScaled(bmp, masterW);
  const masterUrl = `/assets/uploads/master-${stamp}.${master.ext}`;   // named for what the browser made of it
  stageBinary(root + `assets/uploads/master-${stamp}.${master.ext}`, master.base64);
  img.setAttribute('data-kiln-master', masterUrl);
  masterBitmaps.set(masterUrl, bmp);   // so a resize before publish resamples from it
  // Display copy at the on-page size.
  const display = await bitmapToScaled(bmp, displayW);
  const dispUrl = `/assets/uploads/img-${stamp}.${display.ext}`;
  stageBinary(root + `assets/uploads/img-${stamp}.${display.ext}`, display.base64);
  img.src = URL.createObjectURL(display.blob);
  img.setAttribute('data-kiln-src', dispUrl);
  img.classList.add('kiln-modified');
  const repeat = img.closest('[data-cms-repeat]');
  if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
  else stageImageEl(img, key);
  showResizeNow(img, key);
  setStatus('Image added — drag its ● corner to resize, then Publish', 'saved');
}

/** Right after an image is added/replaced: put the resize handle on it NOW
 *  (before publish), and keep it until the user clicks elsewhere. */
function showResizeNow(img, key) {
  const handle = enableImageDragResize(img, key);
  img.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const away = (e) => {
    if (e.target === img || e.target.closest('.kiln-img-handle, #kiln-toolbar, #kiln-imgpop, #kiln-modal')) return;
    handle.remove();
    document.removeEventListener('click', away, true);
  };
  setTimeout(() => document.addEventListener('click', away, true), 0);
}

/**
 * Re-encode the CURRENT image at a smaller max dimension (real resampling —
 * the file itself shrinks, not just how it displays), upload the result as a
 * new file, and stage the swap.
 */
async function resampleImage(img, key, maxDim) {
  try {
    setStatus(`Resampling to max ${maxDim}px…`, 'saving');
    const src = img.getAttribute('data-kiln-src') || img.getAttribute('src');
    const res = await fetch(src, { cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error(`could not fetch current image (${res.status})`), { status: res.status });
    const blob0 = await res.blob();
    const baseName = (src.split('/').pop() || 'image').split('?')[0];
    const scaled = await downscale(new File([blob0], baseName, { type: blob0.type }), maxDim);
    await stageImageSwap(img, key, scaled, baseName);
    setStatus(`Resampled to max ${maxDim}px (${Math.round(scaled.blob.size / 1024)} KB) — Publish to put it live`, 'saved');
  } catch (err) {
    console.error('[kiln] resample', err);
    setStatus(notDone('The picture was not made smaller.', err), 'error');
  }
}

/** Shared tail of every image swap: sandbox keeps a data URL; real sites upload
 *  to the repo, preview locally, and stage the future URL. */
async function stageImageSwap(img, key, { blob, base64, ext }, originalName) {
  if (cfg.sandbox) {
    if (refusedByDemo({ blob })) return;
    const dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64}`;
    img.src = dataUrl;
    img.classList.add('kiln-modified');
    const rpt = img.closest('[data-cms-repeat]');
    // Stage the data URL itself so the swap persists across reloads in the
    // visitor's own browser (repeats capture it inside the container HTML).
    if (rpt) stageContainer(rpt, rpt.getAttribute('data-cms-repeat'));
    else stagePending(key, { attrs: { src: dataUrl } });
    setStatus('Image added — hit Publish to save it to your demo', 'saved');
    return;
  }
  const slug = (String(originalName).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'image');
  const name = `${slug}-${Date.now().toString(36)}.${ext}`;
  const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
  const urlPath = `/assets/uploads/${name}`;
  stageBinary(repoPath, base64);   // committed with Publish, not now
  // Show the LOCAL image immediately — the real URL only exists after the
  // next deploy, so pointing at it now would render a broken image.
  img.src = URL.createObjectURL(blob);
  img.setAttribute('data-kiln-src', urlPath);
  img.classList.add('kiln-modified');
  const repeat = img.closest('[data-cms-repeat]');
  if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
  else stagePending(key, { attrs: { src: safeUrl(urlPath) } });
  setStatus('Image staged — hit Publish to put it live', 'saved');
}

/** Display-size change (how big it LOOKS — the file is untouched). */
function applyImageSize(img, key, val) {
  if (val === 'orig') { img.style.removeProperty('width'); img.style.removeProperty('height'); }
  else { img.style.width = val; img.style.height = 'auto'; }
  img.classList.add('kiln-modified');
  const repeat = img.closest('[data-cms-repeat]');
  if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
  else stagePending(key, { attrs: { style: ownStyle(img) || '' } });
  settleOn(img);
  setStatus(val === 'orig' ? 'Size reset — Publish to save' : `Width set to ${val} — Publish to save`, 'saved');
}

async function downscale(file, maxDim = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  // Named for what the browser actually produced: one that cannot write WebP
  // gives JPEG, or PNG for a picture with see-through parts (canvasToFile).
  return canvasToFile(canvas);
}

/** Insert an uploaded image at the cursor inside a rich-text field. */
function insertInlineImage(el) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      setStatus('Adding image…', 'saving');
      const { blob, base64, ext, type } = await downscale(file, 1200);
      // Demo sandbox: never touches GitHub — embed the image as a data URL so it
      // shows immediately and survives the sandbox's localStorage round-trip.
      if (cfg.sandbox) {
        if (refusedByDemo({ blob })) return;
        el.focus();
        document.execCommand('insertHTML', false,
          `<img src="data:${type};base64,${base64}" alt="" style="max-width:100%">`);
        const ins = [...el.querySelectorAll('img')].find(i => i.getAttribute('src')?.startsWith(`data:${type};base64,`));
        if (ins) inlineImgPopover(ins);
        setStatus('Image added — resize it now if you like, then Save and Publish', 'saved');
        return;
      }
      const slug = (file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'image');
      const name = `${slug}-${Date.now().toString(36)}.${ext}`;
      const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `assets/uploads/${name}`;
      const urlPath = `/assets/uploads/${name}`;
      stageBinary(repoPath, base64);   // committed with Publish, not now
      const blobUrl = URL.createObjectURL(blob);
      masterBitmaps.set(urlPath, await createImageBitmap(blob));   // pre-publish resizes read this
      el.focus();
      document.execCommand('insertHTML', false,
        `<img src="${blobUrl}" data-kiln-src="${urlPath}" alt="" style="max-width:100%">`);
      const ins = el.querySelector(`img[src="${blobUrl}"]`);
      if (ins) inlineImgPopover(ins);
      setStatus('Image inserted — resize it now if you like, then Save and Publish', 'saved');
    } catch (err) {
      console.error('[kiln] inline image', err);
      setStatus('Image upload failed', 'error');
    }
  };
  input.click();
}

/** Upload any file (PDF, doc, …) and return { path, name, size }. Members pages upload into the gated folder. */
function uploadAnyFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      if (file.size > UPLOAD_MAX_BYTES) { setStatus(FILE_MESSAGES.size, 'error'); return resolve(null); }
      // Invited editors commit through the worker, which only takes a short list
      // of file types. Say so now, not as a failed Publish later. (The owner's
      // own GitHub token is not limited this way.)
      if (mode === 'editor' && !cfg.sandbox) {
        const problem = uploadProblem(file.name, { size: file.size });
        if (problem) { setStatus(problem.error, 'error'); return resolve(null); }
      }
      // Demo sandbox: hand back an in-browser blob URL instead of committing to
      // GitHub, so the demo can show a working document chip/card/link.
      if (cfg.sandbox) {
        setStatus(`${file.name} added (demo: stays in your browser)`, 'saved');
        return resolve({ path: URL.createObjectURL(file), name: file.name, size: file.size });
      }
      try {
        setStatus(`Uploading ${file.name}…`, 'saving');
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const safe = file.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
        const gated = location.pathname.startsWith('/members');
        const dir = gated ? 'members/files' : 'assets/files';
        const repoPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + `${dir}/${safe}`;
        stageBinary(repoPath, btoa(bin));   // committed with Publish, not now
        setStatus(`${file.name} added ✓ ${gated ? '(members-only)' : ''} — goes live with your next Publish`, 'saved');
        resolve({ path: `/${dir}/${safe}`, name: file.name, size: file.size });
      } catch (err) {
        console.error('[kiln] file upload', err);
        setStatus('File upload failed', 'error');
        resolve(null);
      }
    };
    input.click();
  });
}

/**
 * Upload a document and insert it at the cursor as a text link, a chip, or a
 * card (the .kiln-doc styles ship in kiln-features.js for visitors).
 */
async function insertDocument(el, savedRange) {
  const key = el.getAttribute('data-cms');
  const up = await uploadAnyFile();
  if (!up) return;
  const pretty = up.size > 1024 * 1024 ? `${(up.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(up.size / 1024))} KB`;
  const ext = (up.name.split('.').pop() || 'file').toUpperCase();
  const m = modal(`
    <h3>How should the document appear?</h3>
    <label>Label <input type="text" id="kiln-doc-label" value="${escapeHtml(up.name)}"></label>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-doc-kind" value="link" checked>
        <span><strong>Text link</strong><br><small>Reads like a normal link in the sentence.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-doc-kind" value="chip">
        <span><strong>Chip</strong><br><small>A small bordered button with a 📄 icon.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-doc-kind" value="card">
        <span><strong>Card</strong><br><small>A block with the name and file details (${escapeHtml(ext)} · ${escapeHtml(pretty)}).</small></span></label>
    </div>
    <h4>When clicked</h4>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-doc-open" value="view" checked>
        <span><strong>Open in a new tab</strong><br><small>Views the file in the browser (PDFs, images).</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-doc-open" value="download">
        <span><strong>Download</strong><br><small>Saves the file to their device.</small></span></label>
    </div>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-doc-go">Insert</button>
    </div>`);
  m.querySelector('#kiln-doc-go').onclick = () => {
    const label = escapeHtml(m.querySelector('#kiln-doc-label').value.trim() || up.name);
    const kind = m.querySelector('input[name="kiln-doc-kind"]:checked').value;
    const openMode = m.querySelector('input[name="kiln-doc-open"]:checked').value;
    const href = escapeHtml(safeUrl(up.path));
    const behave = openMode === 'download' ? ' download' : ' target="_blank" rel="noopener"';
    const html = kind === 'link' ? `<a href="${href}"${behave}>${label}</a>`
      : kind === 'chip' ? `<a href="${href}" class="kiln-doc kiln-doc-chip"${behave}>📄 ${label}</a>`
      : `<a href="${href}" class="kiln-doc kiln-doc-card"${behave}><strong>${label}</strong><br><small>${escapeHtml(ext)} · ${escapeHtml(pretty)}</small></a>`;
    m.remove();
    // Insert directly via the DOM (not execCommand) — by the time this runs the
    // field may have left edit mode (interacting with this modal committed it),
    // so we can't rely on a live selection. Insert at the saved range if it's
    // still valid, else append to the field, then re-stage the field ourselves.
    const frag = document.createRange().createContextualFragment(html + '&nbsp;');
    let inserted = false;
    if (savedRange && el.contains(savedRange.startContainer)) {
      try { savedRange.collapse(false); savedRange.insertNode(frag); inserted = true; } catch { /* fall through */ }
    }
    if (!inserted) el.appendChild(frag);
    // Persist it: stage the field's new committed HTML (works whether or not it's
    // still the active edit).
    const repeat = el.closest('[data-cms-repeat]');
    if (repeat) stageContainer(repeat, repeat.getAttribute('data-cms-repeat'));
    else stagePending(key, { html: committedHtml(el, false) });
    el.classList.add('kiln-modified');
    setStatus('Document inserted — Publish when ready', 'saved');
  };
}

// ─── Publish ─────────────────────────────────────────────────────────────────

function flattenPending() {
  const edits = [];
  for (const [key, v] of state.pending) {
    if (v.html !== undefined) edits.push({ key, html: v.html });
    for (const [attr, value] of Object.entries(v.attrs || {})) edits.push({ key, attr, value });
  }
  return edits;
}

/**
 * Post-handoff clearing shared by schedule and suggest: the staged edits now
 * live elsewhere (a worker schedule / suggestion), so retire the stage, the
 * crash-recovery copy, the undo history (⌘Z must not revert the DOM out from
 * under an already-handed-off edit) and the modified markers.
 */
function retireStaged() {
  state.pending.clear();
  clearSavedPending();
  forgetEditHistory();
  document.querySelectorAll('.kiln-modified').forEach(el => el.classList.remove('kiln-modified'));
  // Source edits never ride a schedule/suggestion — any still pending keep
  // their modified markers (the blanket sweep above just removed them).
  for (const ref of state.pendingSource.keys()) syncSourceDom(ref);
  refreshPublishButton();
}

// ─── The publish sheet: what will change, before it changes ──────────────────

/** The value an attribute had before this session touched it. */
function attrBefore(key, attr) {
  for (const entry of editHistory.undo) {
    for (const st of entry.steps) if (st.key === key && st.attrsBefore && attr in st.attrsBefore) return st.attrsBefore[attr];
  }
  return state.undoBaseAttrs.get(key)?.[attr];
}

/** Leave one staged edit out: the page goes back, and Undo brings the edit back. */
function dropPending(key) {
  const entry = state.pending.get(key);
  if (!entry) return;
  const step = { key, prevEntry: JSON.parse(JSON.stringify(entry)), nextEntry: undefined };
  if (entry.html !== undefined) { step.beforeHtml = entry.html; step.afterHtml = state.undoBase.get(key); }
  if (entry.attrs) {
    step.attrsBefore = { ...entry.attrs };
    step.attrsAfter = {};
    for (const a of Object.keys(entry.attrs)) step.attrsAfter[a] = attrBefore(key, a);
  }
  applyUndoStep(step, 'after');
  pushUndoEntry({ steps: [step] });
  refreshPublishButton();
}

const STRUCTURAL_WORDS = {
  annotate: ['Made editable', 'plain'], remove: ['No longer editable', 'plain'],
  removeSection: ['Removed', 'remove'], insertAfter: ['Added', 'add'], appendMain: ['Added', 'add'],
};

/**
 * How many things the publish sheet would list now: the number every Publish
 * control shows. Counted from the same rows the sheet draws, so the two can
 * never disagree; a list with a block added, another moved and a price
 * changed is three, where it used to be one however much had changed in it.
 */
function changeCount() {
  try { return countChanges(publishItems({ light: true })); }
  catch (err) { console.warn('[kiln] the edits could not be counted', err); return state.pending.size + state.pendingSource.size + state.pendingStructural.length; }
}

/**
 * One row per unpublished edit, for the publish sheet. Reads state, changes
 * nothing. `light`: only what the count needs. Which parts a row has is
 * decided from the HTML alone either way; laying text out on the page to read
 * it as a person does is for showing it, and is skipped.
 */
function publishItems({ light = false } = {}) {
  const items = [];
  const shown = (key, html) => (light ? plainText(html) : renderedText(key, html));
  const blocksOf = (html) => [...new DOMParser().parseFromString(`<body>${html ?? ''}</body>`, 'text/html').body.children].map(c => c.outerHTML);
  for (const [key, v] of state.pending) {
    const el = elementForKey(key);
    const isList = !!el && el.getAttribute('data-cms-repeat') === key;
    const parts = [], images = [], warnings = [], links = [];
    let afterText = null;
    if (v.html !== undefined) {
      const baseHtml = state.undoBase.get(key) ?? '';
      if (isList) {
        // Every change is named: what was added, removed and moved, and each block that was changed, by its name.
        const wasBlocks = blocksOf(baseHtml), nowBlocks = blocksOf(v.html);
        const ch = listChanges(wasBlocks, nowBlocks);
        for (const n of ch.added) parts.push({ type: 'note', tone: 'add', text: `Added: ${n}` });
        for (const n of ch.removed) parts.push({ type: 'note', tone: 'remove', text: `Removed: ${n}` });
        if (ch.moved) parts.push({ type: 'note', text: 'The order changed.' });
        const liveBlocks = el ? [...el.children].filter(c => c.classList.contains('kiln-repeat-item')) : [];
        for (const c of ch.changed) {
          let said = false;
          if (c.before !== c.after) {
            parts.push({ type: 'text', name: c.name, before: shown(key, wasBlocks[c.from]), after: shown(key, nowBlocks[c.to]) });
            said = true;
          }
          // the same slot in the block, a different picture
          const was = imageSources(wasBlocks[c.from]), now = imageSources(nowBlocks[c.to]);
          const live = liveBlocks[c.to] ? [...liveBlocks[c.to].querySelectorAll('img')] : [];
          if (was.length === now.length) now.forEach((img, i) => {
            if (was[i].src === img.src) return;
            parts.push({ type: 'image', name: c.name, before: was[i].src, after: live[i]?.currentSrc || live[i]?.src || img.src });
            said = true;
          });
          // neither words nor a picture: a link's address, a tag, a size
          if (!said) parts.push({ type: 'note', text: `Changed: ${c.name}` });
        }
      } else {
        const before = plainText(baseHtml);
        afterText = plainText(v.html);
        if (before !== afterText) { afterText = shown(key, v.html); parts.push({ type: 'text', before: shown(key, baseHtml), after: afterText }); }
      }
      // pictures inside the edited HTML: which are new (for the warnings), and in a field the same slot with a different picture
      const was = imageSources(baseHtml), now = imageSources(v.html);
      const live = el ? [...el.querySelectorAll('img')].filter(i => !i.closest(KILN_CHROME)) : [];
      now.forEach((img, i) => {
        const changed = was.length === now.length ? was[i].src !== img.src : !was.some(w => w.src === img.src);
        if (changed && was.length === now.length && !isList) parts.push({ type: 'image', before: was[i].src, after: live[i]?.currentSrc || live[i]?.src || img.src });
        images.push({ alt: img.alt, changed });
      });
      links.push(...linkProblems(v.html, location.origin));
    }
    if (v.attrs) {
      const a = v.attrs;
      if ('src' in a) {
        parts.push({ type: 'image', before: attrBefore(key, 'src') || '', after: el?.currentSrc || el?.getAttribute('src') || a.src });
        images.push({ alt: a.alt ?? el?.getAttribute('alt'), changed: true });
      }
      if ('alt' in a && (attrBefore(key, 'alt') ?? '') !== a.alt) parts.push({ type: 'text', name: 'Picture description', before: attrBefore(key, 'alt') ?? '', after: a.alt });
      if ('href' in a) {
        parts.push({ type: 'text', name: 'Link goes to', before: attrBefore(key, 'href') ?? '', after: a.href });
        links.push(...linkProblems(`<a href="${escapeHtml(a.href)}">${escapeHtml(el?.innerText || 'this link')}</a>`, location.origin));
      }
      // a resize on its own; a new picture brings its own size along and needs no second line
      if (!('src' in a) && Object.keys(a).some(n => !['alt', 'href', 'data-kiln-src'].includes(n))) parts.push({ type: 'note', text: 'Size or layout changed.' });
    }
    if (!parts.length) parts.push({ type: 'note', text: 'Changed.' });
    warnings.push(...itemWarnings({ tag: isList ? '' : el?.tagName, afterText, images }));
    for (const l of links) {
      if (l.problem === 'empty') warnings.push({ kind: 'link', text: `The link “${l.text}” goes nowhere.` });
      else if (l.problem === 'anchor') {
        const id = decodeURIComponent(l.href.slice(1));
        if (!document.getElementById(id) && !document.getElementsByName(id).length) warnings.push({ kind: 'link', text: `The link “${l.text}” points to a part of this page that is not there.` });
      }
    }
    items.push({ id: key, key, label: readableName(key), parts, warnings, links: links.filter(l => l.problem === 'check'), drop: () => dropPending(key) });
  }
  for (const [ref, v] of state.pendingSource) {
    const rf = state.sourceFields?.get(ref);
    items.push({ id: 'source:' + ref, key: null, sourceRef: ref, label: sourceName(ref),
      parts: v.md && v.words === rf?.richWords
        ? [{ type: 'note', tone: 'plain', text: 'The formatting changed: the words are the same.' }]
        : [{ type: 'text', before: v.md ? (rf?.richWords ?? '') : (state.sourceBase.get(ref) ?? ''), after: v.md ? (v.words ?? '') : v.value }], warnings: [],
      drop: () => { state.pendingSource.delete(ref); syncSourceDom(ref); refreshPublishButton(); } });
  }
  state.pendingStructural.forEach((op, i) => {
    const [word, tone] = STRUCTURAL_WORDS[op.op] || ['Changed', 'plain'];
    const at = editHistory.undo.findIndex(e => e.steps.some(st => st.structural && st.structural.op === op));
    items.push({ id: 'structure:' + i, key: op.key, label: readableName(op.key),
      parts: [{ type: 'note', tone, text: `${word}: ${humanizeKey(op.key) || 'a section'}` }], warnings: [],
      drop: at === -1 ? null : () => {
        const [entry] = editHistory.undo.splice(at, 1);
        for (const st of [...entry.steps].reverse()) applyUndoStep(st, 'before');
        updateUndoUi();
        refreshPublishButton();
      } });
  });
  return items;
}

const linkSeen = new Map();   // address → true (answers) | false (404), for this page load
/** Slow warnings: ask this site whether each internal link in an edit exists. */
function checkEditedLinks(items, add) {
  let budget = 8;
  for (const item of items) {
    for (const l of item.links || []) {
      let url;
      try { url = new URL(l.href, location.href); } catch { continue; }
      if (url.origin !== location.origin) continue;
      const key = url.origin + url.pathname;
      const say = () => add(item.id, { kind: 'link', text: `The link “${l.text}” goes to ${url.pathname}, which is not on this site.` });
      if (linkSeen.has(key)) { if (!linkSeen.get(key)) say(); continue; }
      if (budget-- <= 0) return;
      fetch(key, { method: 'HEAD', cache: 'no-store' }).then(res => {
        linkSeen.set(key, res.status !== 404);
        if (res.status === 404) say();
      }).catch(() => { /* offline or blocked: say nothing rather than guess */ });
    }
  }
}

/** Every Publish control comes here: show what will change, then publish it. */
function requestPublish() {
  if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));
  if (sourceActive) commitSourceEdit();
  const anything = () => state.pending.size || state.pendingSource.size || state.pendingBinaries.size || state.pendingStructural.length;
  if (!anything()) return;
  if (mode === 'editor' && state.scope?.mode === 'review') return;
  if (previewOff(localStorage)) return publish();
  const suggest = isSuggestMode();
  openPublishSheet({
    modal, suggest,
    items: () => publishItems(),
    count: changeCount,
    label: (n) => (suggest ? 'Send for review' : publishLabel(n)),
    extra: () => {
      const rows = state.pending.size + state.pendingSource.size + state.pendingStructural.length;
      const n = state.pendingBinaries.size;
      if (suggest && (n || state.pendingStructural.length)) return 'A suggestion carries text edits only. New pictures and added sections stay here until an owner publishes them.';
      return n && !rows ? `${n} uploaded file${n > 1 ? 's' : ''} will be added to the site.` : '';
    },
    checks: checkEditedLinks,
    jump: (item) => {
      document.querySelector('#kiln-modal [data-close]')?.click();
      const el = item.key ? elementForKey(item.key) : state.sourceFields?.get(item.sourceRef)?.els[0];
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('kiln-flash');
      setTimeout(() => el.classList.remove('kiln-flash'), 1600);
      setTimeout(() => { try { el.click(); } catch { /* not clickable: the flash shows where it is */ } }, 350);
    },
    publish: (note) => publish({ note }),
    onChange: guideSync,
    // the line typed for a publish that was stopped, or brought back after signing in again
    note: keptNote,
  });
}

/** The line under "What changed?", for stopped(): the saved copy holds it, and it is back in its box afterwards. */
function noteTyped(text) {
  const words = String(text || '').trim();
  return words ? { name: TYPED.note, text: words, keep: { where: 'note' } } : null;
}

/** A suggest-only editor pressed "Send for review" in the sheet. */
async function sendSuggestionFromSheet(note) {
  if (state.pendingBinaries.size || state.pendingStructural.length) {
    setStatus('Suggestions carry text edits only. Undo new pictures and added sections first.', 'error');
    return;
  }
  setStatus('Sending your suggestion…', 'saving');
  try {
    const r = await sendSuggestion(note, (text) => setStatus(text, 'saving'));
    keptNote = '';
    setStatus(r.previewSkipped ? 'Sent for review. The preview was skipped.' : 'Sent for review. Nothing is live until an owner approves it.', 'saved');
  } catch (err) {
    console.error('[kiln] suggest', err);
    keptNote = note || '';   // back in its box when the sheet is opened again
    say(err, 'sent', `${notDone('That was not sent.', err)} Your edits are still here.`, noteTyped(note));
  }
}

async function publish(opts = {}) {
  // Still typing in a field? That text is part of what the person is publishing:
  // stage it first (the click-away that normally does this runs after us).
  if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));
  if (sourceActive) commitSourceEdit();
  if (!state.pending.size && !state.pendingBinaries.size && !state.pendingStructural.length
    && !state.pendingSource.size) return;
  // The note from the publish sheet, already cleaned to one line of plain text.
  // Empty: every commit keeps the message it has always had.
  const noteMsg = noteMessage(opts.note);
  if (cfg.sandbox) return publishSandbox(noteMsg, opts.note);
  keptNote = '';   // kept again below if this publish is stopped
  // An invited editor's first publish ends the first-session guide: note what
  // changed now, while the edits are still staged.
  const told = guideWaiting() ? describePublish() : null;
  // Suggest-mode editors don't publish — their Publish proposes. (The worker's
  // proxy guard enforces this server-side; the reroute here is the good UX.)
  // A suggestion cannot carry an edit to a content file yet, so those fields
  // are read-only for a suggest-only editor from the start (lockReason). One
  // that is staged all the same (a draft from before) gets the worker's 403,
  // which publishSource tells in a sentence.
  if (isSuggestMode()) {
    if (state.pendingSource.size) await publishSource(opts.note);
    if (state.pending.size) return opts.note !== undefined ? sendSuggestionFromSheet(opts.note) : suggestChanges();
    return;
  }
  // Only source-file edits staged: skip the HTML flow entirely — there may not
  // even BE a committed page file to edit (§13), and its journal/status tail
  // must not claim "Published" for commits whose build hasn't run (§11).
  if (!state.pending.size && !state.pendingBinaries.size && !state.pendingStructural.length) {
    return publishSource(opts.note);
  }

  // Edits inside a data-cms-partial (e.g. a shared footer or header) fan out to
  // every page; everything else commits to the current page only.
  const partialKeys = new Set();
  for (const key of state.pending.keys()) {
    let el = null;
    try { el = document.querySelector('[data-cms="' + key + '"]'); } catch { el = null; }
    if (el && el.closest('[data-cms-partial]')) partialKeys.add(key);
  }
  const localEdits = [], partialEdits = [];
  for (const [key, v] of state.pending) {
    const bucket = partialKeys.has(key) ? partialEdits : localEdits;
    if (v.html !== undefined) bucket.push({ key, html: v.html });
    for (const [attr, value] of Object.entries(v.attrs || {})) bucket.push({ key, attr, value });
  }

  // Snapshot EXACTLY what we're committing. Publishing is async (GitHub round-trip),
  // and the editor stays live the whole time — the user can keep editing. So instead
  // of a blanket state.pending.clear() at the end (which would silently drop any edit
  // made mid-publish), we only retire the keys we actually sent, and only if they
  // haven't changed since. A re-edit of the same key, or a brand-new key, survives.
  const publishedSnapshot = new Map();
  for (const [key, v] of state.pending) publishedSnapshot.set(key, JSON.stringify(v));

  // Same-field conflict gate: if someone ELSE published a change to a field
  // we're about to write since we loaded the page, ask before overwriting.
  // (Different-field edits merge automatically — editFile re-applies our edits
  // by key against the fresh source.)
  if (localEdits.length && !(await confirmOverwrites(localEdits))) return;

  setStatus('Publishing — committing to GitHub…', 'saving');
  disablePublish(true);
  try {
    // Prune orphaned uploads before committing. A swap that queued an upload and
    // was then undone leaves the binary in pendingBinaries with no edit referencing
    // it — committing it would push a public, unreferenced file to the live site,
    // and its stale data-kiln-src marker would make watchDeploy point a live <img>
    // at that (now-absent) path. Keep only binaries whose filename actually appears
    // in a value we're about to commit.
    if (state.pendingBinaries.size) {
      const haystack = [
        ...localEdits.map(e => e.html ?? e.value ?? ''),
        ...partialEdits.map(e => e.html ?? e.value ?? ''),
        ...state.pendingStructural.map(s => s.html || ''),
      ].join('\n');
      for (const path of [...state.pendingBinaries.keys()]) {
        const base = path.split('/').pop();
        if (base && !haystack.includes(base)) {
          state.pendingBinaries.delete(path);
          try {
            document.querySelectorAll('img[data-kiln-src]').forEach(img => {
              if ((img.getAttribute('data-kiln-src') || '').split('/').pop() === base) img.removeAttribute('data-kiln-src');
            });
          } catch {}
        }
      }
    }
    // Commit any queued binaries (images/docs) FIRST, in one commit, so the files
    // exist before the page that references them goes live. Deferring them to here
    // is what makes "nothing is live until Publish" true (Discard = no orphans).
    if (state.pendingBinaries.size) {
      const files = [...state.pendingBinaries].map(([path, base64]) => ({ path, base64 }));
      await commitFiles(state.gh, cfg.repo, cfg.branch || 'main', files,
        `Upload ${files.length} file${files.length > 1 ? 's' : ''} (via Kiln)`);
      // Retire only the paths we sent; a file queued during the commit survives.
      for (const { path } of files) state.pendingBinaries.delete(path);
      clearImageCache();   // "From this site" should list what was just added
    }
    let result = null;
    // What Undo needs: the page file exactly as it was when this commit was made.
    let textBefore = null;
    const hadSource = state.pendingSource.size > 0;
    const pageMessage = noteMsg || editCommitMessage(state.page.path, localEdits.map(e => e.key));
    const record = publishRecord({ path: state.page.path, branch: cfg.branch || 'main', message: pageMessage });
    // Track which keys actually made it into the commit vs. were skipped (e.g. a
    // key another editor un-annotated between load and publish). The final callback
    // run wins (editFile re-runs it on a sha-conflict retry).
    let appliedKeys = new Set(), skippedKeys = new Set();
    // Freeze the structural ops we're sending so a mid-publish addition can't get
    // applied to this commit (it would then be double-applied on the next Publish).
    const structuralOps = state.pendingStructural.slice();
    if (localEdits.length || structuralOps.length) {
      const structDesc = structuralOps.map(s => s.op === 'annotate' ? `+${s.key}`
        : s.op === 'remove' || s.op === 'removeSection' ? `-${s.key}`
        : `+${s.key || 'section'}`);
      result = await editFile(
        state.gh, cfg.repo, state.page.path, cfg.branch || 'main',
        (text) => {
          textBefore = text;
          // Structural changes (make/unmake editable) first, so field edits can
          // reference newly-annotated keys; then splice the field edits.
          const t = applyStructural(text, structuralOps);
          const { html, applied, skipped } = applyEdits(t, localEdits);
          appliedKeys = new Set(applied);
          skippedKeys = new Set(skipped.map(s => s.key));
          for (const s of skipped) console.warn('[kiln] skipped:', s);
          return html;
        },
        noteMsg || editCommitMessage(state.page.path, [...localEdits.map(e => e.key), ...structDesc])
      );
      // Drop only the structural ops we sent (they're appended, so the sent ones are
      // at the front); anything added mid-publish stays queued for the next Publish.
      state.pendingStructural.splice(0, structuralOps.length);
      record.structural = structuralOps;
    }
    if (partialEdits.length) await publishPartials(partialEdits, noteMsg);
    // Retire only the keys we published and that are unchanged since the snapshot.
    // Anything the user edited (or added) during the commit stays pending and keeps
    // its "modified" marker, so the next Publish picks it up.
    for (const [key, snap] of publishedSnapshot) {
      // A field key whose every edit was skipped never reached the commit (it
      // vanished from source, e.g. another editor un-annotated it). Keep it pending
      // and modified rather than silently discarding the user's work.
      if (skippedKeys.has(key) && !appliedKeys.has(key)) continue;
      if (state.pending.has(key) && JSON.stringify(state.pending.get(key)) === snap) {
        state.pending.delete(key);
        if (!partialKeys.has(key)) {
          record.entries.set(key, snap);
          record.prevBase.set(key, state.undoBase.get(key));
          record.prevBaseAttrs.set(key, state.undoBaseAttrs.get(key));
        }
        // The published value is the new "unedited" state for session undo.
        try {
          const v = JSON.parse(snap);
          if (v.html !== undefined) state.undoBase.set(key, v.html);
          if (v.attrs) state.undoBaseAttrs.set(key, { ...(state.undoBaseAttrs.get(key) || {}), ...v.attrs });
        } catch {}
        try {
          document.querySelectorAll('[data-cms="' + CSS.escape(key) + '"].kiln-modified, [data-cms-repeat="' + CSS.escape(key) + '"].kiln-modified')
            .forEach(el => el.classList.remove('kiln-modified'));
        } catch {}
      }
    }
    // Undo/redo operate on STAGED changes. Once published, those entries would
    // desync the page from the now-live site (⌘Z would revert the DOM but stage
    // nothing), so retire the history at the publish boundary.
    forgetEditHistory();
    await loadPageSource();
    refreshPublishButton();
    // Don't let a fully-skipped edit report success silently — tell the user it's
    // still pending because the section it targeted is gone from the page.
    const keptSkipped = [...skippedKeys].filter(k => !appliedKeys.has(k) && state.pending.has(k));
    if (keptSkipped.length) {
      setStatus(`${keptSkipped.length} edit${keptSkipped.length > 1 ? 's' : ''} couldn't be applied — that section no longer exists on the page. Still pending.`, 'error');
      return;
    }
    if (result && result.unchanged && !partialEdits.length && !state.pendingSource.size) { setStatus('Nothing changed', 'idle'); return; }
    // One page file, one commit: that can be taken back. Shared content (many
    // files) and source files go through History instead.
    const canUndo = result && !result.unchanged && result.commit?.sha && textBefore !== null && !partialEdits.length && !hadSource;
    if (canUndo) offerUndo({ ...record, before: textBefore, after: result.text, sha: result.commit.sha });
    if (told && result && !result.unchanged) guidePublished(told);
    watchDeploy(result?.commit?.sha, result?.text);
    // A mixed publish (page edits + source-file edits from the same screen):
    // commit the source half now, sequentially, with its own §11 states.
    if (state.pendingSource.size) await publishSource(opts.note);
  } catch (err) {
    console.error('[kiln] publish', err);
    keptNote = opts.note || '';   // the line typed under "What changed?" is back in its box when the sheet is opened again
    // A file the worker would not take (type, size, or contents that don't match
    // its name) comes back with a plain sentence — show it, with the file's name.
    const why = fileRefusalText(err.data);
    const which = why && err.data.path ? ` (${String(err.data.path).split('/').pop()})` : '';
    // Re-enable Publish so the user can retry. disablePublish(false) would keep
    // the button disabled when only binaries/structural ops are pending (its
    // check is `!state.pending.size`); refreshPublishButton counts those too.
    // It also saves the edits in this browser, before anything is said about them.
    refreshPublishButton();
    // The sign-in has ended (401), or it does not allow this change (403):
    // the edits stay as they are, and the person is told where they stand.
    // Trouble on the way (no answer, a 5xx, a 429) is neither: it says so, and to try again.
    const f = why ? null : readFailure(err);
    if (f && (f.kind === 'ended' || f.kind === 'refused')) stoppedDialog(f, true, noteTyped(opts.note));
    else if (f && f.kind === 'trouble') setStatus(publishTrouble(f, { edits: state.pending.size, source: state.pendingSource.size }), 'error');
    else setStatus(why ? why + which : `${notDone('That was not published.', err)} Your ${state.pending.size + state.pendingSource.size === 1 ? 'edit is' : 'edits are'} still here.`, 'error');
  }
}

// ─── "Published. Undo": ten seconds to take a publish back ───────────────────

let undoOffer = null;   // { timer, held } while the offer is on screen

/** Show "Published." with an Undo button for ten seconds. Other status lines wait their turn. */
function offerUndo(rec) {
  endUndoOffer(false);
  undoOffer = { held: null, timer: setTimeout(() => endUndoOffer(true), 10000) };
  setStatus(rec.sandbox ? 'Published to your private demo.' : 'Published.', 'saved', {
    offer: true, sticky: true,
    action: { label: 'Undo', title: 'Take this publish back', run: () => (rec.sandbox ? undoSandboxPublish(rec) : undoPublish(rec)) },
  });
}

function endUndoOffer(showHeld) {
  if (!undoOffer) return;
  const { held, timer } = undoOffer;
  clearTimeout(timer);
  undoOffer = null;
  if (!showHeld) return;
  if (held) setStatus(...held);
  else { const el = document.getElementById('kiln-status'); if (el) el.hidden = true; }
}

/** After an undo: the edits are staged again and marked as such. */
function restageRecord(rec) {
  const back = restage(rec, { pending: state.pending, undoBase: state.undoBase, undoBaseAttrs: state.undoBaseAttrs, structural: state.pendingStructural });
  for (const key of back) elementForKey(key)?.classList.add('kiln-modified');
  refreshPublishButton();
  return back.length + rec.structural.length;
}

const editsWaiting = (n) => (n === 1 ? 'your edit is here again, not published' : `your ${n} edits are here again, not published`);

async function undoPublish(rec) {
  endUndoOffer(false);
  setStatus('Undoing that publish…', 'saving');
  try {
    const r = await revertPublish({ gh: state.gh, repo: cfg.repo, branch: rec.branch, path: rec.path, before: rec.before, after: rec.after, message: rec.message });
    if (!r.ok) { undoBlocked(); return; }
    // Stop waiting for the undone commit to appear on the site.
    journalSave(journalAll().filter(e => e.sha !== rec.sha));
    const n = restageRecord(rec);
    await loadPageSource();
    setStatus(`Undone. The site is back as it was, and ${editsWaiting(n)}.`, 'saved');
    guideUndone(n);   // a first-session card still on screen stops saying it is published
  } catch (err) {
    console.error('[kiln] undo publish', err);
    say(err, 'undone', 'Undo did not go through, so nothing changed. History can take the page back.');
  }
}

/** Someone else published to this page after us: undoing would take their work with it. */
function undoBlocked() {
  const el = document.getElementById('kiln-status');
  if (el) el.hidden = true;
  const canHistory = hasFeature('history') && !!document.getElementById('kiln-history');
  const m = modal(`
    <h3>Someone else has published since</h3>
    <p class="kiln-dim">This page was published again after your change, so Undo would remove their work too. Nothing was changed, and your publish is still live.</p>
    <p class="kiln-dim">${canHistory ? 'History can put back just the parts you changed.' : 'Ask the site owner to put it back from History.'}</p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Close</button>
      ${canHistory ? '<button class="kiln-btn-publish" id="kiln-undo-history">Open History</button>' : ''}
    </div>`);
  const go = m.querySelector('#kiln-undo-history');
  if (go) go.onclick = () => { m.remove(); historyPanel(); };
}

function undoSandboxPublish(rec) {
  endUndoOffer(false);
  const s = sandboxStore();
  s.pages = s.pages || {};
  if (rec.prevPage) s.pages[sandboxPath()] = rec.prevPage; else delete s.pages[sandboxPath()];
  if (rec.historyId && s.history?.[sandboxPath()]) s.history[sandboxPath()] = s.history[sandboxPath()].filter(e => e.id !== rec.historyId);
  sandboxSave(s);
  for (const [ref, v] of rec.source || []) {
    state.sourceBase.set(ref, v.base);
    if (!state.pendingSource.has(ref)) state.pendingSource.set(ref, v.entry);
    syncSourceDom(ref);
  }
  const n = restageRecord(rec) + (rec.source?.length || 0);
  setStatus(`Undone: ${editsWaiting(n)}.`, 'saved');
  guideUndone(n);   // the demo's last card stops saying a commit happened
  noteSandboxLists();
}

/**
 * True → go ahead and publish. Checks the repo for changes other people made
 * to the SAME fields we're writing; if found, offers Reload & review (pending
 * edits survive reload via localStorage) or Publish anyway.
 */
async function confirmOverwrites(localEdits) {
  try {
    const fresh = await getFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main');
    if (fresh.sha === state.page.sha) return true;         // nothing changed under us
    const freshVals = readValues(fresh.text);
    const base = state.baseline || {};
    const conflicted = [...new Set(localEdits.map(e => e.key))]
      .filter(k => k in freshVals && k in base && freshVals[k] !== base[k]);
    if (!conflicted.length) return true;                   // their edits touch other fields — clean merge
    return await new Promise((resolve) => {
      const m = modal(`
        <h3>Someone else changed this page</h3>
        <p class="kiln-dim">While you were editing, another editor published changes to
        <strong>${conflicted.map(escapeHtml).join(', ')}</strong> — the same content you're about to publish.
        Publishing now replaces their version with yours.</p>
        <div class="kiln-modal-actions">
          <button class="kiln-btn-ghost" id="kiln-conf-reload">Reload &amp; review (keeps your edits)</button>
          <button class="kiln-btn-publish" id="kiln-conf-mine">Publish mine anyway</button>
        </div>`);
      m.querySelector('#kiln-conf-reload').onclick = () => { savePendingToStorage(); location.reload(); };
      m.querySelector('#kiln-conf-mine').onclick = () => { m.remove(); resolve(true); };
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-close]')) resolve(false);
      });
    });
  } catch { return true; /* pre-flight is best-effort — publish still merges by key */ }
}

/** Apply shared-partial edits to every page that carries those keys, in one commit. */
async function publishPartials(edits, noteMsg = '') {
  const branch = cfg.branch || 'main';
  const tree = await state.gh.request('GET',
    `/repos/${cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const htmlFiles = tree.tree.filter(t => t.type === 'blob' && t.path.endsWith('.html')).map(t => t.path).slice(0, 100);
  const changed = [];
  for (const p of htmlFiles) {
    const file = await getFile(state.gh, cfg.repo, p, branch);
    const { html, applied } = applyEdits(file.text, edits);
    if (applied.length) changed.push({ path: p, text: html });
  }
  if (changed.length) {
    await commitFiles(state.gh, cfg.repo, branch, changed,
      noteMsg || `Update shared content on ${changed.length} page${changed.length > 1 ? 's' : ''} (via Kiln)`);
  }
}

// ─── Source mode: [data-kiln-source] fields (SOURCE-MODE-SPEC §4.3–§13) ──────
// A generated page names each editable value's backing FILE + pointer in one
// attribute; edits are grouped by file and committed through the worker's
// /source/commit, then the build is watched (§11/§12). Feature-detected: a page
// without the attribute runs none of this (§13).

let sourceActive = null;   // { el, surface, ref, parsed, originalText } — the source field being edited

/** A field's name for the person editing ("Title · Spring fair"). */
function sourceName(ref) {
  return sourceLabel(state.sourceFields?.get(ref)?.parsed || parseSourceRef(ref)) || String(ref);
}

/** The hover hint: the name, and for the owner the file and field it is stored in. */
function sourceHint(parsed) {
  return mode === 'admin' ? `Edit: ${sourceLabel(parsed)} (${friendlyRef(parsed)})` : `Edit: ${sourceLabel(parsed)}`;
}

/** Where a field's words are read and written. An entry's plain text lives in its one paragraph. */
function sourceSurface(el, parsed) {
  return isBody(parsed) ? (plainBody(el) || el) : el;
}

async function initSourceFields() {
  const els = [...document.querySelectorAll(`[${SOURCE_ATTR}]`)].filter(el => !isKilnChrome(el));
  if (!els.length) return;   // §13: not one new code path on pages without provenance
  const scan = scanSourceRefs(els.map(el => ({
    ref: el.getAttribute(SOURCE_ATTR), cms: el.hasAttribute('data-cms'),
  })));
  for (const i of scan.dual) {
    console.warn('[kiln] element carries both data-cms and data-kiln-source — source wins:', els[i]);
  }
  state.sourceFields = new Map();
  for (const f of scan.fields) {
    const own = f.indexes.map(i => els[i]);
    // What each place showed when the page loaded. One value can be written
    // two ways on a page (a date, say), and each place gets its own words back.
    const shown = own.map(el => sourceSurface(el, f.parsed).textContent);
    state.sourceFields.set(f.ref, { parsed: f.parsed, els: own, shown, boot: shown[0] });
    if (!state.sourceBase.has(f.ref)) state.sourceBase.set(f.ref, shown[0]);
  }
  // Review-mode seats never see edit affordances (matches decorateFields).
  if (mode === 'editor' && state.scope?.mode === 'review') return;
  for (const m of scan.malformed) {
    // §8.1: malformed provenance → field not editable, ONE console warn with the element.
    console.warn(`[kiln] malformed ${SOURCE_ATTR} — field is not editable:`, els[m.indexes[0]].outerHTML);
    for (const i of m.indexes) lockSourceField(els[i], lockReason({ parsed: null }));
  }
  // Capability handshake (§13), once per boot. The sandbox stages locally.
  if (!cfg.sandbox) state.sourceCaps = await fetchSourceCaps();
  let open = 0;
  let firstWhy = '';
  // Formatted text (an entry's text, a Markdown field) is edited with the
  // toolbar when the worker takes Markdown back and the file can be read.
  const rich = !!state.sourceCaps?.markdown && !!state.gh && !cfg.sandbox;
  for (const [ref, f] of state.sourceFields) {
    for (const el of f.els) {
      // Read-only is decided here, before anyone types: the worker would turn
      // each of these away at Publish, or take words that are not the value.
      const why = lockReason({ parsed: f.parsed, tag: el.tagName, caps: state.sourceCaps, paths: state.scope?.paths, adapter: cfg.adapter || 'astro', plain: !!plainBody(el) || (!isBody(f.parsed) && !el.children.length),
        seat: isSuggestMode() ? 'suggest' : null, rich });
      if (why) { lockSourceField(el, why); firstWhy = firstWhy || why; }
      else if (rich && isMarkdownField(f.parsed)) { decorateRichSource(el, ref, f.parsed); open++; }
      else { decorateSourceField(el, ref, f.parsed); open++; }
    }
  }
  // Nothing on this page can be edited by this person: say so once, in sight.
  if (!open && firstWhy) {
    const limited = (state.scope?.paths || []).some(p => p && p !== '*' && p !== '**');
    // A suggest-only editor was told by the first line (grants.js startLine).
    if (isSuggestMode() && !state.page?.path && (!state.sourceCaps || state.sourceCaps.source)) return;
    if (mode === 'editor' && limited && (!state.sourceCaps || state.sourceCaps.source)) renderScopeNote();
    else setStatus(firstWhy, 'idle', { hold: 12000 });
    return;
  }
  // Click-away saves, Esc reverts — the same semantics data-cms fields have.
  // Registered here so pages without source fields add no listeners.
  document.addEventListener('click', (e) => {
    if (sourceActive && !sourceActive.el.contains(e.target) && !e.target.closest('#kiln-toolbar') && !e.target.closest('.kiln-keeps-edit')) {
      commitSourceEdit({ away: true });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sourceActive) cancelSourceEdit();
  });
  resumeSourceBuilds();
}

/** GET /healthz once per boot; anything that isn't new-style JSON = old worker. */
async function fetchSourceCaps() {
  try {
    const res = await fetch(`${cfg.worker}/healthz`);
    if (!res.ok) return parseSourceCapabilities(null);
    return parseSourceCapabilities(await res.json().catch(() => null));   // old workers say plain 'ok'
  } catch {
    return parseSourceCapabilities(null);   // unreachable worker — read-only beats a dead Publish
  }
}

/**
 * §10 read-only: it looks untouchable, and says why. The sentence is the
 * tooltip, and a click puts it in the status line, because a tooltip needs a
 * mouse that waits and a phone has none.
 */
function lockSourceField(el, why) {
  if (el.classList.contains('kiln-source-locked')) return;
  el.classList.add('kiln-source-field', 'kiln-source-locked');
  el.title = why;
  el.addEventListener('click', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.target.closest('a')) return;
    // A link inside a read-only text is still a link.
    const link = e.target.closest('a[href]');
    if (link && link !== el && el.contains(link)) return;
    e.preventDefault();
    setStatus(why, 'idle', { hold: 9000 });
  });
}

function decorateSourceField(el, ref, parsed) {
  el.classList.add('kiln-field', 'kiln-source-field');
  el.title = sourceHint(parsed);
  el.addEventListener('click', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.target.closest('a')) return;
    if (el.classList.contains('kiln-source-locked')) return;   // made read-only since (keepTheirs): its own click says why
    e.preventDefault(); e.stopPropagation();
    if (!sourceActive || sourceActive.el !== el) startSourceEditing(el, ref, parsed);
  });
}

function startSourceEditing(el, ref, parsed) {
  if (sourceActive && sourceActive.el !== el) commitSourceEdit();
  // An in-progress data-cms edit commits first (its click-away can't see this
  // click — decorateSourceField stopped propagation).
  if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));
  const surface = sourceSurface(el, parsed);
  sourceActive = { el, surface, ref, parsed, originalText: surface.textContent };
  el.classList.add('kiln-editing');
  // Source values are text, not markup (§6 degrades every type to string in
  // v1) — prefer plaintext-only where the browser has it.
  surface.setAttribute('contenteditable', 'plaintext-only');
  if (!surface.isContentEditable) surface.setAttribute('contenteditable', 'true');
  surface.focus();
  const range = document.createRange();
  range.selectNodeContents(surface);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  renderSourceToolbar(el, ref, parsed);
  // The page may show a date or a number in the site's own way ("September
  // 20, 2026"). What is typed here is the value itself: say how it is written.
  if (!typedValue(surface.textContent, parsed.type).ok) setStatus(typeHint(parsed.type), 'idle', { hold: 12000 });
}

/** The field is no longer being typed in: nothing of the editing is left on it. */
function endSourceEditing(a) {
  a.surface.removeAttribute('contenteditable');
  if (a.surface.getAttribute('style') === '') a.surface.removeAttribute('style');   // a browser leaves an empty one behind
  a.el.classList.remove('kiln-editing');
}

/** Click-away/Done for a source field: stage its text if it changed (§10). */
function commitSourceEdit(opts = {}) {
  const a = sourceActive;
  if (!a) return;
  if (a.rich) { commitRichSource(opts); return; }
  sourceActive = null;
  endSourceEditing(a);
  removeToolbar();
  // Where Enter was pressed WebKit puts an element and Chromium a line break:
  // either way it is a line break.
  for (const br of a.surface.querySelectorAll('br')) br.replaceWith('\n');
  const value = a.surface.textContent;
  // Anything else a browser left in an entry's one paragraph goes: the
  // paragraph holds words and nothing else.
  if (a.surface.children.length) a.surface.textContent = value;
  if (value === a.originalText) return;   // nothing was typed here
  const f = state.sourceFields.get(a.ref);
  const base = state.sourceBase.get(a.ref);
  const prev = state.pendingSource.get(a.ref);
  // A date that is not a date, a number that is not one: nothing is staged,
  // the words that were there come back, and the line says how to write it.
  const typed = typedValue(value, a.parsed.type);
  if (!typed.ok) {
    a.surface.textContent = a.originalText;
    setStatus(`“${value.trim().slice(0, 40)}” was not kept. ${typed.why}`, 'error');
    return;
  }
  // Back to what this place showed before any edit → un-stage (undoable).
  const kept = keptText(value, a.parsed.type);
  const own = base === f.boot ? f.shown[f.els.indexOf(a.el)] : base;
  if (prev && (kept === own || kept === base)) stageSourcePending(a.ref, null);
  else if (kept === (prev ? prev.value : own)) syncSourceDom(a.ref);   // only spaces were typed around it
  else stageSourcePending(a.ref, kept);
}

/** Esc: throw the in-progress edit away (staged value, else the pre-edit text). */
function cancelSourceEdit() {
  const a = sourceActive;
  if (!a) return;
  if (a.rich) { cancelRichSource(); return; }
  sourceActive = null;
  endSourceEditing(a);
  a.surface.textContent = a.originalText;
  removeToolbar();
}

// ─── Formatted text from the content files ───────────────────────────────────
// An entry's text (or a field stamped ?type=markdown) is Markdown in the file
// and HTML on the page. It is edited with the same toolbar as a plain HTML
// site; when the person is done the editor writes Markdown back, changed only
// where the page was (source-rich.js, adapters/markdown.js).

function decorateRichSource(el, ref, parsed) {
  const f = state.sourceFields.get(ref);
  if (f && f.richHtml === undefined) { f.richHtml = el.innerHTML; f.richWords = sheetWords(el); }
  el.classList.add('kiln-field', 'kiln-source-field', 'kiln-source-rich');
  el.title = sourceHint(parsed);
  el.addEventListener('click', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.target.closest('a')) return;
    if (el.classList.contains('kiln-source-locked')) return;
    // A part kept as the file has it says so, and takes no typing.
    const kept = e.target.closest(`[${KEEP_ATTR}^="b"]`);
    if (kept && el.contains(kept)) { e.preventDefault(); e.stopPropagation(); setStatus(keepSentence(kept), 'idle', { hold: 9000 }); return; }
    if (sourceActive && sourceActive.el === el) return;
    e.preventDefault(); e.stopPropagation();
    startRichSource(el, ref, parsed);
  });
}

/** Read what the field holds in the file now: the Markdown the page was made from. */
async function readRichText(parsed) {
  const data = await ask('/source/read', { method: 'POST',
    body: { repo: cfg.repo, branch: cfg.branch || 'main', adapter: cfg.adapter || 'astro', file: parsed.path, pointer: parsed.rawPointer } });
  return typeof data.value === 'string' ? data.value : String(data.value ?? '');
}

async function startRichSource(el, ref, parsed) {
  if (sourceActive && sourceActive.el !== el) commitSourceEdit({ away: true });
  if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));
  const f = state.sourceFields.get(ref);
  if (!f) return;
  if (!f.richPrep) {
    setStatus('Reading the text from the site’s files…', 'saving');
    let text;
    try { text = f.richRead !== undefined ? f.richRead : await readRichText(parsed); }
    catch (err) {
      console.warn('[kiln] could not read', parsed.path, err);
      setStatus(prepSentence('unreadable'), 'error', { hold: 9000 });
      return;
    }
    // Matched against the page as it was before any edit staged here; the
    // place on the page shows the staged edit, which already carries the marks.
    const pend = state.pendingSource.get(ref);
    let target = el;
    if (pend?.html !== undefined) { target = document.createElement('div'); target.innerHTML = f.richHtml; }
    const r = richPrepare(target, text, { mdx: /\.mdx$/i.test(parsed.path) });
    if (!r.ok) {
      console.warn('[kiln] formatted text not matched to its file:', parsed.path, r.why, r.at ?? '');
      setStatus(prepSentence(r.why), r.why === 'changed' ? 'idle' : 'error', { hold: 12000 });
      if (!pend) { el.classList.remove('kiln-field'); lockSourceField(el, prepSentence(r.why)); }
      return;
    }
    f.richRead = text;
    f.richPrep = r.prep;
    if (!pend) f.richHtml = el.innerHTML;   // the page with the marks on what is kept
    setStatus('', 'idle');
  }
  sourceActive = { el, ref, parsed, rich: true, startHtml: el.innerHTML };
  el.classList.add('kiln-editing');
  el.contentEditable = 'true';
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* an older browser: a DIV is read as a paragraph */ }
  el.addEventListener('beforeinput', guardKept);
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  renderToolbar(el, null, { markdown: true, label: sourceLabel(parsed).split(' · ')[0],
    onSave: () => commitSourceEdit(), onCancel: () => cancelSourceEdit() });
}

/** Typing may not take away a part kept as the file has it. */
function guardKept(e) {
  const a = sourceActive;
  if (!a?.rich || !/^delete|^insertFromPaste|^insertReplacementText|^insertText/.test(e.inputType || '')) return;
  const ranges = typeof e.getTargetRanges === 'function' ? e.getTargetRanges() : [];
  for (const r of ranges) {
    if (r.collapsed) continue;
    const range = document.createRange();
    try { range.setStart(r.startContainer, r.startOffset); range.setEnd(r.endContainer, r.endOffset); } catch { continue; }
    const kept = [...a.el.querySelectorAll(`[${KEEP_ATTR}^="b"]`)].find(k => range.intersectsNode(k));
    if (kept) { e.preventDefault(); setStatus(keepSentence(kept), 'idle', { hold: 9000 }); return; }
  }
}

function endRichSource(a) {
  a.el.removeEventListener('beforeinput', guardKept);
  a.el.removeAttribute('contenteditable');
  a.el.classList.remove('kiln-editing');
}

/** Done, or a click away: the page's text is written back as Markdown, and staged. */
function commitRichSource(opts = {}) {
  const a = sourceActive;
  if (!a?.rich) return;
  const f = state.sourceFields.get(a.ref);
  const r = f?.richPrep ? richPlan(a.el, f.richPrep) : { unchanged: true };
  if (r.error) {
    console.warn('[kiln] formatted text not written:', a.ref, r.error);
    if (!opts.away) { setStatus(planSentence(r.error), 'error', { hold: 12000 }); return; }
    // Clicked away from a change that cannot be written: it is put back, and said.
    sourceActive = null;
    endRichSource(a);
    removeToolbar();
    a.el.innerHTML = a.startHtml;
    setStatus(`${planSentence(r.error).replace(/ Press Revert[^.]*\.| Type it[^.]*\.$/, '')} The text is back as it was.`, 'error', { hold: 12000 });
    return;
  }
  sourceActive = null;
  endRichSource(a);
  removeToolbar();
  const pend = state.pendingSource.get(a.ref);
  if (r.unchanged) {
    if (pend) stageSourcePending(a.ref, null);   // back to how the file has it: nothing to publish
    return;
  }
  if (pend && pend.value === r.text) return;
  const entry = { value: r.text, md: true, html: a.el.innerHTML, words: sheetWords(a.el) };
  if (f.parsed.type) entry.type = f.parsed.type;
  stageSourcePending(a.ref, entry);
}

/** Esc or Revert: the text goes back to how it was when this edit began. */
function cancelRichSource() {
  const a = sourceActive;
  if (!a?.rich) return;
  sourceActive = null;
  endRichSource(a);
  a.el.innerHTML = a.startHtml;
  removeToolbar();
}

/** The floating control for a source field — label, provenance (§10), Done/Revert. */
function renderSourceToolbar(el, ref, parsed) {
  removeToolbar();
  const tb = document.createElement('div');
  tb.id = 'kiln-toolbar';
  tb.innerHTML = `
    ${TB_GRIP}
    <span class="kiln-tb-label" title="${escapeHtml(parsed.rawPointer)}">${escapeHtml(sourceLabel(parsed).split(' · ')[0])}</span>
    <button class="kiln-tb-fmt kiln-src-where" title="${escapeHtml(`${parsed.path}#${parsed.rawPointer}`)}">Where does this come from?</button>
    <span class="kiln-tb-gap"></span>
    <button class="kiln-tb-save" title="Keep this edit (staged for Publish)">Done</button>
    <button class="kiln-tb-cancel" title="Throw away this edit (Esc)">Revert</button>`;
  document.body.appendChild(tb);
  positionToolbar(tb, el);
  makeToolbarDraggable(tb);
  tb.querySelectorAll('button').forEach(b => b.addEventListener('mousedown', (e) => e.preventDefault()));
  tb.querySelector('.kiln-src-where').onclick = (e) => {
    e.stopPropagation(); e.preventDefault();
    const span = document.createElement('span');
    span.className = 'kiln-tb-label';
    span.textContent = friendlyRef(parsed);                    // events/e.md → title
    span.title = `${parsed.path}#${parsed.rawPointer}`;
    e.currentTarget.replaceWith(span);
  };
  tb.querySelector('.kiln-tb-save').onclick = (e) => { e.stopPropagation(); commitSourceEdit(); };
  tb.querySelector('.kiln-tb-cancel').onclick = (e) => { e.stopPropagation(); cancelSourceEdit(); };
}

/**
 * Stage (value: string) or un-stage (value: null) a source edit, with one undo
 * entry — the source twin of stagePending.
 */
function stageSourcePending(ref, value, opts = {}) {
  const f = state.sourceFields.get(ref);
  const prev = state.pendingSource.get(ref);
  let step = null;
  if (!opts.noUndo) {
    step = { srcRef: ref, prevEntry: prev ? { ...prev } : undefined };
  }
  if (value === null) {
    state.pendingSource.delete(ref);
    if (step) step.nextEntry = undefined;
  } else {
    const entry = typeof value === 'object' ? { ...value } : { value };
    const type = f?.parsed?.type;
    if (type) entry.type = type;
    state.pendingSource.set(ref, entry);
    if (step) step.nextEntry = { ...entry };
  }
  syncSourceDom(ref);
  if (step) {
    if (undoBucket) undoBucket.steps.push(step);
    else pushUndoEntry({ steps: [step] });
  }
  refreshPublishButton();
}

/**
 * Every place that shows `ref` shows the staged words and their marker. With
 * nothing staged it shows what was last saved, or, when nothing has been saved
 * since the page loaded, what that place showed then. A read-only place is
 * never written: its words are not the value (a link's label, a formatted text).
 */
function syncSourceDom(ref) {
  const f = state.sourceFields.get(ref);
  if (!f) return;
  const pend = state.pendingSource.get(ref);
  const base = state.sourceBase.get(ref);
  if (f.richHtml !== undefined) {
    // A formatted text: the page shows what was typed, as the browser holds it.
    f.els.forEach((el) => {
      if (el === sourceActive?.el || el.classList.contains('kiln-source-locked')) return;
      const html = pend?.html ?? f.richHtml;
      if (el.innerHTML !== html) writeInside(el, html);
      el.classList.toggle('kiln-modified', !!pend);
      el.title = sourceHint(f.parsed);
    });
    return;
  }
  f.els.forEach((el, i) => {
    if (el === sourceActive?.el || el.classList.contains('kiln-source-locked')) return;   // never rewrite under the caret
    const text = pend ? pend.value : (base === f.boot ? f.shown[i] : base);
    const surface = sourceSurface(el, f.parsed);
    if (text !== undefined && surface.textContent !== text) surface.textContent = text;
    el.classList.toggle('kiln-modified', !!pend);
    el.title = sourceHint(f.parsed);
  });
}

/** A field whose edit was not saved keeps its marker, and its hint says why. */
function markSourceFieldIssue(ref, why) {
  const f = state.sourceFields.get(ref);
  if (!f) return;
  for (const el of f.els) if (!el.classList.contains('kiln-source-locked')) el.title = `Not saved. ${why}`;
}

/**
 * The bars that tell something and wait for an answer (the failed-build
 * banner, the "not saved" box, the History preview) share one column, so
 * none lies on another. On a wide screen it is at the top. On a phone the top
 * is where the status line is, and each of these used to lie on it there, in
 * a narrow box over the site's own header: the column is above the pencil
 * and its buttons instead, as wide as the screen.
 */
function noticeColumn() {
  let col = document.getElementById('kiln-notices');
  if (!col) {
    col = document.createElement('div');
    col.id = 'kiln-notices';
    document.body.appendChild(col);
  }
  return col;
}

/**
 * What a publish left out, and why, in a box of its own: the status line goes
 * on to say that the site is rebuilding with what WAS saved, and a tooltip on
 * the field is not something a phone can show. Each row goes to its field.
 */
function showNotSaved(list) {
  document.getElementById('kiln-srcskip')?.remove();
  if (!list.length) return;
  const bar = document.createElement('div');
  bar.id = 'kiln-srcskip';
  bar.setAttribute('role', 'status');
  const one = list.length === 1;
  bar.innerHTML = `
    <div class="kiln-srcfail-head"><strong>${one ? 'One change was not saved.' : `${list.length} changes were not saved.`}</strong>
      ${one ? 'It is' : 'They are'} still on the page, outlined in yellow.</div>
    ${list.map((x, i) => `<div class="kiln-srcskip-row"><button type="button" class="kiln-status-link" data-i="${i}">${escapeHtml(x.label)}</button>
      <span>${escapeHtml(x.why)}</span></div>`).join('')}
    <button class="kiln-btn-ghost" id="kiln-srcskip-x">Got it</button>`;
  noticeColumn().appendChild(bar);
  bar.querySelector('#kiln-srcskip-x').onclick = () => bar.remove();
  bar.querySelectorAll('button[data-i]').forEach(btn => {
    btn.onclick = () => {
      const el = state.sourceFields?.get(list[+btn.dataset.i].ref)?.els.find(n => n.isConnected);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('kiln-flash');
      setTimeout(() => el.classList.remove('kiln-flash'), 1500);
    };
  });
}

/**
 * Commit staged source edits: group by FILE, POST /source/commit per file
 * SEQUENTIALLY (§5 — one commit per file, each with its own sha guard), retire
 * applied refs (only if unchanged since the snapshot — mid-publish re-edits
 * survive, mirroring publish()), keep skipped refs pending with their reasons
 * (§8.1), then hand the last commit to the §11/§12 build watcher.
 */
async function publishSource(note = '', opts = {}) {
  // All that is staged, or (opts.only) the fields just answered "Use mine".
  const staged = opts.only ? new Map([...state.pendingSource].filter(([ref]) => opts.only.has(ref))) : state.pendingSource;
  if (!staged.size) return;
  const groups = groupSourceEdits(staged,
    { repo: cfg.repo, branch: cfg.branch || 'main', adapter: cfg.adapter || 'astro', was: sourceWas });
  if (!groups.length) return;
  // An invited editor's first publish ends the first-session guide: note what
  // changed now, while the edits are still staged.
  const told = guideWaiting() ? describePublish() : null;
  const snapshot = new Map();
  for (const [ref, v] of staged) snapshot.set(ref, JSON.stringify(v));
  setStatus(saveSummary(staged.size, groups.length), 'saving');
  disablePublish(true);
  document.getElementById('kiln-srcskip')?.remove();
  const committed = [];
  const notSaved = [];       // { ref, label, why } for every edit that stays staged
  const changed = [];        // { ref, theirs }: someone else changed the field; the person is asked which stands
  let anyOk = false;
  let firstFailure = null;   // the first refusal as readFailure takes it: the thrown error
  for (const g of groups) {
    let data = {};
    let failure = null;
    try {
      data = await ask('/source/commit', { method: 'POST', body: g.body });
    } catch (err) {
      // What the worker said, when it answered.
      data = Number.isInteger(err.status) ? (err.data || {}) : {};
      failure = err;
    }
    const skipped = matchSkippedRefs(g, data.skipped);
    // A field someone else changed since the page was built is not "not
    // saved": it is asked about, with both versions, once the rest is done.
    const theirs = changedRefs(g, data.skipped);
    for (const [ref, current] of theirs) { changed.push({ ref, theirs: current }); skipped.delete(ref); }
    if (failure && theirs.size === g.refs.length) continue;   // nothing of this file was refused: all of it waits for an answer
    if (failure) {
      firstFailure = firstFailure || failure;
      // The whole file's batch stays pending. Why, in a sentence: the worker's
      // own refusal when it is one (a file Kiln never changes, a folder this
      // person was not given, a field that is gone), else what any failure says.
      console.warn('[kiln] source commit failed:', g.file, data);
      const whole = refusalSentence(failure.status, data.error);
      for (const ref of g.refs) {
        if (theirs.has(ref)) continue;
        const why = skipped.has(ref) ? skipSentence(skipped.get(ref)) : (whole || whyNot(failure));
        notSaved.push({ ref, label: sourceName(ref), why });
        markSourceFieldIssue(ref, why);
      }
      continue;
    }
    anyOk = true;
    const appliedRefs = new Set(matchAppliedRefs(g, data.applied));
    const done = [];
    for (const ref of g.refs) {
      if (!appliedRefs.has(ref)) continue;
      // Retire only if unchanged since the snapshot — same discipline publish()
      // uses so an edit made DURING the commit round-trip is never dropped.
      if (state.pendingSource.has(ref) && JSON.stringify(state.pendingSource.get(ref)) === snapshot.get(ref)) {
        const v = state.pendingSource.get(ref);
        done.push({ ref, value: v.value, was: state.sourceBase.get(ref), ...(v.type && { type: v.type }) });
        state.pendingSource.delete(ref);
        state.sourceTheirs.delete(ref);
        state.sourceBase.set(ref, v.value);   // the committed value is the new baseline
        const rf = state.sourceFields?.get(ref);
        if (v.md && rf) { rf.richRead = v.value; rf.richPrep = null; rf.richHtml = v.html; rf.richWords = v.words; }
        syncSourceDom(ref);
      }
    }
    for (const [ref, reason] of skipped) {
      console.warn('[kiln] source edit skipped:', ref, reason);
      const why = skipSentence(reason);
      notSaved.push({ ref, label: sourceName(ref), why });
      markSourceFieldIssue(ref, why);
    }
    if (data.commit && !data.unchanged) {
      committed.push({ file: data.file || g.file, sha: data.commit.sha, parent: data.commit.parent, refs: done });
    }
  }
  if (anyOk) {
    // Same publish-boundary rule as the HTML flow: committed edits must not be
    // ⌘Z-able back into the stage.
    forgetEditHistory();
  }
  refreshPublishButton();
  if (!committed.length) {
    // Nothing was saved. An ended sign-in (401) and trouble on the way are
    // told as they are for a page edit: the edits stay staged and saved in
    // this browser. Anything the worker turned away is listed with its reason.
    const f = firstFailure ? readFailure(firstFailure) : null;
    if (f) keptNote = note || '';
    if (f && f.kind === 'ended') stoppedDialog(f, true, noteTyped(note));
    else if (f && f.kind === 'trouble') setStatus(publishTrouble(f, { edits: state.pending.size, source: state.pendingSource.size }), 'error');
    else if (notSaved.length) {
      showNotSaved(notSaved);
      setStatus(notSaved.length === 1 ? 'That was not saved. Your edit is still here.' : 'Those were not saved. Your edits are still here.', 'error');
    } else if (changed.length) setStatus('Nothing was published yet.', 'idle');
    else if (anyOk) setStatus('Nothing changed', 'idle');
    if (changed.length && !(f && (f.kind === 'ended' || f.kind === 'trouble'))) await askTheirsOrMine(changed, note);
    return;
  }
  showNotSaved(notSaved);
  if (told) guidePublished({ ...told, source: true });
  rememberBuild(committed);
  watchSourceBuild(committed);
  if (changed.length) await askTheirsOrMine(changed, note);
}

/**
 * What a field held when this page was read, sent with its edit so the worker
 * does not write over a change someone else made since (source-fields.js
 * readAs). Once the person has chosen their own words over someone else's, it
 * is what the worker said the file holds. After a publish from this page it
 * is what was published.
 */
function sourceWas(ref) {
  if (state.sourceTheirs.has(ref)) return state.sourceTheirs.get(ref);
  const f = state.sourceFields?.get(ref);
  if (!f) return undefined;
  if (f.richRead !== undefined) return f.richRead;
  const base = state.sourceBase.get(ref);
  if (base !== f.boot) return readAs([base], f.parsed.type);
  // A read-only place shows something that is not the value (a link's label).
  return readAs(f.els.map((el, i) => (el.classList.contains('kiln-source-locked') ? null : f.shown[i])), f.parsed.type);
}

/**
 * Someone else changed these fields since the page was built, and the worker
 * left the edits out. Each is asked about with both versions in sight. "Keep
 * theirs" drops the edit and shows their words; "Use mine" publishes it in
 * their place, knowingly. Put away without an answer, the edit stays on the
 * page, not published.
 */
async function askTheirsOrMine(changed, note) {
  const mine = new Set();
  let kept = 0, waiting = 0;
  for (const c of changed) {
    const pend = state.pendingSource.get(c.ref);
    if (!pend) continue;
    const answer = await askWhich(modal, theirsOrMine({ label: sourceName(c.ref), theirs: c.theirs, mine: pend.value }));
    if (answer === 'theirs') { keepTheirs(c.ref, c.theirs); kept++; }
    else if (answer === 'mine') { state.sourceTheirs.set(c.ref, c.theirs); mine.add(c.ref); }
    else waiting++;
  }
  refreshPublishButton();
  if (mine.size) return publishSource(note, { only: mine });
  if (waiting) setStatus(waiting === 1 ? 'Your edit is still on the page, not published.' : 'Your edits are still on the page, not published.', 'idle', { hold: 9000 });
  else if (kept) setStatus(kept === 1 ? 'Theirs is kept. Your edit was dropped.' : 'Theirs are kept. Your edits were dropped.', 'idle', { hold: 9000 });
}

/** "Keep theirs": the edit is dropped, and the page shows what the file says now. */
function keepTheirs(ref, theirs) {
  const f = state.sourceFields?.get(ref);
  state.pendingSource.delete(ref);
  state.sourceTheirs.delete(ref);
  forgetEditHistory();   // Undo must not bring the dropped edit back as if nobody had been asked
  if (!f) return;
  if (isBody(f.parsed)) {
    // Their text is markdown, and the page can only show it once the site has
    // made a page of it. Until then this place shows the words from before,
    // and takes no edit that would be compared against them.
    syncSourceDom(ref);
    for (const el of f.els) {
      el.classList.remove('kiln-field', 'kiln-modified');
      lockSourceField(el, 'Someone else changed this text. Reload the page to see it once the site has rebuilt.');
    }
    return;
  }
  state.sourceBase.set(ref, theirsText(theirs));
  syncSourceDom(ref);
}

// §11/§12: Saved → Building… → Published ✓ / Build failed ✕ / still-building.
// Poll through the SAME gh path every other editor read uses (admin: direct
// API; invited editor: the worker /gh proxy, which already allowlists commit
// status + deployments). NEVER "Published" on commit success alone.
const SOURCE_POLL_MS = 10000;

let sourceWatch = 0;   // the newest watcher: a later publish's build carries the earlier ones

function watchSourceBuild(committed, started = Date.now()) {
  const sha = committed[committed.length - 1].sha;   // the LAST commit triggers the build that carries them all
  const mine = ++sourceWatch;
  setStatus(SAVED_BUILDING_COPY, 'saving');
  const tick = async () => {
    if (mine !== sourceWatch) return;
    let status = null;
    let deployStatuses = null;
    try { status = await state.gh.request('GET', `/repos/${cfg.repo}/commits/${encodeURIComponent(sha)}/status`); } catch { /* keep polling */ }
    try {
      const deployments = await state.gh.request('GET', `/repos/${cfg.repo}/deployments?sha=${encodeURIComponent(sha)}&per_page=1`);
      if (Array.isArray(deployments) && deployments.length) {
        deployStatuses = await state.gh.request('GET', `/repos/${cfg.repo}/deployments/${deployments[0].id}/statuses?per_page=1`);
      }
    } catch { /* keep polling */ }
    if (mine !== sourceWatch) return;
    const verdict = resolveBuildState({
      status, deployStatuses, elapsedMs: Date.now() - started, timeoutMs: BUILD_WATCH_MS,
    });
    if (verdict === 'published') { forgetBuild(sha); setStatus('Published ✓', 'saved'); setStatusIdle(); return; }
    if (verdict === 'timeout') { setStatus(STILL_BUILDING_COPY, 'saved'); return; }
    if (verdict === 'failed') { sourceBuildFailedBanner(committed, sha); return; }
    setStatus(SAVED_BUILDING_COPY, 'saving');
    setTimeout(tick, SOURCE_POLL_MS);
  };
  setTimeout(tick, SOURCE_POLL_MS);
}

// A publish to content files, kept in this browser while the site rebuilds
// (source-fields.js buildRecord). The page a reload brings back is the page
// from before the build: without this it shows the old words and says nothing.
const buildsKey = () => `kiln_building:${cfg.repo}`;
function readBuilds() {
  try { return (JSON.parse(localStorage.getItem(buildsKey())) || []).filter(r => buildStanding(r) !== 'gone'); } catch { return []; }
}
function writeBuilds(list) {
  try { if (list.length) localStorage.setItem(buildsKey(), JSON.stringify(list.slice(-5))); else localStorage.removeItem(buildsKey()); } catch { /* storage blocked: a reload shows the page as built */ }
}
function rememberBuild(committed) {
  const rec = buildRecord(committed);
  if (rec) writeBuilds([...readBuilds(), rec]);
}
/** That build is live (and so is every publish before it), or its change was undone. */
function forgetBuild(sha) {
  const list = readBuilds();
  const at = list.find(r => r.sha === sha)?.at ?? 0;
  writeBuilds(list.filter(r => r.at > at));
}

/** After a reload: show what was saved on a page that has not been rebuilt yet, and go on watching the build. */
function resumeSourceBuilds() {
  if (cfg.sandbox) return;
  let waiting = null;
  for (const rec of readBuilds()) {
    const plan = resumePlan(rec, (ref) => (state.sourceFields?.has(ref) ? state.sourceBase.get(ref) : undefined));
    for (const r of plan.show) { state.sourceBase.set(r.ref, r.value); syncSourceDom(r.ref); }
    if (plan.waiting) waiting = rec;
  }
  if (!waiting) return;
  if (buildStanding(waiting) === 'building') watchSourceBuild(waiting.files, waiting.at);
  else setStatus('Your last change is saved. The site has not shown it yet, so this page shows it from this browser.', 'idle', { hold: 12000 });
}

/** Undo after a failed build took a file back: its words are on the page again as an unpublished edit. */
function restageAfterUndo(c) {
  for (const r of c.refs || []) {
    if (!state.sourceFields?.has(r.ref)) continue;
    state.sourceBase.set(r.ref, r.was);
    if (!state.pendingSource.has(r.ref)) state.pendingSource.set(r.ref, r.type ? { value: r.value, type: r.type } : { value: r.value });
    syncSourceDom(r.ref);
  }
  // Nothing of that file is waiting for a build any more.
  writeBuilds(readBuilds().map(rec => ({ ...rec, files: rec.files.filter(f => f.sha !== c.sha) })).filter(rec => rec.files.length));
  refreshPublishButton();
}

/**
 * §12: a failed build blocks EVERYONE's publishes until the bad commit is gone,
 * so the banner offers one-click revert per committed file (POST /source/revert
 * back to that commit's parent). Each row is named by what was changed, and
 * the link to the commit on GitHub is for the owner, who can open it.
 */
function sourceBuildFailedBanner(committed, sha) {
  setStatus(BUILD_FAILED_COPY, 'error');
  document.getElementById('kiln-srcfail')?.remove();
  const bar = document.createElement('div');
  bar.id = 'kiln-srcfail';
  bar.innerHTML = `
    <div class="kiln-srcfail-head"><strong>Build failed.</strong> The site still shows the version from before.
      ${mode === 'admin' ? `<a class="kiln-status-link" href="https://github.com/${escapeHtml(cfg.repo)}/commit/${escapeHtml(sha)}"
        target="_blank" rel="noopener">See what happened</a>` : 'Undo your change here, or ask the site’s owner to look.'}</div>
    ${committed.map((c, i) => `<div class="kiln-srcfail-row"><span>${escapeHtml((c.refs || []).length ? c.refs.map(r => sourceName(r.ref)).join(', ') : c.file)}</span>
      <button class="kiln-btn-ghost" data-i="${i}">${UNDO_ICON} Undo this change</button></div>`).join('')}
    <button class="kiln-btn-ghost" id="kiln-srcfail-x">Dismiss</button>`;
  noticeColumn().prepend(bar);   // above what a publish left out, when both are up
  bar.querySelector('#kiln-srcfail-x').onclick = () => bar.remove();
  bar.querySelectorAll('button[data-i]').forEach(btn => {
    btn.onclick = async () => {
      const c = committed[+btn.dataset.i];
      const body = revertRequest(c, { repo: cfg.repo, branch: cfg.branch || 'main' });
      if (!body) { setStatus('There is no earlier version of that to go back to.', 'error'); return; }
      btn.disabled = true;
      btn.textContent = 'Undoing…';
      try {
        await ask('/source/revert', { method: 'POST', body });
        btn.textContent = 'Undone ✓';
        restageAfterUndo(c);
        setStatus('Undone. The site rebuilds without that change, and your edit is back on this page, not published.', 'saved', { hold: 12000 });
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = `${UNDO_ICON} Undo this change`;
        say(err, 'undone', notDone('That change was not undone.', err));
      }
    };
  });
}

// ─── §7.3: the wrong-mode guard ──────────────────────────────────────────────
// An html-mode site whose page file is committed BUILD OUTPUT: editing it is
// silent data loss (the next build erases the commit). Detect once per session
// (root listing → generatorSignals), block with an explanation instead of
// decorating fields. Source-mode sites and pages with provenance never hit it.

const SRC_GUARD_KEY = () => `kiln_srcguard:${cfg.repo}`;

async function wrongModeGuard() {
  if (cfg.sandbox || cfg.mode === 'source') return false;
  if (document.querySelector(`[${SOURCE_ATTR}]`)) return false;
  if (!state.page?.path) return false;
  let sig = null;
  try { sig = JSON.parse(sessionStorage.getItem(SRC_GUARD_KEY())); } catch { /* no cache */ }
  if (!sig || typeof sig !== 'object') {
    try {
      const listing = await state.gh.request('GET', `/repos/${cfg.repo}/contents`);
      const files = (Array.isArray(listing) ? listing : []).map(f => f.type === 'dir' ? `${f.path}/` : f.path);
      const s = generatorSignals(files);
      sig = { gen: s.detected[0]?.displayName || null, builtHtml: s.builtHtml };
    } catch {
      sig = { gen: null, builtHtml: false };   // listing unreachable — never block on a blip
    }
    try { sessionStorage.setItem(SRC_GUARD_KEY(), JSON.stringify(sig)); } catch { /* private mode */ }
  }
  const pageInBuildDir = /^(dist|_site|build|out)\//i.test(state.page.path);
  if (!sig.gen || !(sig.builtHtml || pageInBuildDir)) return false;
  modal(`
    <h3>This page is build output</h3>
    <p class="kiln-dim">Kiln can see <code>${escapeHtml(state.page.path)}</code>, but this site is built
    by <strong>${escapeHtml(sig.gen)}</strong> — that file is regenerated on every build, and any edit
    here would be erased the next time the site publishes.</p>
    <p class="kiln-dim">Switch this site to <strong>Source Mode</strong> (<code>mode: 'source'</code> in
    kiln-config.js, with provenance on the templates) to edit the content it’s built from.</p>
    <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Dismiss</button></div>`);
  return true;
}

// ─── Demo sandbox (cfg.sandbox) ───────────────────────────────────────────────
// A private, local-only editing experience: every visitor is auto-signed-in,
// edits live only in their own browser (never committed, never shared), and the
// whole thing resets after 24h. Nothing one visitor types is ever shown to another.

function sandboxStore() {
  try { return JSON.parse(localStorage.getItem(SANDBOX_KEY)) || {}; } catch (e) { return {}; }
}
function sandboxSave(o) {
  try { localStorage.setItem(SANDBOX_KEY, JSON.stringify(o)); return true; }
  catch (e) { return false; }   // out of local space (e.g. many large images)
}
function sandboxPath() { return (location.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '') || '/'); }

function sandboxTTLCheck() {
  const s = sandboxStore();
  if (s._createdAt && Date.now() - s._createdAt > SANDBOX_TTL) sandboxReset();
}

/** Start the demo over: its publishes and drafts, and the unpublished edits saved for any of its pages. */
function sandboxReset() {
  try {
    localStorage.removeItem(SANDBOX_KEY);
    const mine = `kiln_pending:${cfg.repo}:`;
    for (const key of Object.keys(localStorage)) if (key.startsWith(mine)) localStorage.removeItem(key);
  } catch { /* storage blocked: there is nothing kept to clear */ }
}

/** Apply saved field-level edits (small diffs, not whole pages) to the live DOM. */
function applySandboxEdits(edits) {
  for (const key in edits) {
    const v = edits[key];
    // Source-mode fields save under their full ref (path#pointer) with a plain-
    // text value; everything data-cms keyed carries html/attrs as before.
    if (v.text !== undefined && key.includes('#')) {
      let sel = null;
      try { sel = document.querySelector('[data-kiln-source="' + key + '"]'); } catch { sel = null; }
      if (sel) sel.textContent = v.text;
      continue;
    }
    let el = null;
    try { el = document.querySelector('[data-cms="' + key + '"], [data-cms-repeat="' + key + '"], [data-cms-menu="' + key + '"]'); } catch { el = null; }
    if (!el) continue;
    if (v.html !== undefined) {
      if (el.getAttribute('data-cms-repeat') === key) writeBlocks(el, v.html, tidyBlocks);
      else writeInside(el, v.html);   // the elements the page's own animation is running on stay
    }
    if (v.attrs) for (const a in v.attrs) el.setAttribute(a, v.attrs[a]);
  }
}

function restoreSandboxPage() {
  const s = sandboxStore();
  const edits = s.pages && s.pages[sandboxPath()];
  if (edits) applySandboxEdits(edits);
}

/**
 * What the demo guide's last card says about a publish: one edit's text before
 * and after, and the commit message the same publish gets on a real site.
 */
/** The element on the page that a key names: a field, or a list of blocks. */
function elementForKey(key) {
  try { return document.querySelector(`[data-cms="${CSS.escape(key)}"], [data-cms-repeat="${CSS.escape(key)}"]`); } catch { return null; }
}

/**
 * Text the way a person reads it on the page: lay the HTML out in a throwaway
 * copy of the field (same tag, classes and parent, so the site's CSS applies)
 * and take its rendered text. Reading the live element would pick up Kiln's
 * own block controls, and plain textContent runs lines together.
 */
function renderedText(key, html) {
  const el = elementForKey(key);
  const copy = el ? el.cloneNode(false) : document.createElement('div');
  copy.removeAttribute('id');
  copy.innerHTML = html ?? '';
  copy.style.cssText += ';position:absolute!important;left:-99999px!important;top:0!important;opacity:0!important;pointer-events:none!important';
  (el || document.body.lastChild).after(copy);
  const out = copy.innerText;
  copy.remove();
  return out;
}

function describePublish() {
  const text = renderedText;
  let before = '', after = '';
  const html = [...state.pending].find(([, v]) => v.html !== undefined);
  const attr = [...state.pending].find(([, v]) => v.attrs);
  const src = [...state.pendingSource][0];
  if (html) {
    before = text(html[0], state.undoBase.get(html[0]));
    after = text(html[0], html[1].html);
  } else if (src) {
    before = state.sourceBase.get(src[0]) ?? '';
    after = src[1].value;
  } else if (attr) {
    // An image swap or a link change: say what kind of thing changed, not a data: URL.
    const [key, v] = attr;
    const name = ['alt', 'href'].find(a => a in v.attrs);
    before = name ? (state.undoBaseAttrs.get(key)?.[name] ?? '') : 'The old picture';
    after = name ? v.attrs[name] : 'Your new picture';
  }
  const file = pageFileCandidates(location.pathname, cfg.root || '')[0];
  return { before, after, message: editCommitMessage(file, [...flattenPending().map(e => e.key), ...state.pendingSource.keys()]) };
}

function publishSandbox(noteMsg = '', note = '') {
  const told = describePublish();
  if (noteMsg) told.message = noteMsg;
  const s = sandboxStore();
  s._createdAt = s._createdAt || Date.now();
  s.pages = s.pages || {};
  const prevPage = s.pages[sandboxPath()] ? JSON.parse(JSON.stringify(s.pages[sandboxPath()])) : null;
  // The demo's History: this publish, with what each part was before it.
  const entry = state.pending.size ? historyEntry({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(), message: told.message, pending: state.pending, baseHtml: (key) => state.undoBase.get(key), baseAttr: attrBefore }) : null;
  const record = publishRecord({ sandbox: true, prevPage, source: [], historyId: entry?.id });
  for (const [key, v] of state.pending) {
    record.entries.set(key, JSON.stringify(v));
    record.prevBase.set(key, state.undoBase.get(key));
    record.prevBaseAttrs.set(key, state.undoBaseAttrs.get(key));
  }
  for (const [ref, v] of state.pendingSource) record.source.push({ ref, entry: { ...v }, base: state.sourceBase.get(ref) });
  record.source = record.source.map(x => [x.ref, x]);
  const page = s.pages[sandboxPath()] || {};
  for (const [key, v] of state.pending) {
    const cur = page[key] || {};
    if (v.html !== undefined) cur.html = v.html;
    if (v.attrs) cur.attrs = Object.assign(cur.attrs || {}, v.attrs);
    page[key] = cur;
  }
  // Source edits stage + preview locally too — never a network commit (§13).
  for (const [ref, v] of state.pendingSource) page[ref] = { text: v.value };
  s.pages[sandboxPath()] = page;
  if (sandboxWasEmpty) s._asFile = { ...(s._asFile || {}), [sandboxPath()]: 1 };   // stored by this editor: nothing to mend later
  s._published = true;   // the pill keeps the way to get Kiln in sight from now on (syncSandboxLink)
  s.history = s.history || {};
  const earlier = s.history[sandboxPath()];
  if (entry) s.history[sandboxPath()] = withEntry(earlier, entry);
  // No room: the publish matters more than how far back History reaches.
  if (!sandboxSave(s) && entry) { s.history[sandboxPath()] = [entry]; if (!sandboxSave(s)) delete s.history[sandboxPath()]; }
  if (!sandboxSave(s)) {
    // Nothing was kept. The edits stay, and so does the line typed under "What changed?".
    keptNote = note || '';
    setStatus(SANDBOX_FULL, 'error');
    return;   // keep pending edits so the visitor can retry
  }
  keptNote = '';
  for (const [ref, v] of state.pendingSource) state.sourceBase.set(ref, v.value);
  state.pendingSource.clear();
  state.pending.clear();
  // Same publish boundary as a real site: what is published is no longer
  // something Undo can take back off the page.
  for (const [key, v] of Object.entries(page)) {
    if (v.html !== undefined) state.undoBase.set(key, v.html);
    if (v.attrs) state.undoBaseAttrs.set(key, { ...(state.undoBaseAttrs.get(key) || {}), ...v.attrs });
  }
  forgetEditHistory();
  document.querySelectorAll('.kiln-modified').forEach(el => el.classList.remove('kiln-modified'));
  refreshPublishButton();
  offerUndo(record);
  guidePublished(told);
  syncSandboxLink();
  noteSandboxLists();   // what was published is what the demo's "file" says now
}

function renderSandboxBanner() {
  const st = document.createElement('style');
  st.textContent = `
  /* Left-anchored (not centered) so it stays clear of the bottom-RIGHT editor
     status pill and the FAB. Stacked just UNDER the pencil and its buttons,
     toolbars, sheets and dialogs (wherever one of those needs the space, it
     wins) and just over the chrome that scrolls with the page. */
  #kiln-sandbox-banner{position:fixed;left:18px;bottom:18px;z-index:999998;
    display:flex;align-items:center;gap:13px;background:#1c1c28;color:#fff;border-radius:999px;
    padding:9px 9px 9px 18px;font:13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    box-shadow:0 10px 34px rgba(0,0,0,.34);max-width:min(560px,60vw)}
  #kiln-sandbox-banner b{color:#fff}
  #kiln-sandbox-banner button{background:#fff;color:#1c1c28;border:0;border-radius:999px;
    padding:7px 15px;font:600 12px sans-serif;cursor:pointer;white-space:nowrap}
  /* The way to get Kiln. The demo exists to make someone put Kiln on their own
     site, and the card that says so after a first publish does not stay. Once
     the visitor has published and that card has gone, the pill carries the
     link (.kiln-sbx-get) and says less: they know how the demo works by now. */
  #kiln-sandbox-get{display:none;background:#6366f1;color:#fff;border-radius:999px;padding:7px 15px;
    font:600 12px sans-serif;text-decoration:none;white-space:nowrap}
  #kiln-sandbox-get:hover,#kiln-sandbox-get:focus-visible{background:#4f46e5;color:#fff;outline:2px solid #fff;outline-offset:1px}
  #kiln-sandbox-banner.kiln-sbx-get{white-space:nowrap;gap:9px}
  .kiln-sbx-get #kiln-sandbox-get{display:inline-block}
  .kiln-sbx-get .kiln-sbx-more{display:none}
  /* The full sentence needs a wide window; below that the status pill beside the
     pencil would run into it. Keep the name and the button, on one line. With
     the link in it, the link and "Start over" are what matter: the name goes. */
  @media (max-width:1179px){
    #kiln-sandbox-banner{white-space:nowrap}
    #kiln-sandbox-banner .kiln-sbx-more{display:none}
    .kiln-sbx-get .kiln-sbx-words{display:none}
    #kiln-sandbox-banner.kiln-sbx-get{padding-left:9px}
  }
  /* Phones: a small pill at the bottom left, level with the docked pencil and
     never under it (the pencil's column is kept free on the right). It steps
     aside entirely while a field's toolbar or the menu sheet has the bottom of
     the screen. */
  @media ${MOBILE_MQ}{
    #kiln-sandbox-banner{left:calc(12px + env(safe-area-inset-left,0px));bottom:calc(22px + env(safe-area-inset-bottom,0px));
      max-width:calc(100vw - 108px);box-sizing:border-box;padding:5px 5px 5px 14px;gap:10px;font-size:13px;
      box-shadow:0 6px 22px rgba(0,0,0,.3)}
    #kiln-sandbox-banner span{overflow:hidden;text-overflow:ellipsis}
    #kiln-sandbox-banner button{flex:none;min-height:34px;padding:6px 13px}
    #kiln-sandbox-banner.kiln-sbx-get{padding-left:5px;gap:6px}
    .kiln-sbx-get #kiln-sandbox-get{display:inline-flex;align-items:center;flex:none;box-sizing:border-box;min-height:34px;padding:6px 12px}
    .kiln-tb-open #kiln-sandbox-banner,.kiln-menu-open #kiln-sandbox-banner{display:none}
  }
  /* The demo's menu is the menu of a real site: every item opens its own
     dialog, and says what a real site does where the demo cannot act. Only
     comments (they need other people) and Sign out (nobody is signed in) are
     left out. */
  [data-kiln-sandbox] #kiln-comments,[data-kiln-sandbox] #kiln-signout{display:none!important}`;
  document.head.appendChild(st);
  const b = document.createElement('div');
  b.id = 'kiln-sandbox-banner';
  b.innerHTML = '<span class="kiln-sbx-words"><b>Your private demo.</b><span class="kiln-sbx-more"> Click any text or image to edit, then hit Publish. Saved only for you; resets in 24h.</span></span>'
    + `<a id="kiln-sandbox-get" href="${START_URL}" target="_blank" rel="noopener">${START_LABEL}</a>`
    + '<button id="kiln-sandbox-reset">Start over</button>';
  document.body.appendChild(b);
  b.querySelector('#kiln-sandbox-reset').onclick = startOver;
  syncSandboxLink();
}

/**
 * "Start over": it used to clear the demo the moment it was pressed, and it is
 * on screen all the time. It asks first, in the editor's own dialog, and says
 * what this browser holds that would go. With nothing to lose it just starts over.
 */
async function startOver() {
  if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));
  const s = sandboxStore();
  const some = (of) => !!of && Object.values(of).some(v => v && (Array.isArray(v) ? v.length : Object.keys(v).length));
  const lost = { published: some(s.pages) || some(s.history), draft: some(s.drafts),
    unpublished: changeCount() + state.pendingBinaries.size };
  if ((lost.published || lost.draft || lost.unpublished) && !(await askFirst(modal, ownDialogCopy('start-over', lost)))) return;
  sandboxReset();
  location.reload();
}

/**
 * Whether the demo's pill shows its link to Kiln: once this browser's demo has
 * had a publish, whenever the card that offers the same link is not on screen
 * (it closes by itself, with "Keep exploring", or was never shown to a
 * returning visitor). Called when the pill is drawn, after a publish, and when
 * the card goes.
 */
function syncSandboxLink() {
  const pill = document.getElementById('kiln-sandbox-banner');
  if (!pill) return;
  pill.classList.toggle('kiln-sbx-get', hasPublished(sandboxStore()) && !document.getElementById('kiln-guide-card'));
}

async function initSandbox() {
  injectStyles();
  document.documentElement.setAttribute('data-kiln-sandbox', '1');
  sandboxTTLCheck();
  state.user = 'You';
  { const s = sandboxStore(); sandboxWasEmpty = !s.pages?.[sandboxPath()] && !s.history?.[sandboxPath()]; }
  await healSandboxStore();
  restoreSandboxPage();
  // Use the live DOM as the "source" so fields index cleanly and there is no repo fetch.
  state.page = { path: sandboxPath(), text: document.documentElement.outerHTML };
  state.fields = indexHtml(state.page.text);
  renderAdminBar();
  decorateFields();
  noteSandboxLists();
  await initSourceFields();   // demo source fields stage + preview locally (no worker)
  revealFields();
  renderSandboxBanner();
  // What was not published on an earlier visit is offered back, as on a real
  // site ("Pick up where you left off?"), and after that a draft saved here.
  offerPendingRestore();
  restoreAsked.then(offerDraftSandbox);
  bootBlocks();   // chrome shows in the demo; inserting explains it needs a real site
  // First visit to the demo: point at a heading, then at Publish, then say what happened.
  initGuide({ cfg, mobileMq: MOBILE_MQ, cardGone: syncSandboxLink,
    unpublished: () => state.pending.size + state.pendingSource.size + state.pendingBinaries.size + state.pendingStructural.length,
    publishButton: () => document.getElementById('kiln-pubsheet-go') || document.getElementById('kiln-publish-quick') });
}

/**
 * Publish verification — by checking REALITY, not deployment metadata.
 * (Hosts skip superseded builds, so a commit's deployment record can hang
 * forever even though the change shipped inside a later build.)
 *
 *   compare — fetch a page and hash-compare against the exact text we committed
 *   url     — a brand-new file's URL starts answering 200
 *
 * Every publish goes into a localStorage journal, so closing a modal — or the
 * whole tab — never strands you: verification resumes on the next page load
 * and announces when the change is confirmed live.
 */
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}
const journalKey = () => `kiln_publishing:${cfg.repo}`;
function journalAll() {
  try { return JSON.parse(localStorage.getItem(journalKey())) || []; } catch { return []; }
}
function journalSave(list) {
  try { localStorage.setItem(journalKey(), JSON.stringify(list)); } catch { /* ignore */ }
}
function journalAdd(entry) {
  const list = journalAll().filter(e => e.target !== entry.target);
  list.push({ ...entry, id: Math.random().toString(36).slice(2), started: Date.now() });
  journalSave(list);
  runJournal();
}

let journalTimer = null;
let journalTickN = 0;
function runJournal() {
  if (journalTimer) return;
  const tick = async () => {
    const list = journalAll();
    if (!list.length) { clearInterval(journalTimer); journalTimer = null; setStatusIdle(); return; }
    journalTickN++;
    const keep = [];
    let failed = false;
    for (const e of list) {
      // Deploy state (entries that carry a commit sha) is an ACCELERANT and a
      // failure detector, never the source of truth for "live" — hosts skip
      // superseded builds, so a commit's own deployment can hang forever while
      // the change ships inside a later build. The url/compare probe below
      // still decides. Polled every 2nd tick (12s) to stay polite via proxy.
      if (e.sha && !e.deployed && state.gh && journalTickN % 2 === 1) {
        try {
          const ds = await deployState(state.gh, cfg.repo, e.sha);
          if (ds === 'failure' || ds === 'error') {
            setStatus('Build failed — open commit', 'error',
              { href: `https://github.com/${cfg.repo}/commit/${e.sha}` });
            failed = true;
            continue;                       // drop the entry — it will never go live
          }
          if (ds === 'success') e.deployed = true;   // strong signal; probe confirms below
        } catch { /* deploy-state read failed — the probe still decides */ }
      }
      let live = false;
      try {
        if (e.type === 'url') {
          live = (await fetch(`${e.target}${e.target.includes('?') ? '&' : '?'}kilncb=${Date.now()}`,
            { method: 'HEAD', cache: 'no-store' })).ok;
        } else {
          const res = await fetch(`${e.target}?kilncb=${Date.now()}`, { cache: 'no-store' });
          live = res.ok && djb2(await res.text()) === e.expect;
        }
      } catch { /* network blip — keep waiting */ }
      if (live) {
        if (e.deployed) setStatus('Live ✓ — view site', 'saved', { href: e.target });
        else setStatus(`${e.desc} — live ✓`, 'saved');
        if (e.target === location.pathname || e.target === location.pathname + location.search) swapImagePreviews();
      } else if (Date.now() - e.started > 6 * 60 * 1000) {
        setStatus(`${e.desc} — published ✓ (taking longer than usual to appear; it will)`, 'saved');
      } else {
        keep.push(e);
      }
    }
    journalSave(keep);
    if (keep.length && !failed) {
      setStatus(goingLiveLabel(keep), 'saving');
    }
  };
  journalTimer = setInterval(tick, 6000);
  tick();
}

function setStatusIdle() {
  const then = statusShown;
  setTimeout(() => {
    // Never let the idle reset paper over a visible failure (e.g. build failed).
    const el = document.getElementById('kiln-status');
    if (!el || el.classList.contains('kiln-status--error')) return;
    // Nor over a line that came after the one this was set for: "Removed. Undo"
    // has ten seconds, and this used to take it away after four.
    if (statusShown !== then) return;
    // On a phone the toast covers the page: it returns only with news, and
    // "you are still signed in" is not news.
    if (isMobileEditor()) { el.hidden = true; return; }
    setStatus(`Signed in as ${state.user}`, 'idle');
  }, 4000);
}

function swapImagePreviews() {
  document.querySelectorAll('img[data-kiln-src]').forEach(img => {
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = img.getAttribute('data-kiln-src');
    img.removeAttribute('data-kiln-src');
  });
}

/** Compatibility wrapper: page-edit publishes register a compare entry. */
function watchDeploy(sha, committedText) {
  if (committedText) {
    journalAdd({ type: 'compare', target: location.pathname, expect: djb2(committedText), desc: 'Your page edit', sha });
  } else {
    setStatus('Published to GitHub ✓', 'saved');
    setStatusIdle();
  }
}

// ─── New post / new page ─────────────────────────────────────────────────────

function newContent() {
  const m = modal(`
    <h3>Create something new</h3>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-new-kind" value="post" checked>
        <span><strong>Blog post</strong><br><small>Appears in the journal automatically.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-new-kind" value="page">
        <span><strong>Page</strong><br><small>A standalone page (e.g. /services.html). Add it to the menu afterwards.</small></span></label>
    </div>
    <label>Title <input type="text" id="kiln-np-title" placeholder="What's it called?"></label>
    ${!cfg.sandbox && hasFeature('ai') ? `<label>Brief — let AI draft the content (optional)
      <textarea id="kiln-np-brief" rows="2" maxlength="2000" style="width:100%;font:inherit;resize:vertical"
        placeholder="One line on what it should say, e.g. 'Announcing our fall pie menu'"></textarea></label>` : ''}
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-np-go">Create</button>
    </div>
    <p class="kiln-np-step" id="kiln-np-said" role="status"></p>`);
  // What is typed here is set aside while the page is being made, not thrown
  // away: if it does not go through, the form comes back as it was.
  const form = document.createElement('div');
  const progress = document.createElement('div');
  const formBody = m.querySelector('.kiln-modal-body');
  form.append(...formBody.childNodes);
  formBody.append(form, progress);
  form.querySelector('#kiln-np-title').focus();
  m.querySelector('#kiln-np-go').onclick = async () => {
    const title = m.querySelector('#kiln-np-title').value.trim();
    const kind = m.querySelector('input[name="kiln-new-kind"]:checked').value;
    const brief = m.querySelector('#kiln-np-brief')?.value.trim() || '';
    if (!title) return;
    if (cfg.sandbox) { m.querySelector('#kiln-np-said').textContent = demoSays('newpage'); return; }
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || kind;
    const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const root = cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '';
    const branch = cfg.branch || 'main';
    const href = kind === 'post' ? `/blog/${slug}.html` : `/${slug}.html`;
    const body = progress;
    form.style.display = 'none';
    body.style.display = '';
    body.innerHTML = `<h3>Publishing “${escapeHtml(title)}”</h3>
      <p class="kiln-np-step" id="kiln-np-status">Committing to GitHub…</p>
      <div class="kiln-modal-actions">
        <button class="kiln-btn-ghost" data-close>Close</button>
        <button class="kiln-btn-publish" id="kiln-np-open" disabled>Open it →</button>
      </div>`;
    const status = body.querySelector('#kiln-np-status');
    const openBtn = body.querySelector('#kiln-np-open');
    try {
      const filePath = root + href.slice(1);
      const exists = await getFile(state.gh, cfg.repo, filePath, branch).catch(err => {
        if (err.status === 404) return null;
        throw err;
      });
      if (exists) throw said(`${href} is already a page on this site, so please pick another title`);

      // Optional AI draft: fill the template's remaining text fields from the
      // brief BEFORE the commit that creates the page. The title comes from the
      // title input and the date stays untouched; drafted values are plain text,
      // escaped like the title, so they ride the same pipeline as everything
      // else. Any failure degrades to creating the page un-filled.
      let draftFailed = '';
      const aiDraft = async (html) => {
        if (!brief) return html;
        const skip = new Set(['post_title', 'post_date', 'page_title']);
        const fillable = [...indexHtml(html).fields.values()]
          .filter(f => f.kind === 'field' && f.inner && !skip.has(f.key))
          .slice(0, 20)
          .map(f => ({ key: f.key, hint: humanizeKey(f.key) }));
        if (!fillable.length) return html;
        status.textContent = 'Drafting the content with AI…';
        const r = await draftFill(brief, fillable);
        status.textContent = 'Committing to GitHub…';
        if (r.error) { draftFailed = r.error; return html; }
        const edits = Object.entries(r.fields).map(([key, text]) => ({ key, html: escapeHtml(text) }));
        return edits.length ? applyEdits(html, edits).html : html;
      };

      const files = [];
      if (kind === 'post') {
        const tpl = await getFile(state.gh, cfg.repo, root + '_templates/post.html', branch);
        const cardTpl = await getFile(state.gh, cfg.repo, root + '_templates/post-card.html', branch);
        const blogIndex = await getFile(state.gh, cfg.repo, root + 'blog/index.html', branch);
        const postHtml = await aiDraft(applyEdits(tpl.text, [
          { key: 'post_title', html: escapeHtml(title) },
          { key: 'post_date', html: escapeHtml(date) },
        ]).html.replaceAll('{{title}}', escapeHtml(title)));
        const card = cardTpl.text
          .replaceAll('{{title}}', escapeHtml(title))
          .replaceAll('{{href}}', href)
          .replaceAll('{{date}}', escapeHtml(date));
        const newIndex = applyEdits(blogIndex.text, [{ key: 'post_list', prepend: '\n      ' + card.trim() }]);
        if (!newIndex.applied.length) throw said('The blog page has no list for posts to go into. For the owner: blog/index.html needs a data-cms-list="post_list" container');
        files.push({ path: filePath, text: postHtml }, { path: root + 'blog/index.html', text: newIndex.html });
      } else {
        const tpl = await getFile(state.gh, cfg.repo, root + '_templates/page.html', branch);
        const pageHtml = await aiDraft(applyEdits(tpl.text, [
          { key: 'page_title', html: escapeHtml(title) },
        ]).html.replaceAll('{{title}}', escapeHtml(title)));
        files.push({ path: filePath, text: pageHtml });
      }

      const commit = await commitFiles(state.gh, cfg.repo, branch, files,
        `New ${kind}: ${title} (via Kiln)`);

      journalAdd({ type: 'url', target: href, desc: `New ${kind} “${title}”`, sha: commit.sha });
      status.innerHTML = `Committed ✓ — the site is rebuilding (usually under a minute).<br>
        ${draftFailed ? `<small>The AI did not write a draft, so the ${kind} was created without one. ${escapeHtml(draftFailed)}</small><br>` : ''}
        <small>Safe to close this window: Kiln keeps watching in the background and the link below
        starts working the moment the ${kind} is live${kind === 'page' ? ' — then add it to your navigation via <strong>Site menu</strong>' : ''}.</small>`;
      const started = Date.now();
      const poll = async () => {
        if (!document.body.contains(m)) return;
        try {
          const r = await fetch(`${href}?kilncb=${Date.now()}`, { method: 'HEAD', cache: 'no-store' });
          if (r.ok) {
            status.innerHTML = `<strong>Live ✓</strong> — open it and click into the text to write.${
              kind === 'page' ? ' Then add it to your navigation via <strong>Site menu</strong>.' : ''}`;
            openBtn.disabled = false;
            openBtn.onclick = () => { window.location.assign(href); };
            return;
          }
        } catch { /* keep polling */ }
        if (Date.now() - started > 5 * 60 * 1000) {
          status.textContent = 'Still building — Kiln keeps watching in the background. The page WILL appear; check the journal/menu in a minute.';
          return;
        }
        setTimeout(poll, 5000);
      };
      poll();
    } catch (err) {
      console.error('[kiln] new', kind, err);
      // The form again, with what was typed, and why it did not go through.
      body.style.display = 'none';
      form.style.display = '';
      m.querySelector('#kiln-np-said').textContent = err.status === 404
        ? `This site has no ${kind} template (_templates/${kind}.html) — see the docs.`
        : stopped(err, 'created', typedIn(form)) || notDone('Nothing was created.', err);
    }
  };
}

// ─── Menu editor ─────────────────────────────────────────────────────────────

function menuEditor() {
  const menuField = [...state.fields.fields.values()].find(f => f.kind === 'menu');
  // The demo shows the dialog with the links of the page's own menu in it,
  // whether or not that menu is marked for Kiln: nothing is saved there anyway.
  const demoNav = cfg.sandbox && !menuField
    ? [...document.querySelectorAll('header nav, nav')].find(n => !n.closest(KILN_CHROME) && n.querySelector('a')) : null;
  if (!menuField && !demoNav) {
    modal(`<h3>No editable menu</h3>
      <p class="kiln-dim">This page's navigation isn't marked with <code>data-cms-menu</code>,
      so Kiln can't manage it. See the docs to enable menu editing.</p>
      <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);
    return;
  }
  // Parse the current items from this page's source.
  const innerHtml = demoNav ? demoNav.innerHTML : state.page.text.slice(menuField.inner.start, menuField.inner.end);
  const docFrag = new DOMParser().parseFromString(innerHtml, 'text/html');
  let rows = [...docFrag.querySelectorAll('a')].map(a => ({
    label: a.textContent.trim(), href: a.getAttribute('href') || '/',
  }));
  // Preserve the item wrapper (e.g. <ul><li><a>) so list-based navs keep their
  // markup instead of being flattened to bare <a> on the next menu edit.
  const anchors = [...docFrag.querySelectorAll('a')];
  const itemTag = anchors.length && anchors.every(a => a.parentElement && a.parentElement.tagName === 'LI')
    ? 'li' : null;
  // Also preserve the surrounding <ul>/<ol>. When the menu is tagged on a <nav>
  // (what autotag does), menuField.inner is the whole <ul>…</ul>; rebuilding only
  // the <li> rows would drop the <ul>, orphaning <li> under <nav> and breaking
  // every `nav ul li` rule site-wide. If the items sit in exactly one list, keep
  // that list's open/close tags (with its attributes).
  let listOpen = '', listClose = '';
  if (itemTag === 'li') {
    const lists = [...docFrag.body.querySelectorAll('ul, ol')].filter(l => l.querySelector('li > a'));
    if (lists.length === 1) {
      const tag = lists[0].tagName.toLowerCase();
      const attrs = [...lists[0].attributes].map(a => ` ${a.name}="${escapeHtml(a.value)}"`).join('');
      listOpen = `<${tag}${attrs}>`;
      listClose = `</${tag}>`;
    }
  }

  const m = modal(`
    <h3>Site menu</h3>
    <p class="kiln-dim">Changes apply to <strong>every page</strong> of the site (and to the
    templates, so new pages get the updated menu) in one commit.</p>
    <div id="kiln-menu-rows"></div>
    <button class="kiln-btn-ghost" id="kiln-menu-add">+ Add menu item</button>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-menu-save">Save to all pages</button>
    </div>
    <p class="kiln-np-step" id="kiln-menu-status"></p>`);

  const rowsEl = m.querySelector('#kiln-menu-rows');
  function render() {
    rowsEl.innerHTML = '';
    rows.forEach((row, i) => {
      const div = document.createElement('div');
      div.className = 'kiln-menu-row';
      div.innerHTML = `
        <input type="text" class="kiln-menu-label" value="${escapeHtml(row.label)}" placeholder="Label">
        <input type="text" class="kiln-menu-href" value="${escapeHtml(row.href)}" placeholder="/page.html">
        <button title="Move up">↑</button><button title="Move down">↓</button><button title="Remove">✕</button>`;
      const [up, down, del] = div.querySelectorAll('button');
      div.querySelector('.kiln-menu-label').oninput = (e) => { rows[i].label = e.target.value; };
      div.querySelector('.kiln-menu-href').oninput = (e) => { rows[i].href = e.target.value; };
      up.onclick = () => { if (i > 0) { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; render(); } };
      down.onclick = () => { if (i < rows.length - 1) { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; render(); } };
      del.onclick = () => { rows.splice(i, 1); render(); };
      rowsEl.appendChild(div);
    });
  }
  render();
  m.querySelector('#kiln-menu-add').onclick = () => { rows.push({ label: 'New item', href: '/' }); render(); };

  m.querySelector('#kiln-menu-save').onclick = async () => {
    const status = m.querySelector('#kiln-menu-status');
    if (cfg.sandbox) { status.textContent = demoSays('menu'); return; }
    const menuKey = menuField.key;
    const wrap = (a) => itemTag ? `<${itemTag}>${a}</${itemTag}>` : a;
    const items = rows
      .filter(r => r.label.trim())
      // safeUrl() the href before it's spliced: menu inner-HTML bypasses DOMPurify,
      // and escapeHtml alone doesn't neutralize javascript:/data: schemes, so an
      // editor could otherwise plant script on every page's nav. (safeUrl mirrors
      // the engine's own href gate.)
      .map(r => wrap(`<a href="${escapeHtml(safeUrl(r.href.trim() || '/'))}">${escapeHtml(r.label.trim())}</a>`))
      .join('\n        ');
    const newInner = listOpen
      ? `\n      ${listOpen}\n        ${items}\n      ${listClose}\n    `
      : `\n      ${items}\n    `;
    try {
      status.textContent = 'Step 1 of 3 · Finding the site’s pages…';
      const branch = cfg.branch || 'main';
      const tree = await state.gh.request('GET',
        `/repos/${cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const htmlFiles = tree.tree
        .filter(t => t.type === 'blob' && t.path.endsWith('.html'))
        .map(t => t.path)
        .slice(0, 100);

      const changed = [];
      let skippedPages = 0;
      for (let i = 0; i < htmlFiles.length; i++) {
        status.textContent = `Updating menus… ${i + 1}/${htmlFiles.length}`;
        const file = await getFile(state.gh, cfg.repo, htmlFiles[i], branch);
        const result = applyEdits(file.text, [{ key: menuKey, html: newInner }]);
        if (result.applied.length) changed.push({ path: htmlFiles[i], text: result.html });
        else skippedPages++;
      }
      if (!changed.length) throw said('No page of the site has this menu marked for Kiln. For the owner: the menu needs a matching data-cms-menu container');

      status.textContent = `Committing ${changed.length} page${changed.length > 1 ? 's' : ''} as one change…`;
      const commit = await commitFiles(state.gh, cfg.repo, branch, changed,
        `Update menu on ${changed.length} pages (via Kiln)`);
      const thisPage = changed.find(c => c.path === state.page.path);
      if (thisPage) journalAdd({ type: 'compare', target: location.pathname, expect: djb2(thisPage.text), desc: 'Menu update', sha: commit.sha });
      status.innerHTML = `Step 2 of 3 · Committed ✓ — the site is rebuilding.
        ${skippedPages ? skippedPages + ' page(s) had no managed menu and were left alone.' : ''}<br>
        <small><strong>Safe to close this window</strong> — Kiln keeps watching in the background and
        will say “Menu update — live ✓” by the Kiln button when it's done.</small>`;
      const started = Date.now();
      const poll = async () => {
        if (!document.body.contains(m)) return;
        try {
          const res = await fetch(`${location.pathname}?kilncb=${Date.now()}`, { cache: 'no-store' });
          if (thisPage && res.ok && djb2(await res.text()) === djb2(thisPage.text)) {
            status.innerHTML = 'Step 3 of 3 · <strong>Menu is live on every page ✓</strong>';
            const actions = m.querySelector('.kiln-modal-actions');
            actions.innerHTML = '<button class="kiln-btn-publish" id="kiln-menu-reload">Reload to see it</button>';
            actions.querySelector('#kiln-menu-reload').onclick = () => location.reload();
            return;
          }
        } catch { /* keep polling */ }
        if (Date.now() - started > 5 * 60 * 1000) { status.textContent = 'Still building — watching continues in the background. Safe to close.'; return; }
        setTimeout(poll, 5000);
      };
      poll();
    } catch (err) {
      console.error('[kiln] menu', err);
      status.textContent = stopped(err, 'saved', typedIn(m, true)) || notDone('The menu was not saved.', err);
    }
  };
}

// ─── People & access (admin only) ────────────────────────────────────────────

// Pull the editable sections out of a page's raw HTML (data-cms / -repeat / -menu),
// each with a short text snippet so admins can tell WHAT a key like "hiw2_body" is.
// DOMParser doesn't execute scripts, so parsing repo HTML here is inert.
function extractSections(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [], seen = new Set();
  doc.querySelectorAll('[data-cms],[data-cms-repeat],[data-cms-menu]').forEach(el => {
    const key = el.getAttribute('data-cms') || el.getAttribute('data-cms-repeat') || el.getAttribute('data-cms-menu');
    if (!key || seen.has(key)) return;
    seen.add(key);
    let snippet = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 44);
    if (!snippet && el.tagName === 'IMG') snippet = el.getAttribute('alt') || '(image)';
    out.push({ key, snippet });
  });
  return out;
}

// The site's .html pages, cached per panel-open. Folders in the scope expand to the
// pages they contain so "Choose sections" can group by real page.
let _sitePagesCache = null;
async function listSitePages() {
  if (_sitePagesCache) return _sitePagesCache;
  if (cfg.sandbox) {
    // The demo has no repository to list: this page, and the pages of the site it links to.
    const pages = new Set(pageFileCandidates(location.pathname, cfg.root || '').slice(0, 1));
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.closest(KILN_CHROME)) continue;
      let u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      if (u.origin === location.origin && /(\/|\.html)$/.test(u.pathname)) pages.add(pageFileCandidates(u.pathname, cfg.root || '')[0]);
    }
    _sitePagesCache = [...pages];
    return _sitePagesCache;
  }
  const tree = await state.gh.request('GET',
    `/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch || 'main')}?recursive=1`);
  _sitePagesCache = tree.tree.filter(t => t.type === 'blob' && t.path.endsWith('.html')
    && !t.path.startsWith('_templates/') && !t.path.startsWith('_blocks/')).map(t => t.path);
  return _sitePagesCache;
}

async function invitePanel() {
  _sitePagesCache = null;   // fresh each time the panel opens
  const m = modal(`
    <h3>People &amp; access</h3>
    <p class="kiln-dim" id="kiln-gstatus">Checking Google sign-in…</p>
    <div id="kiln-people-form" style="display:none">
      <label>Google email <input type="email" id="kiln-p-email" placeholder="them@gmail.com"></label>
      <div class="kiln-2col">
        <label>Name <input type="text" id="kiln-p-name" placeholder="Claudia"></label>
        <label>Access (days) <input type="number" id="kiln-p-days" value="90" min="1" max="360"></label>
      </div>
      <label style="font-weight:normal;display:inline-flex;gap:6px;align-items:center;margin:2px 0 4px"><input type="checkbox" id="kiln-p-never"> ${PEOPLE_WORDS.never}</label>
      <div class="kiln-roles">
        <label class="kiln-role"><input type="radio" name="kiln-p-role" value="editor" checked>
          <span><strong>Editor</strong><br><small>Edits pages, images, posts. Signs in with their Google account.</small></span></label>
        <label class="kiln-role"><input type="radio" name="kiln-p-role" value="member">
          <span><strong>Member</strong><br><small>Views the members-only area and documents. Cannot edit.</small></span></label>
      </div>
      <label id="kiln-p-paths-wrap">${PEOPLE_WORDS.pagesLabel}
        <input type="text" id="kiln-p-paths" placeholder="${PEOPLE_WORDS.pagesPlaceholder}"></label>
      <p class="kiln-dim kiln-p-hint" id="kiln-p-paths-hint">${PEOPLE_WORDS.pagesHint}
        <button type="button" class="kiln-btn-pick" id="kiln-p-pick" aria-expanded="false">▾ Choose pages</button></p>
      <div id="kiln-p-pages" class="kiln-pick-box" style="display:none"></div>
      <label id="kiln-p-keys-wrap">${PEOPLE_WORDS.keysLabel}
        <input type="text" id="kiln-p-keys" placeholder="${PEOPLE_WORDS.keysPlaceholder}"></label>
      <p class="kiln-dim kiln-p-hint" id="kiln-p-keys-hint">${PEOPLE_WORDS.keysHint}
        <button type="button" class="kiln-btn-pick" id="kiln-p-keypick" aria-expanded="false">▾ Choose parts</button></p>
      <div id="kiln-p-keylist" class="kiln-pick-box" style="display:none"></div>
      <div id="kiln-p-feat-wrap">
        <label style="margin-bottom:2px">Tools this editor can use
          <button type="button" class="kiln-btn-pick" id="kiln-p-reviewer" title="A comment-only seat: they review and leave comments, with no other tools">Reviewer preset</button></label>
        <div id="kiln-p-features" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin:2px 0 8px"></div>
        <p class="kiln-dim kiln-p-hint">${escapeHtml(PEOPLE_WORDS.toolsHint)}</p>
        <label style="font-weight:normal;display:inline-flex;gap:6px;align-items:flex-start;margin:2px 0 4px;font-size:13px">
          <input type="checkbox" id="kiln-p-suggest" style="margin-top:2px">
          <span><strong>Suggest-only publishing.</strong> ${escapeHtml(PEOPLE_WORDS.suggest)}</span></label>
      </div>
      <p class="kiln-np-step" id="kiln-p-said" role="status"></p>
      <div class="kiln-modal-actions" style="justify-content:flex-start;margin-top:8px">
        <button class="kiln-btn-publish" id="kiln-p-add">Add person</button>
      </div>
      <div id="kiln-people-list" class="kiln-inv-list" style="margin-top:10px">Loading…</div>
    </div>
    <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);

  // Feature checkboxes (which menu tools an editor may use). Defaults on: the
  // low-risk content tools; off: site-wide/structural tools.
  const FEATURES = [
    { v: 'pagesettings', label: 'Page settings', def: true },
    { v: 'history', label: 'History & restore', def: true },
    { v: 'draft', label: 'Save drafts', def: true },
    { v: 'newpost', label: 'New posts & pages', def: false },
    { v: 'schedule', label: 'Schedule publishing', def: false },
    { v: 'menu', label: 'Edit site menu', def: false },
    { v: 'theme', label: 'Theme (colors & fonts)', def: false },
    { v: 'findreplace', label: 'Find & replace', def: false },
    { v: 'makeeditable', label: 'Make things editable', def: false },
    { v: 'comments', label: 'Comments', def: false },
    // AI spends the owner's API credit, so the grant is opt-in — never a default.
    { v: 'ai', label: 'AI assist', def: false },
    { v: 'blocks', label: 'Add sections (blocks)', def: false },
  ];
  m.querySelector('#kiln-p-features').innerHTML = FEATURES.map(f =>
    `<label style="font-weight:normal;display:inline-flex;gap:6px;align-items:center;font-size:12.5px;margin:0">
      <input type="checkbox" class="kiln-p-feat" value="${f.v}" ${f.def ? 'checked' : ''}> ${escapeHtml(f.label)}</label>`).join('');

  // Reviewer preset: a comment-only seat — the Comments tool and nothing else,
  // with the path/section scope cleared back to the defaults.
  m.querySelector('#kiln-p-reviewer').onclick = (e) => {
    e.preventDefault();
    m.querySelectorAll('.kiln-p-feat').forEach(c => { c.checked = c.value === 'comments'; });
    m.querySelector('#kiln-p-paths').value = '';
    m.querySelector('#kiln-p-keys').value = '';
    m.querySelector('#kiln-p-suggest').checked = false;
    m.dataset.mode = 'review';   // comment-only: the worker refuses every write for this seat
  };

  // Show the scope fields only when adding an editor.
  const scopeEls = ['#kiln-p-paths-wrap', '#kiln-p-paths-hint', '#kiln-p-keys-wrap', '#kiln-p-keys-hint', '#kiln-p-feat-wrap']
    .map(s => m.querySelector(s));
  function syncRole() {
    const isEditor = m.querySelector('input[name="kiln-p-role"]:checked').value === 'editor';
    scopeEls.forEach(el => { el.style.display = isEditor ? '' : 'none'; });
    if (!isEditor) { m.querySelector('#kiln-p-pages').style.display = 'none'; m.querySelector('#kiln-p-keylist').style.display = 'none'; }
    else if (m.querySelector('#kiln-p-pages').style.display === 'none') m.querySelector('#kiln-p-pick').click();  // auto-open the page checklist
  }

  // "Choose sections" — checklist of editable fields, GROUPED BY PAGE. Pulls the
  // pages the editor is scoped to (or the whole site if unscoped) and lists each
  // page's sections under its own heading, plus a "whole page" catch-all per page.
  const keyPickBtn = m.querySelector('#kiln-p-keypick');
  keyPickBtn.onclick = async (e) => {
    e.preventDefault();
    const box = m.querySelector('#kiln-p-keylist');
    if (box.style.display !== 'none') { box.style.display = 'none'; keyPickBtn.setAttribute('aria-expanded', 'false'); return; }
    box.style.display = ''; keyPickBtn.setAttribute('aria-expanded', 'true');
    const input = m.querySelector('#kiln-p-keys');
    const selected = () => new Set(input.value.split(',').map(s => s.trim()).filter(Boolean));
    const writeBack = (v, on) => { const cur = selected(); if (on) cur.add(v); else cur.delete(v); input.value = [...cur].join(', '); };

    box.innerHTML = '<p class="kiln-dim" style="margin:6px 2px">Loading sections…</p>';
    // Resolve which pages to show sections for, honoring the page scope (folders expand).
    const thisPage = cfg.sandbox ? pageFileCandidates(location.pathname, cfg.root || '')[0] : state.page.path;
    let pages;
    try {
      const scope = m.querySelector('#kiln-p-paths').value.split(',').map(s => s.trim()).filter(Boolean);
      if (!scope.length) {
        pages = await listSitePages();
      } else {
        const all = await listSitePages();
        pages = [];
        for (const s of scope) {
          if (s.endsWith('.html')) { if (!pages.includes(s)) pages.push(s); }
          else all.filter(p => p === s || p.startsWith(s.replace(/\/$/, '') + '/')).forEach(p => { if (!pages.includes(p)) pages.push(p); });
        }
        if (!pages.includes(thisPage)) pages.unshift(thisPage);
      }
    } catch (err) { stopped(err); pages = [thisPage]; }
    pages = pages.slice(0, 25);

    // Fetch each page's sections+snippets (current page parses its own source — no round-trip).
    const groups = [];
    for (const path of pages) {
      if (path === thisPage) { groups.push({ path, sections: extractSections(state.page.text) }); continue; }
      // the demo reads its other pages as a visitor would; a real site reads the files
      try { const f = cfg.sandbox ? { text: await (await fetch('/' + path)).text() } : await getFile(state.gh, cfg.repo, path, cfg.branch || 'main'); groups.push({ path, sections: extractSections(f.text) }); }
      catch (err) { groups.push({ path, sections: [], err: true }); if (signInOver) break; }
    }

    box.innerHTML = '';
    let any = false;
    for (const g of groups) {
      const head = document.createElement('div');
      head.className = 'kiln-pick-group';
      head.textContent = g.path + (g.path === thisPage ? '  · this page' : '');
      box.appendChild(head);
      if (g.err) { const p = document.createElement('p'); p.className = 'kiln-dim'; p.style.margin = '2px'; p.textContent = "Couldn't load this page."; box.appendChild(p); continue; }
      if (!g.sections.length) { const p = document.createElement('p'); p.className = 'kiln-dim'; p.style.margin = '2px'; p.textContent = 'No named sections.'; box.appendChild(p); continue; }
      any = true;
      const prefixes = [...new Set(g.sections.map(s => (s.key.match(/^[a-z0-9]+_/i) || [])[0]).filter(Boolean))];
      const opts = [
        ...prefixes.map(p => ({ v: p, label: `${p}∗`, snippet: `everything starting “${p}”` })),
        ...g.sections.map(s => ({ v: s.key, label: s.key, snippet: s.snippet })),
      ];
      for (const o of opts) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;gap:8px;align-items:baseline;font-size:12.5px;margin:0;padding:4px 2px';
        row.innerHTML = `<input type="checkbox" value="${escapeHtml(o.v)}" ${selected().has(o.v) ? 'checked' : ''} style="flex:none;align-self:center">
          <span style="flex:none;font-weight:600">${escapeHtml(o.label)}</span>
          ${o.snippet ? `<span class="kiln-dim" style="margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">“${escapeHtml(o.snippet)}${o.snippet.length >= 44 ? '…' : ''}”</span>` : ''}`;
        row.querySelector('input').onchange = (ev) => writeBack(o.v, ev.target.checked);
        box.appendChild(row);
      }
    }
    if (!any && !groups.some(g => g.sections.length)) box.innerHTML = '<p class="kiln-dim" style="margin:6px 2px">These pages have no named sections yet.</p>';
  };

  // "Choose pages" — checkbox list of the site's pages/folders, written back
  // into the comma-separated paths field (which stays hand-editable).
  const pagePickBtn = m.querySelector('#kiln-p-pick');
  pagePickBtn.onclick = async (e) => {
    e.preventDefault();
    const box = m.querySelector('#kiln-p-pages');
    if (box.style.display !== 'none') { box.style.display = 'none'; pagePickBtn.setAttribute('aria-expanded', 'false'); return; }
    box.style.display = ''; pagePickBtn.setAttribute('aria-expanded', 'true');
    box.innerHTML = '<p class="kiln-dim" style="margin:6px 2px">Loading pages…</p>';
    try {
      const pages = (await listSitePages()).slice(0, 100);
      const dirs = [...new Set(pages.filter(p => p.includes('/')).map(p => p.split('/')[0]))];
      const options = [...dirs.map(d => ({ v: d, label: `${d}/ (folder)` })), ...pages.map(p => ({ v: p, label: p }))];
      const input = m.querySelector('#kiln-p-paths');
      const selected = () => new Set(input.value.split(',').map(s => s.trim()).filter(Boolean));
      box.innerHTML = '';
      for (const o of options) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:12.5px;margin:0;padding:4px 2px';
        row.innerHTML = `<input type="checkbox" value="${escapeHtml(o.v)}" ${selected().has(o.v) ? 'checked' : ''}> ${escapeHtml(o.label)}`;
        row.querySelector('input').onchange = (ev) => {
          const cur = selected();
          if (ev.target.checked) cur.add(o.v); else cur.delete(o.v);
          input.value = [...cur].join(', ');
        };
        box.appendChild(row);
      }
    } catch (err) {
      box.innerHTML = `<p class="kiln-dim" style="margin:6px 2px">${escapeHtml(stopped(err) || notDone('The list of pages could not be read.', err))}</p>`;
    }
  };
  m.querySelectorAll('input[name="kiln-p-role"]').forEach(r => r.addEventListener('change', syncRole));
  syncRole();

  // "Never expires" disables the days field; the add handler then sends days:0 (indefinite).
  const neverCb = m.querySelector('#kiln-p-never');
  const daysInput = m.querySelector('#kiln-p-days');
  neverCb.addEventListener('change', () => { daysInput.disabled = neverCb.checked; });

  async function refreshPeople() {
    const status = m.querySelector('#kiln-gstatus');
    const form = m.querySelector('#kiln-people-form');
    if (cfg.sandbox) {
      // The form a site's owner fills in, with nobody behind it.
      status.textContent = demoSays('people');
      form.style.display = '';
      m.querySelector('#kiln-people-list').innerHTML = '';
      return;
    }
    try {
      const data = await ask(`/admin/people?repo=${encodeURIComponent(cfg.repo)}`);
      if (!data.googleConfigured) {
        status.innerHTML = 'To invite editors and members, add Google sign-in to your auth worker: set '
          + '<code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> (see the README). '
          + 'People then sign in with their own Google account — no passwords, no links.';
        form.style.display = 'none';
        return;
      }
      status.textContent = PEOPLE_WORDS.signIn;
      form.style.display = '';
      // AI assist is a tool only where the site has an AI key. A worker that
      // says it has none: the box is not offered. One that says nothing (every
      // worker until it learns to) leaves the box as it was.
      if (data.aiConfigured === false) m.querySelector('.kiln-p-feat[value="ai"]')?.closest('label')?.remove();
      const list = m.querySelector('#kiln-people-list');
      list.innerHTML = (data.people || []).length ? '' : '<p class="kiln-dim">Nobody yet. Add the first person above.</p>';
      for (const p of data.people || []) {
        const realPaths = (p.paths || []).filter(x => x && x !== '' && x !== '**');
        const keyScope = (p.keys || []).length ? ` · sections: ${p.keys.join(', ')}` : '';
        const scope = p.role === 'editor' ? ((realPaths.length ? realPaths.join(', ') : 'whole site') + keyScope) : '';
        const roleLabel = p.role === 'editor' && p.mode === 'suggest' ? 'editor · suggest-only'
          : p.role === 'editor' && p.mode === 'review' ? 'editor · review-only' : p.role;
        const row = document.createElement('div');
        row.className = 'kiln-inv-row';
        row.innerHTML = `<span><strong>${escapeHtml(p.name)}</strong>
          <small>${escapeHtml(p.email)} · ${escapeHtml(roleLabel)}${scope ? ' · ' + escapeHtml(scope) : ''} · ${p.days ? p.days + 'd' : 'never expires'}</small></span>
          <button class="kiln-btn-ghost">Remove</button>`;
        row.querySelector('button').onclick = async () => {
          try {
            await ask('/admin/people/remove', { method: 'POST', body: { repo: cfg.repo, email: p.email } });
          } catch (err) {
            status.textContent = stopped(err, 'removed') || notDone('That person was not removed.', err);
            return;
          }
          refreshPeople();
        };
        list.appendChild(row);
      }
    } catch (err) {
      // The list could not be read. That says nothing about Google sign-in, so the form is left as it is.
      status.textContent = stopped(err) || notDone('The list of people could not be read.', err);
    }
  }
  refreshPeople();

  m.querySelector('#kiln-p-add').onclick = async () => {
    const email = m.querySelector('#kiln-p-email').value.trim();
    const name = m.querySelector('#kiln-p-name').value.trim();
    const days = m.querySelector('#kiln-p-never').checked ? 0 : m.querySelector('#kiln-p-days').value;
    const role = m.querySelector('input[name="kiln-p-role"]:checked').value;
    const paths = m.querySelector('#kiln-p-paths').value.trim();
    const keys = m.querySelector('#kiln-p-keys').value.trim();
    const features = [...m.querySelectorAll('.kiln-p-feat:checked')].map(c => c.value);
    const suggestOnly = m.querySelector('#kiln-p-suggest').checked;
    const said = m.querySelector('#kiln-p-said');
    const lacks = missingPerson({ email });
    said.textContent = lacks ? lacks.say : '';
    if (lacks) { m.querySelector('#kiln-p-email').focus(); return; }
    if (cfg.sandbox) { m.querySelector('#kiln-people-list').innerHTML = `<p class="kiln-dim">${escapeHtml(demoShort('people'))}</p>`; return; }
    let data;
    try {
      data = await ask('/admin/people', { method: 'POST', body: { repo: cfg.repo, email, name, role, days, paths, keys, features,
        ...(suggestOnly ? { mode: 'suggest' } : m.dataset.mode === 'review' ? { mode: 'review' } : {}) } });
    } catch (err) {
      // What was typed stays in the form.
      m.querySelector('#kiln-gstatus').textContent = stopped(err, 'added', typedIn(m)) || notDone('That person was not added.', err);
      return;
    }
    if (data.ok) {
      m.querySelector('#kiln-p-email').value = '';
      m.querySelector('#kiln-p-name').value = '';
      m.querySelector('#kiln-p-paths').value = '';
      m.querySelector('#kiln-p-keys').value = '';
      m.querySelector('#kiln-p-suggest').checked = false;
      delete m.dataset.mode;
      refreshPeople();
    }
  };
}

// ─── History (per-page restore points) ───────────────────────────────────────

const histCache = new Map();   // sha → file text (avoid re-fetching per field/commit)
async function histFile(sha) {
  if (!histCache.has(sha)) histCache.set(sha, (await getFile(state.gh, cfg.repo, state.page.path, sha)).text);
  return histCache.get(sha);
}

/** "hero_headline" → "hero headline", for the middle of a sentence (names.js). */
function humanizeKey(k) {
  return plainName(k);
}

/** Turn a commit message into something a layperson can read in a history list. */
function describeCommit(msg) {
  const first = String(msg).split('\n')[0];
  let m;
  if ((m = first.match(/^Edit [^:]+: (.+?) \(via Kiln\)$/))) {
    const keys = [...new Set(m[1].split(', ').map(humanizeKey))];
    return 'Edited ' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? ` and ${keys.length - 3} more` : '');
  }
  if ((m = first.match(/^Upload (\d+) file/))) return `Added ${m[1]} photo${+m[1] > 1 ? 's' : ''} or file${+m[1] > 1 ? 's' : ''}`;
  if (/^(Undo|Restore) .*\(via Kiln\)$/.test(first)) return 'Went back to an earlier version';
  if (/^Publish draft/.test(first)) return 'Published a saved draft';
  if (/^Publish scheduled/.test(first)) return 'A scheduled publish went live';
  return first.slice(0, 64);
}

/** The value a key currently has on the page (staged edit wins over live source). */
function currentValueFor(key, sourceVals) {
  const pend = state.pending.get(key);
  if (pend?.html !== undefined) return pend.html;
  return sourceVals[key];
}

/** A key's current DOM content, cleaned the way staging would write it. */
function currentDomHtmlFor(key) {
  const esc = CSS.escape(key);
  const rep = document.querySelector(`[data-cms-repeat="${esc}"]`);
  if (rep) return containerCleanHtml(rep).innerHTML;
  const el = document.querySelector(`[data-cms="${esc}"]`);
  return el ? baseHtml(el) : undefined;
}

/**
 * Apply a set of {key, value} changes to the LIVE page as a preview, with a
 * floating Keep/Cancel bar. Keep stages them as normal pending edits (published
 * with the Publish button, undoable with ⌘Z); Cancel puts everything back.
 * Nothing touches GitHub here.
 */
function previewRestore(changes, label, note, removals = []) {
  document.getElementById('kiln-previewbar')?.remove();
  const applied = [];
  for (const { key, value, attrs } of changes) {
    const target = elementForKey(key);
    if (target) beginKey(key, target);   // what Undo goes back to, should this be kept
    const before = value === undefined ? undefined : currentDomHtmlFor(key);
    if (value !== undefined && before === undefined) continue;              // section not on this page
    const el = value === undefined ? elementForKey(key) : applyKeyDom(key, value);
    if (!el) continue;
    // A swapped picture or a link's address (the demo's History keeps these too).
    let attrsBefore = null;
    if (attrs) {
      attrsBefore = {};
      for (const [name, v] of Object.entries(attrs)) {
        attrsBefore[name] = name === 'style' ? (ownStyle(el) ?? null) : el.getAttribute(name);
        if (name === 'style') showStyle(el, v); else el.setAttribute(name, v);
      }
    }
    el.classList.add('kiln-modified', 'kiln-flash');
    setTimeout(() => el.classList.remove('kiln-flash'), 1600);
    applied.push({ key, value, before, el, attrs, attrsBefore });
    previewing.add(key);
  }
  // Sections that must DISAPPEAR for this restore (e.g. a gallery that publish
  // added): preview by hiding; Keep stages a removeSection op.
  const removed = [];
  const seenNodes = new Set();
  for (const key of removals) {
    const esc = CSS.escape(key);
    const el = document.querySelector(`[data-cms-repeat="${esc}"], [data-cms="${esc}"]`);
    const sec = el?.closest('.kiln-added') || (el?.hasAttribute('data-cms-repeat') ? el : null);
    if (!sec || seenNodes.has(sec)) continue;
    seenNodes.add(sec);
    const repKey = sec.querySelector('[data-cms-repeat]')?.getAttribute('data-cms-repeat')
      || sec.getAttribute('data-cms-repeat') || key;
    sec.style.display = 'none';
    removed.push({ node: sec, key: repKey });
  }
  if (!applied.length && !removed.length) return 0;
  (applied[0]?.el || removed[0]?.node.previousElementSibling || document.body)
    .scrollIntoView({ behavior: 'smooth', block: 'center' });
  const bar = document.createElement('div');
  bar.id = 'kiln-previewbar';
  const nChanged = applied.length + removed.length;
  // This bar is the whole of going back: the page shows the older version,
  // and Keep leaves it there as unpublished edits. What it says after that is
  // what is left to do.
  bar.innerHTML = `<span><strong>Previewing</strong> ${label}. ${nChanged} section${nChanged > 1 ? 's' : ''} changed${removed.length ? ` (${removed.length} removed)` : ''}.
    ${note ? `<small>${note}</small>` : ''} <small>Nothing is live yet. Keep it, then press Publish.</small></span>
    <button class="kiln-btn-ghost" id="kiln-pv-cancel">Cancel</button>
    <button class="kiln-btn-publish" id="kiln-pv-keep" title="Keep this on the page as unpublished edits">Keep</button>`;
  noticeColumn().appendChild(bar);
  bar.querySelector('#kiln-pv-keep').onclick = () => {
    previewing.clear();
    undoGroup(() => {
      for (const a of applied) {
        if (a.value !== undefined) stagePending(a.key, { html: a.value });
        if (a.attrs) stagePending(a.key, { attrs: a.attrs });
      }
      for (const r of removed) {
        const parent = r.node.parentElement, next = r.node.nextSibling;
        const op = cfg.sandbox ? null : { op: 'removeSection', key: r.key };
        if (op) state.pendingStructural.push(op);
        r.node.style.display = '';
        r.node.remove();
        undoBucket.steps.push({ structural: { node: r.node, op, html: null, removed: true,
          place: () => parent.insertBefore(r.node, next) } });
      }
    });
    refreshPublishButton();
    bar.remove();
    setStatus(`Kept. Press Publish to make ${applied.length + removed.length > 1 ? 'these changes' : 'this change'} live.`, 'saved', { hold: 9000 });
  };
  bar.querySelector('#kiln-pv-cancel').onclick = () => {
    previewing.clear();
    for (const a of applied) {
      if (a.value !== undefined) applyKeyDom(a.key, a.before);
      for (const [name, v] of Object.entries(a.attrsBefore || {})) {
        if (name === 'style') showStyle(a.el, v); else if (v === null) a.el.removeAttribute(name); else a.el.setAttribute(name, v);
      }
      if (!state.pending.has(a.key)) {
        const esc = CSS.escape(a.key);
        document.querySelectorAll(`[data-cms="${esc}"],[data-cms-repeat="${esc}"]`).forEach(n => n.classList.remove('kiln-modified'));
      }
    }
    for (const r of removed) r.node.style.display = '';
    bar.remove();
    setStatus('Preview cancelled — the page is back to how it was', 'idle');
  };
  return applied.length + removed.length;
}

// ─── Named versions (Figma-style restore points) ─────────────────────────────
// Stored as lightweight git tags `refs/tags/kiln/<unix-ts>-<slug>`, so they
// cost nothing, outlive Kiln itself, and ride the existing worker allowlist
// (POST /git/refs to create, GET /git/matching-refs/ to list; ref DELETE isn't
// allowlisted, so Kiln doesn't offer deletion).

function slugifyVersionName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** 'refs/tags/kiln/1724000000-summer-menu' → { stamp, slug, name, date }; null if not ours. */
function parseVersionTag(ref) {
  const m = String(ref).match(/(?:^|\/)kiln\/(\d+)-([a-z0-9][a-z0-9-]*)$/);
  if (!m) return null;
  const stamp = parseInt(m[1], 10);
  return { stamp, slug: m[2], name: m[2].replace(/-/g, ' '), date: new Date(stamp * 1000) };
}

/**
 * History in the demo: this browser's publishes of this page, newest first,
 * each with the two ways back a real site offers. Both preview on the page
 * and are published like any other edit, so a visitor can publish twice and
 * get the first one back.
 */
function demoHistory(m) {
  const list = m.querySelector('#kiln-hist');
  const status = m.querySelector('#kiln-hist-status');
  const store = sandboxStore();
  const entries = store.history?.[sandboxPath()] || [];
  const published = store.pages?.[sandboxPath()] || {};
  list.insertAdjacentHTML('beforebegin', '<h4>Recent publishes</h4>');
  list.innerHTML = entries.length ? '' : `<p class="kiln-dim">${escapeHtml(DEMO_HISTORY_EMPTY)}</p>`;
  status.textContent = DEMO_HISTORY_NOTE;
  // Only what would change something: a part may already read that way.
  const needed = (changes) => changes.map((c) => {
    const out = { key: c.key };
    const now = state.pending.get(c.key)?.html ?? published[c.key]?.html;
    if (c.value !== undefined && c.value !== now) out.value = c.value;
    const el = elementForKey(c.key);
    for (const [name, v] of Object.entries(c.attrs || {})) {
      if (el && el.getAttribute(name) !== v) out.attrs = { ...(out.attrs || {}), [name]: v };
    }
    return out;
  }).filter(c => c.value !== undefined || c.attrs);
  const back = (changes, label) => {
    const todo = needed(changes);
    if (!todo.length) { status.textContent = 'The page already reads that way.'; return; }
    m.querySelector('.kiln-modal-x').click();
    if (!previewRestore(todo, label, '')) setStatus('Those parts are not on this page any more, so there is nothing to put back.', 'error');
  };
  [...entries].reverse().forEach((pub, i) => {
    const at = entries.length - 1 - i;
    const when = new Date(pub.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const what = escapeHtml(describeCommit(pub.message));
    const row = document.createElement('div');
    row.className = 'kiln-inv-row kiln-hist-row';
    row.innerHTML = `<span><strong>${what}</strong>
      <small>${i === 0 ? '<b class="kiln-hist-live">live now</b> · ' : ''}${escapeHtml(when)} · You</small></span>
      <span class="kiln-hist-acts">
        <button class="kiln-btn-ghost" data-act="undo" title="Put back just what this publish changed">${UNDO_ICON} Undo this change</button>
        ${i === 0 ? '' : '<button class="kiln-btn-ghost" data-act="restore" title="Every section back to how it was at this point">Go back to this</button>'}
      </span>`;
    row.querySelector('[data-act="undo"]').onclick = () => back(undoChanges(pub), `undo “${what}”`);
    const rBtn = row.querySelector('[data-act="restore"]');
    if (rBtn) rBtn.onclick = () => back(goBackChanges(entries, at), `the page as it was ${escapeHtml(when)}`);
    list.appendChild(row);
  });
}

/** `resume`: { sha, name } puts a name that was being typed back on that version's row (after signing in again). */
async function historyPanel(resume = null) {
  // A page built from content files has no file of its own to show versions of.
  if (!cfg.sandbox && !state.page.path) {
    modal(`
      <h3>Page history</h3>
      <p class="kiln-dim">This page is built from the site’s content files, and History can’t show their
      versions here yet. Every change you publish is still kept, and the site’s owner can bring any of them back.</p>
      <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);
    return;
  }
  const m = modal(`
    <h3>Page history</h3>
    <p class="kiln-dim">Every publish saves a version of this page. <strong>Undo this change</strong> takes
    back just what that publish changed; <strong>Go back to this</strong> returns the whole page to how it
    was then. Both show the result on the page first, with Cancel and Keep. Nothing changes on the live site
    until you publish. (For one section's history, click into it and press its ${'↻'} clock button.)</p>
    <div id="kiln-hist" class="kiln-inv-list">Loading…</div>
    <p class="kiln-np-step" id="kiln-hist-status"></p>`);
  const status = m.querySelector('#kiln-hist-status');

  if (cfg.sandbox) { demoHistory(m); return; }

  const list = m.querySelector('#kiln-hist');
  const spin = (msg) => { status.innerHTML = `<span class="kiln-spin"></span> ${msg}`; };
  // A way back is shown on the page itself, by the page's own styles and
  // scripts, with Cancel and Keep. (It used to be shown first in two frames
  // side by side with the scripts off, where a site that fades its sections
  // in as they are scrolled to showed them blank.)
  const closeHistory = () => m.querySelector('.kiln-modal-x')?.click();

  // Undo ONE publish: put back the sections it changed, leave everything since.
  async function undoCommit(c) {
    const parentSha = c.parents?.[0]?.sha;
    if (!parentSha) { status.textContent = 'This is the very first version — there’s nothing before it to go back to.'; return; }
    spin('Comparing with the version before it…');
    const before = readValues(await histFile(parentSha));
    const after = readValues(await histFile(c.sha));
    const changes = [], removals = [];
    for (const key of Object.keys(after)) {
      if (before[key] === undefined) { removals.push(key); continue; }   // that publish ADDED this — undo = remove it
      if (before[key] !== after[key]) changes.push({ key, value: before[key] });
    }
    if (!changes.length && !removals.length) {
      status.textContent = 'That publish didn’t change any section content on this page (it may have been photos or layout).';
      return;
    }
    const what = escapeHtml(describeCommit(c.commit.message));
    closeHistory();
    const n = previewRestore(changes, `undo “${what}”`, '', removals);
    if (!n) setStatus('Those sections aren’t on this page anymore, so there’s nothing to put back.', 'error');
  }

  // Whole-page: every section back to how it was at that version (a commit sha
  // from the list below, or a named version's tagged sha).
  async function restoreVersion(sha, what) {
    spin('Reading that version…');
    const thenText = await histFile(sha);
    const vals = readValues(thenText);
    const curVals = readValues(state.page.text);
    const changes = [], removals = [];
    for (const [key, value] of Object.entries(vals)) {
      if (currentValueFor(key, curVals) !== value) changes.push({ key, value });
    }
    let gone = 0;
    for (const key of Object.keys(curVals)) {
      if (vals[key] !== undefined) continue;
      // Kiln-added sections (galleries/events) get removed with the restore;
      // anything else that merely wasn't annotated back then stays as it is.
      const el = document.querySelector(`[data-cms-repeat="${CSS.escape(key)}"], [data-cms="${CSS.escape(key)}"]`);
      if (el?.closest('.kiln-added')) removals.push(key); else gone++;
    }
    if (!changes.length && !removals.length) { status.textContent = 'The page already matches that version.'; return; }
    const note = gone ? `${gone} section${gone > 1 ? 's' : ''} added since then stay as they are.` : '';
    closeHistory();
    const n = previewRestore(changes, `the page as it was ${what}`, note, removals);
    if (!n) setStatus('Those sections aren’t on this page anymore, so there’s nothing to put back.', 'error');
  }

  async function loadNamedVersions() {
    const box = m.querySelector('#kiln-nv');
    if (!box) return;
    let refs = [];
    try {
      refs = await state.gh.request('GET', `/repos/${cfg.repo}/git/matching-refs/tags/kiln/`);
    } catch (err) {
      // The list of publishes below is read with the same sign-in and says what happened; once is enough.
      box.innerHTML = `<p class="kiln-dim">${escapeHtml(readFailure(err).kind === 'other' ? notDone('Named versions could not be read.', err) : 'Named versions could not be read.')}</p>`;
      return;
    }
    if (!Array.isArray(refs)) refs = [];
    const vers = refs.map(r => ({ ...parseVersionTag(r.ref), sha: r.object?.sha }))
      .filter(v => v.stamp && v.sha)
      .sort((a, b) => b.stamp - a.stamp);
    box.innerHTML = vers.length ? ''
      : '<p class="kiln-dim">No named versions yet — hit ⭑ on any publish below to keep it findable.</p>';
    for (const v of vers) {
      const when = v.date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const row = document.createElement('div');
      row.className = 'kiln-inv-row';
      row.innerHTML = `<span><strong>${escapeHtml(v.name)}</strong>
        <small>${when} · ${escapeHtml(String(v.sha).slice(0, 7))}</small></span>
        <span class="kiln-hist-acts"><button class="kiln-btn-ghost" title="Every section back to how it was in this named version">Go back to this</button></span>`;
      row.querySelector('button').onclick = () =>
        restoreVersion(v.sha, `“${escapeHtml(v.name)}”`).catch(err => { status.textContent = stopped(err) || notDone('That version could not be read.', err); });
      box.appendChild(row);
    }
  }

  // "⭑ Name" on a publish row → inline input → tag that commit.
  function nameVersionInline(row, c) {
    const acts = row.querySelector('.kiln-hist-acts');
    const form = document.createElement('span');
    form.className = 'kiln-nv-form';
    form.innerHTML = `<input type="text" class="kiln-nv-input" maxlength="40" placeholder="e.g. Summer menu">
      <button class="kiln-btn-ghost" data-nv="save">Save</button>
      <button class="kiln-btn-ghost" data-nv="cancel" aria-label="Cancel naming">✕</button>`;
    acts.style.display = 'none';
    acts.after(form);
    const input = form.querySelector('input');
    const closeForm = () => { form.remove(); acts.style.display = ''; };
    form.querySelector('[data-nv="cancel"]').onclick = closeForm;
    const save = async () => {
      const raw = input.value.trim();
      const slug = slugifyVersionName(raw);
      if (!slug) { status.textContent = 'Give it a name with some letters or numbers.'; input.focus(); return; }
      const btn = form.querySelector('[data-nv="save"]');
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await state.gh.request('POST', `/repos/${cfg.repo}/git/refs`,
          { ref: `refs/tags/kiln/${Math.floor(Date.now() / 1000)}-${slug}`, sha: c.sha });
        closeForm();
        status.textContent = `Saved as “${raw}” — it’s in Named versions above.`;
        loadNamedVersions();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Save';
        status.textContent = err.status === 422
          ? 'A version with that name was just created — try a slightly different name.'
          : stopped(err, 'saved', () => (input.isConnected && input.value.trim()
            ? { name: TYPED.version, text: input.value.trim(), keep: { where: 'version', sha: c.sha } } : null)) || notDone('The name was not saved.', err);
      }
    };
    form.querySelector('[data-nv="save"]').onclick = save;
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
    input.focus();
  }

  list.insertAdjacentHTML('beforebegin',
    '<h4>Named versions</h4><div id="kiln-nv" class="kiln-inv-list"><p class="kiln-dim">Loading…</p></div><h4>Recent publishes</h4>');
  loadNamedVersions();

  let commits = [];
  try {
    commits = await state.gh.request('GET',
      `/repos/${cfg.repo}/commits?path=${encodeURIComponent(state.page.path)}&per_page=20`);
  } catch (err) { list.textContent = ''; status.textContent = stopped(err) || notDone('The history could not be read.', err); return; }

  list.innerHTML = commits.length ? '' : '<p class="kiln-dim">No saved versions yet — they appear after your first publish.</p>';

  commits.forEach((c, i) => {
    const div = document.createElement('div');
    div.className = 'kiln-inv-row kiln-hist-row';
    const when = new Date(c.commit.author.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    div.innerHTML = `<span><strong>${escapeHtml(describeCommit(c.commit.message))}</strong>
      <small>${i === 0 ? '<b class="kiln-hist-live">live now</b> · ' : ''}${when} · ${escapeHtml(c.commit.author.name)}</small></span>
      <span class="kiln-hist-acts">
        <button class="kiln-btn-ghost" data-act="undo" title="Put back just what this publish changed">${UNDO_ICON} Undo this change</button>
        ${i === 0 ? '' : '<button class="kiln-btn-ghost" data-act="restore" title="Every section back to how it was at this point">Go back to this</button>'}
        <button class="kiln-btn-ghost" data-act="name" title="Name this version so it’s easy to find and restore later">⭑ Name</button>
      </span>`;
    div.querySelector('[data-act="undo"]').onclick = () => undoCommit(c).catch(err => { status.textContent = stopped(err) || notDone('The two versions could not be compared.', err); });
    const rBtn = div.querySelector('[data-act="restore"]');
    if (rBtn) rBtn.onclick = () => restoreVersion(c.sha, escapeHtml(when)).catch(err => { status.textContent = stopped(err) || notDone('That version could not be read.', err); });
    div.querySelector('[data-act="name"]').onclick = () => nameVersionInline(div, c);
    list.appendChild(div);
    if (resume && typeof resume.name === 'string' && resume.sha === c.sha) {
      nameVersionInline(div, c);
      div.querySelector('.kiln-nv-input').value = resume.name.slice(0, 40);
    }
  });
}

/**
 * Preview reverting one field to a past value: apply it to the live DOM (visible
 * preview), stage it as a pending edit, and let the user Publish or Undo. Both
 * before AND after a prior publish — it's just a staged field edit either way.
 */
function previewFieldRevert(key, value, histModal) {
  histModal?.remove();
  const n = previewRestore([{ key, value }], `“${escapeHtml(humanizeKey(key))}” from an earlier version`, '');
  if (!n) setStatus('That section isn’t on this page anymore', 'error');
}


/**
 * Per-section history: reached by clicking into a section and pressing the clock
 * button. Shows this one field's past versions (newest first) with an Undo that
 * PREVIEWS the change in the page before you keep it.
 */
async function fieldHistoryPanel(key, isRepeat = false) {
  if (state.active) commitEdit(state.active, state.active.getAttribute('data-cms'));
  const m = modal(`
    <h3>History for this section</h3>
    <p class="kiln-dim"><strong title="${escapeHtml(key)}">${escapeHtml(readableName(key))}</strong>: pick an earlier version to see it on
    the page, then keep it or cancel. ${isRepeat
      ? 'This is a set of blocks (rows share their fields), so history covers the whole set.'
      : 'Only this section changes.'}</p>
    <div id="kiln-fh" class="kiln-inv-list">Loading…</div>`);
  const box = m.querySelector('#kiln-fh');

  const rows = [];
  // Unpublished edit first (undo-before-publish).
  const pend = state.pending.get(key);
  const esc = CSS.escape(key);
  const liveEl = document.querySelector(`[data-cms="${esc}"], [data-cms-repeat="${esc}"]`);

  // The rows are drawn the same way wherever the versions come from.
  const draw = () => {
    box.innerHTML = '';
    if (pend && pend.html !== undefined && pend.html !== (rows[0] && rows[0].v)) {
      const r = document.createElement('div');
      r.className = 'kiln-inv-row';
      r.style.borderColor = 'rgba(251,191,36,.55)';
      r.innerHTML = `<span><span class="kiln-hist-prev">${histPreview(pend.html)}</span><small>your unpublished edit</small></span>
        <button class="kiln-btn-ghost">${UNDO_ICON} Undo this</button>`;
      r.querySelector('button').onclick = () => {
        state.pending.delete(key);
        // applyKeyDom handles both plain fields and repeat containers (which
        // need their editing handles re-wired after an innerHTML reset).
        if (rows[0] && rows[0].v !== undefined && rows[0].v !== null) applyKeyDom(key, rows[0].v);
        document.querySelectorAll(`[data-cms="${esc}"], [data-cms-repeat="${esc}"]`).forEach(n => n.classList.remove('kiln-modified'));
        refreshPublishButton(); m.remove();
        setStatus(`Your unpublished edit to “${readableName(key)}” is undone.`, 'saved');
      };
      box.appendChild(r);
    }
    if (!rows.length && !box.children.length) { box.innerHTML = '<p class="kiln-dim">No saved history for this section yet — it appears here after your first publish.</p>'; return; }
    rows.forEach(({ c, v, start }, i) => {
      const when = start ? '' : new Date(c.commit.author.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const r = document.createElement('div');
      r.className = 'kiln-inv-row';
      // Top row = what's live: its Undo goes back to the previous version.
      // Older rows: "Go back to this" previews that version. Everything previews
      // on the page first; nothing is live until Publish.
      const btnHtml = i === 0
        ? (rows.length > 1 ? `<button class="kiln-btn-ghost" title="Put this section back to the version before">${UNDO_ICON} Undo this change</button>` : '')
        : `<button class="kiln-btn-ghost">${UNDO_ICON} Go back to this</button>`;
      r.innerHTML = `<span><span class="kiln-hist-prev">${histPreview(v)}</span>
        <small>${i === 0 ? '<b class="kiln-hist-live">live now</b> · ' : ''}${start ? 'before your first publish' : `${when} · ${escapeHtml(c.commit.author.name)}`}</small></span>
        ${btnHtml}`;
      const btn = r.querySelector('button');
      if (btn) btn.onclick = () => previewFieldRevert(key, i === 0 ? rows[1].v : v, m);
      box.appendChild(r);
    });
  };

  if (cfg.sandbox) {
    // The demo's history of this part: this browser's publishes that changed it.
    const store = sandboxStore();
    const versions = partVersions(store.history?.[sandboxPath()] || [], key, store.pages?.[sandboxPath()]?.[key]?.html);
    for (const v of versions) rows.push({ c: { commit: { author: { date: v.ts, name: 'You' } } }, v: v.value, start: v.ts === null });
    draw();
    return;
  }
  try {
    const commits = await state.gh.request('GET',
      `/repos/${cfg.repo}/commits?path=${encodeURIComponent(state.page.path)}&per_page=15`);
    let lastVal = null;
    for (const c of commits.slice(0, 12)) {
      const text = await histFile(c.sha);
      const v = readValues(text)[key];
      if (v === undefined) continue;
      if (v !== lastVal) { rows.push({ c, v }); lastVal = v; }
    }
    draw();
  } catch (err) { box.innerHTML = `<p class="kiln-dim">${escapeHtml(stopped(err) || notDone('The history could not be read.', err))}</p>`; }
}

function histPreview(html) {
  return escapeHtml((new DOMParser().parseFromString(html, 'text/html').body.textContent || '').trim().slice(0, 80)) || '<em>(empty)</em>';
}

// ─── Page settings (title + meta description) ────────────────────────────────

function pageSettingsPanel() {
  // A page built from content files has no file of its own to change.
  if (!cfg.sandbox && !state.page.path) {
    modal(`
      <h3>Page settings</h3>
      <p class="kiln-dim">This page’s title and description come from the site’s own files, so they can’t be
      changed here. Ask the site’s owner.</p>
      <div class="kiln-modal-actions"><button class="kiln-btn-ghost" data-close>Close</button></div>`);
    return;
  }
  const cur = readHead(state.page.text);
  const m = modal(`
    <h3>Page settings — ${escapeHtml(state.page.path)}</h3>
    <label>Page title (browser tab + search results)
      <input type="text" id="kiln-ps-title" value="${escapeHtml(cur.title)}"></label>
    <label>Description (search results &amp; link previews)
      <input type="text" id="kiln-ps-desc" value="${escapeHtml(cur.description)}" maxlength="200"></label>
    <label>Social image URL (link previews — optional)
      <input type="text" id="kiln-ps-ogimg" value="${escapeHtml(cur.ogImage || '')}" placeholder="/assets/img/social.jpg"></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-ps-go">Publish</button>
    </div>
    <p class="kiln-np-step" id="kiln-ps-status"></p>
    ${mode === 'admin' ? `<hr class="kiln-hr"><h4>Danger zone</h4>
      <div class="kiln-inv-row" style="border-color:#fecaca">
        <span><strong>Delete this page</strong><small>Removes ${escapeHtml(state.page.path)} from the site. History keeps it recoverable.</small></span>
        <button class="kiln-btn-ghost" id="kiln-ps-del">Delete page…</button>
      </div>` : ''}`);
  m.querySelector('#kiln-ps-go').onclick = async () => {
    const title = m.querySelector('#kiln-ps-title').value;
    const description = m.querySelector('#kiln-ps-desc').value;
    const ogImage = m.querySelector('#kiln-ps-ogimg').value;
    const status = m.querySelector('#kiln-ps-status');
    if (cfg.sandbox) { status.textContent = demoSays('pagesettings'); return; }
    status.textContent = 'Publishing…';
    try {
      const result = await editFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main',
        (text) => editHead(text, { title, description, ogImage }),
        `Page settings: ${state.page.path} (via Kiln)`);
      if (result.unchanged) { status.textContent = 'Nothing changed.'; return; }
      await loadPageSource();
      journalAdd({ type: 'compare', target: location.pathname, expect: djb2(result.text), desc: 'Page settings', sha: result.commit?.sha });
      status.textContent = 'Committed ✓ — safe to close; Kiln will confirm when live.';
    } catch (err) { status.textContent = stopped(err, 'published', typedIn(m)) || notDone('The settings were not published.', err); }
  };
  const delBtn = m.querySelector('#kiln-ps-del');
  if (delBtn) delBtn.onclick = async () => {
    const status = m.querySelector('#kiln-ps-status');
    // One dialog of the editor's own (own-dialogs.js): what happens, and the
    // file's name typed into it before the button does anything.
    if (!(await askFirst(modal, ownDialogCopy('delete-page', { path: state.page.path })))) return;
    status.textContent = 'Deleting…';
    (async () => {
      try {
        const file = await getFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main');
        await state.gh.request('DELETE', `/repos/${cfg.repo}/contents/${state.page.path.split('/').map(encodeURIComponent).join('/')}`,
          { message: `Delete ${state.page.path} (via Kiln)`, sha: file.sha, branch: cfg.branch || 'main' });
        status.innerHTML = 'Deleted ✓ — the page comes off the site on the next deploy. <strong>Open Site menu to remove its link.</strong>';
      } catch (err) { status.textContent = stopped(err, 'deleted') || notDone('The page was not deleted.', err); }
    })();
  };
}

// ─── Find & replace (site-wide) ──────────────────────────────────────────────

function findReplacePanel() {
  const m = modal(`
    <h3>Find &amp; replace across the site</h3>
    <label>Find <input type="text" id="kiln-fr-find" placeholder="Old phone number, name, address…"></label>
    <label>Replace with <input type="text" id="kiln-fr-repl"></label>
    <div class="kiln-modal-actions" style="justify-content:flex-start">
      <button class="kiln-btn-publish" id="kiln-fr-scan">Preview matches</button>
    </div>
    <div id="kiln-fr-out" class="kiln-inv-list" style="margin-top:8px"></div>
    <p class="kiln-np-step" id="kiln-fr-status"></p>`);
  const status = m.querySelector('#kiln-fr-status');
  m.querySelector('#kiln-fr-scan').onclick = async () => {
    const find = m.querySelector('#kiln-fr-find').value;
    const repl = m.querySelector('#kiln-fr-repl').value;
    const out = m.querySelector('#kiln-fr-out');
    if (!find || find.length < 2) { status.textContent = 'Type at least 2 characters to find.'; return; }
    if (cfg.sandbox) { status.textContent = demoSays('findreplace'); return; }
    status.textContent = 'Scanning every page…';
    out.innerHTML = '';
    try {
      const branch = cfg.branch || 'main';
      const tree = await state.gh.request('GET', `/repos/${cfg.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      const files = tree.tree.filter(x => x.type === 'blob' && x.path.endsWith('.html')).map(x => x.path).slice(0, 100);
      const hits = [];
      for (let i = 0; i < files.length; i++) {
        status.textContent = `Scanning… ${i + 1}/${files.length}`;
        const f = await getFile(state.gh, cfg.repo, files[i], branch);
        const count = f.text.split(find).length - 1;
        if (count) hits.push({ path: files[i], count, text: f.text });
      }
      if (!hits.length) { status.textContent = `No matches for “${find}”.`; return; }
      out.innerHTML = hits.map(h => `<div class="kiln-inv-row"><span>${escapeHtml(h.path)}</span><small>${h.count}×</small></div>`).join('');
      status.innerHTML = `${hits.reduce((n, h) => n + h.count, 0)} match(es) in ${hits.length} file(s).
        <strong>This replaces matches anywhere in the page source</strong> — review on GitHub afterwards if unsure.`;
      const act = document.createElement('div');
      act.className = 'kiln-modal-actions';
      act.innerHTML = `<button class="kiln-btn-ghost" data-close>Cancel</button>
        <button class="kiln-btn-publish">Replace all (1 commit)</button>`;
      out.after(act);
      act.querySelector('.kiln-btn-publish').onclick = async () => {
        status.textContent = 'Committing…';
        try {
          const changed = hits.map(h => ({ path: h.path, text: h.text.split(find).join(repl) }));
          const commit = await commitFiles(state.gh, cfg.repo, branch, changed, `Replace “${find}” → “${repl}” on ${changed.length} pages (via Kiln)`);
          const thisPage = changed.find(c => c.path === state.page.path);
          if (thisPage) journalAdd({ type: 'compare', target: location.pathname, expect: djb2(thisPage.text), desc: 'Find & replace', sha: commit.sha });
          status.textContent = 'Committed ✓ — rebuilding. Safe to close; Kiln will confirm when live.';
          act.remove();
        } catch (err) { status.textContent = stopped(err, 'replaced', typedIn(m)) || notDone('Nothing was replaced.', err); }
      };
    } catch (err) { status.textContent = stopped(err, '', typedIn(m)) || notDone('The pages could not be searched.', err); }
  };
}

// ─── Drafts (kiln-drafts branch) ─────────────────────────────────────────────

const DRAFT_BRANCH = 'kiln-drafts';

async function ensureDraftBranch() {
  try {
    await state.gh.request('GET', `/repos/${cfg.repo}/git/ref/${encodeURIComponent('heads/' + DRAFT_BRANCH)}`);
  } catch {
    const main = await state.gh.request('GET', `/repos/${cfg.repo}/git/ref/${encodeURIComponent('heads/' + (cfg.branch || 'main'))}`);
    await state.gh.request('POST', `/repos/${cfg.repo}/git/refs`, { ref: `refs/heads/${DRAFT_BRANCH}`, sha: main.object.sha });
  }
}

async function saveDraft() {
  if (!state.pending.size) return;
  if (cfg.sandbox) { saveDraftSandbox(); return; }
  // Drafts save only text/attribute edits. Uploaded images and added sections
  // live in pendingBinaries/pendingStructural, which a draft can't carry — a
  // draft referencing an uncommitted image would publish a broken link, and an
  // annotation-dependent edit would be silently dropped. Make the user publish
  // (or discard) those first rather than lose them.
  if (state.pendingBinaries.size || state.pendingStructural.length) {
    setStatus('Publish your new images / added sections first — drafts save text edits only', 'error');
    return;
  }
  setStatus('Saving draft…', 'saving');
  try {
    await ensureDraftBranch();
    const edits = flattenPending();
    const drafted = applyEdits(state.page.text, edits).html;
    let sha;
    try { sha = (await getFile(state.gh, cfg.repo, state.page.path, DRAFT_BRANCH)).sha; } catch { /* new draft */ }
    await putFile(state.gh, cfg.repo, state.page.path, {
      text: drafted, sha, branch: DRAFT_BRANCH,
      message: `Draft: ${state.page.path} (via Kiln)`,
    });
    state.pending.clear();
    clearSavedPending();
    // Retire undo history at the draft boundary too: the edits now live in the
    // draft branch, so ⌘Z would revert the DOM while the draft still carries them
    // (and redo would re-stage an already-saved edit for a second commit).
    forgetEditHistory();
    document.querySelectorAll('.kiln-modified').forEach(el => el.classList.remove('kiln-modified'));
    refreshPublishButton();
    setStatus('Draft saved ✓ — nothing is live; resume it any time from this page', 'saved');
  } catch (err) {
    console.error('[kiln] draft', err);
    say(err, 'saved', notDone('The draft was not saved.', err));
  }
}

/** "There's a saved draft of this page": the same question on a real site and in the demo. */
function draftDialog(canDelete) {
  return modal(`
    <h3>There's a saved draft of this page</h3>
    <p class="kiln-dim">It isn't live. Resume editing it, publish it as-is, or leave it for later.</p>
    <div class="kiln-modal-actions kiln-acts-grid">
      <button class="kiln-btn-ghost" data-close>Later</button>
      ${canDelete ? '<button class="kiln-btn-ghost" id="kiln-dr-del">Delete draft</button>' : ''}
      <button class="kiln-btn-ghost" id="kiln-dr-pub">Publish it now</button>
      <button class="kiln-btn-publish" id="kiln-dr-resume">Resume draft</button>
    </div>
    <p class="kiln-np-step" id="kiln-dr-status"></p>`);
}

/**
 * Try-out mode has no draft branch to save to. The draft is kept in this
 * browser, beside the demo's publishes, and is offered back the next time the
 * page is opened: the same thing a real site does, with nothing sent anywhere.
 */
function saveDraftSandbox() {
  const s = sandboxStore();
  s._createdAt = s._createdAt || Date.now();
  s.drafts = s.drafts || {};
  s.drafts[sandboxPath()] = { ts: Date.now(), edits: Object.fromEntries(state.pending) };
  if (!sandboxSave(s)) { setStatus(SANDBOX_FULL, 'error'); return; }
  state.pending.clear();
  clearSavedPending();
  forgetEditHistory();
  document.querySelectorAll('.kiln-modified').forEach(el => el.classList.remove('kiln-modified'));
  refreshPublishButton();
  setStatus(DEMO_DRAFT_SAVED, 'saved');
}

/** Try-out mode, as the page opens: a draft saved here earlier is offered back. */
function offerDraftSandbox() {
  const draft = sandboxStore().drafts?.[sandboxPath()];
  const n = draft && draft.edits && typeof draft.edits === 'object' ? Object.keys(draft.edits).length : 0;
  if (!n) return;
  const m = draftDialog(true);
  const taken = () => { const s = sandboxStore(); if (s.drafts) { delete s.drafts[sandboxPath()]; sandboxSave(s); } m.remove(); };
  const back = () => restoreSaved({ edits: draft.edits, source: {}, count: n }, Promise.resolve([]), false);
  m.querySelector('#kiln-dr-resume').onclick = async () => {
    taken();
    await back();
    setStatus(`Draft loaded, ${n} change${n === 1 ? '' : 's'}. Publish when ready.`, 'saved');
  };
  m.querySelector('#kiln-dr-pub').onclick = async () => { taken(); await back(); publishSandbox(); };
  m.querySelector('#kiln-dr-del').onclick = async () => {
    if (!(await askFirst(modal, ownDialogCopy('delete-draft', { changes: n, demo: true })))) return;
    taken();
    setStatus('Draft deleted.', 'saved');
  };
}

async function checkForDraft() {
  if (!state.page.path) return;   // a page built from content files has no file a draft could be of
  let draft;
  try { draft = await getFile(state.gh, cfg.repo, state.page.path, DRAFT_BRANCH); } catch { return; }
  if (!draft || djb2(draft.text) === djb2(state.page.text)) return;
  await restoreAsked;   // one question at a time, and the unpublished edits first
  const m = draftDialog(mode === 'admin');
  const status = m.querySelector('#kiln-dr-status');
  m.querySelector('#kiln-dr-resume').onclick = () => {
    const draftFields = indexHtml(draft.text).fields;
    let applied = 0;
    for (const [key, f] of draftFields) {
      if (!f.inner) continue;
      const value = draft.text.slice(f.inner.start, f.inner.end);
      const liveF = state.fields.fields.get(key);
      const liveValue = liveF?.inner ? state.page.text.slice(liveF.inner.start, liveF.inner.end) : null;
      if (value === liveValue) continue;
      const el = document.querySelector(`[data-cms="${CSS.escape(key)}"]`);
      if (el && !el.closest('[data-cms-repeat]')) {
        beginKey(key, el);
        writeInside(el, value);
        el.classList.add('kiln-modified');
        stagePending(key, { html: value });
        applied++;
      } else if (liveF?.kind === 'repeat' || el?.hasAttribute('data-cms-repeat')) {
        const cont = document.querySelector(`[data-cms-repeat="${CSS.escape(key)}"]`);
        if (cont) { applyKeyDom(key, value); stagePending(key, { html: value }); applied++; }
      }
    }
    refreshPublishButton();
    setStatus(`Draft loaded (${applied} change${applied === 1 ? '' : 's'}) — Publish when ready`, 'saved');
    m.remove();
  };
  m.querySelector('#kiln-dr-pub').onclick = async () => {
    status.textContent = 'Publishing draft…';
    try {
      const result = await editFile(state.gh, cfg.repo, state.page.path, cfg.branch || 'main',
        () => draft.text, `Publish draft: ${state.page.path} (via Kiln)`);
      journalAdd({ type: 'compare', target: location.pathname, expect: djb2(draft.text), desc: 'Draft publish', sha: result?.commit?.sha });
      await loadPageSource();
      status.textContent = 'Published ✓ — your site rebuilds now; the change goes live in about a minute.';
    } catch (err) { status.textContent = stopped(err, 'published') || notDone('The draft was not published.', err); }
  };
  const del = m.querySelector('#kiln-dr-del');
  if (del) del.onclick = async () => {
    // How many parts of the page the draft holds differently from the page as it is.
    let changes = 0;
    for (const [key, f] of indexHtml(draft.text).fields) {
      const live = state.fields.fields.get(key);
      if (f.inner && draft.text.slice(f.inner.start, f.inner.end) !== (live?.inner ? state.page.text.slice(live.inner.start, live.inner.end) : null)) changes++;
    }
    if (!(await askFirst(modal, ownDialogCopy('delete-draft', { changes })))) return;
    status.textContent = 'Deleting…';
    try {
      await state.gh.request('DELETE', `/repos/${cfg.repo}/contents/${state.page.path.split('/').map(encodeURIComponent).join('/')}`,
        { message: `Discard draft: ${state.page.path} (via Kiln)`, sha: draft.sha, branch: DRAFT_BRANCH });
      status.textContent = 'Draft deleted.';
      setTimeout(() => m.remove(), 600);
    } catch (err) { status.textContent = stopped(err, 'deleted') || notDone('The draft was not deleted.', err); }
  };
}

// ─── Scheduled publishing ────────────────────────────────────────────────────

/** `at`: the time that was chosen before (after signing in again), as the time box holds it. */
function schedulePanel(at) {
  if (!state.pending.size) return;
  // Scheduling re-applies text edits later against the live source; it can't
  // carry queued image uploads or added sections (same reason as drafts).
  if (state.pendingBinaries.size || state.pendingStructural.length) {
    setStatus('Publish your new images / added sections first — scheduling covers text edits only', 'error');
    return;
  }
  const inOneHour = new Date(Date.now() + 3600000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const m = modal(`
    <h3>${scheduleTitle(countChanges(publishItems({ light: true }).filter(i => state.pending.has(i.key))))}</h3>
    <p class="kiln-dim">Kiln publishes them at the time you pick (it checks every 5 minutes), and the site rebuilds.</p>
    <label>Publish at <input type="datetime-local" id="kiln-sc-at" value="${typeof at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(at) ? at : inOneHour}"></label>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-sc-go">Schedule</button>
    </div>
    <h4>Already scheduled</h4>
    <div id="kiln-sc-list" class="kiln-inv-list">Loading…</div>
    <p class="kiln-np-step" id="kiln-sc-status"></p>`);
  const status = m.querySelector('#kiln-sc-status');
  async function refreshList() {
    const list = m.querySelector('#kiln-sc-list');
    // Try-out mode has nobody to hand a schedule to. It says what a real site
    // does and asks nothing of the worker, which could only answer "forbidden".
    if (cfg.sandbox) { list.innerHTML = `<p class="kiln-dim">${escapeHtml(demoSays('schedule'))}</p>`; return; }
    try {
      const data = await ask(`/schedules?repo=${encodeURIComponent(cfg.repo)}`);
      list.innerHTML = (data.schedules || []).length ? '' : '<p class="kiln-dim">Nothing scheduled.</p>';
      for (const s of data.schedules || []) {
        const row = document.createElement('div');
        row.className = 'kiln-inv-row';
        row.innerHTML = `<span><strong>${escapeHtml(s.desc)}</strong>
          <small>${new Date(s.at).toLocaleString()} · by ${escapeHtml(s.by)}</small></span>
          <button class="kiln-btn-ghost">Cancel</button>`;
        row.querySelector('button').onclick = async () => {
          try {
            await ask('/schedule/cancel', { method: 'POST', body: { repo: cfg.repo, id: s.id } });
          } catch (err) {
            status.textContent = stopped(err, 'cancelled') || notDone('That was not cancelled.', err);
            return;
          }
          refreshList();
        };
        list.appendChild(row);
      }
    } catch (err) {
      list.innerHTML = `<p class="kiln-dim">${escapeHtml(stopped(err) || 'Could not load.')}</p>`;
    }
  }
  refreshList();
  m.querySelector('#kiln-sc-go').onclick = async () => {
    const at = m.querySelector('#kiln-sc-at').value;
    if (!at) return;
    if (cfg.sandbox) { status.textContent = `${demoShort('schedule')} Your edit${state.pending.size > 1 ? 's are' : ' is'} still here, to publish now.`; return; }
    status.textContent = 'Scheduling…';
    try {
      // Send field-level edits (not a full-page snapshot): the worker re-applies
      // them against the live source at fire time, so edits published in the
      // meantime aren't wiped.
      const edits = flattenPending();
      const data = await ask('/schedule', { method: 'POST',
        body: { repo: cfg.repo, path: state.page.path, branch: cfg.branch || 'main',
          edits, at: new Date(at).toISOString(),
          message: `Scheduled edit: ${state.page.path} (via Kiln)`,
          desc: `${state.page.path} (${[...state.pending.keys()].slice(0, 3).join(', ')})` } });
      if (!data.ok) throw said(data.error || 'The site did not take the schedule');
      // The edits now live in the schedule on the worker — retire the stage.
      retireStaged();
      status.textContent = `Scheduled for ${new Date(data.at).toLocaleString()} ✓ — safe to close.`;
      refreshList();
    } catch (err) {
      status.textContent = stopped(err, 'scheduled', () => {
        const chosen = m.isConnected ? m.querySelector('#kiln-sc-at').value : '';
        return chosen ? { name: TYPED.schedule, text: new Date(chosen).toLocaleString(), keep: { where: 'schedule', at: chosen } } : null;
      }) || notDone('Nothing was scheduled.', err);
    }
  };
}

// ─── Settings (admin) ────────────────────────────────────────────────────────

function settingsPanel() {
  const ui = localStorage.getItem('kiln_ui_mode') || 'fab';
  const touch = isTouch();
  const auth = cfg.auth || {};
  const isAdmin = mode === 'admin';
  const m = modal(`
    <h3>Settings</h3>
    <h4>Your editor (this browser)</h4>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-uimode" value="fab" ${ui === 'fab' ? 'checked' : ''}>
        <span><strong>Floating button</strong><br><small>A round button you can drag; ${touch ? 'tap it for the menu' : 'hover for the menu'}.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-uimode" value="bar" ${ui === 'bar' ? 'checked' : ''}>
        <span><strong>Top bar</strong><br><small>Fixed bar with all actions visible.</small></span></label>
      <label class="kiln-role"><input type="checkbox" id="kiln-set-nopreview" ${previewOff(localStorage) ? 'checked' : ''}>
        <span><strong>Publish without the preview</strong><br><small>Publish goes live at once, without first showing what will change.</small></span></label>
    </div>
    ${isAdmin ? `
    <h4>This site (applies to everyone, committed to the repo)</h4>
    <label class="kiln-role"><input type="checkbox" id="kiln-set-google" ${auth.google !== false ? 'checked' : ''}>
      <span><strong>Google sign-in</strong><br><small>Invited editors and members sign in with their Google account at yoursite.com/kiln.</small></span></label>` : ''}
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Close</button>
      <button class="kiln-btn-publish" id="kiln-set-save">Save</button>
    </div>
    <p class="kiln-np-step" id="kiln-set-status"></p>`);
  const status = m.querySelector('#kiln-set-status');
  m.querySelector('#kiln-set-save').onclick = async () => {
    const newUi = m.querySelector('input[name="kiln-uimode"]:checked').value;
    const uiChanged = newUi !== ui;
    setPreviewOff(localStorage, m.querySelector('#kiln-set-nopreview').checked);
    localStorage.setItem('kiln_ui_mode', newUi);
    const google = isAdmin ? m.querySelector('#kiln-set-google').checked : (cfg.auth?.google !== false);
    const siteChanged = isAdmin && google !== (cfg.auth?.google !== false);
    if (!siteChanged) {
      status.textContent = uiChanged ? 'Saved — reloading to apply your editor layout…' : 'Saved.';
      if (uiChanged) setTimeout(() => location.reload(), 600);
      return;
    }
    status.textContent = 'Committing site settings…';
    try {
      const cfgPath = (cfg.root ? cfg.root.replace(/\/+$/, '') + '/' : '') + 'assets/kiln-config.js';
      const result = await editFile(state.gh, cfg.repo, cfgPath, cfg.branch || 'main', (text) => {
        let out = text;
        const flags = `\n  // Managed by Kiln Settings\n  auth: { google: ${google} },\n`;
        out = out.replace(/\n\s*\/\/ Managed by Kiln Settings\n\s*(loginButton:[^\n]*\n\s*)?auth:[^\n]*\n/, '\n');
        out = out.replace(/\n\s*loginButton:[^\n]*\n/, '\n');
        const close = out.lastIndexOf('};');
        return out.slice(0, close) + flags + out.slice(close);
      }, 'Kiln settings (via Kiln)');
      journalAdd({ type: 'compare', target: '/assets/kiln-config.js', expect: djb2(result.text), desc: 'Site settings', sha: result.commit?.sha });
      status.textContent = 'Committed ✓ — applies to everyone after the rebuild (~1 min).' + (uiChanged ? ' Reloading…' : '');
      if (uiChanged) setTimeout(() => location.reload(), 1500);
    } catch (err) { status.textContent = stopped(err, 'saved') || notDone('The settings were not saved.', err); }
  };
}

// ─── Make things editable (admin) ────────────────────────────────────────────
// Kiln annotates its own HTML: pick any element on the page and Kiln splices
// the data-cms attributes into the repo file (or strips them off again). The
// live DOM is mapped to the source by counting same-tag elements in tree order,
// with Kiln-injected chrome filtered out, then sanity-checked by text content.

const PICKABLE = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'ul', 'ol',
  'img', 'div', 'section', 'article', 'figure', 'figcaption', 'blockquote', 'small', 'strong',
  'em', 'td', 'th', 'tr', 'tbody', 'table', 'time', 'dl', 'dt', 'dd', 'caption', 'address']);

const KILN_CHROME = '#kiln-fab-wrap,#kiln-topbar,#kiln-toolbar,#kiln-modal,#kiln-imgpop,#kiln-previewbar,#kiln-notices,'
  + '#kiln-presence,#kiln-pickbar,#kiln-sandbox-banner,#kiln-scope-note,.kiln-item-ctl,.kiln-ctl-cell,.kiln-repeat-add,'
  + '.kiln-filterbar,.kiln-filterbar-preview,.kiln-evbar,.kiln-img-handle,'
  + '#kiln-cmt-layer,#kiln-cmt-hint,#kiln-cmt-pop,#kiln-cmt-composer,#kiln-blocks-layer';

function isKilnChrome(el) { return !!el.closest(KILN_CHROME); }

/** The DOM index of `el` among same-tag elements, skipping Kiln-injected ones. */
function domNth(el) {
  const all = [...document.getElementsByTagName(el.tagName)].filter(e => !isKilnChrome(e));
  return all.indexOf(el);
}

let pickMode = null;

function exitPickMode() {
  if (!pickMode) return;
  document.removeEventListener('mouseover', pickMode.over, true);
  document.removeEventListener('click', pickMode.click, true);
  document.removeEventListener('keydown', pickMode.esc, true);
  document.querySelectorAll('.kiln-pick-hover').forEach(n => n.classList.remove('kiln-pick-hover'));
  pickMode.bar.remove();
  // Restore the Kiln button/bar that we hid on entry.
  document.getElementById('kiln-fab-wrap')?.style.removeProperty('display');
  document.getElementById('kiln-topbar')?.style.removeProperty('display');
  pickMode = null;
}

/** The element pick-mode would act on for a given event target. */
function pickCandidate(target) {
  if (!(target instanceof Element) || isKilnChrome(target)) return null;
  // Already-annotated ancestor wins — that's what "remove editing" targets.
  const annotated = target.closest('[data-cms], [data-cms-repeat], [data-cms-menu]');
  if (annotated && !isKilnChrome(annotated)) return annotated;
  for (let el = target; el && el !== document.body; el = el.parentElement) {
    if (PICKABLE.has(el.tagName.toLowerCase())) return el;
  }
  return null;
}

/** Add a NEW gallery or events section to the page (distinct from make-editable,
 *  which annotates EXISTING content). Inserts a starter block, staged for Publish. */
function addSectionFlow() {
  const m = modal(`
    <h3>Add a section</h3>
    <p class="kiln-dim">Pick what to add, then click where on the page it should go.</p>
    <div class="kiln-roles">
      <label class="kiln-role"><input type="radio" name="kiln-add-kind" value="gallery" checked>
        <span><strong>Photo gallery</strong><br><small>Upload photos; visitors get a grid and a full-screen lightbox.</small></span></label>
      <label class="kiln-role"><input type="radio" name="kiln-add-kind" value="events">
        <span><strong>Events list</strong><br><small>Add events with a form; visitors get list + month/week/day calendar.</small></span></label>
    </div>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-add-go">Choose where →</button>
    </div>`);
  m.querySelector('#kiln-add-go').onclick = () => {
    const kind = m.querySelector('input[name="kiln-add-kind"]:checked').value;
    m.remove();
    pickSectionSpot(kind);
  };
}

/** Click-to-place: hover top-level page sections, click to insert after one. */
function pickSectionSpot(kind) {
  const host = document.querySelector('main') || document.body;
  // Candidate anchors: the page's top-level blocks (skip Kiln chrome).
  const anchors = [...host.children].filter(c => !isKilnChrome(c) && c.getBoundingClientRect().height > 20);
  const bar = document.createElement('div');
  bar.id = 'kiln-pickbar';
  bar.innerHTML = `<span>${pickBarWords({ touch: isTouch() })}</span> <button id="kiln-spot-end">Put it at the end</button>
    <button id="kiln-spot-cancel" class="kiln-pick-cancel">Cancel</button>`;
  document.body.appendChild(bar);
  let hovered = null;
  const mark = (el) => {
    hovered?.classList.remove('kiln-spot-hover');
    hovered = el;
    el?.classList.add('kiln-spot-hover');
  };
  const over = (e) => {
    if (e.target.closest('#kiln-pickbar')) { mark(null); return; }
    mark(anchors.find(a => a.contains(e.target)) || null);
  };
  const done = (anchor) => {
    cleanup();
    insertNewSection(kind, anchor);   // null anchor = end of page
  };
  const click = (e) => {
    if (e.target.closest('#kiln-pickbar')) return;
    e.preventDefault(); e.stopPropagation();
    const a = anchors.find(x => x.contains(e.target));
    if (a) done(a);
  };
  const key = (e) => { if (e.key === 'Escape') { cleanup(); setStatus('Nothing was added.', 'idle'); } };
  function cleanup() {
    mark(null);
    bar.remove();
    document.removeEventListener('mouseover', over, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', key, true);
  }
  bar.querySelector('#kiln-spot-end').onclick = (e) => { e.stopPropagation(); done(null); };
  bar.querySelector('#kiln-spot-cancel').onclick = (e) => { e.stopPropagation(); cleanup(); setStatus('Nothing was added.', 'idle'); };
  document.addEventListener('mouseover', over, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', key, true);
}

function insertNewSection(kind, anchor) {
  const stamp = Date.now().toString(36);
  const key = `${kind}_${stamp}`;
  const attr = kind === 'gallery' ? 'data-kiln-gallery' : 'data-kiln-events';
  const heading = kind === 'gallery' ? 'Gallery' : 'Events';
  // The section's headings take the type the site's own headings have, read
  // off the nearest one: it used to arrive in whatever the browser gives a
  // heading nobody styled, which on most sites is plain body text.
  const like = [anchor, anchor?.previousElementSibling, document.querySelector('main') || document.body]
    .map(sec => sec && [...sec.querySelectorAll('h2, h1, h3')].find(h => !isKilnChrome(h) && !h.closest('.kiln-added') && h.getClientRects().length)).find(Boolean);
  const look = like ? headingVars(getComputedStyle(like)) : '';
  // Kiln's own plain look for it, unless the site has styles for an event of its own.
  const plain = !siteStyles('kiln-event');
  const html = `\n<section class="kiln-added${plain ? ' kiln-plain' : ''}" style="padding:2.5rem 0${look ? ';' + look : ''}"><div style="max-width:1080px;margin:0 auto;padding:0 1.25rem">`
    + `<h2 class="kiln-added-title" data-cms="${key}_title">${heading}</h2><div data-cms-repeat="${key}" ${attr}></div></div></section>\n`;
  const wrap = document.createElement('div'); wrap.innerHTML = html.trim();
  const node = wrap.firstElementChild;
  stageSectionInsert({ node, html, key, anchor });
  node.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
  setupRepeat(node.querySelector('[data-cms-repeat]'), key);
  setStatus(cfg.sandbox
    ? `${kind === 'gallery' ? 'A gallery' : 'An events list'} is added for this visit to the demo. On a real site, Publish keeps it.`
    : `Added a ${kind} — click “+ Add ${kind === 'gallery' ? 'photos' : 'event'}”, then Publish`, 'saved');
}

/** Whether the site's own stylesheet does anything to an element of this class (a box, a border, a background). */
function siteStyles(cls) {
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden';
  box.innerHTML = `<article></article><article class="${cls}"></article>`;
  document.body.appendChild(box);
  const [a, b] = [...box.children].map(n => getComputedStyle(n));
  const differs = ['paddingTop', 'paddingLeft', 'marginTop', 'borderTopWidth', 'borderLeftWidth', 'backgroundColor', 'display', 'boxShadow', 'borderRadius'].some(k => a[k] !== b[k]);
  box.remove();
  return differs;
}

/**
 * Shared staging for a NEW top-level section — the gallery/events flow and the
 * block library both land here. Places `node` live (after `anchor`, or at the
 * end of <main>), stages the matching insertAfter/appendMain op for Publish
 * (sandbox: preview-only), and records one undo entry. Returns the staged op,
 * or null in the sandbox.
 */
function stageSectionInsert({ node, html, key, anchor }) {
  const host = document.querySelector('main') || document.body;
  // The block picker is async — if the anchor section vanished meanwhile
  // (undo, another tab), fall back to the end of the page.
  if (anchor && !anchor.isConnected) anchor = null;
  const place = () => anchor ? anchor.after(node) : host.appendChild(node);
  // Live preview at the chosen spot; the same position is staged for the source.
  let op = null;
  if (anchor) {
    const tag = anchor.tagName.toLowerCase();
    const nth = domNth(anchor);
    place();
    op = { op: 'insertAfter', tag, nth, html, key };
  } else {
    place();
    op = { op: 'appendMain', html, key };
  }
  if (!cfg.sandbox) { state.pendingStructural.push(op); refreshPublishButton(); }
  pushUndoEntry({ steps: [{ structural: { node, op: cfg.sandbox ? null : op, html, place } }] });
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return cfg.sandbox ? null : op;
}

/** Boot the block library + section chrome (blocks.js gates itself by feature/scope). */
function bootBlocks() {
  initBlocks({ state, cfg, mode, hasFeature, pageInScope, keyInScope, modal, setStatus, escapeHtml, stopped,
    isKilnChrome, decorateField, setupRepeat, pushUndoEntry, refreshPublishButton, stageSectionInsert,
    // The screen space Kiln's fixed controls are using right now: a section
    // divider that scrolls under any of them steps aside.
    heldBoxes: () => ['#kiln-quick', '#kiln-fab', '#kiln-sandbox-banner', '#kiln-topbar', ...(isMobileEditor() ? ['#kiln-toolbar'] : [])].map(sel => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r && r.width && r.height ? { top: r.top, bottom: r.bottom } : null;
    }).filter(Boolean),
    sanitizeBlock: (html) => DOMPurify.sanitize(html, BLOCK_SANITIZE),
    ghRequest: (method, path, body) => state.gh.request(method, path, body),
    fetchFile: (p) => getFile(state.gh, cfg.repo, p, cfg.branch || 'main'),
    putRepoFile: (path, opts) => putFile(state.gh, cfg.repo, path, opts) });
}

function makeEditableMode() {
  if (pickMode) return exitPickMode();
  // Hide the Kiln button/menu and top bar so they can't intercept picks and
  // aren't left visible-but-dead behind the pick bar.
  const fab = document.getElementById('kiln-fab-wrap'); if (fab) fab.style.display = 'none';
  const top = document.getElementById('kiln-topbar'); if (top) top.style.display = 'none';
  const bar = document.createElement('div');
  bar.id = 'kiln-pickbar';
  bar.innerHTML = `<span><strong>Make-editable mode.</strong> ${isTouch() ? 'Tap' : 'Click'} anything to make it editable, or
    something already editable to make it plain again.<span class="kiln-keys-only"> <kbd>Esc</kbd> exits.</span></span>
    <button id="kiln-pick-exit">Done</button>`;
  document.body.appendChild(bar);
  const over = (e) => {
    document.querySelectorAll('.kiln-pick-hover').forEach(n => n.classList.remove('kiln-pick-hover'));
    const c = pickCandidate(e.target);
    if (c) c.classList.add('kiln-pick-hover');
  };
  const click = (e) => {
    if (e.target.closest('#kiln-pickbar, #kiln-modal')) return;
    e.preventDefault();
    e.stopPropagation();
    const el = pickCandidate(e.target);
    if (!el) return;
    if (el.hasAttribute('data-cms') || el.hasAttribute('data-cms-repeat') || el.hasAttribute('data-cms-menu')) {
      unmakeDialog(el);
    } else {
      makeDialog(el);
    }
  };
  const esc = (e) => { if (e.key === 'Escape') exitPickMode(); };
  bar.querySelector('#kiln-pick-exit').onclick = exitPickMode;
  document.addEventListener('mouseover', over, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', esc, true);
  pickMode = { bar, over, click, esc };
}

function suggestKey(el) {
  const base = (el.textContent || el.getAttribute('alt') || el.tagName).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').split('_').slice(0, 3).join('_')
    || el.tagName.toLowerCase();
  let key = base.slice(0, 40), n = 2;
  while (state.fields.fields.has(key)) key = `${base.slice(0, 38)}_${n++}`;
  return key;
}

/** ≥2 children with the same tag → looks like a list of blocks. */
function looksRepeatable(el) {
  const kids = [...el.children].filter(k => !isKilnChrome(k));
  if (kids.length < 2) return false;
  return kids.every(k => k.tagName === kids[0].tagName);
}

function makeDialog(el) {
  const tag = el.tagName.toLowerCase();
  const isImg = tag === 'img';
  const repeatable = !isImg && looksRepeatable(el);
  // A container can host a gallery/events list even when empty — the "+ Add"
  // button seeds the first item — so offer those on any block-level box, not
  // only ones that already contain a list.
  const isContainer = !isImg && (el.children.length >= 1
    || ['div', 'section', 'ul', 'ol', 'aside', 'article', 'figure', 'main'].includes(tag));
  const snippet = (el.textContent || el.getAttribute('alt') || '').trim().slice(0, 70);
  const inRepeat = !!el.closest('[data-cms-repeat]');
  const key = suggestKey(el);
  const kinds = isImg
    ? [{ v: 'img', t: 'Swappable image', d: 'Click to replace, resize, and set alt text.' }]
    : [
      { v: 'text', t: 'Editable text', d: 'Click-to-edit with formatting, links, images.' },
      { v: 'plain', t: 'Plain text only', d: 'No formatting allowed — safest for headings and labels.' },
      ...(repeatable && !inRepeat ? [
        { v: 'repeat', t: 'Repeating blocks', d: 'Editors can add, remove, reorder, and tag the blocks inside.' },
      ] : []),
    ];
  const m = modal(`
    <h3>Make this editable</h3>
    <p class="kiln-dim">&lt;${escapeHtml(tag)}&gt; ${snippet ? '· “' + escapeHtml(snippet) + '…”' : ''}</p>
    <div class="kiln-roles">
      ${kinds.map((k, i) => `<label class="kiln-role"><input type="radio" name="kiln-mk-kind" value="${k.v}" ${i === 0 ? 'checked' : ''}>
        <span><strong>${k.t}</strong><br><small>${k.d}</small></span></label>`).join('')}
    </div>
    <label>Field name <input type="text" id="kiln-mk-key" value="${escapeHtml(key)}" pattern="[a-z0-9_]+"></label>
    <p class="kiln-dim">Lowercase letters, numbers, underscores. This is the label editors see on the toolbar.</p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-mk-go">Make editable</button>
    </div>
    <p class="kiln-np-step" id="kiln-mk-status"></p>`);
  m.querySelector('#kiln-mk-go').onclick = async () => {
    const kind = m.querySelector('input[name="kiln-mk-kind"]:checked').value;
    const k = m.querySelector('#kiln-mk-key').value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    const status = m.querySelector('#kiln-mk-status');
    if (!k) return;
    if (state.fields.fields.has(k)) { status.textContent = `"${k}" is already used on this page — pick another name.`; return; }
    status.textContent = 'Committing…';
    try {
      await annotateElement(el, kind, k);
      m.remove();
    } catch (err) {
      console.error('[kiln] make-editable', err);
      status.textContent = notDone('That was not made editable.', err);
    }
  };
}

function applyAnnotationToDom(el, kind, key) {
  // Reflect the new annotation in the live DOM so it's usable without a reload.
  if (kind === 'img') {
    el.setAttribute('data-cms', key);
    el.setAttribute('data-cms-attr', 'src');
    decorateField(el, key);
  } else if (kind === 'repeat' || kind === 'gallery' || kind === 'events') {
    el.setAttribute('data-cms-repeat', key);
    if (kind === 'gallery') el.setAttribute('data-kiln-gallery', '');
    if (kind === 'events') el.setAttribute('data-kiln-events', '');
    setupRepeat(el, key);
    el.querySelectorAll('[data-cms]').forEach(n => decorateField(n, n.getAttribute('data-cms')));
  } else {
    el.setAttribute('data-cms', key);
    if (kind === 'plain') el.setAttribute('data-cms-plain', '');
    decorateField(el, key);
  }
}

async function annotateElement(el, kind, key) {
  const tag = el.tagName.toLowerCase();
  const nth = domNth(el);
  if (nth < 0) throw said('Kiln lost track of that part of the page, so please reload and try again');
  const domText = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // Demo sandbox: no repo to commit to — just wire it up live for the session.
  if (cfg.sandbox) {
    applyAnnotationToDom(el, kind, key);
    state.fields = indexHtml(document.documentElement.outerHTML);
    setStatus(`“${key}” is now editable ✓ (demo: for this session)`, 'saved');
    return;
  }
  const attrs = kind === 'img' ? ` data-cms="${key}" data-cms-attr="src"`
    : kind === 'repeat' ? ` data-cms-repeat="${key}"`
    : kind === 'gallery' ? ` data-cms-repeat="${key}" data-kiln-gallery`
    : kind === 'events' ? ` data-cms-repeat="${key}" data-kiln-events`
    : kind === 'plain' ? ` data-cms="${key}" data-cms-plain`
    : ` data-cms="${key}"`;
  // Verify we can locate it in the CURRENT source (fail early), then STAGE the
  // annotation — it's applied to the file at Publish, so it's pending like any
  // other edit (nothing auto-commits).
  const node = findNthTag(state.page.text, tag, nth);
  if (!node) throw said('Kiln could not find that part in the page’s file. For the owner: if the site builds this page with JavaScript, annotate the source file by hand');
  const srcText = node.innerText.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (domText && srcText && domText !== srcText) {
    // Often the site's own JS rewrote the text (dates, counters). The element
    // POSITION still matches, so annotating is safe — but confirm, because the
    // editor will show (and could overwrite) the source version, not the
    // script's output.
    // One dialog of the editor's own (own-dialogs.js), not the browser's box.
    if (!(await askFirst(modal, ownDialogCopy('reads-differently', { onScreen: domText, inFile: srcText })))) {
      throw said('The words in the page’s file are not the words on screen, so nothing was changed');
    }
  }
  state.pendingStructural.push({ op: 'annotate', tag, nth, attrs, key });
  applyAnnotationToDom(el, kind, key);
  refreshPublishButton();
  setStatus(`“${key}” is now editable — Publish to save it to the site`, 'saved');
}

/** Apply all staged structural changes (annotate/unannotate) to raw page HTML. */
function applyStructural(text, ops) {
  let t = text;
  for (const s of (ops || state.pendingStructural)) {
    if (s.op === 'annotate') t = annotateNthTag(t, s.tag, s.nth, s.attrs) || t;
    else if (s.op === 'remove') { const out = removeAnnotations(t, s.key); if (out !== null) t = out; }
    else if (s.op === 'appendMain') { const out = appendIntoNthTag(t, 'main', 0, s.html) || appendIntoNthTag(t, 'body', 0, s.html); if (out) t = out; }
    else if (s.op === 'removeSection') { const out = removeKilnSection(t, s.key); if (out !== null) t = out; }
    else if (s.op === 'insertAfter') {
      // Place after the chosen element; if it can't be found in source anymore
      // (page changed underneath us), fall back to the end of <main>.
      const out = insertAfterNthTag(t, s.tag, s.nth, s.html)
        || appendIntoNthTag(t, 'main', 0, s.html) || appendIntoNthTag(t, 'body', 0, s.html);
      if (out) t = out;
    }
  }
  return t;
}

function unmakeDialog(el) {
  const key = el.getAttribute('data-cms') || el.getAttribute('data-cms-repeat') || el.getAttribute('data-cms-menu');
  const kindLabel = el.hasAttribute('data-cms-repeat') ? 'repeating blocks'
    : el.hasAttribute('data-cms-menu') ? 'managed menu' : 'editable field';
  // Keys repeat inside block lists; only the first (indexed) element maps to source.
  const first = document.querySelector(`[data-cms="${CSS.escape(key)}"], [data-cms-repeat="${CSS.escape(key)}"], [data-cms-menu="${CSS.escape(key)}"]`);
  if (first !== el && el.closest('[data-cms-repeat]') !== el) {
    setStatus('Blocks in a list share their field names — remove editing on the FIRST block, or on the list itself.', 'error');
    return;
  }
  const m = modal(`
    <h3>Remove editing from “${escapeHtml(key)}”?</h3>
    <p class="kiln-dim">This ${kindLabel} stops being editable in Kiln. The content itself stays
    exactly as it is — only the editing annotation is removed. You can make it editable again any time.</p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-um-go">Remove editing</button>
    </div>
    <p class="kiln-np-step" id="kiln-um-status"></p>`);
  const stripDom = () => {
    ['data-cms', 'data-cms-attr', 'data-cms-plain', 'data-cms-repeat', 'data-cms-menu', 'data-kiln-gallery', 'data-kiln-events']
      .forEach(a => el.removeAttribute(a));
    el.classList.remove('kiln-field', 'kiln-repeat');
    el.removeAttribute('title');
  };
  m.querySelector('#kiln-um-go').onclick = () => {
    // Demo sandbox: no repo — just strip it from the live DOM for the session.
    if (cfg.sandbox) {
      stripDom();
      state.fields = indexHtml(document.documentElement.outerHTML);
      m.remove();
      setStatus(`“${key}” is no longer editable (demo)`, 'saved');
      return;
    }
    // Stage the removal — applied at Publish, pending like any other edit.
    state.pendingStructural.push({ op: 'remove', key });
    stripDom();
    // Drop any pending field edit for this now-unmanaged key.
    state.pending.delete(key);
    refreshPublishButton();
    m.remove();
    setStatus(`“${key}” will stop being editable — Publish to save`, 'saved');
  };
}

// ─── Done / exit ─────────────────────────────────────────────────────────────

function doneEditing() {
  if (state.pending.size || state.pendingBinaries.size || state.pendingStructural.length || state.pendingSource.size) {
    const nDone = state.pending.size + state.pendingSource.size || state.pendingBinaries.size;
    const m = modal(`
      <h3>You have ${nDone} unpublished edit${nDone > 1 ? 's' : ''}</h3>
      <p class="kiln-dim">Publish them first, or discard and exit?</p>
      <div class="kiln-modal-actions">
        <button class="kiln-btn-ghost" data-close>Keep editing</button>
        <button class="kiln-btn-ghost" id="kiln-discard">Discard &amp; exit</button>
        <button class="kiln-btn-publish" id="kiln-pub-exit">Publish first</button>
      </div>`);
    m.querySelector('#kiln-discard').onclick = () => {
      state.pending.clear(); state.pendingBinaries.clear(); state.pendingStructural = [];
      state.pendingSource.clear();
      clearSavedPending();   // discarded: not to be offered back when editing is resumed
      editHistory.undo.length = 0; editHistory.redo.length = 0;
      exitEditMode();
    };
    m.querySelector('#kiln-pub-exit').onclick = async () => { m.remove(); await publish(); };
    return;
  }
  exitEditMode();
}

function exitEditMode() {
  sessionStorage.setItem(PAUSE_KEY, '1');
  location.reload();
}

// ─── UI chrome ───────────────────────────────────────────────────────────────

/**
 * The Kiln FAB — a draggable floating button that expands into the action
 * menu. Replaces the old fixed top bar so the site itself stays unobstructed.
 * Position is remembered per-browser.
 */
/**
 * Sign out. With edits waiting it asks first, in the editor's own dialog:
 * signing out throws them away, whatever kind they are.
 */
async function signOut() {
  const edits = state.pending.size + state.pendingSource.size + state.pendingStructural.length + state.pendingBinaries.size;
  if (edits && !(await askFirst(modal, ownDialogCopy('sign-out', { edits })))) return;
  clearSavedPending();
  window.Kiln.logout();
}

function renderAdminBar() {
  initPalette({ state, cfg, mode, pageInScope, keyInScope, humanizeKey, listSitePages, modal, setStatus, escapeHtml, stopped,
    chrome: KILN_CHROME,   // the editor's own parts: never searched as the page's words
    fetchFile: (p) => getFile(state.gh, cfg.repo, p, cfg.branch || 'main'),
    // A site a generator builds: its pages are not the repository's .html
    // files. They are listed from its routes, its links and its sitemap, and
    // each is checked against the built site (site-pages.js).
    generated: () => !cfg.sandbox && (cfg.mode === 'source' || (!state.page?.path && !!document.querySelector(`[${SOURCE_ATTR}]`))),
    builtPages: () => builtPages({
      adapter: cfg.adapter || 'astro',
      here: location.href,
      hrefs: [...document.querySelectorAll('a[href]')].filter(a => !a.closest(KILN_CHROME)).map(a => a.getAttribute('href')),
      treePaths: async () => (await state.gh.request('GET', `/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch || 'main')}?recursive=1`))
        .tree.filter(t => t.type === 'blob').map(t => t.path),
      fetchPage: async (pathname) => {
        const res = await fetch(pathname, { credentials: 'same-origin' });
        const at = new URL(res.url || pathname, location.href);
        const same = at.origin === location.origin;
        return { ok: res.ok && same, type: res.headers.get('content-type') || '', path: at.pathname, text: res.ok && same ? await res.text() : '' };
      },
    }),
    sourceFieldRows: () => [...(state.sourceFields || [])].map(([ref, f]) => ({ ref, name: sourceName(ref), el: f.els.find(el => el.isConnected && !el.classList.contains('kiln-source-locked')) })).filter(r => r.el) });
  initSuggest({ state, cfg, mode, modal, setStatus, escapeHtml, ask, stopped, flattenPending, retireStaged,
    saveDraft, journalAdd, humanizeKey, noteTyped,
    note: () => keptNote, noteDone: () => { keptNote = ''; },
    fetchFile: (p) => getFile(state.gh, cfg.repo, p, cfg.branch || 'main'),
    ghRequest: (method, path, body) => state.gh.request(method, path, body) });
  initAssist({ state, cfg, mode, modal, setStatus, escapeHtml, ask, say,
    stagePending, stageContainer, commitEdit, humanizeKey });
  initTheme({ state, cfg, mode, modal, setStatus, escapeHtml, pageInScope, journalAdd, djb2, stopped,
    fetchFile: (p) => getFile(state.gh, cfg.repo, p, cfg.branch || 'main') });
  if ((localStorage.getItem('kiln_ui_mode') || 'fab') === 'bar') { renderTopBar(); return; }
  const fab = document.createElement('div');
  fab.id = 'kiln-fab-wrap';
  fab.innerHTML = `
    <div id="kiln-fab-menu" hidden>
      <div class="kiln-fab-head">
        <span class="kiln-brand">Kiln</span>
        <span class="kiln-user">${escapeHtml(state.user)}${mode === 'editor' && !cfg.sandbox ? ' · editor' : ''}</span>
      </div>
      <button id="kiln-publish" class="kiln-fab-item kiln-fab-primary" disabled>Publish</button>
      <div id="kiln-grp-edits" class="kiln-fab-group" hidden>
        <div class="kiln-fab-label">Your unpublished edits</div>
        <button id="kiln-draft" class="kiln-fab-item">Save as draft</button>
        <button id="kiln-sharepreview" class="kiln-fab-item">Share a preview link</button>
        <button id="kiln-schedule" class="kiln-fab-item">Schedule for later…</button>
        <button id="kiln-discard" class="kiln-fab-item kiln-fab-danger">Discard edits</button>
      </div>
      <div class="kiln-fab-group">
        <div class="kiln-fab-label">This page</div>
        <button id="kiln-newpost" class="kiln-fab-item">＋ New post or page</button>
        <button id="kiln-pagesettings" class="kiln-fab-item">Page settings</button>
        <button id="kiln-history" class="kiln-fab-item">History &amp; restore</button>
        <button id="kiln-comments" class="kiln-fab-item">💬 Comments</button>
        ${canMakeEditable() ? '<button id="kiln-addsection" class="kiln-fab-item">＋ Add a gallery or events</button>' : ''}
      ${canMakeEditable() ? '<button id="kiln-makeblock" class="kiln-fab-item">✨ Make text/images editable</button>' : ''}
      </div>
      <div class="kiln-fab-group">
        <div class="kiln-fab-label">Whole site</div>
        <button id="kiln-palette-btn" class="kiln-fab-item">Search &amp; jump <span class="kiln-pal-kbd">⌘K</span></button>
        <button id="kiln-menu" class="kiln-fab-item">Site menu</button>
        <button id="kiln-theme" class="kiln-fab-item">Theme</button>
        <button id="kiln-findreplace" class="kiln-fab-item">Find &amp; replace</button>
        ${mode === 'admin' || cfg.sandbox ? '<button id="kiln-suggestions" class="kiln-fab-item">Suggestions <span id="kiln-sug-badge" hidden></span></button>' : ''}
        ${mode === 'admin' || cfg.sandbox ? '<button id="kiln-invite" class="kiln-fab-item">People &amp; access</button>' : ''}
        <button id="kiln-settings" class="kiln-fab-item">Settings</button>
        <button id="kiln-help" class="kiln-fab-item" data-href="${escapeHtml(helpLink())}" title="Opens the guide in a new tab">Help <span class="kiln-pal-kbd" aria-hidden="true">↗</span></button>
      </div>
      <div class="kiln-fab-foot">
        <button id="kiln-done" title="Hide Kiln and browse normally (stays signed in — return via the Resume button or yoursite.com/kiln)">Done editing</button>
        <button id="kiln-signout">Sign out</button>
      </div>
    </div>
    <button id="kiln-fab" title="Kiln — drag me anywhere" aria-label="Kiln editing menu" aria-haspopup="true" aria-expanded="false" aria-controls="kiln-fab-menu">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      <span id="kiln-fab-badge" hidden></span>
    </button>
    <div id="kiln-quick">
      <div id="kiln-undo-wrap" hidden>
        <button id="kiln-undo-btn" title="Undo last change (⌘Z)">${UNDO_ICON} Undo</button>
        <button id="kiln-redo-btn" title="Redo (⌘⇧Z)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M21 7v6h-6"/><path d="M20.5 13a9 9 0 1 1-2.6-8.4L21 7"/></svg> Redo</button>
      </div>
      <button id="kiln-publish-quick" type="button" hidden>Publish</button>
    </div>
    <div class="kiln-status" id="kiln-status" role="status" hidden></div>`;
  document.body.appendChild(fab);
  fab.querySelector('#kiln-undo-btn').onclick = (e) => { e.stopPropagation(); undoEdit(); };
  fab.querySelector('#kiln-redo-btn').onclick = (e) => { e.stopPropagation(); redoEdit(); };
  // Publish, in the open: the same function as the menu's first item, shown
  // beside the pencil whenever there is something unpublished.
  fab.querySelector('#kiln-publish-quick').onclick = (e) => { e.stopPropagation(); requestPublish(); };
  // A toast you have read is in the way: tap it to put it away.
  fab.querySelector('#kiln-status').addEventListener('click', (e) => {
    if (!e.target.closest('a, button')) e.currentTarget.hidden = true;
  });

  // Restore position (default: bottom-right).
  function clampFab() {
    const r = fab.getBoundingClientRect();
    if (r.left < 4 || r.top < 4 || r.right > window.innerWidth - 4 || r.bottom > window.innerHeight - 4) {
      const x = Math.max(8, Math.min(r.left, window.innerWidth - 56));
      const y = Math.max(8, Math.min(r.top, window.innerHeight - 56));
      fab.style.left = x + 'px'; fab.style.top = y + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
      localStorage.setItem('kiln_fab_pos', JSON.stringify({ x, y }));
    }
  }
  try {
    const pos = JSON.parse(localStorage.getItem('kiln_fab_pos'));
    if (pos) {
      fab.style.left = pos.x + 'px'; fab.style.top = pos.y + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
    }
  } catch { /* default position */ }
  requestAnimationFrame(() => { clampFab(); placeQuickRow(); });
  window.addEventListener('resize', () => { clampFab(); placeQuickRow(); });

  const btn = fab.querySelector('#kiln-fab');
  const menu = fab.querySelector('#kiln-fab-menu');

  // The menu is either following the mouse (opened by hovering the pencil: it
  // closes when the mouse leaves) or PINNED (opened, or kept, by a click, a tap
  // or the keyboard: it stays until a second click on the pencil, Escape, or a
  // click somewhere else). One place flips it, so the pencil's aria-expanded
  // and the page-level "menu is open" class never drift from what is on screen.
  let pinned = false;
  const menuOpen = () => !menu.hidden;
  function setMenu(open, pin = false) {
    if (open) positionMenu(); else menu.hidden = true;
    pinned = open && pin;
    btn.setAttribute('aria-expanded', String(open));
    document.documentElement.classList.toggle('kiln-menu-open', open);
  }
  const menuItems = () => [...menu.querySelectorAll('button')].filter(b => !b.disabled && b.getClientRects().length);
  const focusItem = (i) => { const items = menuItems(); if (items.length) items[(i + items.length) % items.length].focus(); };

  // Drag with a click/drag threshold so taps still open the menu.
  // On phones the FAB is docked by CSS (drag would fight the dock and corrupt
  // the saved desktop position) — a pointer there only ever toggles the menu.
  let drag = null;
  let touchedAt = 0;   // a tap also fires a late, made-up mouseenter: see the hover handler
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') touchedAt = Date.now();
    drag = { x: e.clientX, y: e.clientY, left: fab.offsetLeft, top: fab.offsetTop, moved: false, docked: isMobileEditor() };
    btn.setPointerCapture(e.pointerId);
  });
  btn.addEventListener('pointercancel', () => { drag = null; });
  btn.addEventListener('pointermove', (e) => {
    if (!drag || drag.docked) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    if (drag.moved) {
      setMenu(false);
      const x = Math.min(Math.max(drag.left + dx, 8), window.innerWidth - 56);
      const y = Math.min(Math.max(drag.top + dy, 8), window.innerHeight - 56);
      fab.style.left = x + 'px'; fab.style.top = y + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
    }
  });
  btn.addEventListener('pointerup', () => {
    if (drag && drag.moved) {
      localStorage.setItem('kiln_fab_pos', JSON.stringify({ x: fab.offsetLeft, y: fab.offsetTop }));
      placeQuickRow();
    } else if (!menuOpen()) {
      setMenu(true, true);
    } else if (!pinned) {
      // Hovering opened it and this is the click that naturally follows: the
      // person wants the menu. Keep it.
      pinned = true;
    } else {
      setMenu(false);
    }
    drag = null;
  });
  // Enter / Space on the pencil arrive as a click with no pointer behind it
  // (pointer clicks were handled above and are skipped here).
  btn.addEventListener('click', (e) => {
    if (e.detail !== 0) return;
    if (menuOpen()) setMenu(false);
    else { setMenu(true, true); focusItem(0); }
  });
  // Arrow keys walk the menu; from the pencil they open it. Escape closes it
  // and hands focus back to the pencil.
  fab.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!menuOpen()) return;
      e.stopPropagation();
      setMenu(false);
      btn.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const onPencil = document.activeElement === btn;
    if (!onPencil && !menu.contains(document.activeElement)) return;
    e.preventDefault();
    if (!menuOpen()) setMenu(true, true);
    const items = menuItems();
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Home') focusItem(0);
    else if (e.key === 'End') focusItem(-1);
    else if (e.key === 'ArrowDown') focusItem(at + 1);          // from the pencil: the first item
    else focusItem(at === -1 ? -1 : at - 1);                    // from the pencil: the last item
  });
  // Escape closes the menu from anywhere on the page too.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menuOpen() || fab.contains(e.target)) return;
    setMenu(false);
  });

  function positionMenu() {
    // Phone: the stylesheet's bottom-sheet rules own the geometry — wipe any
    // inline coordinates a desktop open may have left, then just show it.
    if (isMobileEditor()) { menu.style.cssText = ''; menu.hidden = false; return; }
    // Fixed coordinates, measured then clamped — works wherever the FAB is parked.
    menu.style.position = 'fixed';
    menu.style.visibility = 'hidden';
    menu.hidden = false;
    const br = btn.getBoundingClientRect();
    // As tall as the room on its side of the pencil, and no taller: a full
    // menu on a small laptop scrolls inside itself instead of running off the
    // screen or lying over the pencil and the status line beside it.
    const above = br.top > window.innerHeight / 2;
    menu.style.maxHeight = `${Math.max(220, (above ? br.top : window.innerHeight - br.bottom) - 18)}px`;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = br.right - mw;                       // right-align to the button…
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));   // …then clamp
    let top = above ? br.top - mh - 10 : br.bottom + 10;
    top = Math.max(8, Math.min(top, window.innerHeight - mh - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.visibility = 'visible';
  }

  document.addEventListener('click', (e) => {
    if (!fab.contains(e.target) && menuOpen()) setMenu(false);
  });

  // Hovering the PENCIL opens the menu; leaving the pencil-and-menu area closes
  // it again, unless a click pinned it. Only the pencil opens it: the Undo,
  // Redo and Publish buttons share this wrapper, and reaching for Publish must
  // not throw a menu over it. Not on phones, and not for the mouseenter a
  // browser invents after a tap (it would re-open what the tap just closed).
  let hoverTimer = null;
  btn.addEventListener('mouseenter', () => {
    if (isMobileEditor() || Date.now() - touchedAt < 1000) return;
    clearTimeout(hoverTimer);
    if (!menuOpen()) setMenu(true, false);
  });
  const leaveSoon = (ms) => () => {
    clearTimeout(hoverTimer);
    if (!pinned) hoverTimer = setTimeout(() => { if (!pinned) setMenu(false); }, ms);
  };
  fab.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
  menu.addEventListener('mouseenter', () => clearTimeout(hoverTimer));
  menu.addEventListener('mouseleave', leaveSoon(250));
  fab.addEventListener('mouseleave', leaveSoon(350));

  // An open menu sheet closes when a field's toolbar comes up: a tap on a field
  // under the sheet never reaches the click-away above, because the field's own
  // handler stops it.
  watchToolbar(() => { if (menuOpen()) setMenu(false); });

  const close = (fn) => () => { setMenu(false); fn(); };
  fab.querySelector('#kiln-publish').onclick = close(requestPublish);
  fab.querySelector('#kiln-newpost').onclick = close(newContent);
  fab.querySelector('#kiln-menu').onclick = close(menuEditor);
  fab.querySelector('#kiln-theme').onclick = close(openThemePanel);
  fab.querySelector('#kiln-history').onclick = close(historyPanel);
  fab.querySelector('#kiln-done').onclick = close(doneEditing);
  fab.querySelector('#kiln-discard').onclick = close(discardEdits);
  fab.querySelector('#kiln-pagesettings').onclick = close(pageSettingsPanel);
  fab.querySelector('#kiln-findreplace').onclick = close(findReplacePanel);
  fab.querySelector('#kiln-palette-btn').onclick = close(openPalette);
  fab.querySelector('#kiln-schedule').onclick = close(schedulePanel);
  fab.querySelector('#kiln-draft').onclick = close(saveDraft);
  fab.querySelector('#kiln-sharepreview').onclick = close(sharePreviewPanel);
  const sugBtn = fab.querySelector('#kiln-suggestions');
  if (sugBtn) sugBtn.onclick = close(suggestionsPanel);
  fab.querySelector('#kiln-comments').onclick = close(openComments);
  const settingsBtn = fab.querySelector('#kiln-settings');
  if (settingsBtn) settingsBtn.onclick = close(settingsPanel);
  fab.querySelector('#kiln-help').onclick = close(openHelp);
  fab.querySelector('#kiln-signout').onclick = close(signOut);
  const inviteBtn = fab.querySelector('#kiln-invite');
  if (inviteBtn) inviteBtn.onclick = close(invitePanel);
  const makeBtn = fab.querySelector('#kiln-makeblock');
  if (makeBtn) makeBtn.onclick = close(makeEditableMode);
  const addSecBtn = fab.querySelector('#kiln-addsection');
  if (addSecBtn) addSecBtn.onclick = close(addSectionFlow);

  applyFeatureGating();
  refreshPublishButton();   // suggest-mode label ("Suggest changes") from the first paint
  updateOnlineChip();
  // What this person can do here, in one true sentence (grants.js startLine).
  // A phone has no click, and its outlines are always on.
  const seat = mode === 'editor' && !cfg.sandbox ? state.scope?.mode || null : null;
  setStatus(startLine({ user: state.user, touch: window.matchMedia('(hover: none)').matches, scopeMode: seat,
    comments: hasFeature('comments'), pageFile: !!state.page?.path || !!cfg.sandbox }), 'idle', seat === 'review' || (seat === 'suggest' && !state.page?.path) ? { hold: 12000 } : undefined);
}

/**
 * The Undo / Redo / Publish row sits above the pencil, right-aligned to it —
 * which runs off the screen once the pencil has been dragged to the left or the
 * top edge. Flip the row to the side that has room. (Phones dock the pencil
 * bottom-right, so nothing ever flips there.)
 */
function placeQuickRow() {
  const fab = document.getElementById('kiln-fab-wrap');
  const row = document.getElementById('kiln-quick');
  if (!fab || !row) return;
  window.dispatchEvent(new Event('kiln:chrome'));   // the row grew, shrank or emptied: section dividers re-check
  fab.classList.remove('kiln-flip-x', 'kiln-flip-y');
  const r = row.getBoundingClientRect();
  if (!r.width) return;   // nothing in it right now
  if (r.left < 8) fab.classList.add('kiln-flip-x');
  if (r.top < 8) fab.classList.add('kiln-flip-y');
}

/**
 * While a field's toolbar is up (phones dock it across the bottom of the
 * screen), the rest of Kiln's chrome gets out of its way. The stylesheet keys
 * off one class on <html>; this keeps that class true to the DOM, whichever of
 * the several code paths added or removed the toolbar.
 */
function watchToolbar(onOpen) {
  new MutationObserver(() => {
    const open = !!document.getElementById('kiln-toolbar');
    if (open === document.documentElement.classList.contains('kiln-tb-open')) return;
    document.documentElement.classList.toggle('kiln-tb-open', open);
    if (open && onOpen) onOpen();
    guideSync();   // the demo guide's next step may have been waiting behind the toolbar
  }).observe(document.body, { childList: true });
}

function renderTopBar() {
  const bar = document.createElement('div');
  bar.id = 'kiln-topbar';
  bar.innerHTML = `
    <span class="kiln-brand">Kiln</span>
    <span class="kiln-user">${escapeHtml(state.user)}${mode === 'editor' && !cfg.sandbox ? ' · editor' : ''}</span>
    <span class="kiln-status" id="kiln-status" hidden></span>
    <span class="kiln-bar-spacer"></span>
    <span id="kiln-undo-wrap" hidden>
      <button id="kiln-undo-btn" class="kiln-btn-ghost" title="Undo last change (⌘Z)" aria-label="Undo">${UNDO_ICON}</button>
      <button id="kiln-redo-btn" class="kiln-btn-ghost" title="Redo (⌘⇧Z)" aria-label="Redo"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M21 7v6h-6"/><path d="M20.5 13a9 9 0 1 1-2.6-8.4L21 7"/></svg></button>
    </span>
    <button id="kiln-palette-btn" class="kiln-btn-ghost" title="Search &amp; jump (⌘K)">Search</button>
    <button id="kiln-newpost" class="kiln-btn-ghost">+ New</button>
    <button id="kiln-menu" class="kiln-btn-ghost">Menu</button>
    <button id="kiln-theme" class="kiln-btn-ghost">Theme</button>
    <button id="kiln-pagesettings" class="kiln-btn-ghost">Page</button>
    <button id="kiln-findreplace" class="kiln-btn-ghost">Replace</button>
    <button id="kiln-history" class="kiln-btn-ghost">History</button>
    <button id="kiln-comments" class="kiln-btn-ghost">💬 Comments</button>
    ${canMakeEditable() ? '<button id="kiln-addsection" class="kiln-btn-ghost" title="Add a gallery or events section">＋ Add</button><button id="kiln-makeblock" class="kiln-btn-ghost" title="Make text/images editable">✨ Editable</button>' : ''}${mode === 'admin' || cfg.sandbox ? '<button id="kiln-suggestions" class="kiln-btn-ghost" title="Review suggested changes">Suggestions <span id="kiln-sug-badge" hidden></span></button>' : ''}${mode === 'admin' || cfg.sandbox ? '<button id="kiln-invite" class="kiln-btn-ghost">People</button>' : ''}
    <button id="kiln-settings" class="kiln-btn-ghost">Settings</button>
    <button id="kiln-help" class="kiln-btn-ghost" data-href="${escapeHtml(helpLink())}" title="Opens the guide in a new tab">Help</button>
    <button id="kiln-draft" class="kiln-btn-ghost" hidden>Draft</button>
    <button id="kiln-sharepreview" class="kiln-btn-ghost" hidden title="Save a draft, get a shareable link">Preview link</button>
    <button id="kiln-schedule" class="kiln-btn-ghost" hidden>Schedule</button>
    <button id="kiln-discard" class="kiln-btn-ghost" hidden>Discard</button>
    <button id="kiln-publish" class="kiln-btn-publish" disabled>Publish</button>
    <button id="kiln-done" class="kiln-btn-ghost">Done</button>
    <button id="kiln-signout" class="kiln-btn-link">sign out</button>`;
  // Making room for the bar moves the page down by the bar's height, and a
  // browser that keeps what you were reading in place then scrolls by the
  // same amount: the first lines of the page end up under the bar. A page
  // that was at its top stays at its top.
  const atTop = window.scrollY < 2;
  document.body.prepend(bar);
  if (atTop) {
    const up = () => { if (window.scrollY <= bar.offsetHeight + 2) window.scrollTo(0, 0); };
    up(); requestAnimationFrame(up); setTimeout(up, 250);
  }
  bar.querySelector('#kiln-undo-btn').onclick = undoEdit;
  bar.querySelector('#kiln-redo-btn').onclick = redoEdit;
  bar.querySelector('#kiln-publish').onclick = requestPublish;
  bar.querySelector('#kiln-newpost').onclick = newContent;
  bar.querySelector('#kiln-menu').onclick = menuEditor;
  bar.querySelector('#kiln-theme').onclick = openThemePanel;
  bar.querySelector('#kiln-pagesettings').onclick = pageSettingsPanel;
  bar.querySelector('#kiln-findreplace').onclick = findReplacePanel;
  bar.querySelector('#kiln-palette-btn').onclick = openPalette;
  bar.querySelector('#kiln-history').onclick = historyPanel;
  bar.querySelector('#kiln-comments').onclick = openComments;
  bar.querySelector('#kiln-done').onclick = doneEditing;
  bar.querySelector('#kiln-discard').onclick = discardEdits;
  bar.querySelector('#kiln-draft').onclick = saveDraft;
  bar.querySelector('#kiln-sharepreview').onclick = sharePreviewPanel;
  bar.querySelector('#kiln-schedule').onclick = schedulePanel;
  const sugBtn = bar.querySelector('#kiln-suggestions');
  if (sugBtn) sugBtn.onclick = suggestionsPanel;
  bar.querySelector('#kiln-signout').onclick = signOut;
  const inviteBtn = bar.querySelector('#kiln-invite');
  if (inviteBtn) inviteBtn.onclick = invitePanel;
  const makeBtn = bar.querySelector('#kiln-makeblock');
  if (makeBtn) makeBtn.onclick = makeEditableMode;
  const addSecBtn = bar.querySelector('#kiln-addsection');
  if (addSecBtn) addSecBtn.onclick = addSectionFlow;
  bar.querySelector('#kiln-help').onclick = openHelp;
  const settingsBtn = bar.querySelector('#kiln-settings');
  if (settingsBtn) settingsBtn.onclick = settingsPanel;
  applyFeatureGating();
  refreshPublishButton();   // suggest-mode label ("Suggest changes") from the first paint
  updateOnlineChip();
  watchToolbar();
  setStatus(`Signed in as ${state.user}`, 'idle');
}

function discardEdits() {
  const nAll = state.pending.size + state.pendingSource.size;
  if (!nAll) return;
  const m = modal(`
    <h3>Discard ${nAll} unpublished edit${nAll > 1 ? 's' : ''}?</h3>
    <p class="kiln-dim">The page goes back to what's currently live. This can't be undone.</p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" data-close>Keep editing</button>
      <button class="kiln-btn-publish" id="kiln-disc-go">Discard</button>
    </div>`);
  m.querySelector('#kiln-disc-go').onclick = () => {
    state.pending.clear();
    state.pendingBinaries.clear();   // queued uploads were never committed — just drop them
    state.pendingStructural = [];
    state.pendingSource.clear();
    clearSavedPending();
    location.reload();
  };
}

/**
 * Place the toolbar where it does NOT cover the element being edited:
 * above it when there's room, below it otherwise, and only as a last resort
 * pinned inside the viewport (where the drag handle saves the day). Must run
 * AFTER the toolbar is in the DOM so its real (possibly wrapped) size is known.
 */
function positionToolbar(tb, el) {
  if (isMobileEditor()) { pinToolbarMobile(tb); return; }   // phone: fixed bar above the keyboard
  const r = el.getBoundingClientRect();
  const th = tb.offsetHeight, tw = tb.offsetWidth;
  let top;
  if (r.top - th - 10 >= 8) top = r.top - th - 10;                      // above the element
  else if (r.bottom + 10 + th <= window.innerHeight - 8) top = r.bottom + 10;  // below it
  else top = Math.max(8, window.innerHeight - th - 12);                 // pinned; drag to taste
  const left = Math.max(8, Math.min(r.left, window.innerWidth - tw - 8));
  tb.style.top = `${top + window.scrollY}px`;
  tb.style.left = `${left + window.scrollX}px`;
}

/**
 * Phone toolbar placement: ride the VISUAL viewport's bottom edge, which is the
 * top of the on-screen keyboard while typing (iOS overlays the keyboard without
 * shrinking the layout viewport, so position:fixed;bottom:0 would sit UNDER it).
 * The stylesheet makes #kiln-toolbar a full-width fixed bar; this keeps its
 * `top` glued to visualViewport height/offset until the toolbar leaves the DOM.
 */
function pinToolbarMobile(tb) {
  const vv = window.visualViewport;
  const place = () => {
    if (!tb.isConnected) { off(); return; }   // self-unhooks on the tick after removal
    const top = vv ? vv.offsetTop + vv.height - tb.offsetHeight
      : window.innerHeight - tb.offsetHeight;
    tb.style.top = `${Math.max(0, Math.round(top))}px`;
    tb.style.left = '0px';
  };
  const off = () => {
    if (!vv) return;
    vv.removeEventListener('resize', place);
    vv.removeEventListener('scroll', place);
  };
  if (vv) {
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
  }
  tb._kilnVvOff = off;   // removeToolbar unhooks promptly (place() is the fallback)
  place();
}

/** Drag anywhere on the toolbar chrome (not its buttons/inputs) to move it. */
function makeToolbarDraggable(tb) {
  if (isMobileEditor()) return;   // phone: the bar is pinned above the keyboard — never draggable
  let drag = null;
  tb.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input, select, a')) return;
    drag = { x: e.clientX, y: e.clientY, left: parseFloat(tb.style.left) || 0, top: parseFloat(tb.style.top) || 0 };
    tb.setPointerCapture(e.pointerId);
    tb.classList.add('kiln-tb-dragging');
    e.preventDefault();
  });
  tb.addEventListener('pointermove', (e) => {
    if (!drag) return;
    tb.style.left = `${drag.left + e.clientX - drag.x}px`;
    tb.style.top = `${drag.top + e.clientY - drag.y}px`;
  });
  const end = () => { drag = null; tb.classList.remove('kiln-tb-dragging'); };
  tb.addEventListener('pointerup', end);
  tb.addEventListener('pointercancel', end);
}

const TB_GRIP = '<span class="kiln-tb-grip" title="Drag to move this toolbar" aria-hidden="true">⠿</span>';

function renderToolbar(el, key, opts = {}) {
  removeToolbar();
  const tb = document.createElement('div');
  tb.id = 'kiln-toolbar';
  // A formatted text from a content file: only what Markdown can hold
  // (no underline, no site styles), and Done/Revert write Markdown back.
  const md = !!opts.markdown;
  const isLink = !md && el.tagName === 'A';
  const plain = !md && el.hasAttribute('data-cms-plain');
  const styles = !md && Array.isArray(cfg.styles) ? cfg.styles : [];
  const LINK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
  const IMG_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
  const HIST_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2"/></svg>';
  tb.innerHTML = `
    ${TB_GRIP}
    ${md ? `<span class="kiln-tb-label" title="${escapeHtml(opts.label)}">${escapeHtml(opts.label)}</span>`
    : `<span class="kiln-tb-label" title="${escapeHtml(key)}">${escapeHtml(readableName(key))}</span>`}
    ${plain ? '' : `
      <select class="kiln-style-select" title="Text format and site styles">
        <option value="">Style</option>
        <optgroup label="Format">
          <option value="fmt:p">Body</option>
          <option value="fmt:h2">Heading</option>
          <option value="fmt:h3">Subheading</option>
          <option value="fmt:blockquote">Quote</option>
        </optgroup>
        ${styles.length ? `<optgroup label="Site styles">
          ${styles.map(s => `<option value="cls:${escapeHtml(s.class)}">${escapeHtml(s.label)}</option>`).join('')}
        </optgroup>` : ''}
      </select>
      <button class="kiln-tb-fmt" data-cmd="bold" title="Bold"><b>B</b></button>
      <button class="kiln-tb-fmt" data-cmd="italic" title="Italic"><i>I</i></button>
      ${md ? '' : '<button class="kiln-tb-fmt" data-cmd="underline" title="Underline"><u>U</u></button>'}
      <button class="kiln-tb-fmt" data-cmd="insertUnorderedList" title="Bullet list">≔</button>
      <button class="kiln-tb-fmt" data-cmd="insertOrderedList" title="Numbered list">1.</button>
      <button class="kiln-tb-fmt" data-cmd="link" title="Turn selection into a link">${LINK_ICON}</button>
      ${md ? '' : `<button class="kiln-tb-fmt" data-cmd="img" title="Insert an image at the cursor">${IMG_ICON}</button>
      <button class="kiln-tb-fmt" data-cmd="doc" title="Upload a document (PDF, doc…) and insert it at the cursor">📄</button>`}
      <button class="kiln-tb-fmt kiln-tb-clear" data-cmd="removeFormat" title="Clear formatting">Clear</button>`}
    ${isLink ? `<input class="kiln-href-input" type="text" value="${escapeHtml(el.getAttribute('href') || '')}" title="Where this links to" placeholder="/page.html or https://…">
      <button class="kiln-tb-fmt kiln-tb-attach" data-cmd="attach" title="Upload a file (PDF, doc…) and point this link at it">Attach file…</button>` : ''}
    ${hasFeature('ai') && !md ? '<button class="kiln-tb-fmt" id="kiln-ai" data-cmd="ai" title="AI assist — improve, shorten, change tone, translate">✨</button>' : ''}
    <span class="kiln-tb-gap"></span>
    ${md ? '' : `<button class="kiln-tb-fmt" data-cmd="hist" title="This section's history — undo to a previous version">${HIST_ICON}</button>`}
    <button class="kiln-tb-save" title="Keep this edit (you can still Esc-revert until you click away)">Done</button>
    <button class="kiln-tb-cancel" title="Throw away this edit (Esc)">Revert</button>`;
  document.body.appendChild(tb);
  positionToolbar(tb, el);
  makeToolbarDraggable(tb);

  tb.querySelectorAll('.kiln-tb-fmt').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cmd = btn.dataset.cmd;
      if (cmd === 'link') {
        linkDialog(el);
        return;   // the dialog hands the cursor back itself, with the selection as it was
      } else if (cmd === 'img') {
        insertInlineImage(el);
      } else if (cmd === 'doc') {
        const sel = window.getSelection();
        const savedRange = sel.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
        insertDocument(el, savedRange);
      } else if (cmd === 'attach') {
        const input = tb.querySelector('.kiln-href-input');
        const up = await uploadAnyFile();
        if (up && input) input.value = up.path;
      } else if (cmd === 'ai') {
        openAssistMenu(el, key, btn);
        return;   // the menu takes over — don't steal focus back to the field
      } else if (cmd === 'hist') {
        // Fields inside a repeat share their key across every block (each table
        // row reuses sd_notes etc.), so per-field history is ambiguous — track
        // and restore the CONTAINER, which is also how these fields publish.
        const rep = el.closest('[data-cms-repeat]');
        fieldHistoryPanel(rep ? rep.getAttribute('data-cms-repeat') : key, !!rep);
        return;
      } else {
        document.execCommand(cmd, false, null);
      }
      el.focus();
    });
  });
  const styleSelect = tb.querySelector('.kiln-style-select');
  if (styleSelect) {
    styleSelect.addEventListener('mousedown', (e) => e.stopPropagation());
    styleSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      const value = styleSelect.value;
      styleSelect.value = '';
      if (!value) return;
      const sel = window.getSelection();
      const inField = sel.rangeCount && el.contains(sel.anchorNode);
      if (value.startsWith('fmt:')) {
        // Block format: works on the block the cursor is in (no selection needed).
        if (!inField) { el.focus(); }
        document.execCommand('formatBlock', false, value.slice(4));
      } else if (value.startsWith('cls:')) {
        const cls = value.slice(4);
        if (inField && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          const span = document.createElement('span');
          span.className = cls;
          try {
            range.surroundContents(span);
          } catch {
            span.appendChild(range.extractContents());
            range.insertNode(span);
          }
        } else {
          setStatus('Select some text first, then pick a site style', 'idle');
        }
      }
      el.focus();
    });
  }
  tb.querySelector('.kiln-tb-save').onclick = (e) => { e.stopPropagation(); if (md) opts.onSave(); else commitEdit(el, key); };
  tb.querySelector('.kiln-tb-cancel').onclick = (e) => { e.stopPropagation(); if (md) opts.onCancel(); else cancelEditing(); };
}

/**
 * The toolbar's link button: the editor's own dialog, where the browser's
 * box used to ask (link-dialog.js says what it reads and what an address may
 * be, which is what it always was). The edit stays open underneath: when the
 * dialog goes, by any way out, the cursor is back in the field with the
 * selection as it was, and only then is the link made, changed or taken off.
 */
function linkDialog(el) {
  const sel = window.getSelection();
  const range = sel.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  // The link the whole selection is inside, if there is one (never the field itself, when the field is a link).
  const node = range ? range.commonAncestorContainer : null;
  const found = (node && node.nodeType === 1 ? node : node?.parentElement)?.closest('a');
  const link = found && found !== el && el.contains(found) ? found : null;
  if (!link && (!range || range.collapsed)) {
    setStatus(LINK_NEEDS_WORDS, 'idle');
    el.focus();
    return;
  }
  const copy = linkDialogCopy(link ? link.getAttribute('href') || '' : null);
  let then = null;   // what the chosen button does, once the dialog is away and the selection is back
  const back = () => {
    el.focus();
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    then?.();
  };
  const m = modal(`
    <h3>${copy.title}</h3>
    <label>Link to
      <input type="text" id="kiln-link-url" value="${escapeHtml(copy.value)}" placeholder="https://… or /page"
        autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <p class="kiln-dim">A web address, or a page of this site such as /about.</p>
    <div class="kiln-modal-actions">
      ${copy.remove ? '<button class="kiln-btn-ghost" id="kiln-link-remove">Remove link</button>' : ''}
      <button class="kiln-btn-ghost" data-close>Cancel</button>
      <button class="kiln-btn-publish" id="kiln-link-go">${copy.go}</button>
    </div>`, { onClose: back });
  m.classList.add('kiln-keeps-edit');   // a click in here is not a click away from the field
  const input = m.querySelector('#kiln-link-url');
  input.select();
  const finish = (fn) => { then = fn; m._kilnClose(); };
  const go = () => {
    const url = input.value;   // as typed: the field's sanitizer decides what stays, when the edit is kept
    if (!url) { input.focus(); return; }
    finish(() => { if (link) link.setAttribute('href', url); else document.execCommand('createLink', false, url); });
  };
  m.querySelector('#kiln-link-go').onclick = go;
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  const remove = m.querySelector('#kiln-link-remove');
  if (remove) remove.onclick = () => finish(() => link.replaceWith(...link.childNodes));
}

function removeToolbar() {
  const tb = document.getElementById('kiln-toolbar');
  if (!tb) return;
  tb._kilnVvOff?.();   // drop the visualViewport listeners the mobile pin added
  tb.remove();
  // A resize handle belongs to the toolbar that was just open. Its own
  // click-away never fires when the next click lands on a field (the field
  // stops the event), which left the handle stranded on the page.
  document.querySelectorAll('.kiln-img-handle').forEach(h => h.remove());
}

// The panel a dialog was opened over (opts.over), set aside until that dialog is put away.
let modalUnder = null;

/**
 * The editor's dialog. One at a time: opening one replaces the one that is
 * open. Except `opts.over`, for a dialog that tells the person something
 * about the panel they are in (the sign-in has ended): the panel is set aside
 * with everything typed into it and comes back, as it was, when the dialog is
 * put away. `opts.onClose` runs when the dialog is put away.
 */
function modal(bodyHtml, opts = {}) {
  let open = document.getElementById('kiln-modal');
  if (opts.over && open?.dataset.over) { open._kilnClose(); open = document.getElementById('kiln-modal'); }   // a second look at the same thing
  if (opts.over && open) {
    modalUnder = open;
    open.id = 'kiln-modal-under';
    open.style.display = 'none';
  } else if (!opts.over) {
    // Put a dialog that was over a panel away properly first, so that it leaves nothing behind.
    if (open?.dataset.over) { open._kilnClose(); open = document.getElementById('kiln-modal'); }
    open?.remove();
    modalUnder?.remove();
    modalUnder = null;
  }
  const wrap = document.createElement('div');
  wrap.id = 'kiln-modal';
  if (opts.over) wrap.dataset.over = '1';
  wrap.innerHTML = `<div class="kiln-modal-card" role="dialog" aria-modal="true" tabindex="-1">`
    + `<button class="kiln-modal-x" data-close aria-label="Close">✕</button>`
    + `<div class="kiln-modal-body">${bodyHtml}</div></div>`;
  const close = () => {
    const shown = wrap.isConnected;
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
    if (!shown) return;
    if (opts.over && modalUnder && !document.getElementById('kiln-modal')) {
      if (modalUnder.isConnected) { modalUnder.id = 'kiln-modal'; modalUnder.style.display = ''; }
      modalUnder = null;
    }
    opts.onClose?.();
  };
  wrap._kilnClose = close;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  // Esc closes; Tab is trapped inside the dialog so keyboard focus can't wander
  // onto the page behind it.
  const onKey = (e) => {
    if (wrap.id !== 'kiln-modal') return;   // set aside under another dialog: that one has the keyboard
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...wrap.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(wrap);
  (wrap.querySelector('input') || wrap.querySelector('.kiln-modal-card')).focus();
  return wrap;
}

function refreshPublishButton() {
  // The number of things the publish sheet lists: every change to a list is one, as every edit to a field is.
  const n = changeCount();
  // A queued upload with no field edit still needs a Publish to commit it.
  const anything = n || state.pendingBinaries.size || state.pendingStructural.length;
  const btn = document.getElementById('kiln-publish');
  // The same action, always in sight beside the pencil while something is unpublished.
  const quick = document.getElementById('kiln-publish-quick');
  if (mode === 'editor' && state.scope?.mode === 'review') {
    if (btn) btn.hidden = true;
    if (quick) quick.hidden = true;
    const d = document.getElementById('kiln-draft');
    if (d) d.hidden = true;
    return;
  }
  // Suggest-mode editors propose — same button, honest label.
  const label = publishLabel(n, { suggest: isSuggestMode() });
  if (btn) {
    btn.disabled = !anything;
    btn.textContent = label;
    // A suggest-only editor on a page the site builds from content files has
    // nothing a suggestion can carry: the button is not in the menu there.
    btn.hidden = isSuggestMode() && !!state.page && !state.page.path && !anything;
  }
  if (quick) {
    quick.textContent = label;
    quick.hidden = !anything;
    quick.disabled = false;
    placeQuickRow();
  }
  const badge = document.getElementById('kiln-fab-badge');
  if (badge) { badge.hidden = !anything; badge.textContent = n || (state.pendingBinaries.size || state.pendingStructural.length ? '•' : ''); }
  // The whole "unpublished edits" group appears only when there's something to act on.
  const grp = document.getElementById('kiln-grp-edits');
  if (grp) grp.hidden = !anything;
  const discard = document.getElementById('kiln-discard');
  if (discard) discard.textContent = n ? `Discard ${n} edit${n > 1 ? 's' : ''}` : 'Discard edits';
  // Draft + Schedule + Share preview need actual PAGE edits (not just an uploaded
  // binary — and not source-file edits, which none of them can carry), and an
  // editor must be granted them (dataset.gated set by applyFeatureGating).
  const nHtml = state.pending.size;
  const sched = document.getElementById('kiln-schedule');
  if (sched) sched.style.display = (nHtml && !sched.dataset.gated) ? '' : 'none';
  const draftBtn = document.getElementById('kiln-draft');
  if (draftBtn) draftBtn.style.display = (nHtml && !draftBtn.dataset.gated) ? '' : 'none';
  const shareBtn = document.getElementById('kiln-sharepreview');
  if (shareBtn) shareBtn.style.display = (nHtml && !shareBtn.dataset.gated) ? '' : 'none';
  savePendingToStorage();
  guideSync();   // the demo guide follows the page's state (a no-op anywhere else)
}

function disablePublish(yes) {
  const off = yes || !(state.pending.size || state.pendingSource.size);
  for (const id of ['kiln-publish', 'kiln-publish-quick']) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = off;
  }
}

/**
 * How far down the screen the site's own bars reach from the top: a header it
 * keeps there, and at the top of the page a banner or an announcement over it
 * (under-bar.js isSiteBar).
 */
function siteBarsBottom() {
  const screen = { width: window.innerWidth, height: window.innerHeight, atTop: window.scrollY < 4 };
  let from = 0;
  for (let i = 0; i < 5; i++) {
    const at = document.elementsFromPoint(Math.round(screen.width / 2), from + 10).find(e => !isKilnChrome(e) && e !== document.documentElement && e !== document.body);
    let reach = 0;
    for (let n = at; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const r = n.getBoundingClientRect(), pos = getComputedStyle(n).position;
      if (isSiteBar({ top: r.top, bottom: r.bottom, width: r.width, pinned: pos === 'fixed' || pos === 'sticky', named: n.matches('header, nav, [role="banner"]') }, from, screen)) reach = Math.max(reach, r.bottom);
    }
    if (reach <= from) break;
    from = reach;
  }
  return Math.round(from);
}

/** On a phone the line of words goes below the site's own bars: it used to lie on the site's logo. */
function placeStatus() {
  const el = document.getElementById('kiln-status');
  if (!el || el.hidden || !isMobileEditor() || el.closest('#kiln-topbar')) return;
  el.style.setProperty('--kiln-under', `${siteBarsBottom()}px`);
  if (statusPlaced) return;
  statusPlaced = true;
  let frame = 0;
  window.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; placeStatus(); }); }, { passive: true });
}

function setStatus(text, kind, opts) {
  const el = document.getElementById('kiln-status');
  if (!el) return;
  // "Published. Undo" keeps the line for its ten seconds. News that arrives
  // meanwhile is shown when it ends; a failure is shown at once.
  if (undoOffer && !opts?.offer) {
    if (kind !== 'error') { undoOffer.held = [text, kind, opts]; return; }
    endUndoOffer(false);
  }
  // A spinner rides alongside busy ('saving') states so publishing/uploading
  // reads as active work, not a frozen label. opts.href turns the whole line
  // into a link (e.g. "Live ✓ — view site", "Build failed — open commit").
  el.innerHTML = (kind === 'saving' ? '<span class="kiln-spin" aria-hidden="true"></span>' : '')
    + (opts?.href
      ? `<a class="kiln-status-link" href="${escapeHtml(opts.href)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`
      : `<span>${escapeHtml(text)}</span>`)
    + (opts?.action ? `<button type="button" class="kiln-status-act" title="${escapeHtml(opts.action.title || '')}">${escapeHtml(opts.action.label)}</button>` : '');
  if (opts?.action) el.querySelector('.kiln-status-act').onclick = (e) => { e.stopPropagation(); opts.action.run(); };
  el.className = `kiln-status kiln-status--${kind}${opts?.action ? ' kiln-status--act' : ''}`;
  if (opts?.tag) el.dataset.tag = opts.tag; else delete el.dataset.tag;
  el.hidden = false;
  statusShown++;
  placeStatus();
  clearTimeout(statusHideTimer);
  if (opts?.signIn) { signInLine = [text, kind, opts]; return; }
  if (signInLine && !opts?.offer) { statusHideTimer = setTimeout(() => setStatus(...signInLine), 6000); return; }
  if (opts?.sticky) return;
  // Busy/error states stay visible; calm states fade away on their own. On a
  // phone the toast sits over the top of the page, so it leaves sooner. A line
  // with something to press says how long it stays (opts.hold).
  if (kind === 'idle' || kind === 'saved') {
    statusHideTimer = setTimeout(() => { el.hidden = true; }, opts?.hold || (isMobileEditor() ? 4000 : 6000));
  }
}

// ─── Crash-proof pending edits ───────────────────────────────────────────────

function pendingStorageKey() {
  return `kiln_pending:${cfg.repo}:${state.page?.path || location.pathname}`;
}

function savePendingToStorage() {
  // Not before the restore offer has read what an earlier visit left. An
  // invited editor's first presence answer refreshes the Publish button during
  // boot, with nothing staged yet, and that used to erase the saved edits
  // before they could be offered back.
  if (!keptReady) return;
  syncKeptFiles();
  try {
    // Edits to the page's own fields, and to the content files of a generated page.
    const record = draftRecord(state.pending, state.pendingSource, Date.now(), state.typed);
    if (!record) { localStorage.removeItem(pendingStorageKey()); return; }
    localStorage.setItem(pendingStorageKey(), JSON.stringify(record));
  } catch {
    // No room for the copy. An older copy left in its place would hold room for edits that may be gone: remove it.
    try { localStorage.removeItem(pendingStorageKey()); } catch { /* storage blocked */ }
  }
}

function clearSavedPending() {
  try { localStorage.removeItem(pendingStorageKey()); } catch { /* ignore */ }
  keptHere.clear();
  if (keptReady && !cfg.sandbox) forgetFiles(pendingStorageKey()).catch(() => {});
}

// Uploads waiting for Publish are kept beside the saved edits (pending-files.js),
// so "Pick up where you left off?" brings the pictures back too.
const keptHere = new Set();   // repo paths this page load has written to the browser's store
let keptReady = false;        // true once offerPendingRestore has read what an earlier visit left

/** Make what is kept match what is queued. With no edits staged, a queued file is an orphan: keep none. */
function syncKeptFiles() {
  if (!keptReady || cfg.sandbox) return;
  const page = pendingStorageKey();
  const queued = state.pending.size ? [...state.pendingBinaries.keys()] : [];
  const { add, remove } = syncPlan(queued, [...keptHere]);
  for (const path of add) {
    keptHere.add(path);
    keepFile(page, path, state.pendingBinaries.get(path)).catch(() => keptHere.delete(path));
  }
  if (remove.length) {
    for (const path of remove) keptHere.delete(path);
    forgetFiles(page, remove).catch(() => {});
  }
}

/** If the tab crashed/closed with staged edits, offer to bring them back. */
function offerPendingRestore() {
  // Read the uploads an earlier visit left before anything here can tidy them away.
  const kept = cfg.sandbox ? Promise.resolve([]) : keptFiles(pendingStorageKey()).catch(() => []);
  keptReady = true;
  // Back from "Sign in again" in this tab: the edits are put back without asking.
  let back = false;
  try { back = sessionStorage.getItem(BACK_KEY) === '1'; sessionStorage.removeItem(BACK_KEY); } catch { /* private mode */ }
  let saved, ts;
  try {
    const stored = JSON.parse(localStorage.getItem(pendingStorageKey()));
    // A content-file edit comes back only to a field that is on this page and can be edited now.
    saved = readDraft(stored, { known: (ref) => !!state.sourceFields?.get(ref)?.els.some(el => el.classList.contains('kiln-source-field') && !el.classList.contains('kiln-source-locked')) });
    ts = stored?.ts;
  } catch { return; }
  if (!saved) return;
  // The demo starts over after a day, and what was not published goes with it.
  if (cfg.sandbox && Date.now() - ts > SANDBOX_TTL) { clearSavedPending(); return; }
  if (back) { restoreSaved(saved, kept, true); return; }
  const names = [...Object.keys(saved.edits).map(readableName), ...Object.keys(saved.source).map(sourceName)];
  const when = new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // What was being typed when a sign-in ended (a comment, a note, a time) is offered back with the edits, or on its own.
  const typedName = saved.typed ? TYPED[saved.typed.where] : '';
  let answered;
  restoreAsked = new Promise((resolve) => { answered = resolve; });
  const m = modal(`
    <h3>Pick up where you left off?</h3>
    <p class="kiln-dim">${saved.count ? `You have ${saved.count} unpublished edit${saved.count > 1 ? 's' : ''} from
    ${when}
    on this page (${names.map(escapeHtml).join(', ')})${typedName ? `, and ${typedName}` : ''}.` : `${typedName.charAt(0).toUpperCase() + typedName.slice(1)} from ${when} is saved in this browser.`}</p>
    <div class="kiln-modal-actions">
      <button class="kiln-btn-ghost" id="kiln-rest-no">${saved.count ? 'Discard them' : 'Discard it'}</button>
      <button class="kiln-btn-publish" id="kiln-rest-yes">${saved.count ? 'Restore edits' : 'Bring it back'}</button>
    </div>`, { onClose: () => answered() });
  m.querySelector('#kiln-rest-no').onclick = () => { clearSavedPending(); m.remove(); answered(); };
  m.querySelector('#kiln-rest-yes').onclick = async () => { await restoreSaved(saved, kept, false); m.remove(); answered(); };
}

/** Put saved edits (what readDraft gives) back on the page, staged as they were. `kept` resolves to the uploads kept beside them. */
async function restoreSaved(saved, kept, signedInAgain) {
  // The pictures and files those edits added: queue them again, and show each
  // picture from the kept bytes (its address on the site does not exist yet).
  const files = filesToRestore(await kept, saved.edits);
  for (const f of files) { state.pendingBinaries.set(f.path, f.base64); keptHere.add(f.path); }
  for (const [key, edit] of Object.entries(saved.edits)) {
    const target = elementForKey(key);
    if (target && !state.pending.has(key)) beginKey(key, target);   // what Undo goes back to: the part before these edits
    state.pending.set(key, edit);
    const esc = CSS.escape(key);
    // applyKeyDom handles BOTH plain fields and repeat containers (re-wiring the
    // repeat). The old code skipped repeats, so the DOM showed the un-restored
    // content while Publish committed the restored html — publishing what wasn't
    // previewed. Also restore attr edits (href/src/style), which were dropped.
    if (edit.html !== undefined) applyKeyDom(key, edit.html);
    if (edit.attrs) {
      document.querySelectorAll(`[data-cms="${esc}"]`).forEach(n => {
        for (const [a, v] of Object.entries(edit.attrs)) {
          if (v === undefined || v === null) continue;
          if (a === 'style') showStyle(n, v); else n.setAttribute(a, v);
        }
      });
    }
    document.querySelectorAll(`[data-cms="${esc}"], [data-cms-repeat="${esc}"]`)
      .forEach(n => n.classList.add('kiln-modified'));
  }
  for (const f of files) {
    const url = siteAddress(f.path, cfg.root || '');
    const ext = (f.path.split('.').pop() || '').toLowerCase();
    if (!/^(png|jpe?g|webp|avif|gif)$/.test(ext)) continue;
    let preview = null;
    for (const img of document.querySelectorAll('img')) {
      if (img.closest(KILN_CHROME) || img.getAttribute('src') !== url) continue;
      if (!preview) {
        try { preview = URL.createObjectURL(new Blob([Uint8Array.from(atob(f.base64), c => c.charCodeAt(0))], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` })); }
        catch { break; }
      }
      img.setAttribute('data-kiln-src', url);
      img.src = preview;
    }
  }
  // Edits to content files: staged again, and shown in every place the value appears.
  for (const [ref, entry] of Object.entries(saved.source)) {
    state.pendingSource.set(ref, entry);
    syncSourceDom(ref);
  }
  refreshPublishButton();   // also rewrites the saved copy from what is staged: what was typed is taken out of it here
  const typedName = saved.typed ? resumeTyped(saved.typed) : '';
  if (signedInAgain) setStatus(backAfterSignIn(saved.count, files.length, typedName), 'saved');
  else if (saved.count) setStatus(`${saved.count} edit${saved.count > 1 ? 's' : ''} restored${files.length ? ', with the files they added' : ''} — Publish when ready`, 'saved');
}

// What was typed into a panel is put back where it was typed: the panel is
// opened again with the words in it. Once the editor has finished starting
// (comments are set up after the saved edits are read).
let startedUp = false;
const onceStarted = [];
/** Put back what the saved copy held of a panel (saved-edits.js `typed`). Returns how the sentences call it. */
function resumeTyped(typed) {
  const open = {
    comment: () => resumeComment(typed),
    reply: () => resumeComment(typed),
    note: () => { keptNote = typed.text; },
    schedule: () => schedulePanel(typed.at),
    version: () => historyPanel({ sha: typed.sha, name: typed.text }),
  }[typed.where];
  if (startedUp) open(); else onceStarted.push(open);
  return TYPED[typed.where];
}
// The line typed under "What changed?" for a publish or a suggestion that was stopped: back in its box the next time it opens.
let keptNote = '';

function escapeHtml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * Neutralize dangerous URL schemes on href/src values. Attribute edits bypass
 * DOMPurify, so this is the gate. Allows relative/anchor/query URLs and the
 * http:, https:, mailto:, tel: schemes; everything else (javascript:, data:,
 * vbscript:, obfuscated "java\tscript:", …) collapses to a harmless '#'.
 */
function safeUrl(value) {
  const v = String(value);
  // Strip control + whitespace chars so "java\tscript:" can't slip past the scheme test.
  const stripped = v.replace(/[\u0000-\u001f\u007f ]/g, '');
  // Relative paths, anchors, query strings, and bare fragments are always fine.
  if (stripped === '' || /^[\/#.?]/.test(stripped)) return v;
  const scheme = stripped.match(/^[a-z][a-z0-9+.-]*:/i);
  if (!scheme) return v; // no scheme at all (e.g. "page.html") — relative, allow
  return /^(https?|mailto|tel):$/i.test(scheme[0]) ? v : '#';
}

function injectStyles() {
  // How a section the editor adds looks on a site with no styles of its own for
  // it (the visitor's script carries the same rules). First in the head, so
  // any rule of the site's own comes later.
  const added = document.createElement('style');
  added.setAttribute('data-kiln', '1');
  added.textContent = ADDED_CSS;
  document.head.insertBefore(added, document.head.firstChild);
  const style = document.createElement('style');
  // Marked so block previews can collect the SITE's styles without dragging
  // Kiln's own chrome CSS into the preview iframes.
  style.setAttribute('data-kiln', '1');
  style.textContent = `
/* The editor's dark surfaces (menu, toolbars, search, bars, the line of words)
   are all this colour. It was see-through enough to need the blur behind it:
   where a browser does not draw the blur, the page's own words showed sharply
   through a menu. It is solid enough to read on its own now, and the blur,
   where it is drawn, only softens the little that is left. */
:root{--kiln-bg:rgba(16,16,25,.985);--kiln-accent:#6366f1;--kiln-accent-h:#4f46e5;--kiln-ok:#34d399;
  --kiln-warn:#fbbf24;--kiln-err:#f87171;--kiln-font:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif}
#kiln-fab-wrap{position:fixed;bottom:20px;right:20px;z-index:999999;font-family:var(--kiln-font)}
/* Undo / Redo / Publish: one row above the pencil, right-aligned to it. An
   absolute box inside the 48px wrapper would shrink to its narrowest, so it is
   sized to its content. placeQuickRow() flips it when the pencil has been
   dragged to an edge that leaves the row no room. */
#kiln-quick{position:absolute;right:0;bottom:58px;display:flex;align-items:center;justify-content:flex-end;gap:6px;width:max-content}
.kiln-flip-x #kiln-quick{right:auto;left:0}
.kiln-flip-y #kiln-quick{bottom:auto;top:58px}
/* The open menu has Publish as its first item; the row would only sit on it. */
.kiln-menu-open #kiln-quick{display:none}
#kiln-fab-wrap #kiln-undo-wrap{display:flex;flex-direction:row;gap:6px}
#kiln-fab-wrap #kiln-undo-wrap[hidden]{display:none!important}
#kiln-publish-quick{height:36px;padding:0 18px;border-radius:999px;border:none;cursor:pointer;background:var(--kiln-accent);
  color:#fff;box-shadow:0 3px 12px rgba(79,70,229,.45);font:600 13.5px var(--kiln-font);white-space:nowrap;transition:background .13s}
#kiln-publish-quick:hover:not(:disabled){background:var(--kiln-accent-h)}
#kiln-publish-quick:disabled{opacity:.55;cursor:default}
#kiln-publish-quick[hidden]{display:none!important}
/* The menu's own Publish, for someone who cannot publish or suggest here: the
   item's display above would otherwise beat the hidden attribute. */
#kiln-publish[hidden]{display:none!important}
#kiln-fab:focus-visible,#kiln-publish-quick:focus-visible,#kiln-fab-wrap #kiln-undo-wrap button:focus-visible{
  outline:2px solid #fff;outline-offset:2px;box-shadow:0 0 0 5px var(--kiln-accent)}
#kiln-fab-wrap #kiln-undo-wrap button{height:32px;padding:0 13px;border-radius:999px;border:none;cursor:pointer;
  background:#fff;color:#374151;box-shadow:0 3px 12px rgba(0,0,0,.18);display:inline-flex;align-items:center;gap:6px;
  font:600 12.5px var(--kiln-font);white-space:nowrap;transition:all .13s}
#kiln-fab-wrap #kiln-undo-wrap button:hover:not(:disabled){background:#eef2ff;color:var(--kiln-accent)}
/* Solid, not see-through: the row floats over the page, and a faded pill let
   whatever was under it show through the label. */
#kiln-fab-wrap #kiln-undo-wrap button:disabled{color:#c7c9d4;cursor:default;box-shadow:0 3px 12px rgba(0,0,0,.1)}
#kiln-topbar #kiln-undo-wrap{display:inline-flex;gap:4px}
#kiln-topbar #kiln-undo-wrap[hidden]{display:none!important}
#kiln-topbar #kiln-undo-wrap button:disabled{opacity:.35}
#kiln-fab{position:relative;width:48px;height:48px;border-radius:50%;border:none;cursor:grab;
  background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;display:flex;align-items:center;
  justify-content:center;box-shadow:0 6px 24px rgba(79,70,229,.45),0 2px 6px rgba(0,0,0,.2);
  transition:transform .15s,box-shadow .15s;touch-action:none}
#kiln-fab:hover{transform:scale(1.07);box-shadow:0 8px 30px rgba(79,70,229,.55)}
#kiln-fab:active{cursor:grabbing}
#kiln-fab-badge{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;
  background:var(--kiln-warn);color:#1c1300;font-size:11px;font-weight:700;display:flex;
  align-items:center;justify-content:center;padding:0 5px;box-shadow:0 1px 4px rgba(0,0,0,.3)}
#kiln-fab-badge[hidden]{display:none!important}
#kiln-fab-menu[hidden]{display:none!important}
#kiln-fab-menu{position:absolute;width:230px;background:var(--kiln-bg);-webkit-backdrop-filter:blur(16px);
  backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:8px 8px 0;
  box-shadow:0 18px 50px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:3px;
  /* a full menu is taller than a small laptop's screen: it scrolls inside itself, never off the screen */
  max-height:calc(100vh - 16px);overflow-y:auto;box-sizing:border-box;overscroll-behavior:contain;scroll-padding-bottom:48px}
.kiln-fab-head{display:flex;align-items:center;gap:8px;padding:6px 10px 8px}
.kiln-brand{font-weight:700;letter-spacing:.02em;font-size:14px;
  background:linear-gradient(135deg,#a5b4fc,#818cf8);-webkit-background-clip:text;background-clip:text;color:transparent}
.kiln-user{color:#9ca3af;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kiln-fab-item{display:block;width:100%;text-align:left;background:none;border:none;color:#d6d8e1;
  padding:9px 10px;border-radius:9px;cursor:pointer;font-size:13px;font-family:var(--kiln-font);transition:background .12s}
.kiln-fab-item:hover{background:rgba(255,255,255,.08);color:#fff}
.kiln-fab-item:focus-visible,.kiln-fab-foot button:focus-visible{outline:2px solid var(--kiln-accent);outline-offset:-2px;color:#fff}
.kiln-fab-group{display:flex;flex-direction:column;gap:2px;border-top:1px solid rgba(255,255,255,.07);margin-top:4px;padding-top:5px}
.kiln-fab-group[hidden]{display:none}
.kiln-fab-label{font:600 9.5px var(--kiln-font);letter-spacing:.09em;text-transform:uppercase;color:#6b7280;padding:2px 10px 4px}
.kiln-fab-danger{color:#f9a8a8}
.kiln-fab-danger:hover{background:rgba(248,113,113,.16);color:#fff}
.kiln-fab-primary{background:var(--kiln-accent);color:#fff;font-weight:600;text-align:center}
.kiln-fab-primary:hover{background:var(--kiln-accent-h);color:#fff}
.kiln-fab-primary:disabled{opacity:.4;cursor:default;background:rgba(255,255,255,.08);color:#9ca3af;font-weight:500}
.kiln-fab-foot{display:flex;justify-content:space-between;border-top:1px solid rgba(255,255,255,.08);
  margin:4px -8px 0;padding:6px 8px 8px;
  /* stays in sight while a long menu scrolls: the way out is never below the
     fold. The menu has no padding under it (the foot carries it), so no item
     shows through a strip beneath the foot. */
  position:sticky;bottom:0;background:rgb(20,20,31);border-radius:0 0 16px 16px}
.kiln-fab-foot button{background:none;border:none;color:#8b8e9c;font-size:11.5px;cursor:pointer;
  padding:5px 8px;border-radius:7px;font-family:var(--kiln-font)}
.kiln-fab-foot button:hover{color:#fff;background:rgba(255,255,255,.07)}
.kiln-status{position:absolute;right:56px;top:50%;transform:translateY(-50%);box-sizing:border-box;
  background:var(--kiln-bg);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  color:#d6d8e1;font-size:12px;line-height:1.4;padding:8px 13px;border-radius:11px;border:1px solid rgba(255,255,255,.09);
  box-shadow:0 6px 22px rgba(0,0,0,.3);width:max-content;max-width:min(460px,70vw)}
.kiln-flip-x .kiln-status{right:auto;left:56px}
.kiln-status{display:flex;align-items:center;gap:8px}
/* display:flex above would otherwise beat the hidden attribute, and the pill
   would never leave on a site whose own CSS does not reset [hidden]. */
.kiln-status[hidden]{display:none!important}
.kiln-status--saving{color:var(--kiln-warn)}
.kiln-spin{flex:none;width:13px;height:13px;border-radius:50%;border:2px solid rgba(251,191,36,.3);
  border-top-color:var(--kiln-warn);animation:kilnspin .7s linear infinite}
@keyframes kilnspin{to{transform:rotate(360deg)}}
.kiln-status--saved{color:var(--kiln-ok)}
.kiln-status--error{color:var(--kiln-err)}
.kiln-status-link{color:inherit;font-weight:600;text-decoration:underline;text-underline-offset:2px}
.kiln-status-link:hover{opacity:.85}
/* "Published. Undo": the one status line with something to press. */
.kiln-status--act{padding:6px 6px 6px 14px;gap:12px;font-size:13px;font-weight:600;color:#fff}
.kiln-status-act{flex:none;background:#fff;color:#1c1c28;border:none;border-radius:8px;padding:6px 14px;
  font:700 12.5px var(--kiln-font);cursor:pointer}
.kiln-status-act:hover,.kiln-status-act:focus-visible{background:#e0e7ff;outline:2px solid var(--kiln-accent);outline-offset:1px}
.kiln-btn-publish{background:var(--kiln-accent);color:#fff;border:none;padding:7px 16px;border-radius:9px;
  cursor:pointer;font-size:13px;font-weight:600;font-family:var(--kiln-font);transition:background .15s,transform .1s}
.kiln-btn-publish:hover:not(:disabled){background:var(--kiln-accent-h);transform:translateY(-1px)}
.kiln-btn-publish:disabled{opacity:.35;cursor:default}
.kiln-btn-ghost{background:rgba(255,255,255,.06);color:#c7c9d4;border:1px solid rgba(255,255,255,.1);
  padding:6px 12px;border-radius:9px;cursor:pointer;font-size:12.5px;font-family:var(--kiln-font);
  white-space:nowrap;transition:all .15s}
.kiln-btn-ghost:hover{color:#fff;background:rgba(255,255,255,.12)}
.kiln-field{cursor:pointer;outline:2px dashed var(--kiln-rest,transparent);outline-offset:4px;border-radius:4px;transition:outline-color .15s}
.kiln-field:hover{outline-color:rgba(99,102,241,.75)}
/* When editing starts every field shows its outline for a moment, then settles
   back (revealFields). A touch screen has no hover to find them with, so there
   a faint outline stays. */
.kiln-reveal .kiln-field:not(.kiln-editing):not(.kiln-modified){animation:kilnreveal 2.1s ease-out both}
@keyframes kilnreveal{0%,70%{outline-color:rgba(99,102,241,.75)}100%{outline-color:var(--kiln-rest,transparent)}}
@media(hover:none){:root{--kiln-rest:rgba(99,102,241,.32)}}
@media(prefers-reduced-motion:reduce){
  .kiln-reveal .kiln-field:not(.kiln-editing):not(.kiln-modified){animation:none;transition:none;outline-color:rgba(99,102,241,.75)}
}
.kiln-field.kiln-editing{outline:2px solid var(--kiln-accent);cursor:text;padding:2px 4px;min-width:40px}
.kiln-field.kiln-modified{outline:2px solid var(--kiln-warn)}
img.kiln-field:hover{outline-style:solid;filter:brightness(.9)}
/* Source-mode fields (data-kiln-source) ride the kiln-field affordances; a
   locked one (old worker / malformed ref / image type) reads as untouchable. */
.kiln-source-locked{cursor:not-allowed;outline:2px dashed transparent;outline-offset:4px;border-radius:4px;transition:outline-color .15s}
.kiln-source-locked:hover{outline-color:rgba(156,163,175,.85)}
/* A formatted text being edited: the parts kept as the file has them (a table, code, a component) take no typing, and look it. */
.kiln-source-rich.kiln-editing [data-kiln-keep^="b"]{cursor:not-allowed;outline:1px dashed rgba(156,163,175,.9);outline-offset:3px;border-radius:4px;user-select:none}
/* §12 build-failed banner: per-file one-click revert. */
#kiln-notices{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999998;display:flex;flex-direction:column;
  align-items:center;gap:8px;box-sizing:border-box;max-width:92vw;pointer-events:none}
#kiln-notices>*{pointer-events:auto;flex:none;box-sizing:border-box}
#kiln-srcfail{display:flex;
  flex-direction:column;gap:8px;background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  color:#d6d8e1;font:13px/1.45 var(--kiln-font);padding:12px 16px;border-radius:13px;
  border:1px solid rgba(248,113,113,.5);box-shadow:0 12px 40px rgba(0,0,0,.4);max-width:min(560px,92vw)}
#kiln-srcfail strong{color:var(--kiln-err)}
.kiln-srcfail-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.kiln-srcfail-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:#fff}
#kiln-srcfail .kiln-btn-ghost{white-space:nowrap}
#kiln-srcfail-x{align-self:flex-end}
/* What a publish left out, and why: under the failed-build banner when both are up (they share #kiln-notices). */
#kiln-srcskip{display:flex;
  flex-direction:column;gap:8px;background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  color:#d6d8e1;font:13px/1.45 var(--kiln-font);padding:12px 16px;border-radius:13px;box-sizing:border-box;
  border:1px solid rgba(251,191,36,.5);box-shadow:0 12px 40px rgba(0,0,0,.4);width:max-content;max-width:min(560px,92vw);
  max-height:60vh;overflow-y:auto}
#kiln-srcskip strong{color:var(--kiln-warn)}
.kiln-srcskip-row{display:flex;flex-direction:column;gap:1px}
.kiln-srcskip-row .kiln-status-link{background:none;border:0;padding:0;font:600 13px/1.4 var(--kiln-font);color:#fff;text-align:left;cursor:pointer;text-decoration:underline}
#kiln-srcskip-x{align-self:flex-end}
.kiln-flash{animation:kilnflash 1.4s ease}
@keyframes kilnflash{0%{outline:3px solid var(--kiln-ok);outline-offset:6px}100%{outline:3px solid transparent;outline-offset:4px}}
#kiln-toolbar{position:absolute;background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  color:#fff;padding:7px 9px;border-radius:12px;display:flex;align-items:center;gap:6px;
  font-family:var(--kiln-font);font-size:12px;z-index:999999;border:1px solid rgba(255,255,255,.08);
  box-shadow:0 10px 32px rgba(0,0,0,.35);flex-wrap:wrap;max-width:92vw}
.kiln-tb-label{color:#8b8e9c;margin-right:2px;font-size:11px}
.kiln-tb-hint{color:#8b8e9c;font-size:11px;font-style:italic}
#kiln-toolbar{cursor:grab;touch-action:none}
#kiln-pickbar,#kiln-cmt-hint{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999998;display:flex;
  align-items:center;gap:14px;background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  color:#d6d8e1;font:13px/1.45 var(--kiln-font);padding:10px 16px;border-radius:13px;
  border:1px solid rgba(255,255,255,.1);box-shadow:0 12px 40px rgba(0,0,0,.4);max-width:92vw}
#kiln-pickbar strong{color:#fff}
#kiln-pickbar .kiln-pick-cancel{background:rgba(255,255,255,.14)}
/* Advice about keys is for a keyboard: not shown on a screen that is touched. */
@media (hover:none){.kiln-keys-only{display:none!important}}
/* Help under a box in People & access: small, but not tiny, and dark enough to read. */
.kiln-p-hint{margin:-2px 0 8px!important;font-size:13px!important;line-height:1.45;color:#4b5563!important}
#kiln-pickbar kbd,#kiln-cmt-hint kbd{background:rgba(255,255,255,.12);border-radius:4px;padding:1px 5px;font-size:11px}
#kiln-pickbar button,#kiln-cmt-hint button{background:var(--kiln-accent);color:#fff;border:none;border-radius:8px;
  padding:6px 14px;font:600 12px var(--kiln-font);cursor:pointer;white-space:nowrap}
/* Restore-preview bar: in the column of bars (#kiln-notices); the page shows the
   older version behind it until Keep or Cancel. */
#kiln-previewbar{display:flex;
  align-items:center;gap:12px;background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  color:#d6d8e1;font:13px/1.45 var(--kiln-font);padding:10px 16px;border-radius:13px;
  border:1px solid rgba(255,255,255,.1);box-shadow:0 12px 40px rgba(0,0,0,.4);max-width:92vw}
#kiln-previewbar strong{color:#fff}
#kiln-previewbar small{display:block;color:#9ca3af;font-size:11.5px}
#kiln-previewbar .kiln-btn-publish{white-space:nowrap}
.kiln-hist-row{flex-wrap:wrap}
.kiln-hist-acts{display:flex;gap:6px;flex:none}
.kiln-hist-acts .kiln-btn-ghost,.kiln-cmt-thread .kiln-btn-ghost{font-size:11.5px;padding:5px 10px;white-space:nowrap}
/* Ghost buttons are styled for the dark menu — inside white modals (history
   rows) they were almost invisible. Give them real contrast there. */
.kiln-modal-body .kiln-inv-row .kiln-btn-ghost,.kiln-modal-body .kiln-hist-acts .kiln-btn-ghost,.kiln-cmt-thread .kiln-btn-ghost{
  color:#1f2937;background:#f3f4f6;border:1px solid #cfd4db;font-weight:600}
.kiln-modal-body .kiln-inv-row .kiln-btn-ghost:hover,.kiln-modal-body .kiln-hist-acts .kiln-btn-ghost:hover,.kiln-cmt-thread .kiln-btn-ghost:hover{
  color:#fff;background:var(--kiln-accent);border-color:var(--kiln-accent)}
.kiln-hist-live{color:#059669;font-weight:700}
.kiln-pick-hover{outline:2px dashed #34d399!important;outline-offset:3px;cursor:copy!important}
.kiln-spot-hover{outline:2px dashed var(--kiln-accent)!important;outline-offset:4px;cursor:copy!important;position:relative}
.kiln-spot-hover::after{content:"new section goes here ↓";position:absolute;left:50%;bottom:-14px;transform:translateX(-50%);
  z-index:999999;background:var(--kiln-accent);color:#fff;font:600 12px var(--kiln-font);padding:4px 12px;border-radius:999px;white-space:nowrap}
.kiln-pick-hover[data-cms],.kiln-pick-hover[data-cms-repeat],.kiln-pick-hover[data-cms-menu]{outline-color:#f87171!important;cursor:not-allowed!important}
.kiln-img-handle{position:absolute;width:22px;height:22px;border-radius:50%;background:var(--kiln-accent);
  border:2.5px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:nwse-resize;z-index:9999998;touch-action:none}
.kiln-img-handle::after{content:"";position:absolute;inset:5px;border-right:2px solid #fff;border-bottom:2px solid #fff;
  border-radius:0 0 2px 0}
.kiln-img-handle-on{transform:scale(1.15)}
#kiln-imgpop{position:absolute;background:var(--kiln-bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  color:#fff;padding:6px 8px;border-radius:11px;display:flex;align-items:center;gap:5px;
  font-family:var(--kiln-font);font-size:12px;z-index:9999999;border:1px solid rgba(255,255,255,.08);
  box-shadow:0 10px 32px rgba(0,0,0,.35)}
#kiln-toolbar.kiln-tb-dragging{cursor:grabbing;opacity:.92}
.kiln-tb-grip{color:#6b7280;font-size:13px;line-height:1;padding:2px 1px;cursor:grab;user-select:none}
#kiln-toolbar.kiln-tb-dragging .kiln-tb-grip{cursor:grabbing}
.kiln-tb-gap{flex:0 0 2px;width:1px;height:18px;background:rgba(255,255,255,.12)}
.kiln-tb-fmt{background:rgba(255,255,255,.08);color:#e7e7ee;border:none;min-width:27px;height:26px;
  border-radius:7px;cursor:pointer;font-size:12px;display:inline-flex;align-items:center;justify-content:center;
  padding:0 6px;font-family:var(--kiln-font);transition:background .12s}
.kiln-tb-fmt:hover{background:rgba(99,102,241,.55)}
.kiln-tb-clear,.kiln-tb-attach{font-size:11.5px}
.kiln-href-input{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#fff;
  border-radius:7px;padding:5px 8px;font-size:12px;width:190px;font-family:var(--kiln-font)}
.kiln-href-input::placeholder{color:#6b7280}
.kiln-tb-save{background:var(--kiln-accent);color:#fff;border:none;padding:5px 12px;border-radius:7px;
  cursor:pointer;font-size:12px;font-weight:600;font-family:var(--kiln-font)}
.kiln-tb-save:hover{background:var(--kiln-accent-h)}
.kiln-tb-cancel{background:transparent;color:#8b8e9c;border:none;padding:5px 8px;cursor:pointer;
  font-size:12px;font-family:var(--kiln-font)}
.kiln-tb-cancel:hover{color:#fff}
.kiln-style-select{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:#fff;
  border-radius:7px;padding:4px 5px;font-size:12px;max-width:120px;font-family:var(--kiln-font)}
.kiln-style-select option,.kiln-style-select optgroup{color:#1c1c28}
#kiln-modal{position:fixed;inset:0;background:rgba(10,10,18,.45);-webkit-backdrop-filter:blur(6px);
  backdrop-filter:blur(6px);z-index:9999999;display:flex;align-items:flex-start;justify-content:center;
  padding-top:9vh;font-family:var(--kiln-font)}
.kiln-modal-card{position:relative;background:#fff;color:#1c1c28;border-radius:18px;max-width:500px;width:92%;
  box-shadow:0 24px 80px rgba(0,0,0,.3);max-height:86vh;overflow:hidden;display:flex;flex-direction:column}
/* The X lives on the (non-scrolling) card, so it stays pinned in the corner while
   the body scrolls underneath — previously it sat in the scroll area and vanished. */
.kiln-modal-x{position:absolute;top:12px;right:12px;z-index:3;width:30px;height:30px;border-radius:50%;
  border:none;background:#eceef1;color:#4b5563;font-size:14px;cursor:pointer;display:flex;align-items:center;
  justify-content:center;transition:all .13s;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.kiln-modal-x:hover{background:#dfe2e6;color:#111}
.kiln-modal-body{padding:24px;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0}
.kiln-modal-body h3{margin:0 0 14px;font-size:17px;font-weight:700;letter-spacing:-.01em;padding-right:34px}
.kiln-tabs{display:flex;gap:6px;margin:0 0 14px;border-bottom:1.5px solid #eef0f3}
.kiln-tab{background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1.5px;color:#6b7280;
  font:600 13px var(--kiln-font);padding:7px 10px;cursor:pointer}
.kiln-tab:hover{color:#111}
.kiln-tab-on{color:var(--kiln-accent);border-bottom-color:var(--kiln-accent)}
.kiln-hist-prev{color:#374151;font-size:13px}
.kiln-modal-body h4{margin:16px 0 8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af}
.kiln-modal-body label{display:block;font-size:13px;color:#4b5563;margin-bottom:10px}
.kiln-modal-body label[hidden]{display:none}
.kiln-modal-body input[type=text],.kiln-modal-body input[type=email],.kiln-modal-body input[type=number]{
  width:100%;box-sizing:border-box;padding:10px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;margin-top:4px;
  font-family:var(--kiln-font);transition:border-color .15s;outline:none}
.kiln-modal-body input:focus{border-color:var(--kiln-accent)}
.kiln-2col{display:grid;grid-template-columns:1.4fr 1fr;gap:10px}
@media(max-width:480px){.kiln-2col{grid-template-columns:1fr}
  .kiln-tb-fmt{min-width:34px;height:34px}
  #kiln-toolbar .kiln-href-input{width:100%}
  .kiln-item-ctl button{width:34px;height:34px}}
.kiln-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.kiln-modal-actions .kiln-btn-ghost{color:#4b5563;border-color:#e5e7eb;background:#f9fafb}
.kiln-modal-actions .kiln-btn-ghost:hover{color:#111;background:#f3f4f6}
.kiln-roles{display:flex;flex-direction:column;gap:8px;margin:10px 0}
.kiln-role{display:flex;gap:10px;align-items:flex-start;border:1.5px solid #e5e7eb;border-radius:12px;
  padding:11px;cursor:pointer;transition:all .15s}
.kiln-role:has(input:checked){border-color:var(--kiln-accent);background:#eef2ff}
.kiln-role small{color:#6b7280;line-height:1.45}
.kiln-summary{cursor:pointer;font-size:13px;color:#6b7280;padding:4px 0;font-weight:600}
.kiln-linkrow{display:flex;gap:8px;margin-top:8px}
.kiln-linkrow input{flex:1;font-size:12px;color:#374151}
.kiln-inv-ok{font-size:13px;color:#059669;margin-top:12px}
.kiln-hr{border:none;border-top:1px solid #f3f4f6;margin:18px 0 10px}
/* A clearly-clickable "pick from a list" button — the ghost style was too muted to read as an action. */
.kiln-btn-pick{display:inline-flex;align-items:center;gap:5px;margin-left:6px;padding:4px 11px;font:600 12px var(--kiln-font);
  color:var(--kiln-accent);background:#eef2ff;border:1.5px solid var(--kiln-accent);border-radius:8px;cursor:pointer;
  vertical-align:middle;transition:all .13s}
.kiln-btn-pick:hover{background:var(--kiln-accent);color:#fff}
.kiln-btn-pick[aria-expanded=true]{background:var(--kiln-accent);color:#fff}
/* Picker checklists sit INSIDE the scrolling modal body — no inner scroll (that made
   the dreaded scroll-within-a-scroll); the whole modal scrolls as one surface. */
.kiln-pick-box{margin:0 0 10px;border:1.5px solid #eef0f3;border-radius:10px;padding:4px 10px}
.kiln-pick-box .kiln-pick-group{font:700 11px var(--kiln-font);text-transform:uppercase;letter-spacing:.05em;
  color:#6b7280;margin:9px 0 3px;padding-top:8px;border-top:1px solid #f3f4f6}
.kiln-pick-box .kiln-pick-group:first-child{border-top:none;padding-top:2px;margin-top:4px}
.kiln-inv-list{display:flex;flex-direction:column;gap:6px}
.kiln-inv-row{display:flex;justify-content:space-between;align-items:center;border:1.5px solid #f3f4f6;
  border-radius:10px;padding:9px 12px;font-size:13px;gap:8px}
.kiln-inv-row small{color:#9ca3af;display:block;margin-top:1px}
.kiln-dim{color:#9ca3af;font-size:12px;margin-top:10px;line-height:1.5}
.kiln-np-step{font-size:13px;color:#4b5563;min-height:20px;line-height:1.5}
/* Suggestions: the review queue + the little open-count badge on its button. */
#kiln-sug-badge{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;
  border-radius:9px;background:var(--kiln-warn);color:#1c1300;font-size:10.5px;font-weight:700;
  padding:0 5px;margin-left:5px;vertical-align:1px}
#kiln-sug-badge[hidden]{display:none!important}
.kiln-sug-item{border:1.5px solid #f3f4f6;border-radius:10px;padding:2px 4px}
.kiln-sug-item .kiln-inv-row{border:none;padding:7px 8px}
.kiln-sug-actions{display:flex;gap:6px;align-items:center;flex:none}
.kiln-sug-actions .kiln-btn-publish{padding:6px 12px;font-size:12px}
.kiln-sug-err{color:#b91c1c;font-size:12px;margin:0 8px 8px;line-height:1.45}
.kiln-sug-diff{margin:0 8px 10px;border-top:1px solid #f3f4f6;padding-top:8px;font-size:12.5px;color:#374151}
.kiln-sug-cols{display:grid;grid-template-columns:110px 1fr 1fr;gap:4px 10px;padding:4px 0;align-items:baseline}
.kiln-sug-cols>span{overflow-wrap:anywhere}
.kiln-sug-colhead{font:700 10.5px var(--kiln-font);text-transform:uppercase;letter-spacing:.05em;color:#9ca3af}
.kiln-sug-before{color:#9ca3af;text-decoration:line-through;text-decoration-color:#fca5a5}
.kiln-sug-after{color:#065f46}
.kiln-sug-decided{margin-top:12px}
.kiln-sug-decided summary{cursor:pointer;font-size:12.5px;color:#6b7280;margin-bottom:6px}
.kiln-sug-decided .kiln-inv-row{margin-top:6px}
.kiln-sug-preview-link{word-break:break-all;font-size:13.5px;color:var(--kiln-accent)}
/* Theme panel: token rows grouped by kind. Value inputs stay compact — the
   global 100%-width modal input rule is overridden here. */
.kiln-th-src,.kiln-th-hint{font-size:11px;color:#9ca3af;margin:2px 2px 4px;line-height:1.45}
.kiln-th-row{display:flex;align-items:center;gap:10px;padding:6px 2px;border-bottom:1px solid #f3f4f6}
.kiln-th-name,.kiln-th-val{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kiln-th-name{flex:1;min-width:0;font:600 13px var(--kiln-font);color:#374151}
.kiln-th-raw{display:block;font:400 10.5px ui-monospace,Menlo,monospace;color:#9ca3af;overflow:hidden;text-overflow:ellipsis}
.kiln-th-swatch{flex:none;width:26px;height:26px;border-radius:8px;border:1px solid rgba(0,0,0,.14)}
.kiln-th-row input,.kiln-th-select{margin:0;border:1.5px solid #e5e7eb;border-radius:8px;background:#fff}
.kiln-th-row input[type=color]{flex:none;width:46px;height:30px;padding:1px 2px;cursor:pointer}
.kiln-th-row input[type=text]{flex:0 1 180px;width:180px;padding:7px 9px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace}
.kiln-th-select{flex:0 1 220px;max-width:220px;padding:7px 8px;font:12.5px var(--kiln-font);color:#1c1c28}
.kiln-th-val{flex:0 1 auto;max-width:230px;font:12px ui-monospace,Menlo,monospace;color:#9ca3af}
.kiln-th-example{background:#f6f7f9;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;font:12px/1.6 ui-monospace,Menlo,monospace;overflow-x:auto}
.kiln-repeat-item{position:relative}
/* The control bar stays INSIDE its block: on a narrow card (a two-column grid
   on a phone, a small gallery thumbnail) it wraps onto a second row instead of
   hanging out over the neighbouring block or off the edge of the screen. */
.kiln-item-ctl{position:absolute;top:8px;right:8px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px;
  max-width:calc(100% - 16px);z-index:9999;opacity:0;transition:opacity .15s}
.kiln-repeat-item:hover>.kiln-item-ctl{opacity:1}
.kiln-row-editing .kiln-item-ctl{opacity:0!important;pointer-events:none}
/* Under a bar the site keeps at the top of the screen: neither seen nor pressed. */
.kiln-under-bar{visibility:hidden!important;pointer-events:none!important}
/* Table rows keep their controls in a dedicated end-of-row cell (a floating
   overlay would cover the last column's text while typing). */
.kiln-ctl-cell{width:1%;white-space:nowrap;vertical-align:middle;background:none!important;border:none!important;padding:2px 4px!important}
.kiln-ctl-cell .kiln-item-ctl{position:static;display:flex;flex-wrap:nowrap;max-width:none;opacity:0}
.kiln-repeat-item:hover .kiln-ctl-cell .kiln-item-ctl{opacity:1}
/* An empty field being edited must still show a caret and accept clicks. */
.kiln-editing:empty{min-width:70px;min-height:1.15em;display:inline-block}
td.kiln-editing:empty,th.kiln-editing:empty{display:table-cell}
.kiln-editing{caret-color:var(--kiln-accent)}
/* Touch devices have no hover: keep block controls permanently visible so
   move/duplicate/tag/remove (and the only reorder path on a phone) are reachable. */
@media(hover:none){.kiln-item-ctl,.kiln-ctl-cell .kiln-item-ctl{opacity:1}}
.kiln-item-ctl button{background:var(--kiln-bg);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
  color:#fff;border:1px solid rgba(255,255,255,.1);width:27px;height:27px;border-radius:8px;
  cursor:pointer;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.25);transition:background .12s}
.kiln-item-ctl button:hover{background:var(--kiln-accent)}
.kiln-ctl-more{display:none}
.kiln-repeat-add{display:block;margin:10px auto 0;background:rgba(99,102,241,.08);color:var(--kiln-accent);
  border:1.5px dashed rgba(99,102,241,.5);border-radius:10px;padding:8px 18px;cursor:pointer;
  font-size:13px;font-weight:600;font-family:var(--kiln-font);transition:all .15s}
.kiln-repeat-add:hover{background:rgba(99,102,241,.16)}
/* Gallery thumbnail grid — mirrors features.js so EDITORS see thumbnails too
   (the visitor runtime stands down during editing sessions). */
.kiln-gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--kiln-thumb,180px),1fr));gap:10px}
.kiln-gallery-grid figure{margin:0}
.kiln-gallery-grid img{width:100%;height:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px;display:block}
.kiln-gallery-grid figcaption{font-size:.8em;opacity:.75;padding:4px 2px}
.kiln-gallery-grid .kiln-repeat-add,.kiln-gallery-grid .kiln-gallery-opts{align-self:center;aspect-ratio:auto}
.kiln-gallery-opts{font-size:12px!important;opacity:.85}
.kiln-filterbar-preview{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin:0 0 14px;
  padding:8px 10px;border:1.5px dashed rgba(99,102,241,.4);border-radius:11px;background:rgba(99,102,241,.05)}
.kiln-fp-label{font:600 10.5px var(--kiln-font);letter-spacing:.08em;text-transform:uppercase;color:var(--kiln-accent);margin-right:2px}
.kiln-fp-pill{border:1.5px solid rgba(99,102,241,.4);background:#fff;color:#4b5563;border-radius:999px;
  padding:4px 13px;font:500 12.5px var(--kiln-font);cursor:pointer;transition:all .13s}
.kiln-fp-pill:hover{border-color:var(--kiln-accent)}
.kiln-fp-pill.kiln-fp-on{background:var(--kiln-accent);color:#fff;border-color:var(--kiln-accent);font-weight:600}
.kiln-menu-row{display:flex;gap:6px;margin-bottom:6px;align-items:center}
.kiln-menu-row input{flex:1;padding:8px!important;margin:0!important}
.kiln-menu-row .kiln-menu-href{flex:1.2}
.kiln-menu-row button{background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:8px;width:28px;height:34px;
  cursor:pointer;font-size:12px;transition:background .12s}
.kiln-menu-row button:hover{background:#eef2ff}
#kiln-topbar{position:fixed;top:0;left:0;right:0;height:46px;background:var(--kiln-bg);
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);color:#e7e7ee;display:flex;
  align-items:center;gap:8px;padding:0 12px;z-index:99999;font-family:var(--kiln-font);
  font-size:13px;border-bottom:1px solid rgba(255,255,255,.07);overflow-x:auto}
#kiln-topbar .kiln-status{position:static;transform:none;box-shadow:none;border:none;background:none;width:auto;max-width:30vw;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* The bar scrolls sideways when it does not fit. With something to publish,
   Publish stays pinned at its right end instead of scrolling out of reach. */
#kiln-topbar #kiln-publish:not(:disabled){position:sticky;right:0;z-index:1;flex:none;box-shadow:0 0 0 7px rgb(16,16,25)}
.kiln-bar-spacer{flex:1}
body:has(#kiln-topbar){padding-top:46px!important}
.kiln-dragging{opacity:.45;outline:2px dashed var(--kiln-accent)!important}
#kiln-scope-note{position:fixed;left:16px;bottom:16px;z-index:999998;display:flex;align-items:center;gap:8px;
  background:var(--kiln-bg);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:#d6d8e1;
  font:12px/1.4 var(--kiln-font);padding:8px 13px;border-radius:11px;border:1px solid rgba(255,255,255,.14);
  box-shadow:0 6px 22px rgba(0,0,0,.3);max-width:74vw}
#kiln-presence{position:fixed;left:16px;bottom:16px;z-index:999998;display:flex;align-items:center;gap:8px;
  background:var(--kiln-bg);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:#fbbf24;
  font:12px/1.4 var(--kiln-font);padding:8px 13px;border-radius:11px;border:1px solid rgba(251,191,36,.35);
  box-shadow:0 6px 22px rgba(0,0,0,.3);max-width:74vw}
.kiln-presence-dot{width:8px;height:8px;border-radius:50%;background:#fbbf24;flex:none;
  animation:kilnpulse 2s ease-in-out infinite}
#kiln-online{display:inline-flex;align-items:center;gap:6px;margin-left:auto;background:rgba(52,211,153,.14);
  color:#34d399;border:1px solid rgba(52,211,153,.3);border-radius:999px;padding:3px 10px;font:600 11px var(--kiln-font);cursor:pointer}
#kiln-online:hover{background:rgba(52,211,153,.22)}
.kiln-online-dot{width:7px;height:7px;border-radius:50%;background:#34d399;animation:kilnpulse 2s ease-in-out infinite}
#kiln-topbar #kiln-online{margin-left:8px}
@keyframes kilnpulse{0%,100%{opacity:1}50%{opacity:.35}}
#kiln-menu-add{margin-top:4px;color:#4b5563;border-color:#e5e7eb;background:#f9fafb}
/* Named versions: inline naming form on a history row */
.kiln-nv-form{display:flex;gap:6px;align-items:center;flex:none}
.kiln-modal-body input.kiln-nv-input{width:170px;margin:0;padding:7px 9px;font-size:13px}
.kiln-nv-form .kiln-btn-ghost{font-size:11.5px;padding:5px 10px;white-space:nowrap}
/* Visual restore preview: current page beside the restored one, stacked when narrow */
.kiln-which{margin:10px 0 0}
.kiln-which strong{display:block;font:600 12px/1.4 var(--kiln-font);color:#555}
.kiln-which-text{margin-top:3px;padding:8px 10px;border:1px solid #ddd;border-radius:8px;background:#fafafa;color:#111;font:14px/1.45 var(--kiln-font);white-space:pre-wrap;overflow-wrap:anywhere;max-height:9.5em;overflow:auto}
.kiln-ask-which .kiln-which + .kiln-dim{margin-top:12px}
.kiln-ask .kiln-btn-risky{background:#c62828}
.kiln-ask .kiln-btn-risky:hover:not(:disabled){background:#a81f1f}
/* ⌘K palette — dark card matching the Kiln chrome, riding on the modal() shell. */
.kiln-palette-wrap .kiln-modal-card{background:var(--kiln-bg);-webkit-backdrop-filter:blur(16px);
  backdrop-filter:blur(16px);color:#e7e7ee;max-width:580px;border:1px solid rgba(255,255,255,.09)}
.kiln-palette-wrap .kiln-modal-x{display:none}
.kiln-palette-wrap .kiln-modal-body{padding:10px}
.kiln-pal-input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.07);border:1.5px solid rgba(255,255,255,.14);
  color:#fff;border-radius:11px;padding:11px 14px;font:14px var(--kiln-font);outline:none}
.kiln-pal-input:focus{border-color:var(--kiln-accent)}
.kiln-pal-input::placeholder{color:#6b7280}
.kiln-pal-list{max-height:52vh;overflow-y:auto;margin-top:6px}
.kiln-pal-sec{font:600 9.5px var(--kiln-font);letter-spacing:.09em;text-transform:uppercase;color:#6b7280;
  padding:9px 10px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kiln-pal-item{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:none;
  color:#d6d8e1;padding:8px 10px;border-radius:9px;cursor:pointer;font:13px var(--kiln-font)}
.kiln-pal-item .kiln-pal-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.kiln-pal-item small{flex:1;text-align:right;color:#8b8e9c;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kiln-pal-item.kiln-pal-on{background:rgba(99,102,241,.32);color:#fff}
.kiln-pal-snip .kiln-pal-name{white-space:normal;font-size:12.5px;line-height:1.45}
.kiln-pal-hit{background:rgba(251,191,36,.4);color:#fff;border-radius:3px;padding:0 2px}
.kiln-pal-note{color:#8b8e9c;font:12.5px var(--kiln-font);padding:12px 10px 6px}
.kiln-pal-foot{color:#6b7280;font:11px var(--kiln-font);padding:8px 10px 2px;border-top:1px solid rgba(255,255,255,.07);margin-top:8px}
.kiln-pal-kbd{float:right;color:#6b7280;font-size:10px;border:1px solid rgba(255,255,255,.16);border-radius:5px;padding:1px 5px;margin-top:1px}
/* Comments: pins on the page, thread popover, composer, panel rows */
#kiln-cmt-layer{position:fixed;inset:0;pointer-events:none;z-index:999998;font-family:var(--kiln-font)}
.kiln-cmt-pin,.kiln-cmt-num{border-radius:50% 50% 50% 4px;background:var(--kiln-accent);color:#fff;display:flex;align-items:center;justify-content:center;font:700 11px var(--kiln-font)}
.kiln-cmt-pin{position:absolute;transform:translate(-50%,-50%);width:24px;height:24px;border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35);cursor:pointer;pointer-events:auto;padding:0;transition:transform .12s}
.kiln-cmt-pin:hover{transform:translate(-50%,-50%) scale(1.15)}
.kiln-cmt-ghost{opacity:.6;border-style:dashed;background:#8b5cf6}
.kiln-cmt-placing,.kiln-cmt-placing *{cursor:crosshair!important}
#kiln-cmt-pop,#kiln-cmt-composer{position:fixed;z-index:9999998;width:300px;max-width:92vw;background:#fff;color:#1c1c28;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.35);padding:14px;font-family:var(--kiln-font)}
#kiln-cmt-pop{max-height:70vh;overflow-y:auto;padding-top:20px}
#kiln-cmt-composer textarea{width:100%;min-height:76px;padding:9px;border:1.5px solid #e5e7eb;border-radius:10px;font:13.5px/1.45 var(--kiln-font);resize:vertical;box-sizing:border-box}
#kiln-cmt-composer textarea:focus,.kiln-cmt-reply input[type=text]:focus{outline:none;border-color:var(--kiln-accent)}
.kiln-cmt-head small,.kiln-cmt-meta,.kiln-cmt-as{color:#9ca3af;font-size:11.5px}
.kiln-cmt-as{display:block;margin:6px 0 2px}
.kiln-cmt-thread{border:1.5px solid #eef0f3;border-radius:12px;padding:12px;margin:0 0 10px;font-size:13px}
.kiln-cmt-done{opacity:.78;background:#fafbfc}
.kiln-cmt-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.kiln-cmt-num{flex:none;width:20px;height:20px}
.kiln-cmt-msg{margin:0 0 8px}
.kiln-cmt-meta{display:block;margin:8px 0 2px}
.kiln-cmt-text{white-space:pre-wrap;overflow-wrap:break-word;color:#1f2937;line-height:1.5}
.kiln-cmt-reply,.kiln-cmt-acts{display:flex;gap:6px;margin-top:8px}
.kiln-cmt-reply input[type=text]{flex:1;min-width:0;width:auto;margin:0;padding:7px 9px;border:1.5px solid #e5e7eb;border-radius:9px;font-size:12.5px}
.kiln-cmt-thread .kiln-cmt-del:hover{background:#ef4444;border-color:#ef4444}
.kiln-cmt-resolved summary{cursor:pointer;font:600 12px var(--kiln-font);color:#6b7280;margin:4px 0 8px}
#kiln-cmt-pop .kiln-cmt-thread{border:none;padding:0;margin:0}
#kiln-comments{position:relative}
#kiln-comments[data-badge]::after{content:attr(data-badge);position:absolute;top:50%;right:8px;transform:translateY(-50%);min-width:17px;height:17px;border-radius:9px;background:var(--kiln-warn);color:#1c1300;font:700 10.5px/17px var(--kiln-font);text-align:center;padding:0 4px}
/* Block library: hover dividers between sections, remove affordance, picker rows */
#kiln-blocks-layer{position:absolute;top:0;left:0;width:100%;height:0;pointer-events:none;z-index:999997;font-family:var(--kiln-font)}
.kiln-block-gap{position:absolute;height:24px;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;pointer-events:auto;opacity:0;transition:opacity .15s}
.kiln-block-gap:hover,.kiln-block-gap:focus-within{opacity:1}
/* Under the pencil, its Undo/Redo/Publish row or the demo banner: that strip is theirs. */
.kiln-block-gap.kiln-gap-yield{visibility:hidden;pointer-events:none}
.kiln-block-gap::before{content:"";position:absolute;left:8px;right:8px;top:50%;height:2px;margin-top:-1px;background:var(--kiln-accent);border-radius:2px;opacity:.85}
.kiln-block-gap button{position:relative;background:var(--kiln-accent);color:#fff;border:none;border-radius:999px;padding:4px 14px;font:600 12px var(--kiln-font);cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.28);white-space:nowrap}
.kiln-block-gap button:hover{background:var(--kiln-accent-h)}
.kiln-block-remove{position:absolute;pointer-events:auto;transform:translateX(-100%);background:var(--kiln-bg);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:5px 12px;font:600 11.5px var(--kiln-font);cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3)}
.kiln-block-remove:hover{background:#ef4444;border-color:#ef4444}
.kiln-blk-card{max-width:660px}
.kiln-blk-row{display:flex;align-items:center;gap:12px;border:1.5px solid #eef0f3;border-radius:12px;padding:10px;margin-bottom:10px}
.kiln-blk-prev{flex:none;width:230px;height:120px;overflow:hidden;border-radius:8px;background:#f3f4f6;position:relative}
.kiln-blk-prev iframe{border:0;position:absolute;top:0;left:0;transform-origin:0 0;pointer-events:none}
.kiln-blk-meta{flex:1;min-width:0;font-size:13px}
.kiln-blk-meta strong{display:block;color:#111827}
.kiln-blk-meta small{display:block;color:#6b7280;margin-top:2px;overflow:hidden;text-overflow:ellipsis}
.kiln-blk-ex{background:#0f172a;color:#e2e8f0;font:11px/1.55 ui-monospace,Menlo,monospace;padding:12px;border-radius:10px;overflow:auto;max-height:260px;white-space:pre}
@media(max-width:640px){.kiln-blk-row{flex-wrap:wrap}.kiln-blk-prev{width:100%}}
/* ─── Phone-first chrome ─────────────────────────────────────────────────────
   Same components reshaped for thumbs: bottom sheets, ≥40px targets, a
   keyboard-aware toolbar. Inert on desktop — the query is MOBILE_MQ, the same
   one isMobileEditor() answers, so CSS and the JS forks flip together. */
@media ${MOBILE_MQ}{
/* No double-tap zoom / tap delay on Kiln chrome. */
#kiln-fab-wrap,#kiln-fab,#kiln-topbar,#kiln-toolbar,#kiln-modal,#kiln-imgpop,#kiln-previewbar,#kiln-pickbar,
#kiln-cmt-pop,#kiln-cmt-composer,#kiln-cmt-hint,#kiln-ai-menu,
.kiln-item-ctl,.kiln-repeat-add,.kiln-block-gap,.kiln-block-remove,.kiln-img-handle{touch-action:manipulation}
/* 16px inputs, or iOS zooms the page when one focuses. [type=…] matches the
   base rules' specificity — a bare "input" here would lose to them. */
.kiln-modal-body input[type=text],.kiln-modal-body input[type=email],.kiln-modal-body input[type=number],
.kiln-modal-body select,.kiln-modal-body textarea,.kiln-pal-input,.kiln-href-input,
#kiln-cmt-composer textarea,.kiln-cmt-reply input[type=text]{font-size:16px}
/* FAB docks bottom-right (drag is off — see renderAdminBar). */
#kiln-fab-wrap{left:auto!important;top:auto!important;
  right:calc(14px + env(safe-area-inset-right,0px))!important;bottom:calc(16px + env(safe-area-inset-bottom,0px))!important}
#kiln-fab{width:56px;height:56px}
/* The row never leaves the screen: if Undo, Redo and Publish do not fit side by
   side, Publish keeps the line next to the pencil and the pills go above it. */
#kiln-quick{bottom:66px;flex-wrap:wrap;gap:8px;max-width:calc(100vw - 22px - env(safe-area-inset-right,0px))}
#kiln-fab-wrap #kiln-undo-wrap{gap:8px}
#kiln-fab-wrap #kiln-undo-wrap button{height:40px;padding:0 16px}
#kiln-publish-quick{height:44px;padding:0 20px;font-size:15px}
/* A field's toolbar is docked across the bottom while you type: the pencil and
   its row step aside until it closes, so nothing sits on the toolbar. */
.kiln-tb-open #kiln-fab,.kiln-tb-open #kiln-quick{display:none}
/* FAB menu → bottom sheet; the 100vmax shadow is the scrim (tap = click-away). */
#kiln-fab-menu{position:fixed!important;left:0!important;right:0!important;bottom:0!important;top:auto!important;
  width:auto;max-height:88dvh;overflow-y:auto;-webkit-overflow-scrolling:touch;
  overscroll-behavior:contain;border-radius:20px 20px 0 0;border-bottom:none;
  padding:4px 14px calc(14px + env(safe-area-inset-bottom,0px));
  box-shadow:0 -12px 48px rgba(0,0,0,.45),0 0 0 100vmax rgba(10,10,18,.45)}
#kiln-fab-menu::before{content:"";flex:none;width:42px;height:5px;border-radius:3px;
  background:rgba(255,255,255,.28);margin:6px auto}
.kiln-fab-item{display:flex;align-items:center;min-height:44px;font-size:15px;padding:10px 12px}
.kiln-fab-primary{justify-content:center;min-height:50px;font-size:16px}
/* The docked pencil rides the sheet's corner as tap-again-to-close. The foot
   is the strip it sits in: it stays at the bottom of the sheet while the
   items scroll behind it, as tall as the pencil and clear of it on the right,
   so the pencil never lies on an item and "Done editing" is never cut off. */
#kiln-fab-menu{padding-bottom:0;scroll-padding-bottom:calc(84px + env(safe-area-inset-bottom,0px))}
.kiln-fab-foot{margin:4px -14px 0;border-radius:0;align-items:center;
  padding:10px 86px calc(22px + env(safe-area-inset-bottom,0px)) 14px}
.kiln-fab-foot button{min-height:44px;font-size:13.5px;padding:8px 12px}
.kiln-pal-kbd{display:none}
/* Status toasts: top-center, clear of FAB and keyboard. A hint, not a fixture:
   setStatus() takes it away after a few seconds, and a tap dismisses it. */
#kiln-fab-wrap .kiln-status{position:fixed;left:50%;right:auto;bottom:auto;
  top:calc(10px + var(--kiln-under,0px) + env(safe-area-inset-top,0px));transform:translateX(-50%);max-width:92vw;font-size:13px}
/* With the menu or a dialog up from the bottom, or the guide's last card in the
   middle of the screen, the line is at the very top again: below the site's
   bars it would lie on them. */
.kiln-menu-open #kiln-fab-wrap .kiln-status,body:has(#kiln-modal) #kiln-fab-wrap .kiln-status,
body:has(#kiln-guide-card) #kiln-fab-wrap .kiln-status{top:calc(10px + env(safe-area-inset-top,0px))}
#kiln-fab-wrap .kiln-status--act{font-size:14.5px;padding:6px 6px 6px 16px}
.kiln-status-act{min-height:40px;padding:6px 20px;font-size:14.5px}
/* Top-bar mode: same bar, thumb-height targets, finger-scrollable. */
#kiln-topbar{height:56px;-webkit-overflow-scrolling:touch}
body:has(#kiln-topbar){padding-top:56px!important}
#kiln-topbar button{min-height:44px;flex:none}
/* Modals → bottom sheets: drag-handle bar, sticky action row. */
#kiln-modal{align-items:flex-end;padding:0}
.kiln-modal-card{max-width:none;width:100%;box-sizing:border-box;border-radius:20px 20px 0 0;max-height:92dvh}
.kiln-modal-card::before{content:"";flex:none;width:42px;height:5px;border-radius:3px;background:#d7dade;margin:8px auto 0}
.kiln-modal-x{top:14px;right:12px;width:38px;height:38px;font-size:16px}
.kiln-modal-body{padding:16px 16px calc(18px + env(safe-area-inset-bottom,0px))}
.kiln-modal-actions{position:sticky;bottom:0;background:#fff;padding:10px 0 4px;margin-top:14px}
.kiln-modal-actions button,.kiln-btn-pick{min-height:44px}
/* A dialog with three or four choices (a saved draft) had them all in one row,
   and the one most people want wrapped onto two lines. Two to a row, each on
   one line, with the plain primary one last, under the thumb. */
.kiln-modal-actions.kiln-acts-grid{flex-wrap:wrap}
.kiln-acts-grid button{flex:1 1 calc(50% - 4px);white-space:nowrap}
/* ⌘K palette: full screen instead — its input must stay top-anchored (keyboard). */
#kiln-modal.kiln-palette-wrap{align-items:stretch}
.kiln-palette-wrap .kiln-modal-card{max-width:none;height:100dvh;max-height:none;border-radius:0}
.kiln-palette-wrap .kiln-modal-card::before{display:none}
/* No backdrop to tap, no Esc on phones — show the ✕. */
.kiln-palette-wrap .kiln-modal-x{display:flex;background:rgba(255,255,255,.14);color:#e7e7ee}
.kiln-palette-wrap .kiln-pal-input{padding-right:58px}
.kiln-palette-wrap .kiln-modal-body{display:flex;flex-direction:column;padding:12px}
.kiln-pal-input{flex:none;padding:13px 14px}
.kiln-pal-list{flex:1;max-height:none;-webkit-overflow-scrolling:touch}
.kiln-pal-item{min-height:44px}
/* Text/image toolbar: fixed bar ABOVE the keyboard (pinToolbarMobile tracks
   the visual viewport; dragging is off). */
#kiln-toolbar{position:fixed;top:auto;width:100%;max-width:none;box-sizing:border-box;cursor:default;
  border-radius:14px 14px 0 0;border-left:none;border-right:none;border-bottom:none;
  padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px));gap:7px}
.kiln-tb-grip,.kiln-tb-label,.kiln-tb-gap{display:none}
.kiln-tb-fmt{min-width:40px;height:40px;font-size:14px}
.kiln-tb-save{min-height:40px;padding:5px 16px;font-size:13.5px}
.kiln-tb-cancel{min-height:40px;font-size:13.5px}
.kiln-style-select{height:40px}
#kiln-toolbar .kiln-href-input{flex:1;min-width:120px;width:auto}
/* The toolbar's ✨ menu (inline-styled, assist.js) → small sheet. */
#kiln-ai-menu{left:0!important;right:0!important;top:auto!important;bottom:0!important;min-width:0!important;max-width:none!important;
  border-radius:16px 16px 0 0!important;box-shadow:0 -12px 48px rgba(0,0,0,.45)!important;
  padding:10px 14px calc(14px + env(safe-area-inset-bottom,0px))!important}
#kiln-ai-menu button{min-height:44px!important}
#kiln-ai-menu input{min-height:40px;font-size:16px!important}
/* Repeat blocks: thumb-size controls. One "more" button per block is always
   visible (no hover on touch); a tap on it opens that block's bar underneath
   it. The button keeps its corner either way, so the same spot closes it. */
.kiln-item-ctl{gap:8px;opacity:1;min-width:40px;min-height:40px}
.kiln-item-ctl button{width:40px;height:40px;border-radius:10px;font-size:16px;display:none}
.kiln-item-ctl.kiln-ctl-open button{display:inline-block}
.kiln-item-ctl .kiln-ctl-more{display:inline-block;position:absolute;top:0;right:0;font-size:20px;line-height:1}
.kiln-item-ctl.kiln-ctl-open{padding-top:48px}
.kiln-item-ctl.kiln-ctl-open .kiln-ctl-more{background:var(--kiln-accent)}
/* Opened, the buttons used to lie over the block's own second line and the
   next block's words. They take a row of their own at the foot of the block
   instead, which grows to hold them (kiln-ctl-flow: set when the block's
   layout allows it). The "more" button keeps its corner. */
.kiln-item-ctl.kiln-ctl-open.kiln-ctl-flow{position:static;flex:0 0 100%;grid-column:1/-1;width:100%;max-width:none;
  box-sizing:border-box;padding:10px 0 2px;justify-content:flex-end}
.kiln-item-ctl.kiln-ctl-open.kiln-ctl-flow .kiln-ctl-more{top:8px;right:8px}
/* In a table row the bar lives in its own cell and must not change the cell's
   size (the whole table would reflow). It stays one button wide; open, its
   buttons spill out along the row to the left of the "more" button. */
.kiln-ctl-cell .kiln-item-ctl{position:relative;width:40px;max-width:none;flex-wrap:nowrap;padding:0;opacity:1}
.kiln-ctl-cell .kiln-item-ctl .kiln-ctl-more{position:static;order:99}
.kiln-ctl-cell .kiln-item-ctl.kiln-ctl-open{padding:0}
.kiln-repeat-add{min-height:44px;font-size:14px}
/* Comments: thumb-size pins; popover + composer → bottom sheets. */
.kiln-cmt-pin{width:40px;height:40px;font-size:14px;border-radius:50% 50% 50% 5px}
#kiln-cmt-pop,#kiln-cmt-composer{left:0!important;right:0!important;top:auto!important;bottom:0!important;
  width:auto;max-width:none;border-radius:18px 18px 0 0;box-shadow:0 -14px 50px rgba(0,0,0,.4);
  padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px))}
#kiln-cmt-pop{max-height:70dvh;padding-top:30px}
.kiln-cmt-reply input,.kiln-cmt-reply button,.kiln-cmt-acts button{min-height:40px}
#kiln-cmt-hint{flex-wrap:wrap;top:calc(10px + env(safe-area-inset-top,0px))}
#kiln-cmt-hint button{min-height:40px}
/* Section chrome: add-section dividers stay visible (no hover on touch). */
/* No hover on a phone, so dividers show by themselves: only the two around
   the section last touched, not one between every pair of sections. */
.kiln-block-gap{opacity:0;pointer-events:none;height:44px}
.kiln-block-gap.kiln-gap-near{opacity:1;pointer-events:auto}
.kiln-block-gap button{padding:10px 18px;font-size:13px}
.kiln-block-remove{padding:11px 16px;font-size:12.5px}
/* Image chrome: size buttons inherit .kiln-tb-fmt 40px; bigger drag handle. */
#kiln-imgpop{max-width:96vw;flex-wrap:wrap;gap:7px;padding:8px}
.kiln-img-handle{width:32px;height:32px;border-width:3px}
.kiln-img-handle::after{inset:8px}
/* Helper bars wrap instead of overflowing a 390px screen. */
#kiln-pickbar{flex-wrap:wrap;max-width:94vw;top:calc(10px + env(safe-area-inset-top,0px))}
#kiln-pickbar button,#kiln-previewbar button{min-height:40px}
/* The bars that wait for an answer: as wide as the screen, above the pencil
   and its row of buttons. The top is the status line's, and the site's header's. */
#kiln-notices{left:8px;right:8px;top:auto;bottom:calc(140px + env(safe-area-inset-bottom,0px));transform:none;max-width:none;
  align-items:stretch}
#kiln-notices>*{max-width:none;width:auto;max-height:36dvh;overflow-y:auto}
#kiln-previewbar{flex-wrap:wrap;gap:8px 10px}
#kiln-previewbar>span{flex:1 1 100%}
#kiln-previewbar button{flex:1 1 0}
#kiln-scope-note,#kiln-presence{max-width:60vw;bottom:calc(14px + env(safe-area-inset-bottom,0px))}
}` + publishSheetCss(MOBILE_MQ) + imagePickerCss(MOBILE_MQ);
  document.head.appendChild(style);
}
