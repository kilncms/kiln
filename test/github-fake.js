/**
 * An in-memory GitHub for one repository, with a real git object model: blobs,
 * trees, commits, branches and tags, content-addressed, and the REST endpoints
 * the worker and the editor transport use (contents, git data, refs, compare,
 * branches). Fast-forward rules are enforced the way GitHub enforces them.
 *
 * It lets a test drive the REAL worker handlers and the REAL editor transport
 * (src/github.js) through whole publishes, and then look at what the
 * repository holds. Not a test file.
 */
import { createHash } from 'node:crypto';

const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const jsonRes = (obj, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const notFound = () => jsonRes({ message: 'Not Found' }, 404);

export function fakeGitHub({ repo = 'acme/site', files = {}, defaultBranch = 'main', author = { name: 'Site Owner', email: 'owner@example.com' } } = {}) {
  const blobs = new Map();     // sha → Buffer
  const trees = new Map();     // sha → Map(path → { mode, sha })
  const commits = new Map();   // sha → { tree, parents, author, message }
  const refs = new Map();      // 'heads/main' | 'tags/x' → commit sha
  const calls = [];
  let fail = null;             // (method, path) => true to answer 500
  let afterWrite = null;       // called after every successful write (to simulate someone else)

  const putBlob = (buf) => { const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf); const s = sha1(`blob ${b.length}\0${b.toString('latin1')}`); blobs.set(s, b); return s; };
  const putTree = (map) => { const s = sha1('tree ' + [...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, e]) => `${e.mode} ${p}\0${e.sha}`).join('\n')); trees.set(s, new Map(map)); return s; };
  const putCommit = (c) => { const s = sha1(`commit ${JSON.stringify(c)} ${commits.size}`); commits.set(s, c); return s; };
  const isAncestor = (a, b) => { const seen = new Set(); const todo = [b]; while (todo.length) { const x = todo.pop(); if (x === a) return true; if (seen.has(x)) continue; seen.add(x); todo.push(...(commits.get(x)?.parents || [])); } return false; };
  /** A branch name, tag name or commit sha → commit sha (or null). */
  const resolve = (ref) => commits.has(ref) ? ref : refs.get(`heads/${ref}`) || refs.get(`tags/${ref}`) || refs.get(ref) || null;
  const treeOf = (ref) => { if (trees.has(ref)) return trees.get(ref); const c = resolve(ref); return c ? trees.get(commits.get(c).tree) : null; };
  const listing = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, e]) => ({ path, mode: e.mode, type: 'blob', sha: e.sha, size: blobs.get(e.sha).length }));

  const seed = new Map(Object.entries(files).map(([p, text]) => [p, { mode: '100644', sha: putBlob(text) }]));
  refs.set(`heads/${defaultBranch}`, putCommit({ tree: putTree(seed), parents: [], author, message: 'site' }));

  const api = {
    repo, blobs, trees, commits, refs, calls,
    head: (branch = defaultBranch) => refs.get(`heads/${branch}`),
    read: (path, ref = defaultBranch) => { const e = treeOf(ref)?.get(path); return e ? blobs.get(e.sha).toString('utf8') : null; },
    paths: (ref = defaultBranch) => [...(treeOf(ref) || new Map()).keys()].sort(),
    /** A commit made outside the test's subject (the owner pushing, say). */
    commit: (changes, { branch = defaultBranch, by = author, message = 'outside change' } = {}) => {
      const parent = refs.get(`heads/${branch}`);
      const map = new Map(trees.get(commits.get(parent).tree));
      for (const [p, text] of Object.entries(changes)) { if (text === null) map.delete(p); else map.set(p, { mode: '100644', sha: putBlob(text) }); }
      const c = putCommit({ tree: putTree(map), parents: [parent], author: by, message });
      refs.set(`heads/${branch}`, c);
      return c;
    },
    failOn: (fn) => { fail = fn; },
    onWrite: (fn) => { afterWrite = fn; },
    /** A branch pushed anew: exactly these files, as one commit with no parent (what a build's force-push leaves). */
    push: (branch, pushed, { by = author, message = 'pushed' } = {}) => {
      const c = putCommit({ tree: putTree(new Map(Object.entries(pushed).map(([p, text]) => [p, { mode: '100644', sha: putBlob(text) }]))), parents: [], author: by, message });
      refs.set(`heads/${branch}`, c);
      return c;
    },
    /** The marks on a commit (commit statuses), newest first: sha → [{ context, state }]. */
    statuses: new Map(),

    /** The fetch handler: answers https://api.github.com/repos/<repo>/…; anything else is undefined (→ 404 in withFetch). */
    handler: async (url, init = {}) => {
      const base = `https://api.github.com/repos/${repo}`;
      if (!url.startsWith(base)) return undefined;
      const method = (init.method || 'GET').toUpperCase();
      const [rawPath, query = ''] = url.slice(base.length).split('?');
      const path = decodeURIComponent(rawPath);
      const q = new URLSearchParams(query);
      const headers = init.headers || {};
      const accept = headers.Accept || headers.accept || '';
      const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : {};
      calls.push({ method, path, auth: headers.Authorization || headers.authorization || '', body });
      if (fail && fail(method, path)) return jsonRes({ message: 'Server Error' }, 500);
      const wrote = (res) => { if (afterWrite) { const f = afterWrite; afterWrite = null; f(api); afterWrite = afterWrite || f; } return res; };
      let m;

      if (path === '' && method === 'GET') return jsonRes({ full_name: repo, default_branch: defaultBranch, permissions: { push: true, admin: false } });
      if (path === '/branches' && method === 'GET') return jsonRes([...refs].filter(([k]) => k.startsWith('heads/')).map(([k, s]) => ({ name: k.slice(6), commit: { sha: s } })));

      if ((m = /^\/contents\/(.+)$/.exec(path))) {
        const file = m[1];
        if (method === 'HEAD') return treeOf(q.get('ref') || defaultBranch)?.get(file) ? new Response(null, { status: 200 }) : notFound();
        if (method === 'GET') {
          const e = treeOf(q.get('ref') || defaultBranch)?.get(file);
          if (!e) return notFound();
          return jsonRes({ type: 'file', path: file, sha: e.sha, size: blobs.get(e.sha).length, encoding: 'base64', content: blobs.get(e.sha).toString('base64').replace(/(.{60})/g, '$1\n') });
        }
        if (method === 'DELETE') {
          const branch = body.branch || defaultBranch;
          const parent = refs.get(`heads/${branch}`);
          if (!parent) return jsonRes({ message: `Branch ${branch} not found` }, 404);
          const map = new Map(trees.get(commits.get(parent).tree));
          const had = map.get(file);
          if (!had) return notFound();
          if (body.sha !== had.sha) return jsonRes({ message: `${file} does not match ${body.sha}` }, 409);
          map.delete(file);
          const c = putCommit({ tree: putTree(map), parents: [parent], author: body.author || author, message: body.message });
          refs.set(`heads/${branch}`, c);
          return wrote(jsonRes({ content: null, commit: { sha: c, parents: [{ sha: parent }] } }));
        }
        if (method === 'PUT') {
          const branch = body.branch || defaultBranch;
          const parent = refs.get(`heads/${branch}`);
          if (!parent) return jsonRes({ message: `Branch ${branch} not found` }, 404);
          const map = new Map(trees.get(commits.get(parent).tree));
          const had = map.get(file);
          if (had && !body.sha) return jsonRes({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, 422);
          if (had && body.sha !== had.sha) return jsonRes({ message: `${file} does not match ${body.sha}` }, 409);
          if (!had && body.sha) return jsonRes({ message: 'sha given for a file that does not exist' }, 422);
          const blob = putBlob(Buffer.from(body.content, 'base64'));
          map.set(file, { mode: '100644', sha: blob });
          const c = putCommit({ tree: putTree(map), parents: [parent], author: body.author || author, message: body.message });
          refs.set(`heads/${branch}`, c);
          return wrote(jsonRes({ content: { path: file, sha: blob }, commit: { sha: c } }, had ? 200 : 201));
        }
      }

      // The commits that changed one file, newest first (first parents only, as a plain history reads).
      if (path === '/commits' && method === 'GET' && q.get('path')) {
        const file = q.get('path');
        const out = [];
        for (let c = resolve(q.get('sha') || defaultBranch); c && out.length < Number(q.get('per_page') || 30);) {
          const cm = commits.get(c);
          const parent = cm.parents[0];
          // A folder: any file under it changed.
          const under = (t) => JSON.stringify([...t].filter(([p]) => p === file || p.startsWith(`${file}/`)));
          const now = under(trees.get(cm.tree));
          const was = parent ? under(trees.get(commits.get(parent).tree)) : '[]';
          if (now !== was) out.push({ sha: c, parents: cm.parents.map(sha => ({ sha })), commit: { author: { ...cm.author, date: '2026-10-07T12:00:00Z' }, message: cm.message } });
          c = parent;
        }
        return jsonRes(out);
      }
      if ((m = /^\/git\/ref\/(.+)$/.exec(path)) && method === 'GET') return refs.has(m[1]) ? jsonRes({ ref: `refs/${m[1]}`, object: { type: 'commit', sha: refs.get(m[1]) } }) : notFound();
      if ((m = /^\/git\/commits\/(\w+)$/.exec(path)) && method === 'GET') {
        const c = commits.get(m[1]);
        return c ? jsonRes({ sha: m[1], tree: { sha: c.tree }, parents: c.parents.map(sha => ({ sha })), author: c.author, message: c.message }) : notFound();
      }
      if ((m = /^\/git\/trees\/(.+)$/.exec(path)) && method === 'GET') { const t = treeOf(m[1]); return t ? jsonRes({ sha: m[1], tree: listing(t), truncated: false }) : notFound(); }
      if ((m = /^\/git\/blobs\/(\w+)$/.exec(path)) && method === 'GET') {
        const b = blobs.get(m[1]);
        if (!b) return notFound();
        if (/vnd\.github\.raw/.test(accept)) return new Response(b, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'X-GitHub-Media-Type': 'github.v3; param=raw' } });
        return jsonRes({ sha: m[1], size: b.length, encoding: 'base64', content: b.toString('base64') });
      }

      if (path === '/git/blobs' && method === 'POST') return wrote(jsonRes({ sha: putBlob(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')) }, 201));
      if (path === '/git/trees' && method === 'POST') {
        const baseTree = body.base_tree ? treeOf(body.base_tree) : new Map();
        if (!baseTree) return jsonRes({ message: 'base_tree not found' }, 422);
        const map = new Map(baseTree);
        for (const e of body.tree || []) {
          if (e.sha === null) { map.delete(e.path); continue; }
          const blob = typeof e.content === 'string' ? putBlob(e.content) : e.sha;
          if (!blobs.has(blob)) return jsonRes({ message: `tree.sha ${blob} is not a valid blob` }, 422);
          map.set(e.path, { mode: e.mode || '100644', sha: blob });
        }
        return wrote(jsonRes({ sha: putTree(map) }, 201));
      }
      if (path === '/git/commits' && method === 'POST') {
        if (!trees.has(body.tree) || (body.parents || []).some(p => !commits.has(p))) return jsonRes({ message: 'Tree or parent does not exist' }, 422);
        return wrote(jsonRes({ sha: putCommit({ tree: body.tree, parents: body.parents || [], author: body.author || author, message: body.message }) }, 201));
      }
      if (path === '/git/refs' && method === 'POST') {
        const name = String(body.ref || '').replace(/^refs\//, '');
        if (!/^(heads|tags)\/.+/.test(name)) return jsonRes({ message: 'Reference name is not valid' }, 422);
        if (refs.has(name)) return jsonRes({ message: 'Reference already exists' }, 422);
        if (!commits.has(body.sha)) return jsonRes({ message: 'Object does not exist' }, 422);
        refs.set(name, body.sha);
        return wrote(jsonRes({ ref: `refs/${name}`, object: { sha: body.sha } }, 201));
      }
      if ((m = /^\/git\/refs\/(.+)$/.exec(path))) {
        if (!refs.has(m[1])) return jsonRes({ message: 'Reference does not exist' }, 422);
        if (method === 'DELETE') { refs.delete(m[1]); return jsonRes(null, 204); }
        if (method === 'PATCH') {
          if (!commits.has(body.sha)) return jsonRes({ message: 'Object does not exist' }, 422);
          if (!body.force && !isAncestor(refs.get(m[1]), body.sha)) return jsonRes({ message: 'Update is not a fast forward' }, 422);
          refs.set(m[1], body.sha);
          return wrote(jsonRes({ ref: `refs/${m[1]}`, object: { sha: body.sha } }));
        }
      }
      if ((m = /^\/commits\/(\w+)\/statuses$/.exec(path)) && method === 'GET') return jsonRes(api.statuses.get(m[1]) || []);
      if ((m = /^\/compare\/(.+?)\.\.\.(.+)$/.exec(path)) && method === 'GET') {
        const a = resolve(m[1]); const b = resolve(m[2]);
        if (!a || !b) return notFound();
        if (a === b) return jsonRes({ status: 'identical', ahead_by: 0, behind_by: 0, total_commits: 0, commits: [], files: [] });
        if (isAncestor(a, b)) {
          // The commits on the way from a to b (first parents), oldest first, and the files that differ.
          const chain = [];
          for (let c = b; c && c !== a; c = commits.get(c).parents[0]) chain.unshift(c);
          const ta = trees.get(commits.get(a).tree); const tb = trees.get(commits.get(b).tree);
          const files = [...new Set([...ta.keys(), ...tb.keys()])].sort().filter(p => ta.get(p)?.sha !== tb.get(p)?.sha)
            .map(p => ({ filename: p, status: !ta.has(p) ? 'added' : !tb.has(p) ? 'removed' : 'modified' }));
          return jsonRes({ status: 'ahead', ahead_by: chain.length, behind_by: 0, total_commits: chain.length, files,
            commits: chain.map(sha => ({ sha, parents: commits.get(sha).parents.map(p => ({ sha: p })), commit: { author: commits.get(sha).author, message: commits.get(sha).message } })) });
        }
        // Behind, or diverged: how many commits each side has that the other lacks, and the ones `b` is ahead by
        // (first parents, oldest first) with their authors, as GitHub lists them.
        const reach = (x) => { const seen = new Set(); const todo = [x]; while (todo.length) { const c = todo.pop(); if (!c || seen.has(c)) continue; seen.add(c); todo.push(...(commits.get(c)?.parents || [])); } return seen; };
        const ra = reach(a); const rb = reach(b);
        const ahead = [];
        for (let c = b; c && !ra.has(c); c = commits.get(c).parents[0]) ahead.unshift(c);
        return jsonRes({ status: ahead.length ? 'diverged' : 'behind', ahead_by: ahead.length, behind_by: [...ra].filter(c => !rb.has(c)).length, total_commits: ahead.length,
          commits: ahead.map(sha => ({ sha, parents: commits.get(sha).parents.map(p => ({ sha: p })), commit: { author: commits.get(sha).author, message: commits.get(sha).message } })) });
      }
      return notFound();
    },
  };
  return api;
}

/**
 * GitHub's answers about a GitHub App on one person's own account: the
 * account's installation (asked as the App), a token for that installation,
 * and the repositories the installation can reach.
 *
 *   GET  /users/<login>/installation               as the App (a signed JWT)
 *   POST /app/installations/<id>/access_tokens     as the App
 *   GET  /installation/repositories                with a token issued above
 *
 * `repos` are { full_name, private, homepage }. `state` may be changed between
 * calls (state.installed = false, state.repos.push(…)), and `tokens` holds the
 * tokens GitHub still takes (clear it to stand for tokens that have ended).
 * Any other address is undefined, so a test can put another handler after it.
 */
export function fakeInstallation({ login = 'ada', uid = 7, id = 9001, selection = 'selected', repos = [], installed = true } = {}) {
  const state = { login, uid, id, selection, repos: [...repos], installed };
  const calls = [];
  const tokens = new Set();
  let fail = null;             // (method, path) => a status to answer with, or a Response, or 'throw'
  let issued = 0;
  const isJwt = (auth) => /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth);
  return {
    state, calls, tokens,
    failOn: (fn) => { fail = fn; },
    handler: async (url, init = {}) => {
      const base = 'https://api.github.com';
      if (!url.startsWith(`${base}/`)) return undefined;
      const method = (init.method || 'GET').toUpperCase();
      const [rawPath, query = ''] = url.slice(base.length).split('?');
      const path = decodeURIComponent(rawPath);
      const q = new URLSearchParams(query);
      const ours = path.toLowerCase() === `/users/${state.login}/installation`.toLowerCase()
        || path === `/app/installations/${state.id}/access_tokens` || path === '/installation/repositories';
      if (!ours) return undefined;
      const headers = init.headers || {};
      const auth = headers.Authorization || headers.authorization || '';
      const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : {};
      calls.push({ method, path, auth, body });
      const broken = fail ? fail(method, path) : null;
      if (broken === 'throw') throw new TypeError('fetch failed');
      if (broken instanceof Response) return broken;
      if (broken) return jsonRes({ message: 'Server Error' }, Number(broken) || 500);

      if (path === '/installation/repositories' && method === 'GET') {
        if (!tokens.has(auth.replace(/^Bearer /, ''))) return jsonRes({ message: 'Bad credentials' }, 401);
        const per = Math.min(100, Number(q.get('per_page')) || 30);
        const page = Math.max(1, Number(q.get('page')) || 1);
        return jsonRes({ total_count: state.repos.length, repository_selection: state.selection,
          repositories: state.repos.slice((page - 1) * per, page * per).map((r, i) => ({ id: 5000 + (page - 1) * per + i, name: r.full_name.split('/')[1], private: false, homepage: null, ...r })) });
      }
      if (!isJwt(auth)) return jsonRes({ message: 'A JSON web token could not be decoded' }, 401);
      if (!state.installed) return notFound();
      if (method === 'GET' && path !== `/app/installations/${state.id}/access_tokens`) {
        return jsonRes({ id: state.id, account: { login: state.login, id: state.uid, type: 'User' }, target_id: state.uid, target_type: 'User',
          repository_selection: state.selection, html_url: `https://github.com/settings/installations/${state.id}` });
      }
      if (method === 'POST' && path === `/app/installations/${state.id}/access_tokens`) {
        const token = `ghs_list_${++issued}`;
        tokens.add(token);
        return jsonRes({ token, expires_at: '2026-11-13T13:00:00Z', permissions: body.permissions || { contents: 'write', metadata: 'read' }, repository_selection: state.selection }, 201);
      }
      return notFound();
    },
  };
}
