/**
 * Suggestions on a site Kiln hosts get a preview without anybody typing
 * anything.
 *
 * The editor writes a suggestion to a branch of its own, and shows "Open
 * preview", only when the site's settings file has a `preview:` line. On
 * Kiln's hosting Kiln writes that line itself: when the site is first looked
 * after (worker/lookafter.js: lookAfter), from the five-minute job for a site
 * that was hosted before (setPreviews), and into the settings file of a site
 * Kiln starts (worker/prepare.js: kilnConfigFile). "Check this site" says
 * whether the line is there (worker/sitecheck.js). These tests run the real
 * functions over an in-memory GitHub. Nothing here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFetch, fakeKV, githubWrites } from './worker-harness.js';
import { fakeGitHub } from './github-fake.js';
import { kilnConfigFile, withPreview, withKilnTags, KILN_PAGE } from '../worker/prepare.js';
import { lookAfter, setPreviews, previewsStep } from '../worker/lookafter.js';
import { previewPattern } from '../worker/hosting.js';
import { checkSite } from '../worker/sitecheck.js';

const SERVICE = 'https://auth.example';
const REPO = 'ada/club';
const CONFIG = 'assets/kiln-config.js';
const SITE = { id: 'a1b2c3d4-1111-4222-8333-444455556666', repo: REPO };
const ADDRESS = 'https://club-a1b2c3d4.kiln-sites.workers.dev';
const HOSTING = { HOSTING_ACCOUNT_ID: 'acct', HOSTING_API_TOKEN: 'cf-token', HOSTING_SUBDOMAIN: 'kiln-sites' };
const PATTERN = 'https://pv-a1b2c3d4-{branch}.kiln-sites.workers.dev';
const LINE = `  preview: '${PATTERN}',\n`;
const PAGES = 'https://{branch}.club.pages.dev';                              // what an owner on Cloudflare Pages types
const OTHER = 'https://stg-pv-0f9e8d7c-{branch}.kiln-test.workers.dev';      // what Kiln's hosting wrote for another site
const ADA = { name: 'ada', email: '42+ada@users.noreply.github.com' };
const MESSAGE = 'Kiln: suggestions on this site get a preview of their own';
const NOT_CHANGED = /could not be changed( this time)?\. Suggestions on this site work as before, without a preview\.$/;
const REFUSED = { message: 'Repository rule violations found\n\nChanges must be made through a pull request.' };

const starter = (over = {}) => kilnConfigFile({ repo: REPO, branch: 'main', worker: SERVICE, ...over });
const page = (title) => `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>${title}</title>\n</head>\n<body>\n  <h1>${title}</h1>\n</body>\n</html>\n`;
/** A repository with Kiln in it and one page. `settings` null leaves the settings file out. */
const hostedFiles = (settings = starter()) => ({
  'index.html': withKilnTags(page('Home')).html,
  'assets/kiln.js': '/* kiln */', 'assets/kiln-editor.js': '/* editor */', 'assets/kiln-features.js': '/* features */',
  ...(settings === null ? {} : { [CONFIG]: settings }), 'kiln.html': KILN_PAGE,
});
const hostingEnv = (seed = {}) => ({ KILN: fakeKV(seed), ...HOSTING });
/** GitHub for one repository, or for several ({ 'ada/one': gh, … }). `shut()` true means the branch takes no direct change. */
const api = (ghs, shut = () => false) => async (url, init) => {
  const one = typeof ghs.handler === 'function' ? ghs : Object.entries(ghs).find(([r]) => url.startsWith(`https://api.github.com/repos/${r}/`) || url === `https://api.github.com/repos/${r}`)?.[1];
  if (!one || !url.startsWith('https://api.github.com/')) return undefined;
  if (shut() && init.method === 'PATCH' && url.includes('/git/refs/heads/')) return new Response(JSON.stringify(REFUSED), { status: 422, headers: { 'Content-Type': 'application/json' } });
  return one.handler(url, init);
};
const commitsMade = (calls) => calls.filter(c => c.method === 'POST' && /\/git\/commits$/.test(c.url));
const token = async () => 'inst-token';
const marked = (env, id = SITE.id) => env.KILN.map.has(`pvset:${id}`);
/** How many days a site's mark still has, or null for a mark that stays for good. */
const markDays = (env, id = SITE.id) => (env.KILN.expires.has(`pvset:${id}`) ? (env.KILN.expires.get(`pvset:${id}`) - Date.now() / 1000) / 86400 : null);
/** Run `fn` with nothing written to the console: these functions log what they did. */
async function quiet(fn) {
  const warn = console.warn, log = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.warn = warn; console.log = log; }
}

