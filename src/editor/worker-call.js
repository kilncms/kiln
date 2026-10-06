/**
 * Asking the worker for something with the editor's sign-in.
 *
 * Everything the editor asks of the worker's own routes (comments,
 * suggestions, schedules, People, AI assist, presence, source edits) goes
 * through here, so a failed answer always carries its status and body the way
 * the GitHub transport's does, and sign-in-ended.js can say what it means.
 *
 * Two things the answers alone do not settle, and what is done about each
 * with only what every worker has always answered:
 *
 *  - Some routes answer 403 when the worker does not know who is asking
 *    (schedules, presence, People), where others answer 401. A 403 is
 *    therefore checked once: `stands()` asks through the editor's main
 *    transport, which answers an ended sign-in with 401 on every worker. If
 *    it says the sign-in is over, that answer is the one thrown.
 *
 *  - The owner's GitHub token runs out every eight hours and the transport
 *    renews it. These routes are sent that token too, so for the owner a 401
 *    is checked the same way; when the check renewed the token, the request
 *    is sent once more with the new one.
 *
 * Pure: fetch and the check are handed in, so all of it is tested in node.
 */

/**
 *   worker    the worker's address
 *   headers   () → the sign-in headers as they are now
 *   stands    () → resolves when the sign-in still stands; throws what the
 *             transport threw when it does not, or could not be asked
 *   renews    true when `stands` can renew the sign-in (the owner's token)
 *   ended     (err) called with the error whenever an answer says the sign-in is over
 */
export function makeAsk({ worker, headers, stands = null, renews = false, ended = () => {}, fetchImpl = globalThis.fetch }) {
  return async function ask(route, { method = 'GET', body } = {}) {
    let sentWith = '';   // the sign-in headers the last request went out with
    const send = () => {
      const signIn = headers();
      sentWith = JSON.stringify(signIn);
      return fetchImpl(worker + route, {
        method,
        headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...signIn },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    };
    let res = await send();
    let good = false;   // the check was made, and the sign-in stands
    if (stands && (res.status === 403 || (res.status === 401 && renews))) {
      try {
        await stands();
        good = true;
      } catch (err) {
        // The sign-in is over: that is the answer. Anything else the check met leaves the first answer as it is.
        if (err?.signIn === 'ended' || (!err?.signIn && err?.status === 401)) { ended(err); throw err; }
      }
      // The sign-in is not the one the request went out with (renewed by the
      // check, or by something else while the request was on its way): once more, with the one there is now.
      if (good && JSON.stringify(headers()) !== sentWith) res = await send();
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    const said = data && typeof data.error === 'string' && data.error.trim();
    const err = new Error(said || `the request failed (${res.status})`);
    err.status = res.status;
    err.data = data && typeof data === 'object' ? data : {};
    // A 401 to a sign-in that was just found good is a refusal, not an ended sign-in.
    if (res.status === 401 && good) err.signIn = 'stands';
    else if (res.status === 401) ended(err);
    throw err;
  };
}
