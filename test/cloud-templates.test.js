/**
 * Page templates when Kiln is added to a site (worker/prepare.js: readPages,
 * isPageTemplate, isWholePage; worker/lookafter.js: planCharset; and the
 * setup tool's pageTemplates in cli/index.mjs).
 *
 * A site keeps the templates the editor's "New post or page" makes pages from
 * in _templates/. Adding Kiln and the character-set step passed that folder
 * over, so a new page had no Kiln script tags (the Kiln button never came up
 * on it) and no character-set line (its accents came out as other letters on
 * Kiln's hosting). A template that is a whole page now gets the same lines as
 * a page, in the same commits. A template that is a piece of a page is left
 * exactly as it is, and the first pass at what can be edited marks no template.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPrepare, applyPrepare, publicPlan, isSitePage, isPageTemplate, isWholePage, withKilnTags, KILN_TAGS } from '../worker/prepare.js';
import { planCharset, applyCharset, withCharset, CHARSET_TAG } from '../worker/lookafter.js';
import { planFirstPass, applyFirstPass } from '../worker/firstpass.js';
import { autotag } from '../src/autotag.js';
import { withFetch, jsonRes } from './worker-harness.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = 'ada/club';
const AUTHOR = { name: 'ada', email: 'ada@users.noreply.github.com' };
const page = (title) => `<!doctype html>\n<html lang="en">\n<head>\n  <title>${title}</title>\n</head>\n<body>\n  <h1>${title}</h1>\n  <p>Words about ${title} that its owner will want to change one day.</p>\n</body>\n</html>\n`;
const PAGE_TPL = `<!doctype html>\n<html lang="en">\n<head>\n  <title>{{title}} — The Club</title>\n</head>\n<body>\n  <nav><a href="/">Home</a></nav>\n  <h1>{{title}}</h1>\n  <p>Start writing here.</p>\n</body>\n</html>\n`;
const POST_TPL = PAGE_TPL.replace('<p>Start writing here.</p>', '<article>\n    <p>{{body}}</p>\n  </article>');
const CARD = '<article class="post-card">\n  <h3><a href="{{url}}">{{title}}</a></h3>\n  <p>{{excerpt}}</p>\n</article>\n';
const NOTE = '<!-- goes inside the <body> of a page, under its <head> -->\n<aside class="note"><p>{{note}}</p></aside>\n';
const SITE = {
  'index.html': page('Home'), 'about.html': page('About'), 'blog/index.html': page('Journal'),
  '_templates/page.html': PAGE_TPL, '_templates/post.html': POST_TPL, '_templates/post-card.html': CARD, '_templates/note.html': NOTE,
  'assets/site.css': 'body { margin: 0 }\n',
};
const TEMPLATES = ['_templates/page.html', '_templates/post.html'];
const PIECES = ['_templates/post-card.html', '_templates/note.html'];

/** A repository at GitHub, as the service's requests see it, all in memory. */
function fakeSite(files) {
  const blobs = new Map(), trees = new Map(), commits = new Map(), made = [];
  let n = 0, head = 'c0';
  const put = (text) => { const sha = `b${++n}`; blobs.set(sha, text); return sha; };
  trees.set('t0', new Map(Object.entries(files).map(([p, text]) => [p, put(text)])));
  commits.set('c0', { tree: 't0', parents: [] });
  const handler = async (url, init) => {
    if (url.startsWith('https://release.example/')) return new Response(`// ${url.split('/').pop()}\n`);
    const m = /^https:\/\/api\.github\.com\/repos\/ada\/club(.*)$/.exec(url);
    if (!m) return undefined;
    const at = m[1], body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    let x;
    if (init.method === 'GET' && at === '') return jsonRes({ default_branch: 'main', id: 1 });
    if (init.method === 'GET' && at === '/git/ref/heads/main') return jsonRes({ object: { sha: head } });
    if (init.method === 'GET' && (x = /^\/git\/commits\/(\w+)$/.exec(at))) return jsonRes({ tree: { sha: commits.get(x[1]).tree } });
    if (init.method === 'GET' && (x = /^\/git\/trees\/(\w+)\?recursive=1$/.exec(at))) {
      return jsonRes({ tree: [...trees.get(x[1])].map(([p, sha]) => ({ type: 'blob', path: p, sha, mode: '100644', size: Buffer.byteLength(blobs.get(sha)) })) });
    }
    if (init.method === 'GET' && (x = /^\/git\/blobs\/(\w+)$/.exec(at))) return new Response(blobs.get(x[1]));
    if (init.method === 'POST' && at === '/git/blobs') return jsonRes({ sha: put(Buffer.from(body.content, 'base64').toString('utf8')) }, 201);
    if (init.method === 'POST' && at === '/git/trees') {
      const next = new Map(trees.get(body.base_tree));
      for (const e of body.tree) next.set(e.path, e.sha || put(e.content));
      const sha = `t${++n}`; trees.set(sha, next); return jsonRes({ sha }, 201);
    }
    if (init.method === 'POST' && at === '/git/commits') { const sha = `c${++n}`; commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message }); made.push(sha); return jsonRes({ sha }, 201); }
    if (init.method === 'PATCH' && at === '/git/refs/heads/main') { head = body.sha; return jsonRes({}); }
    return undefined;
  };
  const live = () => trees.get(commits.get(head).tree);
  return {
    handler, made, commits,
    read: (p) => (live().has(p) ? blobs.get(live().get(p)) : undefined),
    /** The paths a commit changed or added, compared with the commit before it. */
    changedBy(sha) { const c = commits.get(sha), was = trees.get(commits.get(c.parents[0]).tree); return [...trees.get(c.tree)].filter(([p, s]) => was.get(p) !== s).map(([p]) => p).sort(); },
  };
}
const ask = { token: 'installation-token', repo: REPO, worker: 'https://auth.kilncms.com' };