// ─── The line, as a function of the file ──────────────────────────────────────

test('the settings file: a starter file gets one line straight after worker, and every other character stays', () => {
  const before = starter();
  const out = withPreview(before, PATTERN);
  assert.equal(out.state, 'done');
  assert.equal(out.text, "window.KILN = {\n  repo:   'ada/club',\n  branch: 'main',\n  worker: 'https://auth.example',\n  preview: 'https://pv-a1b2c3d4-{branch}.kiln-sites.workers.dev',\n  styles: [],\n};\n");
  assert.equal(out.text.replace(LINE, ''), before);
  assert.deepEqual(withPreview(out.text, PATTERN), { state: 'same' }, 'asked again, there is nothing to do');
  // A site that was given a name keeps it, below the new line.
  assert.equal(withPreview(starter({ siteName: 'Oak Bakery' }), PATTERN).text, starter({ siteName: 'Oak Bakery', preview: PATTERN }));
});

test('the settings file Kiln starts a site with: no preview line unless it is given one, and the line it writes is the one withPreview looks for', () => {
  assert.equal(starter().includes('preview'), false);
  assert.equal(starter({ preview: '' }), starter());
  assert.equal(starter({ preview: null }), starter());
  assert.equal(starter({ preview: PATTERN }), "window.KILN = {\n  repo:   'ada/club',\n  branch: 'main',\n  worker: 'https://auth.example',\n  preview: 'https://pv-a1b2c3d4-{branch}.kiln-sites.workers.dev',\n  styles: [],\n};\n");
  assert.equal(starter({ preview: PATTERN, siteName: 'Oak Bakery' }).split('\n')[4], "  preview: 'https://pv-a1b2c3d4-{branch}.kiln-sites.workers.dev',", 'straight after worker');
  assert.deepEqual(withPreview(starter({ preview: PATTERN }), PATTERN), { state: 'same' });
  assert.deepEqual(withPreview(starter({ preview: PATTERN, siteName: 'Oak Bakery' }), PATTERN), { state: 'same' });
});

test('the settings file: a pattern its owner typed is never touched, however it is written', () => {
  const owns = [
    `  preview: '${PAGES}',\n`,
    '  "preview": "https://deploy-preview-{branch}--club.netlify.app",\n',
    "  preview: '',\n",                                     // switched off on purpose
    "  preview: previewBase + '{branch}',\n",              // not a plain address
    `  preview: '${PATTERN}' + suffix,\n`,
  ];
  for (const own of owns) {
    const file = starter().replace('  styles: [],\n', `${own}  styles: [],\n`);
    assert.deepEqual(withPreview(file, PATTERN), { state: 'has_own' }, own);
  }
  // On one line with the rest, it is still the owner's.
  assert.deepEqual(withPreview(`window.KILN = { repo: 'ada/club', worker: '${SERVICE}', preview: '${PAGES}' };\n`, PATTERN), { state: 'has_own' });
});

