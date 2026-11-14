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
 * A site that Astro builds is not marked yet. Its owner is given a report in
 * place of a refusal: how much of the text written in the site's templates a
 * first pass could make editable by itself (src/astro-firstpass.js reads the
 * templates), and how much is left for a developer. Nothing is written.
 *
 * The routes are in cloud.js (GET and POST /cloud/sites/firstpass).
 */

import { autotag, onlyAddsMarks } from '../src/autotag.js';
import { tallyAstro } from '../src/astro-firstpass.js';
import { readPages, commitChange, inTurn, readText, MAX_ASTRO_FILES, MAX_PAGE_BYTES } from './prepare.js';

const KINDS = ['fields', 'images', 'repeats', 'menu'];

// The check itself is beside the pass it checks (src/autotag.js), so the editor
// holds its own whole-page pass to the same rule. Still exported from here.
export { onlyAddsMarks };

/**
 * Read the repository and work out what a first pass would mark. Writes
 * nothing. `state` is 'ready' (there is something to mark), 'nothing' (the
 * pass finds nothing more to mark), 'report' (a site Astro builds: what a
 * first pass could mark, counted and not written), or one of readPages'
 * reasons the pages were not read.
 */
export async function planFirstPass({ token, repo }) {
  const site = await readPages({ token, repo });
  if (site.state === 'built' && site.kind === 'astro' && site.entries) {
    const report = await planAstroReport({ token, repo, site });
    if (report) return report;
  }
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

/**
 * The report for a site Astro builds: every .astro file under src/ is read
 * (as many, and as large, as adding Kiln reads) and its text elements are
 * counted by whether a first pass could take them. Writes nothing. Null when
 * the site has more template files than are read here, or GitHub's list of
 * its files is cut short: the count would be of a part, so the site is told
 * what it was told before.
 */
async function planAstroReport({ token, repo, site }) {
  const astro = site.entries
    .filter(e => e.path.startsWith('src/') && e.path.endsWith('.astro') && !e.path.split('/').some(d => d.startsWith('.') || d === 'node_modules'))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (site.cut || astro.length > MAX_ASTRO_FILES) return null;
  const read = await inTurn(astro, (e) => (Number(e.size) > MAX_PAGE_BYTES ? { tooLarge: true } : readText(token, repo, e.sha)));
  // A file GitHub would not hand over might hold most of the text: no count is better than a wrong one.
  if (read.some(r => r.failed)) return { state: 'github' };
  // A file that is too large or is not text has no `text`, and is counted among those that could not be read.
  const report = tallyAstro(astro.map((e, i) => ({ path: e.path, text: read[i].text })));
  return { branch: site.branch, head: site.head, treeSha: site.treeSha, generator: site.generator, state: 'report', report };
}

const REPORT_FILES = 10;      // the files with the most text a first pass could take
const REPORT_UNREAD = 20;     // names of files that could not be read, at most

const leftShown = (l) => ({ mixed: l.mixed, from_code: l.fromCode, with_tags: l.withTags, in_loop: l.inLoop, marked: l.marked });

/** The sentences under the report, in the order they are shown. */
export function astroReportSentences(report) {
  const n = report.safe, m = report.total, k = m - n, f = report.unread.length;
  const out = [];
  if (!n) out.push('Kiln found no text in this site\'s templates that it can mark by itself. The words on your pages come from content files or from code, and a developer marks those with one line each.');
  else if (!k) out.push(`Kiln can make every heading and paragraph on this site's templates editable by itself, ${n} in all.`);
  else out.push(`Kiln can make ${n} of ${m} headings and paragraphs on this site's templates editable by itself. The other ${k} come from your content files or from code, or mix words with a value, and a developer marks those with one line each.`);
  out.push('This counts the text written in your page templates. A line inside a list that repeats counts once here, however many times it shows on the site.');
  if (f) out.push(`Kiln could not read ${f} of the template files, so they are not counted.`);
  return out;
}

/** What the dashboard is shown of a plan: counts and names, never a page's text. */
export function publicFirstPass(plan, { repo } = {}) {
  const out = { state: plan.state, repo, branch: plan.branch || null };
  if (plan.generator) out.generator = plan.generator;
  if (plan.pageCount) out.page_count = plan.pageCount;
  if (plan.report) {
    const r = plan.report;
    out.report = {
      files: r.files,
      total: r.total,
      safe: r.safe,
      left: leftShown(r.left),
      top: r.perFile.filter(f => f.total > 0).slice(0, REPORT_FILES).map(f => ({ path: f.path, total: f.total, safe: f.safe, left: leftShown(f.left) })),
      unread: r.unread.slice(0, REPORT_UNREAD),
      unread_count: r.unread.length,
    };
    out.sentences = astroReportSentences(r);
  }
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
  if (code === 'report') return 'Kiln cannot mark these by itself yet. This report shows what it will be able to do.';
  return null;
}
