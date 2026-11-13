/**
 * Whether the AI tools are offered (src/editor/ai-offered.js, used by
 * hasFeature('ai') in main.js and by assist.js).
 *
 * On a site whose Kiln service holds no AI key, the toolbar's ✨ button, the
 * picture's "Describe" and the new page's "let AI draft the content" were all
 * offered, and each could only fail: the service answers every AI request
 * "ai not configured". They were then shown unless the service had said it
 * has no AI, which left them on show for the first seconds after sign-in,
 * until its answer came. Now they are shown only once the service has said it
 * has AI. An older service, whose health answer does not say, keeps what it
 * had: the tools are shown once that answer has come, and put away the first
 * time a request is answered "ai not configured".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aiSaid, aiOffered, aiAfter, AI_NOT_SAID, aiNotSetUpWords, noAiKey } from '../src/editor/ai-offered.js';
import { editorEnv, call, withFetch, REPO } from './worker-harness.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const assist = readFileSync(new URL('../src/editor/assist.js', import.meta.url), 'utf8');

test('ai: an answer of the service says it has AI, says it has none, or does not say', () => {
  assert.equal(aiSaid({ ok: true, aiConfigured: true }), true);
  assert.equal(aiSaid({ people: [], googleConfigured: true, aiConfigured: false }), false);
  for (const silent of [null, undefined, 'ok', {}, { ok: true, modes: ['html'] }, { aiConfigured: 'yes' }, { aiConfigured: 0 }]) assert.equal(aiSaid(silent), null);
});

test('ai: the tools are shown to someone granted them only once the service has said it has AI', () => {
  assert.equal(aiOffered({ granted: true, known: true }), true);
  assert.equal(aiOffered({ granted: true, known: null }), false, 'no answer yet: nothing is shown that may have to be taken away');
  assert.equal(aiOffered({ granted: true }), false);
  assert.equal(aiOffered({ granted: true, known: false }), false, 'no AI on the service: nothing is offered that can only fail');
  assert.equal(aiOffered({ granted: true, known: AI_NOT_SAID }), true, 'an older service that does not say: as it was before');
  for (const known of [true, false, null, AI_NOT_SAID]) assert.equal(aiOffered({ granted: false, known }), false, 'never to someone not granted them');
  assert.equal(aiOffered({ granted: true, sandbox: true, known: false }), true, 'the demo shows every tool, and says what each does on a real site');
  assert.equal(aiOffered({ granted: true, sandbox: true, known: null }), true);
});

test('ai: the first seconds after sign-in, on a site with no AI, with AI, and on an older service', () => {
  const shown = (known) => aiOffered({ granted: true, known });
  // no AI: never shown, before the answer or after
  let known = null;
  assert.equal(shown(known), false);
  known = aiAfter(known, { ok: true, aiConfigured: false }, { health: true });
  assert.deepEqual([known, shown(known)], [false, false]);
  // AI: shown from the answer on
  known = aiAfter(null, { ok: true, aiConfigured: true }, { health: true });
  assert.deepEqual([known, shown(known)], [true, true]);
  // an older service: its health answer is JSON without the field, plain "ok" (read as null), or never comes (null)
  for (const old of [{ ok: true, modes: ['html'] }, null, 'ok']) {
    known = aiAfter(null, old, { health: true });
    assert.deepEqual([known, shown(known)], [AI_NOT_SAID, true], 'as before this fix: offered');
    known = aiAfter(known, { aiConfigured: false });   // the first request answered "ai not configured"
    assert.deepEqual([known, shown(known)], [false, false], 'and put away on the first "not set up" answer');
  }
  // a tab told "no AI" earlier in the visit stays told, whatever an older service's health answer does not say
  assert.equal(aiAfter(false, { ok: true }, { health: true }), false);
  // an answer that is not the health answer and does not say changes nothing: the tools do not appear on a guess
  assert.equal(aiAfter(null, { people: [] }), null);
  assert.equal(aiAfter(true, { people: [] }), true);
  // the owner gives the service a key, and People & access says so
  assert.equal(aiAfter(false, { people: [], aiConfigured: true }), true);
});

test('ai: the one line a person reads says the tools are gone, and who can turn them on', () => {
  assert.equal(aiNotSetUpWords('editor'), 'AI is not set up on this site, so the AI tools have been put away. The site’s owner can turn them on.');
  assert.equal(aiNotSetUpWords('admin'), 'AI is not set up on this site, so the AI tools have been put away. To turn them on, give the Kiln service an Anthropic key: wrangler secret put AI_API_KEY');
  for (const mode of ['admin', 'editor']) assert.equal(/[—–]/.test(aiNotSetUpWords(mode)), false, 'no dashes');
  assert.match(assist, /function explainNotConfigured\(\) \{\n  const \{ mode, setStatus \} = deps;\n  setStatus\(aiNotSetUpWords\(mode\), 'error'\);\n\}/);
  assert.equal(noAiKey('https://auth.example'), 'kiln_no_ai:https://auth.example');
});

test('ai: every AI tool in the editor is behind the one question, and the question listens to the service', () => {
  const has = main.slice(main.indexOf('function hasFeature(feature)'), main.indexOf('/** The guide for whoever is signed in'));
  assert.match(has, /return feature === 'ai' \? aiOffered\(\{ granted, sandbox: !!cfg\.sandbox, known: granted && !cfg\.sandbox \? aiHere\(\) : null \}\) : granted;/);
  // the three places an AI tool is drawn, and the menu's own gate
  assert.equal((main.match(/hasFeature\('ai'\)/g) || []).length >= 3, true);
  assert.match(main, /\$\{hasFeature\('ai'\) \? '<button class="kiln-tb-fmt" id="kiln-ai" data-act="ai-alt"/);
  assert.match(main, /\$\{!cfg\.sandbox && hasFeature\('ai'\) \? `<label>Brief/);
  assert.match(main, /\$\{hasFeature\('ai'\) && !md \? '<button class="kiln-tb-fmt" id="kiln-ai" data-cmd="ai"/);
  // the health answer and the people answer are both listened to
  const health = main.slice(main.indexOf('function workerHealth()'), main.indexOf('function workerHealth()') + 420);
  assert.match(health, /\.then\(health => \{ noteAi\(health, true\); return health; \}\);/);
  assert.match(has, /const has = aiAfter\(aiKnown, answer, \{ health \}\);/);
  // nothing waits on the network: the question is answered from what is known now
  assert.match(has, /function aiHere\(\) \{\n  if \(aiKnown === null\) \{ aiRecall\(\); workerHealth\(\); \}\n  return aiKnown;\n\}/);
  assert.equal(/\bawait\b|\.then\(/.test(has), false, 'no waiting between the question and its answer');
  // the answer is asked for while the editor starts, before its bar is drawn, and is not waited for there either
  assert.match(main, /\n  if \(!cfg\.sandbox\) workerHealth\(\);\n  if \(mode === 'editor' && !cfg\.sandbox\) await presencePing\(\);\n  renderAdminBar\(\);/);
  assert.match(main, /if \(data\.aiConfigured === false\) [^\n]*\n      noteAi\(data\);/);
  // told "no AI": remembered for the visit, and the buttons on the page go
  assert.match(has, /sessionStorage\.setItem\(noAiKey\(cfg\.worker\), '1'\)/);
  assert.match(has, /sessionStorage\.removeItem\(noAiKey\(cfg\.worker\)\)/);
  assert.match(has, /if \(!has\) \{ try \{ document\.querySelectorAll\('#kiln-ai, #kiln-ai-menu'\)\.forEach\(el => el\.remove\(\)\);/);
});

test('ai: the first request the service answers "ai not configured" puts the tools away', () => {
  const req = assist.slice(assist.indexOf('async function aiRequest(body)'), assist.indexOf('function failed('));
  assert.match(req, /if \(err\.status !== 501\) throw err;\n[^\n]*\n    if \(deps\.noAi\) deps\.noAi\(\);/);
  assert.match(main, /noAi: \(\) => noteAi\(\{ aiConfigured: false \}\) \}\);/);
});

test('ai: what start-up reaches is declared above the line that starts the editor', () => {
  const start = main.indexOf('\ninit().catch(');
  assert.ok(start !== -1);
  const at = main.indexOf('\nlet aiKnown = null;');
  assert.ok(at !== -1 && at < start, 'aiKnown');
  assert.ok(main.indexOf('\nlet healthzAsk = null;') < start, 'healthzAsk, which the question asks through');
});

test('ai: the service with no AI key answers an AI request 501, and its health answer is read whatever it says', async () => {
  const env = editorEnv({ features: ['ai'] });
  await withFetch(() => undefined, async () => {
    const r = await call(env, 'POST', '/ai/assist', { body: { repo: REPO, action: 'improve', text: 'Hello there.' } });
    assert.equal(r.status, 501);
    assert.equal(r.json.error, 'ai not configured');
    const health = await call(env, 'GET', '/healthz', { session: null });
    assert.equal(health.status, 200);
    // Today it does not say. Once it does (`aiConfigured: !!env.AI_API_KEY`), it says false here, and the editor hides the tools before any press.
    assert.notEqual(aiSaid(health.json), true);
  });
});
