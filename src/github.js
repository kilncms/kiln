/**
 * GitHub transport + file operations for Kiln.
 *
 * Two transports, one interface:
 *   direct — admin with a GitHub App user token; browser → api.github.com
 *   proxy  — invited editor (Google sign-in); browser → kiln-auth worker /gh/* → GitHub
 *            (the worker holds the App installation token and enforces a
 *             per-session repo + path allowlist)
 */

export function makeGh(opts) {
  const { fetchImpl = globalThis.fetch } = opts;

  async function request(method, path, body) {
    let url, headers;
    if (opts.mode === 'proxy') {
      url = `${opts.worker}/gh${path}`;
      headers = { 'X-Kiln-Session': opts.session };
    } else {
      url = `https://api.github.com${path}`;
      headers = { Authorization: `Bearer ${opts.token()}` };
    }
    headers.Accept = 'application/vnd.github+json';
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${data.message || res.statusText}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  return { request };
}

// ─── UTF-8-safe base64 ───────────────────────────────────────────────────────

export function encodeContent(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function decodeContent(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ─── File operations ─────────────────────────────────────────────────────────

export async function getFile(gh, repo, path, ref) {
  const data = await gh.request('GET', `/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  return { text: decodeContent(data.content), sha: data.sha };
}

/** Try candidate paths in order; return the first that exists. */
export async function resolvePageFile(gh, repo, candidates, ref) {
  for (const path of candidates) {
    try {
      const file = await getFile(gh, repo, path, ref);
      return { path, ...file };
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  const err = new Error(`none of [${candidates.join(', ')}] exist in ${repo}@${ref}`);
  err.status = 404;
  throw err;
}

export async function putFile(gh, repo, path, { text, sha, branch, message }) {
  return gh.request('PUT', `/repos/${repo}/contents/${encodePath(path)}`, {
    message,
    content: encodeContent(text),
    sha,
    branch,
  });
}

export async function putBinaryFile(gh, repo, path, { base64, branch, message, sha }) {
  const body = { message, content: base64, branch };
  if (sha) body.sha = sha;
  return gh.request('PUT', `/repos/${repo}/contents/${encodePath(path)}`, body);
}

/**
 * Edit-with-retry: fetch → transform(text) → PUT with sha. If GitHub reports a
 * sha conflict (someone else committed between our read and write), refetch and
 * re-apply the transform against the fresh source. The transform re-locates
 * fields by key, so concurrent edits to *different* fields merge cleanly.
 */
export async function editFile(gh, repo, path, branch, transform, message, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const { text, sha } = await getFile(gh, repo, path, branch);
    const next = transform(text);
    if (next === text) return { unchanged: true };
    try {
      const res = await putFile(gh, repo, path, { text: next, sha, branch, message });
      return { unchanged: false, commit: res.commit, text: next };
    } catch (err) {
      lastErr = err;
      const conflict = err.status === 409 || (err.status === 422 && /sha/i.test(err.data?.message || ''));
      if (!conflict) throw err;
    }
  }
  throw lastErr;
}

/**
 * Atomic multi-file commit via the Git Data API (used for "new blog post":
 * the post file + the updated index land as ONE commit, so the site never
 * deploys in a half-written state).
 * files: [{ path, text } | { path, base64 }]
 */
export async function commitFiles(gh, repo, branch, files, message) {
  const ref = await gh.request('GET', `/repos/${repo}/git/ref/${encodeURIComponent('heads/' + branch)}`);
  const baseCommitSha = ref.object.sha;
  const baseCommit = await gh.request('GET', `/repos/${repo}/git/commits/${baseCommitSha}`);

  const tree = [];
  for (const f of files) {
    const blob = await gh.request('POST', `/repos/${repo}/git/blobs`,
      f.base64 !== undefined
        ? { content: f.base64, encoding: 'base64' }
        : { content: f.text, encoding: 'utf-8' });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await gh.request('POST', `/repos/${repo}/git/trees`,
    { base_tree: baseCommit.tree.sha, tree });
  const commit = await gh.request('POST', `/repos/${repo}/git/commits`,
    { message, tree: newTree.sha, parents: [baseCommitSha] });
  await gh.request('PATCH', `/repos/${repo}/git/refs/${encodeURIComponent('heads/' + branch)}`,
    { sha: commit.sha });
  return commit;
}

/** Poll deploy state for a commit: GitHub deployment statuses, then commit status. */
export async function deployState(gh, repo, sha) {
  try {
    const deployments = await gh.request('GET', `/repos/${repo}/deployments?sha=${sha}&per_page=1`);
    if (deployments.length) {
      const statuses = await gh.request('GET', `/repos/${repo}/deployments/${deployments[0].id}/statuses?per_page=1`);
      if (statuses.length) return statuses[0].state; // success | failure | in_progress | queued ...
    }
  } catch { /* fall through to commit status */ }
  try {
    const status = await gh.request('GET', `/repos/${repo}/commits/${sha}/status`);
    if (status.total_count > 0) return status.state; // success | failure | pending
  } catch { /* unknown */ }
  return 'unknown';
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}
