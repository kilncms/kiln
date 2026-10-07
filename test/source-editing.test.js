/**
 * Editing a page a generator built, as the person editing meets it
 * (src/editor/source-fields.js, and how main.js and firstrun.js use it).
 *
 * The first time the editor was watched in a browser on pages Astro built, it
 * flattened a formatted description to plain text, could never save a number
 * or a yes/no, let a link's label overwrite its address, named fields by
 * their pointer ("/Frontmatter/Title"), and said why something was not saved
 * only in a tooltip. These hold what was put right.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sourceLabel, typedValue, keptText, groupSourceEdits, plainBody, markdownText, lockReason,
  skipSentence, refusalSentence, typeHint, SAVED_BUILDING_COPY, BUILD_FAILED_COPY,
  buildRecord, buildStanding, resumePlan, BUILD_WATCH_MS, BUILD_KEPT_MS,
} from '../src/editor/source-fields.js';
import { parseSourceRef } from '../src/adapters/pointer.js';
import { guideCardCopy } from '../src/editor/firstrun.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, 'src', 'editor', f), 'utf8');
const main = read('main.js');
const ref = (r) => parseSourceRef(r);

// ─── Names ───────────────────────────────────────────────────────────────────

test('names: a field is called by what it is and which entry it belongs to, never by its pointer', () => {
  assert.equal(sourceLabel(ref('src/content/events/interfaith-worship-service.md#/frontmatter/title')), 'Title · Interfaith worship service');
  assert.equal(sourceLabel(ref('src/content/events/one.md#/frontmatter/date?type=date')), 'Date · One');
  assert.equal(sourceLabel(ref('src/content/site/home.md#/frontmatter/intro')), 'Intro · Home');
  // the whole text of an entry is its text, not its "body"
  assert.equal(sourceLabel(ref('src/content/events/one.md#/body')), 'Text · One');
  // a value inside another, and one of a list (counted from 1, as people count)
  assert.equal(sourceLabel(ref('src/content/events/one.md#/frontmatter/venue/name')), 'Venue name · One');
  assert.equal(sourceLabel(ref('src/content/events/one.md#/frontmatter/tags/0')), 'Tags 1 · One');
  // a file called index is named by its folder
  assert.equal(sourceLabel(ref('src/content/about/index.md#/frontmatter/heading')), 'Heading · About');
  assert.equal(sourceLabel(ref('data/site.md#/data/tagline')), 'Tagline · Site');
  assert.equal(sourceLabel(null), '');
});

test('names: the publish sheet, the saved-edits question and "Copy my text" use that name', () => {
  assert.match(main, /items\.push\(\{ id: 'source:' \+ ref, key: null, sourceRef: ref, label: sourceName\(ref\)/);
  assert.equal(/readableName\(String\(ref\)\.split\('#'\)/.test(main), false, 'a row is still named from the raw reference');
  const offer = main.slice(main.indexOf('function offerPendingRestore('), main.indexOf('async function restoreSaved('));
  assert.match(offer, /Object\.keys\(saved\.source\)\.map\(sourceName\)/);
  const copy = main.slice(main.indexOf('function unpublishedText('), main.indexOf('function stoppedDialog('));
  assert.match(copy, /label: sourceName\(ref\)/);
  // the hover hint is the name for an invited editor, and the file as well for the owner
  assert.match(main, /function sourceHint\(parsed\) \{\s*\n\s*return mode === 'admin' \? `Edit: \$\{sourceLabel\(parsed\)\} \(\$\{friendlyRef\(parsed\)\}\)` : `Edit: \$\{sourceLabel\(parsed\)\}`;/);
  assert.equal(/el\.title = `Edit: \$\{friendlyRef\(/.test(main), false);
});

// ─── Typed values ────────────────────────────────────────────────────────────

test('typed: a number and a yes/no are sent as a number and as true or false', () => {
  assert.deepEqual(typedValue('150', 'number'), { ok: true, value: 150 });
  assert.deepEqual(typedValue(' 12.5 ', 'number'), { ok: true, value: 12.5 });
  assert.deepEqual(typedValue('-3', 'number'), { ok: true, value: -3 });
  for (const yes of ['true', 'yes', 'Yes', 'TRUE', ' on ']) assert.deepEqual(typedValue(yes, 'boolean'), { ok: true, value: true });
  for (const no of ['false', 'no', 'No', 'off']) assert.deepEqual(typedValue(no, 'boolean'), { ok: true, value: false });
  // what the worker gets
  const pending = new Map([
    ['src/content/events/one.md#/frontmatter/seats?type=number', { value: '150', type: 'number' }],
    ['src/content/events/one.md#/frontmatter/free?type=boolean', { value: 'no', type: 'boolean' }],
    ['src/content/events/one.md#/frontmatter/title', { value: '150' }],
  ]);
  const [g] = groupSourceEdits(pending, { repo: 'o/r', branch: 'main', adapter: 'astro' });
  assert.deepEqual(g.body.edits.map(e => e.value), [150, false, '150']);
  // what is staged, and saved in the browser, stays the text that was typed
  assert.equal(pending.get('src/content/events/one.md#/frontmatter/seats?type=number').value, '150');
});

test('typed: a value of the wrong kind is told in a sentence that says how to write it', () => {
  assert.deepEqual(typedValue('2026-09-21', 'date'), { ok: true, value: '2026-09-21' });
  assert.deepEqual(typedValue(' 2026-09-21 ', 'date'), { ok: true, value: '2026-09-21' });
  assert.deepEqual(typedValue('September 21', 'date'), { ok: false, why: 'This needs to be a date written like 2026-09-20.' });
  assert.equal(typedValue('2026-02-31', 'date').ok, false, 'a day that does not exist');
  assert.deepEqual(typedValue('18:30', 'time'), { ok: true, value: '18:30' });
  assert.deepEqual(typedValue('6:30pm', 'time'), { ok: false, why: 'This needs to be a time written like 14:30.' });
  assert.deepEqual(typedValue('about 150', 'number'), { ok: false, why: 'This needs to be a number, such as 120.' });
  assert.deepEqual(typedValue('maybe', 'boolean'), { ok: false, why: 'This needs to be yes or no.' });
  assert.deepEqual(typedValue('https://example.org/a', 'url'), { ok: true, value: 'https://example.org/a' });
  assert.deepEqual(typedValue('/about', 'url'), { ok: true, value: '/about' });
  assert.deepEqual(typedValue('Get tickets', 'url'), { ok: false, why: 'This needs to be a web address that starts with https://, or a page of this site such as /about.' });
  // plain text is whatever was typed
  assert.deepEqual(typedValue('  two  spaces ', undefined), { ok: true, value: '  two  spaces ' });
  assert.deepEqual(typedValue('x', 'string'), { ok: true, value: 'x' });
  // no sentence has an exclamation mark or a dash for punctuation
  for (const [t, v] of [['date', 'x'], ['time', 'x'], ['number', 'x'], ['boolean', 'x'], ['url', 'a b']]) {
    assert.equal(/[!—–]| - /.test(typedValue(v, t).why), false);
  }
  // a date the page writes out in words: the person is told how it is typed before they try
  assert.equal(typeHint('date'), 'A date is typed here like 2026-09-20. The page shows it in the site’s own way once the site has rebuilt.');
  assert.equal(typeHint('string'), '');
  assert.equal(typeHint(undefined), '');
  const startEdit = main.slice(main.indexOf('function startSourceEditing('), main.indexOf('function commitSourceEdit('));
  assert.match(startEdit, /if \(!typedValue\(surface\.textContent, parsed\.type\)\.ok\) setStatus\(typeHint\(parsed\.type\), 'idle', \{ hold: 12000 \}\);/);
  // a wrong value is never staged: the editor says so and keeps what was there
  const commit = main.slice(main.indexOf('function commitSourceEdit('), main.indexOf('function cancelSourceEdit('));
  assert.match(commit, /const typed = typedValue\(value, a\.parsed\.type\);/);
  assert.match(commit, /if \(!typed\.ok\) \{/);
  // a value that could not be saved before is still sent as typed when it is somehow staged (the worker says why)
  const [g] = groupSourceEdits(new Map([['a.md#/frontmatter/n?type=number', { value: 'lots', type: 'number' }]]), {});
  assert.equal(g.body.edits[0].value, 'lots');
});

test('typed: a date, a time, a number or an address is kept without the spaces typed around it', () => {
  // the worker takes "2026-09-21" and turns " 2026-09-21" away
  assert.equal(keptText(' 2026-09-21 ', 'date'), '2026-09-21');
  assert.equal(keptText('18:30\n', 'time'), '18:30');
  assert.equal(keptText(' 150 ', 'number'), '150');
  assert.equal(keptText(' yes', 'boolean'), 'yes');
  assert.equal(keptText(' /about ', 'url'), '/about');
  // words are kept as typed
  assert.equal(keptText('  two  spaces ', undefined), '  two  spaces ');
  assert.equal(keptText(' a title ', 'string'), ' a title ');
  const commit = main.slice(main.indexOf('function commitSourceEdit('), main.indexOf('function cancelSourceEdit('));
  assert.match(commit, /const kept = keptText\(value, a\.parsed\.type\);/);
  assert.match(commit, /else stageSourcePending\(a\.ref, kept\);/);
  // a line break typed into an entry's one paragraph leaves it one paragraph of words
  assert.match(commit, /if \(a\.surface\.children\.length\) a\.surface\.textContent = value;/);
  // …and it is a line break in every browser: WebKit puts an element where Enter was pressed
  assert.match(commit, /for \(const br of a\.surface\.querySelectorAll\('br'\)\) br\.replaceWith\('\\n'\);\s*\n\s*const value = a\.surface\.textContent;/);
});

// ─── The text of an entry ────────────────────────────────────────────────────

const el = (tagName, children = [], text = '') => ({ nodeType: 1, tagName, children: children.filter(c => c.nodeType === 1), childNodes: children, nodeValue: null, textContent: text });
const txt = (s) => ({ nodeType: 3, nodeValue: s });

test('text: only one plain paragraph can be edited as words; anything with formatting is left alone', () => {
  const p = el('P', [txt('One plain paragraph.')]);
  assert.equal(plainBody(el('DIV', [p, txt('\n')])), p);
  // bold, a link, a list, a second paragraph, a heading, a line break: not plain
  assert.equal(plainBody(el('DIV', [el('P', [txt('Doors at '), el('STRONG', [txt('5:30pm')])]), txt('\n')])), null);
  assert.equal(plainBody(el('DIV', [el('P', [txt('a')]), txt('\n'), el('P', [txt('b')])])), null);
  assert.equal(plainBody(el('DIV', [el('UL', [el('LI', [txt('a')])])])), null);
  assert.equal(plainBody(el('DIV', [el('H2', [txt('a')])])), null);
  assert.equal(plainBody(el('DIV', [el('P', [txt('a'), el('BR'), txt('b')])])), null);
  // words outside the paragraph, or nothing at all
  assert.equal(plainBody(el('DIV', [txt('loose words '), el('P', [txt('a')])])), null);
  assert.equal(plainBody(el('DIV', [])), null);
  // main.js edits that paragraph, and puts words back into it, so the page keeps its shape
  assert.match(main, /function sourceSurface\(el, parsed\) \{/);
  assert.match(main, /return isBody\(parsed\) \? \(plainBody\(el\) \|\| el\) : el;/);
});

test('text: what is typed is saved as words, not read as formatting', () => {
  assert.equal(markdownText('Plain words, with a comma.'), 'Plain words, with a comma.');
  assert.equal(markdownText('5 * 3 * 2'), '5 \\* 3 \\* 2');
  assert.equal(markdownText('see [the map] <now>'), 'see \\[the map\\] \\<now>');
  assert.equal(markdownText('a `tick` and a \\ slash'), 'a \\`tick\\` and a \\\\ slash');
  // an underscore inside a word is only a letter; at a word's edge it would start slanted text
  assert.equal(markdownText('snake_case and _this_'), 'snake_case and \\_this\\_');
  // what would start a heading, a quote or a list at the start of a line
  assert.equal(markdownText('# not a heading'), '\\# not a heading');
  assert.equal(markdownText('line\n> not a quote\n- not a list\n+ nor this\n1. nor this'), 'line\n\\> not a quote\n\\- not a list\n\\+ nor this\n1\\. nor this');
  assert.equal(markdownText('2026 was the year. 10) too'), '2026 was the year. 10) too');
  // the edit that goes to the worker for an entry's text
  const [g] = groupSourceEdits(new Map([['src/content/site/about.md#/body', { value: 'Tea * biscuits' }], ['src/content/site/about.md#/frontmatter/heading', { value: 'Tea * biscuits' }]]), {});
  assert.deepEqual(g.body.edits.map(e => e.value), ['Tea \\* biscuits', 'Tea * biscuits']);
});

// ─── Read-only, and why ──────────────────────────────────────────────────────

const field = (r, more = {}) => ({ parsed: ref(r), tag: 'P', caps: { source: true, legacy: false, adapters: ['astro'] }, paths: [''], adapter: 'astro', plain: true, ...more });

test('read-only: what cannot be edited is known before anyone types, with a sentence that says why', () => {
  assert.equal(lockReason(field('src/content/events/one.md#/frontmatter/title')), null);
  assert.equal(lockReason(field('src/content/events/one.mdx#/frontmatter/title')), null);
  assert.equal(lockReason(field('src/content/site/about.md#/body', { tag: 'DIV', plain: true })), null);
  // formatting in an entry's text
  assert.match(lockReason(field('src/content/events/one.md#/body', { tag: 'DIV', plain: false })), /^This text has formatting/);
  // the site's configuration, a page template, anything that is not a content file
  for (const r of ['astro.config.mjs#/body', 'src/pages/index.astro#/body', 'package.json#/data/name', 'src/lib/site.ts#/data/name']) {
    assert.equal(lockReason(field(r)), 'This is kept in one of the site’s own files, which Kiln never changes, so it can’t be edited here. Ask the site’s owner.');
  }
  // an .mdx file's text is code
  assert.match(lockReason(field('src/content/events/one.mdx#/body', { tag: 'DIV' })), /written as code/);
  // a picture, and a link whose words are a label and not its address
  assert.match(lockReason(field('src/content/events/one.md#/frontmatter/image?type=image', { tag: 'IMG' })), /^Pictures that come from/);
  assert.match(lockReason(field('src/content/events/one.md#/frontmatter/image', { tag: 'IMG' })), /^Pictures that come from/);
  assert.match(lockReason(field('src/content/events/one.md#/frontmatter/tickets?type=url', { tag: 'A' })), /^This link’s address/);
  assert.equal(lockReason(field('src/content/events/one.md#/frontmatter/tickets?type=url', { tag: 'SPAN' })), null, 'an address shown as words can be edited');
  // a folder this person was not given
  const scoped = { paths: ['src/content/events'] };
  assert.equal(lockReason(field('src/content/events/one.md#/frontmatter/title', scoped)), null);
  assert.equal(lockReason(field('src/content/site/home.md#/frontmatter/heading', scoped)), 'You have not been given this part of the site to edit. Ask the site’s owner if it needs changing.');
  assert.equal(lockReason(field('src/content/events2/one.md#/frontmatter/title', scoped)), 'You have not been given this part of the site to edit. Ask the site’s owner if it needs changing.');
  // a worker from before source mode, or one that could not be asked
  assert.equal(lockReason(field('src/content/events/one.md#/frontmatter/title', { caps: { source: false, legacy: true, adapters: [] } })), 'This page can’t be edited yet. The site’s owner needs to update Kiln first.');
  // a stamp that is not a reference
  assert.match(lockReason({ parsed: null }), /^This text can’t be edited here\./);
  // an adapter this editor does not know: file kinds are left to the worker
  assert.equal(lockReason(field('content/posts/a.toml#/data/title', { adapter: 'hugo' })), null);
  // none of them blames, shouts or uses a dash for punctuation
  for (const f of [field('a.astro#/body'), field('a.md#/body', { plain: false }), field('a.md#/frontmatter/x', { tag: 'IMG' }), { parsed: null }]) {
    assert.equal(/[!—–]| - /.test(lockReason(f)), false);
  }
});

test('read-only: a click says the sentence where a phone can see it, not only in a tooltip', () => {
  const lock = main.slice(main.indexOf('function lockSourceField('), main.indexOf('function decorateSourceField('));
  assert.match(lock, /el\.addEventListener\('click', \(e\) => \{/);
  assert.match(lock, /setStatus\(why, 'idle', \{ hold: 9000 \}\);/);
  assert.equal(/Image source fields aren’t editable yet/.test(main), false);
  assert.equal(/its source reference is malformed/.test(main), false);
  // a page where nothing can be edited says so at once
  const init = main.slice(main.indexOf('async function initSourceFields('), main.indexOf('async function fetchSourceCaps('));
  assert.match(init, /lockReason\(\{ parsed: f\.parsed, tag: el\.tagName, caps: state\.sourceCaps, paths: state\.scope\?\.paths, adapter: cfg\.adapter \|\| 'astro', plain: !!plainBody\(el\)(?: \|\| \(!isBody\(f\.parsed\) && !el\.children\.length\))?,\s+seat: isSuggestMode\(\) \? 'suggest' : null(?:, rich)? \}\)/);
});

// ─── Not saved, and why ──────────────────────────────────────────────────────

test('refused: the worker\'s words are told as sentences', () => {
  assert.equal(skipSentence('needs to be a date, like 2026-09-20'), 'This needs to be a date written like 2026-09-20.');
  assert.equal(skipSentence('needs to be a time, like 14:30'), 'This needs to be a time written like 14:30.');
  assert.equal(skipSentence('needs to be a number'), 'This needs to be a number, such as 120.');
  assert.equal(skipSentence('needs to be true or false'), 'This needs to be yes or no.');
  assert.equal(skipSentence('not a safe URL'), 'This needs to be a web address that starts with https://, or a page of this site such as /about.');
  assert.equal(skipSentence('value may not contain script markup'), 'It can’t contain code, such as a script tag.');
  assert.equal(skipSentence('pointer not found in source'), 'The site’s content no longer has this, so reload the page to see how it is now.');
  assert.equal(skipSentence('type mismatch'), 'This holds something other than words, so it can’t be changed here.');
  assert.equal(skipSentence('something new'), 'The site did not accept it.');
  assert.equal(refusalSentence(400, 'file type not editable by this adapter'), 'This is kept in one of the site’s own files, which Kiln never changes.');
  assert.equal(refusalSentence(403, 'forbidden path for editor'), 'This is kept in one of the site’s own files, which Kiln never changes.');
  assert.equal(refusalSentence(403, 'outside your editing scope'), 'You have not been given this part of the site to edit.');
  assert.equal(refusalSentence(404, 'That content file no longer exists — the page may have been rebuilt since you loaded it. Reload.'), 'The site’s content no longer has this, so reload the page to see how it is now.');
  assert.equal(refusalSentence(403, 'suggest-mode: source edits can’t be proposed yet'), 'You can suggest changes, but on this site a suggestion can’t yet be made to this kind of text. Ask the site’s owner to make the change.');
  assert.equal(refusalSentence(409, 'conflict: the file changed while saving — try again'), 'Someone else saved a change at the same moment, so please publish again.');
  // anything else is not one of these: the caller says it the way every other failure is said
  assert.equal(refusalSentence(502, 'commit failed'), null);
  assert.equal(refusalSentence(401, 'unauthorized'), null);
});

test('refused: what was not saved is on screen after a publish, beside what was', () => {
  const pub = main.slice(main.indexOf('async function publishSource('), main.indexOf('const SOURCE_POLL_MS'));
  // no raw answer in the status line
  assert.equal(/setStatus\(firstError, 'error'\)/.test(pub), false);
  assert.match(pub, /notSaved\.push\(\{ ref, label: sourceName\(ref\), why \}\);/);
  assert.match(pub, /showNotSaved\(notSaved\);/);
  // the note stays while the site rebuilds: it is its own box, not the status line
  assert.match(main, /function showNotSaved\(list\) \{/);
  assert.match(main, /bar\.id = 'kiln-srcskip';/);
});

// ─── Saved, building, published ──────────────────────────────────────────────

test('building: the line says the change is saved, and never that it is published before the build says so', () => {
  assert.equal(SAVED_BUILDING_COPY, 'Saved. The site is rebuilding with your change…');
  assert.equal(BUILD_FAILED_COPY, 'Build failed. Your change is saved but not live.');
  const watch = main.slice(main.indexOf('function watchSourceBuild('), main.indexOf('function sourceBuildFailedBanner('));
  assert.match(watch, /setStatus\(SAVED_BUILDING_COPY, 'saving'\);/);
  assert.equal(/setStatus\('Building…'/.test(main), false);
  // "Published" is said in exactly one place: when the build has reported success
  assert.equal((watch.match(/Published ✓/g) || []).length, 1);
  assert.match(watch, /if \(verdict === 'published'\) \{ forgetBuild\(sha\); setStatus\('Published ✓', 'saved'\);/);
});

test('building: the first-session card says saved, not published, on a site that has to rebuild', () => {
  const card = guideCardCopy({ invited: true, source: true });
  assert.equal(card.title, 'That is saved');
  assert.match(card.sub, /rebuilding/);
  assert.equal(/published|ten seconds|undo/i.test(card.title + card.sub), false);
  assert.equal(card.diff, true);
  // and a site whose page is the file keeps the card it had
  assert.equal(guideCardCopy({ invited: true }).title, 'That is published');
  // the guide hears about a publish to content files, so it does not go back to its first step
  const pub = main.slice(main.indexOf('async function publishSource('), main.indexOf('const SOURCE_POLL_MS'));
  assert.match(pub, /if \(told\) guidePublished\(\{ \.\.\.told, source: true \}\);/);
});

test('building: a failed build names what was changed, and Undo brings the edit back as unpublished', () => {
  const banner = main.slice(main.indexOf('function sourceBuildFailedBanner('), main.indexOf('// ─── §7.3'));
  // the link to the commit on GitHub is for the owner, who can open it
  assert.match(banner, /mode === 'admin' \? `/);
  // rows are named as the person knows them
  assert.match(banner, /c\.refs\.map\(r => sourceName\(r\.ref\)\)/);
  assert.equal(/<span>\$\{escapeHtml\(c\.file\)\}<\/span>/.test(banner), false);
  // after the undo, the words are on the page as an unpublished edit
  assert.match(banner, /restageAfterUndo\(c\);/);
  assert.equal(/ — /.test(banner), false, 'a dash used as punctuation');
});

test('building: a publish is remembered, so a reload while the site rebuilds does not look like a lost change', () => {
  const committed = [
    { file: 'src/content/events/one.md', sha: 'a'.repeat(40), parent: 'p'.repeat(40), refs: [{ ref: 'src/content/events/one.md#/frontmatter/title', value: 'New', was: 'Old' }] },
    { file: 'src/content/site/home.md', sha: 'b'.repeat(40), parent: 'a'.repeat(40), refs: [{ ref: 'src/content/site/home.md#/frontmatter/intro', value: 'Hi', was: 'Hello' }] },
  ];
  const rec = buildRecord(committed, 1000);
  assert.equal(rec.sha, 'b'.repeat(40));
  assert.equal(rec.at, 1000);
  assert.deepEqual(rec.files, committed);
  assert.equal(buildRecord([], 1000), null);
  // watched for five minutes, kept for half an hour, then forgotten
  assert.equal(BUILD_WATCH_MS, 5 * 60 * 1000);
  assert.equal(buildStanding(rec, 1000 + 60 * 1000), 'building');
  assert.equal(buildStanding(rec, 1000 + BUILD_WATCH_MS + 1), 'late');
  assert.equal(buildStanding(rec, 1000 + BUILD_KEPT_MS + 1), 'gone');
  assert.equal(buildStanding(null, 0), 'gone');
  assert.equal(buildStanding({ sha: 1 }, 0), 'gone');
  // what the page shows now decides what to do with each value
  const shown = new Map([['src/content/events/one.md#/frontmatter/title', 'Old']]);
  assert.deepEqual(resumePlan(rec, (r) => shown.get(r)), { show: [{ ref: 'src/content/events/one.md#/frontmatter/title', value: 'New', was: 'Old' }], waiting: true });
  // the rebuilt page already has it: nothing to show, nothing to wait for
  shown.set('src/content/events/one.md#/frontmatter/title', 'New');
  assert.deepEqual(resumePlan(rec, (r) => shown.get(r)), { show: [], waiting: false });
  // the page shows something else again (someone changed it since): left as it is
  shown.set('src/content/events/one.md#/frontmatter/title', 'Theirs');
  assert.deepEqual(resumePlan(rec, (r) => shown.get(r)), { show: [], waiting: false });
  // wired in: written at publish, read when the fields are set up
  assert.match(main, /rememberBuild\(committed\);/);
  assert.match(main, /resumeSourceBuilds\(\);/);
});

// ─── A page with no file of its own ──────────────────────────────────────────

test('no page file: History, Page settings and the scope note say what is true on a page built from content files', () => {
  const hist = main.slice(main.indexOf('async function historyPanel('), main.indexOf('async function undoCommit('));
  assert.match(hist, /if \(!cfg\.sandbox && !state\.page\.path\) \{/);
  const ps = main.slice(main.indexOf('function pageSettingsPanel('), main.indexOf('function pageSettingsPanel(') + 900);
  assert.match(ps, /if \(!cfg\.sandbox && !state\.page\.path\) \{/);
  // no request for a draft of a page that has no file
  const draft = main.slice(main.indexOf('async function checkForDraft('), main.indexOf('async function checkForDraft(') + 300);
  assert.match(draft, /if \(!state\.page\.path\) return;/);
  // "Read-only here" is for a page where this person can edit nothing
  const decorate = main.slice(main.indexOf('function decorateFields('), main.indexOf('function decorateFields(') + 500);
  assert.match(decorate, /if \(mode === 'editor' && state\.page\.path && !pageInScope\(\)\) \{ renderScopeNote\(\); return; \}/);
});
