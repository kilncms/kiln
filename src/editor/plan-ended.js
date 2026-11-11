/**
 * A site whose free trial or plan has ended.
 *
 * The worker stops answering such a site's pages, and the browser hides the
 * refusal from the editor: every save used to fail with "The site could not
 * be reached, so please check your connection", which sends an invited editor
 * looking at their wifi. A current worker says where an address stands
 * (GET /standing, readable from any page), so the editor asks once as it
 * starts and puts what it learns on the page, with the way out.
 *
 * An older worker has no such route, and a worker somebody runs themselves
 * has no trials: both answer nothing this module acts on, and the editor goes
 * on as before. Asking never throws and never holds the editor up.
 *
 * Pure (fetch is handed in), so it is tested in node.
 */

/** What the worker says about this address, or null when it says nothing usable. */
export async function askStanding({ worker, origin, fetchImpl = globalThis.fetch, timeoutMs = 6000 }) {
  if (!worker || !origin || typeof fetchImpl !== 'function') return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(`${String(worker).replace(/\/+$/, '')}/standing?origin=${encodeURIComponent(origin)}`, ctl ? { signal: ctl.signal } : undefined);
    if (!res || !res.ok) return null;
    const answer = await res.json();
    return answer && typeof answer === 'object' && typeof answer.editable === 'boolean' ? answer : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Only an http(s) address is ever offered as a link. */
function safeLink(href) {
  try { const u = new URL(String(href)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null; } catch { return null; }
}

/**
 * What to tell the person, or null when there is nothing to tell.
 *   { words, link, linkWords }  `link` is null when the worker named no dashboard
 */
export function endedNotice(answer) {
  if (!answer || answer.editable !== false) return null;
  if (answer.reason !== 'trial_ended' && answer.reason !== 'plan_ended') return null;
  const trial = answer.reason === 'trial_ended';
  const link = safeLink(answer.dashboard);
  return {
    words: trial
      ? 'This site’s free trial has ended, so changes cannot be published until the site’s owner subscribes. The site and everything already published are untouched.'
      : 'This site’s Kiln plan has ended, so changes cannot be published until the site’s owner subscribes again. The site and everything already published are untouched.',
    link,
    linkWords: link ? 'For the owner: open the Kiln dashboard' : null,
  };
}
