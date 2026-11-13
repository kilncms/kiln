/**
 * Whether the AI tools are offered on this site (hasFeature('ai') in main.js).
 *
 * AI assist works only where the Kiln service holds an AI key. Where it holds
 * none, every AI request is answered "ai not configured" (501), so a button
 * that offers AI there can only fail. The tools are shown to someone granted
 * them only once the service has said it has AI. It says in three places:
 *
 *   the health answer (/healthz)   `aiConfigured`, asked while the editor starts
 *   the people answer              `aiConfigured`, to the owner, when People &
 *                                  access is opened
 *   the first AI request           a 501: the tools are put away there and
 *                                  then, and stay away for this visit
 *
 * Until an answer has come the tools are not offered. They used to be, so on
 * a site with no AI the "let AI draft the content" brief and the ✨ button
 * were there for the first seconds after sign-in and then went. Nothing waits
 * for the answer: a dialog opened before it has come is drawn without them.
 *
 * An older service does not say (no `aiConfigured` in its health answer). Its
 * editors keep what they had before: once that answer has come without saying,
 * the tools are offered, and put away on the first "not set up" answer.
 *
 * Pure: no page, no state of its own (test/ai-offered.test.js).
 */

/** Where this tab remembers that the service said it has no AI. */
export const noAiKey = (worker) => `kiln_no_ai:${worker || ''}`;

/** What an answer of the service says about AI: true, false, or null when it does not say. */
export function aiSaid(answer) {
  return answer && typeof answer === 'object' && typeof answer.aiConfigured === 'boolean' ? answer.aiConfigured : null;
}

/** What is known once the health answer has come and does not say: an older service. */
export const AI_NOT_SAID = 'not said';

/**
 * What is known about AI after an answer of the service.
 *   known   what was known before: true, false, AI_NOT_SAID, or null (no answer yet)
 *   answer  the answer
 *   health  it is the health answer, the one that says on every service that can say
 * An answer that says is believed. The health answer that does not say makes
 * the service an older one, unless something is already known. Any other
 * answer that does not say changes nothing.
 */
export function aiAfter(known, answer, { health = false } = {}) {
  const said = aiSaid(answer);
  if (said !== null) return said;
  return health && known === null ? AI_NOT_SAID : known;
}

/**
 * Are the AI tools shown?
 *   granted  this person has the AI assist tool (the owner always has)
 *   sandbox  the demo, which shows every tool and says what each does on a real site
 *   known    true or false as the service said, AI_NOT_SAID for an older
 *            service that does not say, null while no answer has come
 */
export function aiOffered({ granted, sandbox = false, known = null }) {
  if (!granted) return false;
  if (sandbox) return true;
  return known === true || known === AI_NOT_SAID;
}

/** The line shown the one time an AI tool is pressed on a site with no AI. */
export function aiNotSetUpWords(mode) {
  const gone = 'AI is not set up on this site, so the AI tools have been put away.';
  return mode === 'admin'
    ? `${gone} To turn them on, give the Kiln service an Anthropic key: wrangler secret put AI_API_KEY`
    : `${gone} The site’s owner can turn them on.`;
}
