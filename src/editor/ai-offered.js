/**
 * Whether the AI tools are offered on this site (hasFeature('ai') in main.js).
 *
 * AI assist works only where the Kiln service holds an AI key. Where it holds
 * none, every AI request is answered "ai not configured" (501), so a button
 * that offers AI there can only fail. The tools are shown to someone granted
 * them unless the service has said it has no AI. It says so in three places:
 *
 *   the health answer (/healthz)   `aiConfigured`, once the service gives it
 *                                  there. It does not yet: see below.
 *   the people answer              `aiConfigured`, to the owner, when People &
 *                                  access is opened
 *   the first AI request           a 501: the tools are put away there and
 *                                  then, and stay away for this visit
 *
 * Until the health answer carries the field, an editor cannot know before
 * the first press, so on a site with no AI the tools are there once, say that
 * AI is not set up, and go. What the service needs is one field in the
 * answer of /healthz in worker/index.js: `aiConfigured: !!env.AI_API_KEY`.
 * The editor already reads it.
 *
 * Pure: no page, no state of its own (test/ai-offered.test.js).
 */

/** Where this tab remembers that the service said it has no AI. */
export const noAiKey = (worker) => `kiln_no_ai:${worker || ''}`;

/** What an answer of the service says about AI: true, false, or null when it does not say. */
export function aiSaid(answer) {
  return answer && typeof answer === 'object' && typeof answer.aiConfigured === 'boolean' ? answer.aiConfigured : null;
}

/**
 * Are the AI tools shown?
 *   granted  this person has the AI assist tool (the owner always has)
 *   sandbox  the demo, which shows every tool and says what each does on a real site
 *   known    what the service has said: true, false, or null while it has not said
 */
export function aiOffered({ granted, sandbox = false, known = null }) {
  if (!granted) return false;
  if (sandbox) return true;
  return known !== false;
}

/** The line shown the one time an AI tool is pressed on a site with no AI. */
export function aiNotSetUpWords(mode) {
  const gone = 'AI is not set up on this site, so the AI tools have been put away.';
  return mode === 'admin'
    ? `${gone} To turn them on, give the Kiln service an Anthropic key: wrangler secret put AI_API_KEY`
    : `${gone} The site’s owner can turn them on.`;
}
