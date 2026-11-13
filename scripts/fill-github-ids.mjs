#!/usr/bin/env node
/**
 * fill-github-ids — print the SQL that writes GitHub's number on accounts made
 * before accounts had one (migration 0012_github_id.sql).
 *
 *   node scripts/fill-github-ids.mjs <login> [<login> …]
 *   node scripts/fill-github-ids.mjs ada rosa > fill.sql
 *
 * This only PRINTS. It asks https://api.github.com/users/<login> for each
 * login and prints one statement for each, and you run them yourself:
 *
 *   cd worker
 *   npx wrangler d1 execute kiln-cloud --env production --remote --file ../fill.sql
 *
 * The logins that are waiting for a number:
 *
 *   SELECT github_login FROM accounts WHERE github_login IS NOT NULL AND github_id IS NULL;
 *
 * Read the list before you run this. GitHub gives the number of whoever holds
 * a login TODAY. If the person who made the account has renamed since, the
 * login may be free (this says so and prints no statement) or in somebody
 * else's hands (this cannot tell, and would print that person's number). Leave
 * out any login you are not sure of, and let its person sign in instead.
 *
 * A statement changes nothing on an account that has a number already, so it
 * is safe to run twice. GitHub answers 60 questions an hour from one address
 * without a sign-in. Set GITHUB_TOKEN to ask more.
 */
const API = 'https://api.github.com';
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;   // what GitHub allows, and nothing that could end the quoted text in a statement

const logins = [...new Set(process.argv.slice(2))];
if (!logins.length || logins.some(l => l.startsWith('--'))) {
  console.error('Give the logins to look up: node scripts/fill-github-ids.mjs <login> [<login> …]');
  process.exit(2);
}

let missed = 0;
const note = (line) => { missed++; console.error(line); console.log(`-- ${line}`); };

console.log('-- GitHub\'s number for each account, as GitHub gave it for the login today.');
console.log('-- Check that each login still belongs to the person who made the account, then run these.');
for (const login of logins) {
  if (!LOGIN.test(login)) { note(`"${login.slice(0, 60).replace(/[^A-Za-z0-9-]/g, '?')}" is not a GitHub login. No statement for it. Check the spelling.`); continue; }
  let res;
  try {
    res = await fetch(`${API}/users/${login}`, { headers: {
      Accept: 'application/vnd.github+json', 'User-Agent': 'kiln-fill-github-ids',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    } });
  } catch (e) { note(`GitHub could not be reached for ${login} (${String(e?.message || e).slice(0, 80)}). No statement for it. Run this again for ${login}.`); continue; }
  if (res.status === 404) { note(`Nobody on GitHub is called ${login} today. No statement for it. Its person has renamed or left: let them sign in, or write the number by hand once you know it.`); continue; }
  if (!res.ok) { note(`GitHub answered ${res.status} for ${login}. No statement for it. Wait a while and run this again for ${login}, or set GITHUB_TOKEN.`); continue; }
  const user = await res.json().catch(() => null);
  const n = user && user.id;
  if (!Number.isSafeInteger(n) || n <= 0) { note(`GitHub gave no number for ${login}. No statement for it. Run this again for ${login}.`); continue; }
  if (user.type && user.type !== 'User') { note(`${login} is not a person on GitHub today (GitHub calls it "${String(user.type).replace(/[^A-Za-z]/g, '')}"). No statement for it. Its person has renamed: let them sign in.`); continue; }
  if (user.login && user.login !== login) console.log(`-- GitHub spells this login ${String(user.login).replace(/[^A-Za-z0-9-]/g, '?')}. The statement uses your spelling: make sure it is the one in the database.`);
  console.log(`UPDATE accounts SET github_id = ${n} WHERE github_login = '${login}' AND github_id IS NULL;`);
}
if (missed) { console.error(`${missed} of ${logins.length} got no statement. Read the lines above.`); process.exit(1); }
