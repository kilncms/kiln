/**
 * End-to-end verification against the LIVE demo. Exercises the exact modules the
 * editor bundle ships (engine.js + github.js): the splice engine, the commit
 * transport, the worker's session-proxy security posture, and the members gate.
 * Run: GH_TOKEN=$(gh auth token) node scripts/e2e.mjs
 *
 * Editor sessions are now minted only via Google sign-in (no headless path), so
 * the edit loop here runs through the ADMIN direct transport — the same engine +
 * github.js the editor uses. The session-proxy allowlist and per-editor path
 * scoping are covered by the unit tests (test/) and code review.
 *
 * Legs:
 *  1. edit loop: splice → direct commit → CF deploy → live HTML changed
 *  2. revert (proves the loop twice)
 *  3. new post: atomic multi-file commit → live post + index card
 *  4. proxy security: a valid editor session is required (missing/garbage → 401)
 *  5. members gate: anonymous → 302, gated PDF → 302, tampered cookie → 302
 */
import { applyEdits } from '../src/engine.js';
import { makeGh, getFile, editFile, commitFiles } from '../src/github.js';

const WORKER = 'https://auth.kilncms.com';
const SITE = 'https://kiln-demo.pages.dev';
const REPO = 'kilncms/kiln-demo';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('GH_TOKEN required'); process.exit(1); }

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) { console.error('FAILED, aborting'); summary(); process.exit(1); }
}
function summary() {
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForLive(predicate, label, timeoutMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${SITE}/?cachebust=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
      const html = await res.text();
      if (predicate(html)) return true;
    } catch { /* transient network blip — keep polling */ }
    await sleep(7000);
  }
  return false;
}

// ── 1. The edit loop, admin direct transport ─────────────────────────────────
const gh = makeGh({ mode: 'direct', token: () => TOKEN });

const before = await getFile(gh, REPO, 'index.html', 'main');
check('source fetch works', before.text.includes('data-cms="hero_tagline"'), `${before.text.length} bytes`);

const MARKER = `Proof of the loop: edited at ${new Date().toISOString()}`;
const edited = await editFile(gh, REPO, 'index.html', 'main',
  (text) => applyEdits(text, [{ key: 'hero_tagline', html: MARKER }]).html,
  'E2E: edit hero_tagline (via Kiln)');
check('splice commit accepted', !edited.unchanged && !!edited.commit, `commit ${edited.commit?.sha?.slice(0, 7)}`);

const liveEdit = await waitForLive(html => html.includes(MARKER), 'marker');
check('edit is LIVE on kiln-demo.pages.dev', liveEdit);

// ── 2. Revert (loop proven twice) ────────────────────────────────────────────
const ORIGINAL = `We design and build small-batch goods for people who appreciate
      the craft behind the object.`;
const reverted = await editFile(gh, REPO, 'index.html', 'main',
  (text) => applyEdits(text, [{ key: 'hero_tagline', html: ORIGINAL }]).html,
  'E2E: revert hero_tagline (via Kiln)');
check('revert commit accepted', !reverted.unchanged, `commit ${reverted.commit?.sha?.slice(0, 7)}`);
const liveRevert = await waitForLive(html => !html.includes(MARKER) && html.includes('craft behind the object'), 'revert');
check('revert is LIVE', liveRevert);

// ── 3. New post: atomic multi-file commit ────────────────────────────────────
const RUN = Date.now().toString(36);
const TITLE = `Hello from the editor (${RUN})`;
const SLUG = `hello-from-the-editor-${RUN}`;
const date = 'June 10, 2026';
const tpl = await getFile(gh, REPO, '_templates/post.html', 'main');
const cardTpl = await getFile(gh, REPO, '_templates/post-card.html', 'main');
const blogIndex = await getFile(gh, REPO, 'blog/index.html', 'main');

const postHtml = applyEdits(tpl.text, [
  { key: 'post_title', html: TITLE },
  { key: 'post_date', html: date },
]).html.replaceAll('{{title}}', TITLE);
const card = cardTpl.text.replaceAll('{{title}}', TITLE).replaceAll('{{href}}', `/blog/${SLUG}.html`).replaceAll('{{date}}', date);
const newIndex = applyEdits(blogIndex.text, [{ key: 'post_list', prepend: '\n      ' + card.trim() }]);
check('post template + card render', newIndex.applied.length === 1);

const postCommit = await commitFiles(gh, REPO, 'main', [
  { path: `blog/${SLUG}.html`, text: postHtml },
  { path: 'blog/index.html', text: newIndex.html },
], `New post: ${TITLE} (via Kiln)`);
check('atomic 2-file commit (Git Data API)', !!postCommit.sha, postCommit.sha?.slice(0, 7));

let postLive = false;
{
  const start = Date.now();
  while (Date.now() - start < 240000) {
    const res = await fetch(`${SITE}/blog/${SLUG}.html?cb=${Date.now()}`);
    if (res.status === 200 && (await res.text()).includes(TITLE)) { postLive = true; break; }
    await sleep(7000);
  }
}
check('new post page is LIVE', postLive, `${SITE}/blog/${SLUG}.html`);
const blogLive = await (await fetch(`${SITE}/blog/?cb=${Date.now()}`)).text();
check('blog index shows the new card', blogLive.includes(TITLE));

// ── 4. Proxy security: a valid editor session is required ────────────────────
const probeNoSession = await fetch(`${WORKER}/gh/repos/${REPO}/contents/index.html`);
check('proxy refuses missing session', probeNoSession.status === 401);

const probeBadSession = await fetch(`${WORKER}/gh/repos/${REPO}/contents/index.html`, {
  headers: { 'X-Kiln-Session': 'f'.repeat(64) },
});
check('proxy refuses an unknown session', probeBadSession.status === 401);

// ── 5. Members gate ──────────────────────────────────────────────────────────
const gateRes = await fetch(`${SITE}/members/`, { redirect: 'manual' });
check('members area redirects anonymous visitors', gateRes.status === 302 &&
  (gateRes.headers.get('Location') || '').includes('/members-login.html'));

const pdfGate = await fetch(`${SITE}/members/welcome-pack.pdf`, { redirect: 'manual' });
check('gated PDF also redirects', pdfGate.status === 302);

const tampered = await fetch(`${SITE}/members/`, { headers: { Cookie: 'kiln_member=eyJmYWtlIjoxfQ.deadbeef' }, redirect: 'manual' });
check('tampered cookie is rejected', tampered.status === 302);

summary();