test('the settings file: this site\'s pattern is found in any spelling, and another site\'s pattern from Kiln\'s hosting is replaced where it stood', () => {
  const spelled = starter().replace('  styles: [],\n', `  'preview': "${PATTERN}", // set by Kiln\n  styles: [],\n`);
  assert.deepEqual(withPreview(spelled, PATTERN), { state: 'same' });

  // The site was moved, or added again: the old line of Kiln's hosting gives way to this one.
  const moved = withPreview(starter({ preview: OTHER }), PATTERN);
  assert.equal(moved.state, 'done');
  assert.equal(moved.text, starter({ preview: PATTERN }));
  // The line keeps its place, its quotes and its comment.
  const odd = `window.KILN = {\n  "preview": "${OTHER}", // set by Kiln\n  repo: 'ada/club',\n  worker: '${SERVICE}',\n};\n`;
  assert.deepEqual(withPreview(odd, PATTERN), { state: 'done', text: odd.replace(OTHER, PATTERN) });
  assert.deepEqual(withPreview(odd.replace(OTHER, PATTERN), PATTERN), { state: 'same' });
});

test('the settings file: Windows line endings are kept, on the new line too', () => {
  const crlf = starter().replace(/\n/g, '\r\n');
  const out = withPreview(crlf, PATTERN);
  assert.equal(out.state, 'done');
  assert.equal(out.text, starter({ preview: PATTERN }).replace(/\n/g, '\r\n'));
  assert.equal(/[^\r]\n/.test(out.text), false, 'no line ends any other way');
  assert.deepEqual(withPreview(out.text, PATTERN), { state: 'same' });
});

test('the settings file: the word preview in a comment, in another value or in a setting of a setting is not the line', () => {
  const file = `// preview: '${PAGES}'\nwindow.KILN = {\n  repo:   'ada/club',\n  branch: 'main',\n  // preview: '${PAGES}',\n  /*\n  preview: '${PAGES}',\n  */\n  worker: '${SERVICE}', // this service\n`
    + "  siteName: 'A preview: of the club',\n  nav: { preview: true },\n  styles: [],\n};\n";
  const out = withPreview(file, PATTERN);
  assert.equal(out.state, 'done');
  assert.equal(out.text, file.replace('// this service\n', `// this service\n${LINE}`));
  assert.deepEqual(withPreview(out.text, PATTERN), { state: 'same' });
});

test('the settings file: a file Kiln cannot place its line in is never touched', () => {
  const unknown = {
    'no worker line': "window.KILN = {\n  repo: 'ada/club',\n  styles: [],\n};\n",
    'no settings object': `export default {\n  worker: '${SERVICE}',\n};\n`,
    'worker on one line with the rest': `window.KILN = { repo: 'ada/club', worker: '${SERVICE}' };\n`,
    'no comma after worker': `window.KILN = {\n  repo: 'ada/club',\n  worker: '${SERVICE}'\n};\n`,
    'the value on the next line': `window.KILN = {\n  repo: 'ada/club',\n  worker:\n    '${SERVICE}',\n};\n`,
    'worker only in a comment': `window.KILN = {\n  repo: 'ada/club',\n  // worker: '${SERVICE}',\n};\n`,
    'an object that never closes': `window.KILN = {\n  worker: '${SERVICE}',\n`,
    'an empty file': '',
  };
  for (const [why, file] of Object.entries(unknown)) assert.deepEqual(withPreview(file, PATTERN), { state: 'unknown' }, why);
  assert.deepEqual(withPreview(starter(), ''), { state: 'unknown' }, 'no pattern to write');
  assert.deepEqual(withPreview(starter(), null), { state: 'unknown' });
});

// ─── When a site goes on Kiln's hosting ───────────────────────────────────────

