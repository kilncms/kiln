/**
 * A first pass at what can be edited, from the dashboard.
 *
 * Kiln edits only what a page marks as editable. The setup tool has always
 * offered a cautious first pass (`kiln tag`, src/autotag.js): headings,
 * paragraphs, quotes, captions, pictures, repeating blocks such as cards, and
 * the site menu. This runs that same pass for a site's owner with one press,
 * through the GitHub App, as one commit in their name.
 *
 * It only ever ADDS marks (`data-cms…` attributes). Every changed page is
 * checked for exactly that before it is written: a page where the pass did
 * anything else is left alone and named. A part that is already marked is
 * never touched, so pressing it twice changes nothing the second time, and a
 * visitor sees no difference on any page. What it marks can be made plain
 * again, one part at a time, in the editor.
 *
 *   planFirstPass   reads the repository and says what would be marked
 *   applyFirstPass  marks it
 *   publicFirstPass the part of a plan the dashboard is shown
 *
 * The routes are in cloud.js (GET and POST /cloud/sites/firstpass).
 */

import { autotag } from '../src/autotag.js';
import { readPages, commitChange } from './prepare.js';

const KINDS = ['fields', 'images', 'repeats', 'menu'];

// What the pass may add to a page, and nothing else: one or more data-cms
// attributes with a plain value. (A run found by walking the two texts side by
// side can start or end one space off, so a space is allowed at either end.)
const ONLY_MARKS = /^ ?(?:data-cms(?:-[a-z]+)*(?:="[a-z0-9_-]*")? ?)+$/;

/**
 * True when `after` is `before` with nothing but marks added: every character
 * of the page is still there, in order, and each added run is a data-cms
 * attribute. The two are walked side by side once.
 */
export function onlyAddsMarks(before, after) {
  if (after.length < before.length) return false;
  let i = 0, j = 0;
  while (j < after.length) {
    if (i < before.length && before[i] === after[j]) { i++; j++; continue; }
    // An added run: it goes on until the page's own text picks up again.
    let end = j;
    while (end < after.length && !(i < before.length && before[i] === after[end] && after.startsWith(before.slice(i, i + 12), end))) end++;
    if (!ONLY_MARKS.test(after.slice(j, end))) return false;
    j = end;
  }
  return i === before.length;
}

/**
 * Read the repository and work out what a first pass would mark. Writes
 * nothing. `state` is 'ready' (there is something to mark), 'nothing' (the
 * pass finds nothing more to mark), or one of readPages' reasons the pages
 * were not read.
 */
export async function planFirstPass({ token, repo }) {
  const site = await readPages({ token, repo });
  if (site.state !== 'ok') return site;
  const changes = [], skipped = [...site.skipped];
  const totals = Object.fromEntries(KINDS.map(k => [k, 0]));
  let untouched = 0;
  for (const f of site.files) {
    let out = null;
    try { out = autotag(f.text); } catch { out = null; }
    if (!out) { skipped.push({ path: f.path, why: 'unreadable' }); continue; }
    if (out.html === f.text) { untouched++; continue; }
    if (!onlyAddsMarks(f.text, out.html)) { skipped.push({ path: f.path, why: 'unsafe' }); continue; }
    changes.push({ path: f.path, mode: f.mode, text: out.html, counts: out.counts });
    for (const k of KINDS) totals[k] += Number(out.counts?.[k]) || 0;
  }
  skipped.sort((x, y) => (x.path < y.path ? -1 : 1));
  return {
    branch: site.branch, head: site.head, treeSha: site.treeSha,
    state: changes.length ? 'ready' : 'nothing',
    pages: { total: site.total, untouched, skipped },
    totals,
    changes,
  };
}

/** What the dashboard is shown of a plan: counts and names, never a page's text. */
export function publicFirstPass(plan, { repo } = {}) {
  const out = { state: plan.state, repo, branch: plan.branch || null };
  if (plan.generator) out.generator = plan.generator;
  if (plan.pageCount) out.page_count = plan.pageCount;
  if (plan.pages) {
    out.pages = {
      total: plan.pages.total,
      change: plan.changes.length,
      change_names: plan.changes.slice(0, 12).map(c => c.path),
      untouched: plan.pages.untouched,
      skipped: plan.pages.skipped.slice(0, 20),
      skipped_count: plan.pages.skipped.length,
    };
    out.marks = { text: plan.totals.fields, pictures: plan.totals.images, lists: plan.totals.repeats, menus: plan.totals.menu };
  }
  return out;
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Mark what a `ready` plan describes: one commit, or a PrepareError and nothing changed. */
export async function applyFirstPass({ token, repo, plan, author }) {
  const t = plan.totals;
  const what = [
    t.fields ? count(t.fields, 'piece of text', 'pieces of text') : '',
    t.images ? count(t.images, 'picture', 'pictures') : '',
    t.repeats ? count(t.repeats, 'list of blocks', 'lists of blocks') : '',
    t.menu ? count(t.menu, 'menu', 'menus') : '',
  ].filter(Boolean).join(', ');
  const n = plan.changes.length;
  const message = `Mark a first pass of what can be edited\n\n${what} on ${count(n, 'page', 'pages')}. Made from the Kiln dashboard by ${author.name}. `
    + 'Any of it can be made plain again in the editor, with Make text/images editable.';
  const commit = await commitChange({ token, repo, branch: plan.branch, head: plan.head, treeSha: plan.treeSha, texts: plan.changes, message, author });
  return { ...commit, pages: n };
}

/** The sentences that differ from adding Kiln; the rest are prepareSentence's. */
export function firstPassSentence(code, { generator = '' } = {}) {
  if (code === 'built') return `This site is built by ${generator || 'a site generator'} before it is published, so what can be edited is set in the files it is built from, not on its pages. The setup tool and the guide for source mode cover those.`;
  if (code === 'busy') return 'Kiln is already marking this site. Give it a minute, then reload this page.';
  return null;
}