test('templates: which files are page templates, and which of those are whole pages', () => {
  for (const p of ['_templates/page.html', '_templates/post.html', 'blog/_templates/entry.html', 'lists/public/_templates/x.html']) assert.equal(isPageTemplate(p), true, p);
  for (const p of ['index.html', 'blog/post.html', '_templates/readme.md', '_templates/kiln.html', '_templates/.draft.html', 'node_modules/pkg/_templates/a.html',
    '.cache/_templates/a.html', 'dist/_templates/a.html', 'public/_templates/a.html', 'templates/page.html']) assert.equal(isPageTemplate(p), false, p);
  // A template is still not one of the site's pages: nothing counts it as a page or marks it.
  for (const p of TEMPLATES) assert.equal(isSitePage(p), false, p);

  for (const html of [PAGE_TPL, POST_TPL, '<html><p>x</p></html>', '<HEAD><title>x</title></HEAD><p>x</p>', '<body class="post">\n<p>x</p>\n</body>']) assert.equal(isWholePage(html), true, html.slice(0, 30));
  for (const html of [CARD, NOTE, '', '<header><h1>x</h1></header>', '<p>The &lt;body&gt; of the letter</p>', '<thead><tr><th>x</th></tr></thead>']) assert.equal(isWholePage(html), false, html.slice(0, 30));
});

test('templates: adding Kiln gives a whole-page template the two lines in the same commit, names it as a template, and leaves a piece of a page as it is', async () => {
  const gh = fakeSite(SITE);
  await withFetch(gh.handler, async () => {
    const plan = await planPrepare(ask);
    assert.equal(plan.state, 'ready');
    assert.deepEqual(plan.changes.map(c => c.path), ['about.html', 'blog/index.html', 'index.html']);
    assert.deepEqual(plan.templates.changes.map(c => c.path), TEMPLATES);
    // What the dashboard is shown: pages are counted as pages, templates as templates.
    const shown = publicPlan(plan, { repo: REPO });
    assert.deepEqual([shown.pages.total, shown.pages.add, shown.pages.add_names], [3, 3, ['about.html', 'blog/index.html', 'index.html']]);
    assert.deepEqual(shown.templates, { already: 0, add: 2, add_names: TEMPLATES, skipped: [] });
    assert.ok(!JSON.stringify(shown).includes('post-card') && !JSON.stringify(shown).includes('note.html'));

    const done = await applyPrepare({ ...ask, plan, author: AUTHOR, releaseBase: 'https://release.example' });
    assert.deepEqual([done.pages, done.templates], [3, 2]);
    assert.equal(gh.made.length, 1, 'one commit');
    const changed = gh.changedBy(gh.made[0]);
    for (const p of [...TEMPLATES, 'index.html', 'about.html', 'blog/index.html', 'assets/kiln.js', 'kiln.html']) assert.ok(changed.includes(p), p);
    for (const p of PIECES) assert.ok(!changed.includes(p), p);
    assert.match(gh.commits.get(gh.made[0]).message, /^Add Kiln to this site\n\n3 pages now load the editor\. 2 page templates now load the editor too, so a new page made from one can be edited\. Added from the Kiln dashboard by ada\.$/);

    // The template is the template it was, with the two lines before </body> and nothing else changed.
    assert.equal(gh.read('_templates/page.html'), PAGE_TPL.replace('</body>', `${KILN_TAGS[0]}\n${KILN_TAGS[1]}\n</body>`));
    assert.equal(gh.read('_templates/post-card.html'), CARD);
    assert.equal(gh.read('_templates/note.html'), NOTE);
    // So a page the editor makes from it loads the editor.
    const made = gh.read('_templates/page.html').replaceAll('{{title}}', 'L’été d’Émile');
    assert.equal(withKilnTags(made).state, 'already');

    // Asked again, nothing is left to do.
    const again = await planPrepare(ask);
    assert.equal(again.state, 'prepared');
    assert.deepEqual([again.templates.already, again.templates.changes.length], [2, 0]);
    assert.deepEqual(publicPlan(again, { repo: REPO }).templates, { already: 2, add: 0, add_names: [], skipped: [] });
  });
});