test('look after: a hosted site gets the line as one commit in the owner\'s name, after Kiln and before the character set, and only once', async () => {
  const gh = fakeGitHub({ repo: REPO, files: hostedFiles() });
  const env = hostingEnv();
  assert.equal(previewPattern(env, SITE), PATTERN);
  const look = () => lookAfter(env, { site: SITE, token: 'inst-token', author: ADA, worker: SERVICE, firstpassAt: 5 });
  await withFetch(api(gh), async (calls) => {
    const first = await look();
    assert.deepEqual(first.map(l => [l.step, l.state]), [['kiln', 'nothing'], ['previews', 'done'], ['charset', 'nothing'], ['marks', 'nothing']]);
    const line = first[1];
    assert.equal(line.detail, 'A suggestion or a shared draft on this site now gets a preview address of its own. Kiln added one line to the settings file for that.');
    assert.equal(line.commit.url, `https://github.com/${REPO}/commit/${line.commit.sha}`);
    const commit = gh.commits.get(line.commit.sha);
    assert.equal(commit.message, MESSAGE);
    assert.deepEqual([commit.author.name, commit.author.email], [ADA.name, ADA.email]);
    assert.equal(gh.head(), line.commit.sha);
    assert.equal(gh.read(CONFIG), starter({ preview: PATTERN }));
    assert.equal(gh.read('index.html'), hostedFiles()['index.html'], 'no other file changed');
    assert.equal(commitsMade(calls).length, 1);

    const second = await look();
    assert.deepEqual(second[1], { step: 'previews', state: 'nothing', detail: 'Suggestions on this site already get a preview of their own.' });
    assert.equal(commitsMade(calls).length, 1, 'no second commit');
    assert.equal(gh.head(), line.commit.sha);
  });
  assert.equal(marked(env), true, 'the five-minute job has nothing left to do for this site');
  assert.equal(markDays(env), null);
  assert.equal(await env.KILN.get(`carelock:${SITE.id}`), null);
});

test('look after: an owner\'s own pattern is left alone, a file that cannot be changed is said so in a plain sentence, and the steps after it still run', async () => {
  // The owner typed a pattern for Cloudflare Pages.
  let gh = fakeGitHub({ repo: REPO, files: hostedFiles(starter({ preview: PAGES })) });
  await withFetch(api(gh), async (calls) => {
    assert.deepEqual(await previewsStep(hostingEnv(), { site: SITE, token: 'inst-token', author: ADA }),
      { step: 'previews', state: 'nothing', detail: 'The settings file already names where previews are, so Kiln left it as it is.' });
    assert.deepEqual(githubWrites(calls), []);
  });

  // Somebody rewrote the file, or it is not there.
  const cannot = {
    settings: [hostedFiles(`window.KILN = { repo: 'ada/club', worker: '${SERVICE}' };\n`), 'Kiln could not tell where its line belongs in the settings file of this site, so the settings file could not be changed. Suggestions on this site work as before, without a preview.'],
    no_settings: [hostedFiles(null), 'Kiln found no settings file (assets/kiln-config.js) in ada/club, so the settings file could not be changed. Suggestions on this site work as before, without a preview.'],
  };
  for (const [code, [files, sentence]] of Object.entries(cannot)) {
    gh = fakeGitHub({ repo: REPO, files });
    await withFetch(api(gh), async (calls) => {
      assert.deepEqual(await previewsStep(hostingEnv(), { site: SITE, token: 'inst-token', author: ADA }), { step: 'previews', state: 'not_done', code, detail: sentence });
      assert.deepEqual(githubWrites(calls).filter(c => c.method === 'PATCH'), [], code);
    });
  }

  // A branch that takes no direct change: said so, nothing changed, and the character set and the first pass are still looked at.
  gh = fakeGitHub({ repo: REPO, files: hostedFiles() });
  const before = gh.head();
  const env = hostingEnv();
  await quiet(() => withFetch(api(gh, () => true), async () => {
    const steps = await lookAfter(env, { site: SITE, token: 'inst-token', author: ADA, worker: SERVICE, firstpassAt: 5 });
    assert.deepEqual(steps.map(l => [l.step, l.state, l.code]), [['kiln', 'nothing', undefined], ['previews', 'not_done', 'protected'], ['charset', 'nothing', undefined], ['marks', 'nothing', undefined]]);
    assert.equal(steps[1].detail, 'The main branch of ada/club does not take a direct change (it is protected), so the settings file could not be changed. Suggestions on this site work as before, without a preview.');
  }));
  assert.equal(gh.head(), before);
  assert.equal(gh.read(CONFIG), starter());
  assert.ok(markDays(env) > 0.99 && markDays(env) <= 1, 'the job looks again in a day');

  // GitHub does not answer: the same plain sentence, and never an error.
  await quiet(() => withFetch(async () => new Response('{"message":"Server Error"}', { status: 502 }), async () => {
    const line = await previewsStep(hostingEnv(), { site: SITE, token: 'inst-token', author: ADA });
    assert.deepEqual([line.step, line.state, line.code], ['previews', 'not_done', 'github']);
    assert.match(line.detail, NOT_CHANGED);
  }));
  await quiet(() => withFetch(async () => { throw new Error('socket hang up'); }, async () => {
    const line = await previewsStep(hostingEnv(), { site: SITE, token: 'inst-token', author: ADA });
    assert.deepEqual([line.state, line.code], ['not_done', 'github']);
    assert.match(line.detail, NOT_CHANGED);
    assert.doesNotMatch(line.detail, /—/);
  }));
});

