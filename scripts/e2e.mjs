/**
 * End-to-end verification against the LIVE demo. Exercises the exact modules
 * the editor bundle ships (engine.js + github.js) through the production
 * worker and Pages deployment. Run: GH_TOKEN=$(gh auth token) node scripts/e2e.mjs
 *
 * Legs:
 *  1. magic-link editor flow: invite (admin token) → redeem → session
 *  2. proxy security: non-allowlisted paths are refused
 *  3. edit loop: splice → proxied commit (App installation token) → CF deploy → live HTML changed
 *  4. revert (proves the loop twice)
 *  5. new post: atomic multi-file commit through the proxy → live post + index card
 *  6. members area: invite → redeem cookie → gated 200; no cookie → 302; PDF gated
 */
import { applyEdits } from '../src/engine.js';
import { makeGh, getFile, editFile, commitFiles } from '../src/github.js';

const WORKER = 'https://kiln-auth.erikkwilder.workers.dev';
const SITE = 'https://kiln-demo.pages.dev';
const REPO = 'erikkurtu/kiln-demo';
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
    const res = await fetch(`${SITE}/?cachebust=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
    const html = await res.text();
    if (predicate(html)) return true;
    await sleep(7000);
  }
  return false;
}

// ── 1. Editor invite + redeem ────────────────────────────────────────────────
const invRes = await fetch(`${WORKER}/admin/invite`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ repo: REPO, name: 'E2E Probe', role: 'editor', days: 1 }),
});
const inv = await invRes.json();
check('admin/invite mints an editor invite', !!inv.invite, `id ${String(inv.invite).slice(0, 8)}…`);

const redeemRes = await fetch(`${WORKER}/editor/redeem`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ invite: inv.invite }),
});
const sess = await redeemRes.json();
check('editor/redeem returns a session', !!sess.session && sess.repo === REPO, `name=${sess.name}`);

const replay = await (await fetch(`${WORKER}/editor/redeem`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ invite: inv.invite }),
})).json();
check('invites are single-use', !!replay.error);

// ── 2. Proxy security ────────────────────────────────────────────────────────
const gh = makeGh({ mode: 'proxy', worker: WORKER, session: sess.session });

const probeUser = await fetch(`${WORKER}/gh/user`, { headers: { 'X-Kiln-Session': sess.session } });
check('proxy refuses /user (identity endpoints)', probeUser.status === 403);

const probeOtherRepo = await fetch(`${WORKER}/gh/repos/erikkurtu/kiln/contents/README.md`, {
  headers: { 'X-Kiln-Session': sess.session },
});
check('proxy refuses other repos', probeOtherRepo.status === 403);

const probeDelete = await fetch(`${WORKER}/gh/repos/${REPO}/contents/index.html`, {
  method: 'DELETE', headers: { 'X-Kiln-Session': sess.session },
});
check('proxy refuses DELETE', probeDelete.status === 403);

const probeNoSession = await fetch(`${WORKER}/gh/repos/${REPO}/contents/index.html`);
check('proxy refuses missing session', probeNoSession.status === 401);

// ── 3. The edit loop, through the proxy ──────────────────────────────────────
const MARKER = `Proof of the loop: edited via magic-link proxy at ${new Date().toISOString()}`;
const before = await getFile(gh, REPO, 'index.html', 'main');
check('proxied source fetch works', before.text.includes('data-cms="hero_subhead"'), `${before.text.length} bytes`);

const edited = await editFile(gh, REPO, 'index.html', 'main',
  (text) => applyEdits(text, [{ key: 'hero_subhead', html: MARKER }]).html,
  'E2E: edit hero_subhead via proxy (via Kiln)');
check('proxied splice commit accepted', !edited.unchanged && !!edited.commit, `commit ${edited.commit?.sha?.slice(0, 7)}`);

const liveEdit = await waitForLive(html => html.includes(MARKER), 'marker');
check('edit is LIVE on kiln-demo.pages.dev', liveEdit);

// ── 4. Revert (loop proven twice) ────────────────────────────────────────────
const ORIGINAL = `We design and build small-batch goods for people who appreciate
      the craft behind the object.`;
const reverted = await editFile(gh, REPO, 'index.html', 'main',
  (text) => applyEdits(text, [{ key: 'hero_subhead', html: ORIGINAL }]).html,
  'E2E: revert hero_subhead (via Kiln)');
check('revert commit accepted', !reverted.unchanged, `commit ${reverted.commit?.sha?.slice(0, 7)}`);
const liveRevert = await waitForLive(html => !html.includes(MARKER) && html.includes('craft behind the object'), 'revert');
check('revert is LIVE', liveRevert);

// ── 5. New post: atomic multi-file commit through the proxy ──────────────────
const TITLE = 'Hello from the magic-link editor';
const SLUG = 'hello-from-the-magic-link-editor';
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
check('atomic 2-file commit via proxy (Git Data API)', !!postCommit.sha, postCommit.sha?.slice(0, 7));

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

// ── 6. Members area ──────────────────────────────────────────────────────────
const gateRes = await fetch(`${SITE}/members/`, { redirect: 'manual' });
check('members area redirects anonymous visitors', gateRes.status === 302 &&
  (gateRes.headers.get('Location') || '').includes('/members-login.html'));

const pdfGate = await fetch(`${SITE}/members/welcome-pack.pdf`, { redirect: 'manual' });
check('gated PDF also redirects', pdfGate.status === 302);

const mInvRes = await fetch(`${SITE}/api/member-invite`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ name: 'E2E Member' }),
});
const mInv = await mInvRes.json();
check('member-invite mints a token (admin-gated)', !!mInv.invite);

const badInv = await fetch(`${SITE}/api/member-invite`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gho_nope' },
  body: JSON.stringify({ name: 'intruder' }),
});
check('member-invite refuses bad tokens', badInv.status === 403);

const mRedeem = await fetch(`${SITE}/api/member-redeem`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ invite: mInv.invite }),
});
const setCookie = mRedeem.headers.get('Set-Cookie') || '';
const cookie = setCookie.split(';')[0];
check('member-redeem sets session cookie', mRedeem.status === 200 && cookie.startsWith('kiln_member='));

const memberPage = await fetch(`${SITE}/members/`, { headers: { Cookie: cookie } });
check('member cookie opens /members/', memberPage.status === 200 && (await memberPage.text()).includes('Member Resources'));

const memberPdf = await fetch(`${SITE}/members/welcome-pack.pdf`, { headers: { Cookie: cookie } });
check('member cookie opens the gated PDF', memberPdf.status === 200 &&
  (memberPdf.headers.get('Content-Type') || '').includes('pdf'));

const tampered = await fetch(`${SITE}/members/`, { headers: { Cookie: 'kiln_member=eyJmYWtlIjoxfQ.deadbeef' }, redirect: 'manual' });
check('tampered cookie is rejected', tampered.status === 302);

summary();
