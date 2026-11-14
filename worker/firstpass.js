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
 * A site that Astro builds has its words partly in its templates (`.astro`
 * files), which the service never edits. Its owner is first given a report:
 * how much of the text written in the templates a first pass can make
 * editable by itself (src/astro-firstpass.js reads the templates), and how
 * much is left for a developer. When asked for the change too
 * (`astroChange`, the dashboard's button), the plan also holds it: the words
 * that are safe to take move out of each template into a words file under
 * `src/kiln/`, which the editor can save to, and each one is left showing in
 * the same place. Every changed template is checked before it is written
 * (checkAstroChange, with the words as the service's own YAML reader reads
 * them back from the words file): one that fails is left alone and named. A
 * words file that is there already is never written over.
 *
 * The routes are in cloud.js (GET and POST /cloud/sites/firstpass).
 */

import { autotag, onlyAddsMarks } from '../src/autotag.js';
import { tallyAstro, changeAstro, checkAstroChange } from '../src/astro-firstpass.js';
import { frontmatterRange, readFrontmatterValue } from '../src/adapters/frontmatter.js';
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
 * reasons the pages were not read. With `astroChange`, a site Astro builds
 * that has words safe to move is 'ready' too, and the plan holds the change.
 */
export async function planFirstPass({ token, repo, astroChange = false }) {
  const site = await readPages({ token, repo });
  if (site.state === 'built' && site.kind === 'astro' && site.entries) {
    const report = await planAstroReport({ token, repo, site, change: astroChange });
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
 * what it was told before. With `change`, the plan also holds the change
 * (planAstroChange) and its state is 'ready' when there is anything to move.
 */
async function planAstroReport({ token, repo, site, change = false }) {
  const astro = site.entries
    .filter(e => e.path.startsWith('src/') && e.path.endsWith('.astro') && !e.path.split('/').some(d => d.startsWith('.') || d === 'node_modules'))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (site.cut || astro.length > MAX_ASTRO_FILES) return null;
  const read = await inTurn(astro, (e) => (Number(e.size) > MAX_PAGE_BYTES ? { tooLarge: true } : readText(token, repo, e.sha)));
  // A file GitHub would not hand over might hold most of the text: no count is better than a wrong one.
  if (read.some(r => r.failed)) return { state: 'github' };
  // A file that is too large or is not text has no `text`, and is counted among those that could not be read.
  const files = astro.map((e, i) => ({ path: e.path, mode: e.mode || '100644', text: read[i].text }));
  const report = tallyAstro(files);
  const plan = { branch: site.branch, head: site.head, treeSha: site.treeSha, generator: site.generator, state: 'report', report };
  if (!change) return plan;
  const moved = planAstroChange(files, site.paths || site.entries.map(e => e.path));
  return { ...plan, ...moved, state: moved.changes.length ? 'ready' : 'report' };
}

/** The words a words file holds, as the service's YAML reader gives them: { key: words }, or null when it does not read as written. */
export function readWordsFile(text, keys) {
  const fm = frontmatterRange(text);
  if (!fm || fm.format !== 'yaml' || fm.bodyStart !== text.length) return null;
  const yaml = text.slice(fm.fmStart, fm.fmEnd);
  const out = {};
  for (const key of keys) {
    const value = readFrontmatterValue('yaml', yaml, [key]);
    if (typeof value !== 'string') return null;
    out[key] = value;
  }
  return out;
}

/**
 * The change for a site Astro builds, worked out and checked, not written.
 * `files` is [{ path, mode, text }] (the templates), `paths` every file the
 * repository holds. Answers
 *   { changes: [{ path, mode, text }], astro: { pieces, files, left: [{ path, why }] } }
 * `changes` holds each changed template and its new words file. A template is
 * left alone and named, with why:
 *   'unread'      the reader cannot follow it (or it is too large, or not text)
 *   'name'        it already uses the name `kilnWords`
 *   'path'        its path holds a character that cannot stand in an import
 *   'words_file'  its words file is there already (it is never written over)
 *   'unsafe'      the changed template did not pass the check
 * Astro's settings file, .ts and .js files, content files and everything
 * outside src/ are not among `files`, and are never in `changes`.
 */
export function planAstroChange(files, paths = []) {
  // What is under src/kiln/ already, files and folders, without regard to capitals
  // (two names that differ only there are one file on many computers).
  const there = new Set(), held = new Set();   // files and folders; the files among them
  for (const p of paths) {
    const low = String(p).toLowerCase();
    if (low !== 'src/kiln' && !low.startsWith('src/kiln/')) continue;
    held.add(low);
    for (let k = low.length; k > 'src/'.length; k = low.lastIndexOf('/', k - 1)) there.add(low.slice(0, k));
  }
  const taken = (wordsPath) => {
    const low = wordsPath.toLowerCase();
    if (there.has(low)) return true;             // a file or a folder of that name
    for (let k = low.lastIndexOf('/'); k > 'src/'.length; k = low.lastIndexOf('/', k - 1)) if (held.has(low.slice(0, k))) return true;   // a file where one of its folders must be
    return false;
  };

  const changes = [], left = [];
  let pieces = 0, templates = 0;
  for (const f of files) {
    const c = typeof f.text === 'string' ? changeAstro(f.path, f.text) : { left: 'unread' };
    if (c.none) continue;
    if (c.left) { left.push({ path: f.path, why: c.left }); continue; }
    if (taken(c.wordsPath)) { left.push({ path: f.path, why: 'words_file' }); continue; }
    const words = readWordsFile(c.wordsText, c.pieces.map(p => p.key));
    const wrong = words ? checkAstroChange({ path: f.path, before: f.text, after: c.text, words }) : 'words';
    if (wrong) { left.push({ path: f.path, why: 'unsafe' }); continue; }
    changes.push({ path: f.path, mode: f.mode || '100644', text: c.text }, { path: c.wordsPath, mode: '100644', text: c.wordsText });
    pieces += c.pieces.length;
    templates++;
  }
  left.sort((x, y) => (x.path < y.path ? -1 : 1));
  return { changes, astro: { pieces, files: templates, left } };
}

const REPORT_FILES = 10;      // the files with the most text a first pass could take
const REPORT_UNREAD = 20;     // names of files that could not be read, at most
const LEFT_NAMES = 20;        // names of files the change left alone, at most

const leftShown = (l) => ({ mixed: l.mixed, from_code: l.fromCode, with_tags: l.withTags, in_loop: l.inLoop, marked: l.marked });
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const COUNTS = 'This counts the text written in your page templates. A line inside a list that repeats counts once here, however many times it shows on the site.';
/** The text elements a first pass cannot take, said to their owner (`k` is how many, not 0). */
const theRest = (k) => (k === 1
  ? 'The other one comes from your content files or from code, or mixes words with a value, and a developer marks it with one line.'
  : `The other ${k} come from your content files or from code, or mix words with a value, and a developer marks those with one line each.`);
const couldNotRead = (f) => `Kiln could not read ${f} of the template files, so they are not counted.`;

/** The sentences under the report, in the order they are shown. */
export function astroReportSentences(report) {
  const n = report.safe, m = report.total, k = m - n, f = report.unread.length;
  const out = [];
  if (!n) out.push('Kiln found no text in this site\'s templates that it can mark by itself. The words on your pages come from content files or from code, and a developer marks those with one line each.');
  else if (!k) out.push(`Kiln can make every heading and paragraph on this site's templates editable by itself, ${n} in all.`);
  else out.push(`Kiln can make ${n} of ${m} headings and paragraphs on this site's templates editable by itself. ${theRest(k)}`);
  out.push(COUNTS);
  if (f) out.push(couldNotRead(f));
  return out;
}

/** What the owner of a site Astro builds reads before the change is made (a 'ready' plan), in the order shown. */
export function astroBeforeSentences(plan) {
  const { pieces: n, files: f } = plan.astro;
  const r = plan.report, k = r.total - r.safe;
  const out = [`Kiln will move ${count(n, 'piece of text', 'pieces of text')} out of ${count(f, 'template file', 'template files')} into ${f === 1 ? 'a file' : 'files'} it can edit, and leave ${n === 1 ? 'it' : 'each one'} showing in the same place. Your pages will look the same. Press Mark them to make this change.`];
  if (k) out.push(theRest(k));
  out.push(COUNTS);
  if (r.unread.length) out.push(couldNotRead(r.unread.length));
  return out;
}

/** What they read after it is made, in the order shown. The names of the files left alone are in the answer's `left_alone`. */
export function astroAfterSentences(plan) {
  const { pieces: n, left } = plan.astro;
  const out = [n === 1
    ? '1 piece of text can now be edited. Your site is building again. When it is done, open a page, sign in and click it.'
    : `${n} pieces of text can now be edited. Your site is building again. When it is done, open a page, sign in and click any of them.`];
  if (left.length === 1) out.push('Kiln left 1 template file as it was, because it could not be sure the change was safe there.');
  else if (left.length) out.push(`Kiln left ${left.length} template files as they were, because it could not be sure the change was safe there.`);
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
  if (plan.astro) {
    // `move`: what one press will move. `left_alone`: the templates it will not touch, and why.
    if (plan.state === 'ready') {
      out.move = { pieces: plan.astro.pieces, files: plan.astro.files };
      out.sentences = astroBeforeSentences(plan);
    }
    if (plan.astro.left.length) {
      out.left_alone = plan.astro.left.slice(0, LEFT_NAMES).map(l => ({ path: l.path, why: l.why }));
      out.left_alone_count = plan.astro.left.length;
    }
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

/** Mark what a `ready` plan describes: one commit, or a PrepareError and nothing changed. */
export async function applyFirstPass({ token, repo, plan, author }) {
  if (plan.astro) return applyAstroChange({ token, repo, plan, author });
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

/** The change for a site Astro builds: every changed template and every new words file in one commit, in the owner's name. */
async function applyAstroChange({ token, repo, plan, author }) {
  const { pieces, files } = plan.astro;
  const message = `Mark what can be edited\n\n${count(pieces, 'piece of text', 'pieces of text')} in ${count(files, 'template file', 'template files')} moved into files Kiln can edit, under src/kiln/. `
    + `Each one shows in the same place as before. Made from the Kiln dashboard by ${author.name}.`;
  const commit = await commitChange({ token, repo, branch: plan.branch, head: plan.head, treeSha: plan.treeSha, texts: plan.changes, message, author });
  return { ...commit, pages: files, pieces };
}

/** The sentences that differ from adding Kiln; the rest are prepareSentence's. */
export function firstPassSentence(code, { generator = '' } = {}) {
  if (code === 'built') return `This site is built by ${generator || 'a site generator'} before it is published, so what can be edited is set in the files it is built from, not on its pages. The setup tool and the guide for source mode cover those.`;
  if (code === 'busy') return 'Kiln is already marking this site. Give it a minute, then reload this page.';
  if (code === 'report') return 'Kiln cannot mark these by itself yet. This report shows what it will be able to do.';
  return null;
}