test('look after: a service that hosts nothing has no such step', async () => {
  const gh = fakeGitHub({ repo: REPO, files: hostedFiles() });
  const env = { KILN: fakeKV() };
  await withFetch(api(gh), async (calls) => {
    assert.equal(await previewsStep(env, { site: SITE, token: 'inst-token', author: ADA }), null);
    assert.equal(calls.length, 0);
    const steps = await lookAfter(env, { site: SITE, token: 'inst-token', author: ADA, worker: SERVICE, firstpassAt: 5 });
    assert.deepEqual(steps.map(l => l.step), ['kiln', 'charset', 'marks']);
    assert.deepEqual(githubWrites(calls), []);
  });
  assert.equal(marked(env), false);
});

// ─── A site that was hosted before ────────────────────────────────────────────

test('the five-minute job: a site that was on the hosting already gets the line once, as a commit by Kiln itself, and is marked for good', async () => {
  const gh = fakeGitHub({ repo: REPO, files: hostedFiles() });
  const env = hostingEnv();
  const run = () => setPreviews(env, [SITE], { installationToken: token });
  await quiet(() => withFetch(api(gh), async (calls) => {
    assert.deepEqual(await run(), { looked: 1, added: 1 });
    assert.equal(gh.read(CONFIG), starter({ preview: PATTERN }));
    const made = commitsMade(calls);
    assert.equal(made.length, 1);
    assert.equal(made[0].body.message, MESSAGE);
    assert.equal('author' in made[0].body, false, 'it names no person, so GitHub shows it as made by the Kiln app');
    assert.equal(marked(env), true);
    assert.equal(markDays(env), null, 'the mark stays');
    assert.equal(await env.KILN.get(`carelock:${SITE.id}`), null, 'nothing is left locked');

    // Every run after that asks GitHub nothing about this site.
    const n = calls.length;
    assert.deepEqual(await run(), { looked: 0, added: 0 });
    assert.deepEqual(await run(), { looked: 0, added: 0 });
    assert.equal(calls.length, n);
  }));
});

