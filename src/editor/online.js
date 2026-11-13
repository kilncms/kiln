/**
 * Who else is online: one row per person, and saying "I have left" on sign-out.
 *
 * A tester signed in as one person after another in one browser, and the Kiln
 * menu went on to read "2 online", then "3 online": each person who had signed
 * out kept counting until their entry on the service ran out, six and a half
 * minutes later.
 *
 * Here: the list the menu counts (peopleOnline: each person once, however many
 * tabs they have, and never the person looking), what the editor sends when a
 * person signs out (leaveBody), and the sending itself (tellLeft), which never
 * holds the sign-out up for long and never fails it.
 *
 * Pure, and tested in node (test/online.test.js).
 */

/**
 * The people the menu counts as online.
 *   rows  what the service lists: { name, role, page }
 *   me    the name this person is signed in under
 * A person is one row whatever the service sent (an older service sent a row
 * for every page a person had open), and the person looking is not counted.
 */
export function peopleOnline(rows, me = '') {
  const mine = String(me || '').trim();
  const seen = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.name || '').trim();
    if (!name || name === mine || seen.has(name)) continue;
    seen.set(name, { ...row, name });
  }
  return [...seen.values()];
}

/** What the chip in the menu reads: "1 online", "3 online". */
export function onlineLabel(people) {
  return `${Array.isArray(people) ? people.length : 0} online`;
}

/** What the editor sends to the service's /presence when a person signs out. */
export function leaveBody({ repo, path, name } = {}) {
  return { repo, path: String(path || '/'), name, leave: true };
}

/**
 * Tell the service this person has left. `send` does the sending and may
 * answer late, fail or throw: whatever happens this resolves, with true when
 * the service was told and false when it was not, and after `wait`
 * milliseconds at the latest. Signing out goes ahead either way.
 */
export async function tellLeft(send, { wait = 1500 } = {}) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(send).then((res) => !res || res.ok !== false, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), wait); }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
