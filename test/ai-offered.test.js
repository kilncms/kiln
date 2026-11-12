/**
 * Whether the AI tools are offered (src/editor/ai-offered.js, used by
 * hasFeature('ai') in main.js and by assist.js).
 *
 * On a site whose Kiln service holds no AI key, the toolbar's ✨ button, the
 * picture's "Describe" and the new page's "let AI draft the content" were all
 * offered, and each could only fail: the service answers every AI request
 * "ai not configured". The tools are now shown only where the service has not
 * said it has no AI, and are put away the first time it says so.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aiSaid, aiOffered, aiNotSetUpWords, noAiKey } from '../src/editor/ai-offered.js';
import { editorEnv, call, withFetch, REPO } from './worker-harness.js';

const main = readFileSync(new URL('../src/editor/main.js', import.meta.url), 'utf8');
const assist = readFileSync(new URL('../src/editor/assist.js', import.meta.url), 'utf8');

test('ai: an answer of the service says it has AI, says it has none, or does not say', () => {
  assert.equal(aiSaid({ ok: true, aiConfigured: true }), true);
  assert.equal(aiSaid({ people: [], googleConfigured: true, aiConfigured: false }), false);
  for (const silent of [null, undefined, 'ok', {}, { ok: true, modes: ['html'] }, { aiConfigured: 'yes' }, { aiConfigured: 0 }]) assert.equal(aiSaid(silent), null);
});

test('ai: the tools are shown to someone granted them, unless the service has said it has no AI', () => {
  assert.equal(aiOffered({ granted: true, known: true }), true);
  assert.equal(aiOffered({ granted: true, known: null }), true, 'a service that does not say leaves them as they were');
  assert.equal(aiOffered({ granted: true, known: false }), false, 'no AI on the service: nothing is offered that can only fail');
  for (const known of [true, false, null]) assert.equal(aiOffered({ granted: false, known }), false, 'never to someone not granted them');
  assert.equal(aiOffered({ granted: true, sandbox: true, known: false }), true, 'the demo shows every tool, and says what each does on a real site');
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
  assert.match(health, /\.then\(health => \{ noteAi\(health\); return health; \}\);/);
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