test('the five-minute job: a site whose file could not be changed is looked at again a day later, and not before', async () => {
  const gh = fakeGitHub({ repo: REPO, files: hostedFiles() });
  const before = gh.head();
  const env = hostingEnv();
  let shut = true;
  const run = () => setPreviews(env, [SITE], { installationToken: token });
  await quiet(() => withFetch(api(gh, () => shut), async (calls) => {
    assert.deepEqual(await run(), { looked: 1, added: 0 });
    assert.equal(gh.head(), before);
    assert.ok(markDays(env) > 0.99 && markDays(env) <= 1, `marked for ${markDays(env)} days`);
    // Five minutes on, and every five minutes that day: not looked at.
    const n = calls.length;
    assert.deepEqual(await run(), { looked: 0, added: 0 });
    assert.equal(calls.length, n);
    // A day on the mark has run out, and the site is looked at once more.
    await env.KILN.delete(`pvset:${SITE.id}`);
    assert.deepEqual(await run(), { looked: 1, added: 0 });
    assert.ok(calls.length > n);
    assert.ok(markDays(env) > 0.99, 'and marked for another day');
    // The owner lifts the protection: the next look writes the line, and the mark stays.
    shut = false;
    await env.KILN.delete(`pvset:${SITE.id}`);
    assert.deepEqual(await run(), { looked: 1, added: 1 });
    assert.equal(gh.read(CONFIG), starter({ preview: PATTERN }));
    assert.equal(markDays(env), null);
  }));

  // A file Kiln cannot place its line in, and a repository the app was removed from, wait a day too.
  const odd = fakeGitHub({ repo: REPO, files: hostedFiles(`window.KILN = { repo: 'ada/club', worker: '${SERVICE}' };\n`) });
  const e2 = hostingEnv();
  await quiet(() => withFetch(api(odd), async (calls) => {
    assert.deepEqual(await setPreviews(e2, [SITE], { installationToken: token }), { looked: 1, added: 0 });
    assert.deepEqual(githubWrites(calls), []);
  }));
  assert.ok(markDays(e2) > 0.99 && markDays(e2) <= 1);
  const e3 = hostingEnv();
  await quiet(() => withFetch(api(odd), async (calls) => {
    assert.deepEqual(await setPreviews(e3, [SITE], { installationToken: async () => null }), { looked: 1, added: 0 });
    assert.equal(calls.length, 0);
  }));
  assert.ok(markDays(e3) > 0.99 && markDays(e3) <= 1);
});

test('the five-minute job: three sites a run, an owner\'s own pattern is marked and left alone, and a site that is being looked after waits', async () => {
  const sites = ['one', 'two', 'three', 'four'].map((name, i) => ({ id: `b000000${i + 1}-1111-4222-8333-444455556666`, repo: `ada/${name}` }));
  const settings = (s, over = {}) => kilnConfigFile({ repo: s.repo, branch: 'main', worker: SERVICE, ...over });
  const ghs = Object.fromEntries(sites.map(s => [s.repo, fakeGitHub({ repo: s.repo, files: hostedFiles(settings(s)) })]));
  const env = hostingEnv();
  const lined = () => sites.map(s => ghs[s.repo].read(CONFIG) === settings(s, { preview: previewPattern(env, s) }));
  await quiet(() => withFetch(api(ghs), async (calls) => {
    assert.deepEqual(await setPreviews(env, sites, { installationToken: token }), { looked: 3, added: 3 });
    assert.deepEqual(lined(), [true, true, true, false]);
    assert.equal(commitsMade(calls).length, 3);
    assert.deepEqual(await setPreviews(env, sites, { installationToken: token }), { looked: 1, added: 1 });
    assert.deepEqual(lined(), [true, true, true, true]);
    assert.deepEqual(await setPreviews(env, sites, { installationToken: token }), { looked: 0, added: 0 });
    assert.equal(commitsMade(calls).length, 4);
  }));
  assert.equal(previewPattern(env, sites[3]), 'https://pv-b0000004-{branch}.kiln-sites.workers.dev');

  // An owner who names previews themselves is looked at once, and never again.
  const own = fakeGitHub({ repo: REPO, files: hostedFiles(starter({ preview: PAGES })) });
  const e2 = hostingEnv();
  await quiet(() => withFetch(api(own), async (calls) => {
    assert.deepEqual(await setPreviews(e2, [SITE], { installationToken: token }), { looked: 1, added: 0 });
    assert.deepEqual(githubWrites(calls), []);
    const n = calls.length;
    assert.deepEqual(await setPreviews(e2, [SITE], { installationToken: token }), { looked: 0, added: 0 });
    assert.equal(calls.length, n);
  }));
  assert.equal(own.read(CONFIG), starter({ preview: PAGES }));
  assert.equal(markDays(e2), null);

  // While a look-after of the site runs, the job keeps its hands off, and comes back on a later run.
  const gh = fakeGitHub({ repo: REPO, files: hostedFiles() });
  const e3 = hostingEnv({ [`carelock:${SITE.id}`]: '1' });
  await quiet(() => withFetch(api(gh), async (calls) => {
    assert.deepEqual(await setPreviews(e3, [SITE], { installationToken: token }), { looked: 0, added: 0 });
    assert.equal(calls.length, 0);
    assert.equal(marked(e3), false);
    await e3.KILN.delete(`carelock:${SITE.id}`);
    assert.deepEqual(await setPreviews(e3, [SITE], { installationToken: token }), { looked: 1, added: 1 });
  }));

  // A service that hosts nothing asks nothing.
  const e4 = { KILN: fakeKV() };
  await withFetch(api(gh), async (calls) => {
    assert.deepEqual(await setPreviews(e4, [SITE], { installationToken: token }), { looked: 0, added: 0 });
    assert.equal(calls.length, 0);
  });
  assert.equal(marked(e4), false);
});