test('templates: a site that had Kiln added before this, with templates passed over, is offered the templates alone', async () => {
  const tagged = (html) => withKilnTags(html).html;
  const gh = fakeSite({
    ...SITE, 'index.html': tagged(page('Home')), 'about.html': tagged(page('About')), 'blog/index.html': tagged(page('Journal')),
    'assets/kiln.js': '//', 'assets/kiln-editor.js': '//', 'assets/kiln-features.js': '//', 'assets/kiln-config.js': "window.KILN = { worker: 'https://auth.kilncms.com' };", 'kiln.html': '<html></html>', '_headers': '/*',
  });
  await withFetch(gh.handler, async () => {
    const plan = await planPrepare(ask);
    assert.equal(plan.state, 'ready');
    const shown = publicPlan(plan, { repo: REPO });
    assert.deepEqual([shown.pages.add, shown.pages.already, shown.files.add], [0, 3, []]);
    assert.deepEqual(shown.templates.add_names, TEMPLATES);
    await applyPrepare({ ...ask, plan, author: AUTHOR, releaseBase: 'https://release.example' });
    assert.deepEqual(gh.changedBy(gh.made[0]), TEMPLATES);
    assert.match(gh.commits.get(gh.made[0]).message, /\n\n2 page templates now load the editor too/);
  });
  // A template with no </body> cannot be given the lines: it is named, as a template, and left alone.
  const odd = fakeSite({ 'index.html': page('Home'), '_templates/page.html': '<html><head><title>{{title}}</title></head><h1>{{title}}</h1>' });
  await withFetch(odd.handler, async () => {
    const shown = publicPlan(await planPrepare(ask), { repo: REPO });
    assert.deepEqual(shown.templates, { already: 0, add: 0, add_names: [], skipped: [{ path: '_templates/page.html', why: 'no_body' }] });
    assert.equal(shown.pages.skipped_count, 0);
  });
  // A site with no templates is shown nothing about templates.
  const plain = fakeSite({ 'index.html': page('Home') });
  await withFetch(plain.handler, async () => assert.equal('templates' in publicPlan(await planPrepare(ask), { repo: REPO }), false));
});