// ─── "Check this site" ────────────────────────────────────────────────────────

test('"Check this site": a hosted site that is online is told whether its suggestions get a preview, at no further request to GitHub', async () => {
  const look = (settings, { files = {}, ...opts } = {}) => {
    const gh = fakeGitHub({ repo: REPO, files: { ...hostedFiles(settings), ...files } });
    const handler = async (url, init) => (url.startsWith('https://api.github.com/') ? gh.handler(url, init)
      : new Response('<!doctype html><title>Home</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    return withFetch(handler, async (calls) => {
      const checks = await checkSite({ token: 'inst-token', repo: REPO, origin: ADDRESS, worker: SERVICE, hosted: true, preview: PATTERN, ...opts });
      return { line: checks.find(c => c.id === 'previews') || null, ids: checks.map(c => c.id), github: calls.filter(c => c.url.startsWith('https://api.github.com/')).map(c => `${c.method} ${c.url}`) };
    });
  };

  // The line is there.
  const on = await look(starter({ preview: PATTERN }));
  assert.deepEqual(on.line, { id: 'previews', ok: true, title: 'Suggestions get a preview',
    detail: 'A suggestion or a shared draft on this site is put up at a preview address of its own, so it can be looked at before it is published. Search engines are asked not to list previews, and members-only pages are left out of them.' });
  assert.equal(on.ids.at(-1), 'previews', 'it is the last line');

  // The line is not there yet.
  const off = await look(starter());
  assert.deepEqual(off.line, { id: 'previews', ok: false, title: 'Suggestions get a preview',
    detail: 'Suggestions on this site do not get a preview yet. Kiln adds one line to the site\'s settings file for that by itself, usually within a day.' });
  assert.equal((await look(starter({ preview: OTHER }))).line.ok, false, 'a line Kiln\'s hosting wrote for another site leads nowhere');

  // No line: the owner's own pattern, a service that hosts nothing, a site on another host, a site that is not online, no settings file.
  assert.equal((await look(starter({ preview: PAGES }))).line, null);
  const hostingOff = await look(starter(), { preview: null });
  assert.equal(hostingOff.line, null);
  assert.equal((await look(starter(), { hosted: false })).line, null);
  assert.equal((await look(starter({ preview: PATTERN }), { hosted: false })).line, null);
  assert.equal((await look(starter(), { down: 'Kiln took this site down.' })).line, null);
  assert.equal((await look(null)).line, null);

  // After the members line, where there is one.
  const club = await look(starter({ preview: PATTERN }), { membersOn: true, files: { 'members-login.html': '<h1>Sign in</h1>', 'members/index.html': '<h1>Members</h1>' } });
  assert.deepEqual(club.ids.slice(-2), ['members', 'previews']);

  // The settings file is read once, for the settings line: this line asks GitHub nothing more.
  assert.deepEqual(off.github, hostingOff.github, 'the line costs no further request to GitHub');
  assert.deepEqual(on.github, (await look(starter({ preview: PATTERN }), { preview: null })).github);
  assert.equal(on.github.filter(u => /\/git\/blobs\//.test(u)).length, hostingOff.github.filter(u => /\/git\/blobs\//.test(u)).length);
});