test('templates: the character-set step gives a whole-page template the line too, in the same commit as the pages, and not a piece of a page', async () => {
  const gh = fakeSite(SITE);
  await withFetch(gh.handler, async () => {
    const plan = await planCharset(ask);
    assert.equal(plan.state, 'ready');
    assert.deepEqual(plan.changes.map(c => c.path), ['about.html', 'blog/index.html', 'index.html']);
    assert.deepEqual(plan.templates.changes.map(c => c.path), TEMPLATES);
    const done = await applyCharset({ ...ask, plan, author: AUTHOR });
    assert.deepEqual([done.pages, done.templates], [3, 2]);
    assert.equal(gh.made.length, 1);
    assert.deepEqual(gh.changedBy(gh.made[0]), [...TEMPLATES, 'about.html', 'blog/index.html', 'index.html'].sort());
    assert.match(gh.commits.get(gh.made[0]).message, /3 pages now say they are written in UTF-8 \(<meta charset="utf-8">, first in the head\)\. 2 page templates now say so too, so a new page made from one reads as it should\. /);
    assert.equal(gh.read('_templates/page.html'), PAGE_TPL.replace('<head>\n', `<head>\n  ${CHARSET_TAG}\n`));
    for (const p of PIECES) assert.equal(gh.read(p), SITE[p], p);
    // The page the tester made: its title has accents and a dash from the template, and it now says how it is written.
    assert.equal(withCharset(gh.read('_templates/page.html').replaceAll('{{title}}', 'qa-L’été d’Émile à Noël')).state, 'already');
    const again = await planCharset(ask);
    assert.deepEqual([again.state, again.templates.already], ['nothing', 2]);
  });
  // Pages that already say it, templates that do not: the templates alone are a reason for the commit.
  const said = (html) => withCharset(html).html;
  const late = fakeSite({ ...SITE, 'index.html': said(page('Home')), 'about.html': said(page('About')), 'blog/index.html': said(page('Journal')) });
  await withFetch(late.handler, async () => {
    const plan = await planCharset(ask);
    assert.deepEqual([plan.state, plan.changes.length, plan.templates.changes.length], ['ready', 0, 2]);
    await applyCharset({ ...ask, plan, author: AUTHOR });
    assert.deepEqual(late.changedBy(late.made[0]), TEMPLATES);
    assert.match(late.commits.get(late.made[0]).message, /\n\n2 page templates now say they are written in UTF-8/);
    assert.doesNotMatch(late.commits.get(late.made[0]).message, /0 pages/);
  });
});

test('templates: the first pass at what can be edited still marks no template', async () => {
  // The pass would find things to mark in a template if it were handed one.
  assert.notEqual(autotag(PAGE_TPL).html, PAGE_TPL);
  const gh = fakeSite(SITE);
  await withFetch(gh.handler, async () => {
    const plan = await planFirstPass(ask);
    assert.equal(plan.state, 'ready');
    assert.ok(plan.changes.length > 0);
    assert.deepEqual(plan.changes.filter(c => c.path.includes('_templates')), []);
    assert.equal(plan.pages.total, 3);
    await applyFirstPass({ ...ask, plan, author: AUTHOR });
    assert.equal(gh.made.length, 1);
    assert.deepEqual(gh.changedBy(gh.made[0]).filter(p => p.includes('_templates')), []);
    for (const p of [...TEMPLATES, ...PIECES]) assert.equal(gh.read(p), SITE[p], p);
    assert.match(gh.read('index.html'), /data-cms/);
  });
});

test('templates: the setup tool finds the same templates by the same rule', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'index.mjs'), 'utf8');
  const service = fs.readFileSync(path.join(ROOT, 'worker', 'prepare.js'), 'utf8');
  const rule = /const WHOLE_PAGE = (\/.+\/i);/;
  assert.equal(cli.match(rule)[1], service.match(rule)[1], 'the same line says what a whole page is');
  // The tool's own function, run on a folder of files.
  const source = cli.slice(cli.indexOf('function pageTemplates('), cli.indexOf('/**\n * A page with the two script tags'));
  const pageTemplates = new Function('readdirSync', 'readFileSync', 'path', `const WHOLE_PAGE = ${cli.match(rule)[1]};\n${source}\nreturn pageTemplates;`)(fs.readdirSync, fs.readFileSync, path);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-templates-'));
  try {
    const files = { ...SITE, 'blog/_templates/entry.html': PAGE_TPL, 'node_modules/pkg/_templates/a.html': PAGE_TPL, 'dist/_templates/a.html': PAGE_TPL, 'public/_templates/a.html': PAGE_TPL, '_templates/kiln.html': PAGE_TPL, '_templates/notes.md': '# notes' };
    for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
    const found = pageTemplates(dir).map(f => path.relative(dir, f).split(path.sep).join('/'));
    assert.deepEqual(found, ['_templates/page.html', '_templates/post.html', 'blog/_templates/entry.html']);
    // The service picks the same files out of the same list.
    assert.deepEqual(Object.keys(files).filter(p => isPageTemplate(p) && isWholePage(files[p])).sort(), found);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // The wizard hands them to the same step that gives pages their two lines, and says which are templates.
  assert.match(cli, /for \(const f of \[\.\.\.pages, \.\.\.templates\]\)/);
  assert.match(cli, /\(a page template: new pages are made from it\)/);
});
