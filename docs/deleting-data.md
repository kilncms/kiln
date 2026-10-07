# Deleting what Kiln keeps

What Kiln stores about a person or a site, and how each part is deleted when
someone asks. For the operator of a Kiln worker: Kiln Cloud's operator, or
whoever runs their own. It describes what the code does today; how fast a
request is answered is the operator's promise to make, in the privacy policy.

## Where things are

| What | Where | Gone by itself |
|---|---|---|
| A Kiln Cloud account: GitHub login, public email | D1 `accounts` | Never |
| A Cloud site: repository, address, plan, subscription id | D1 `sites` | When the site is removed |
| The people invited to a site: email, name, role, folders | KV `people:<owner/repo>` | Never |
| An editor's or member's sign-in | KV `esess:…`, `msess:…` | After the days the owner chose; never when that is 0 |
| The owner's GitHub sign-in (a refresh token) | KV `sid:…` | 180 days after its last use |
| A Cloud dashboard sign-in (with a GitHub token) | KV `csess:…` | 30 days |
| Comment threads: each message's name, email and words | KV `cmt:<owner/repo>:…` | Never |
| Suggestions: who, their note, the edited page | KV `sug:<owner/repo>:…` | Never |
| Scheduled publishes: who, the edits | KV `sched:…` | 14 days after they fire |
| API tokens: a label, folders | KV `atok:…` | After their days; never when 0 |
| When a site address was first registered (for the trial) | KV `firstseen:<origin>` | Never |
| A repository's identity (its name may be a person's login) | KV `rid:…`, `rname:…` | Never |
| Which editor build a site last ran | KV `ebuild:<owner/repo>` | Never |
| Who is editing which page now | KV `pres:…` | 6½ minutes |
| Daily backups of D1 and of the KV entries above | the operator's machine | After 14 backups |
| Billing | Lemon Squeezy | Cancelled, never deleted, by Kiln |
| Commits: "Name (via Kiln)", a no-reply address | the site's own repository | Never |
| Drafts | the repository's `kiln-drafts` branch | Never |
| Suggestion previews | branches `kiln/suggest-<name>` | Never |
| Named versions | tags `kiln/<time>-<name>` | Never |

Kiln sends text and pictures to Anthropic when an editor uses AI assist, and keeps
neither. Worker logs name repositories, not people.

## A person who was invited to a site asks to be removed

1. The site's owner removes them in **People & access**. That takes them off
   `people:`, ends their sign-ins at once (`esess:`, `msess:`) and cancels the
   publishes they scheduled.
2. Their comments and suggestions stay. To delete their comments, the owner
   deletes the threads in Comments. Suggestions have no delete button: the
   operator deletes their `sug:` entries by hand (below).
3. Their name stays in the repository's history as the author of the commits
   they made. Removing it means rewriting that history, which is the site
   owner's choice and can't be undone.

## A Kiln Cloud customer asks for their account to be deleted

There is no button for this yet: the operator does it.

1. In the admin dashboard, remove each of their sites (**Remove** cancels the
   subscription first, and refuses if it can't).
2. Delete the account row (from `worker/`, with the production config):
   `npx wrangler d1 execute kiln_cloud --remote --command
   "DELETE FROM accounts WHERE github_login = '<login>'"`.
3. For each repository the sites had, delete the KV entries that name it:
   `people:<repo>`, `ebuild:<repo>`, every `cmt:<repo>:…`, every `sug:<repo>:…`, and the `sched:`,
   `atok:`, `esess:` and `msess:` entries whose value names the repository
   (`npx wrangler kv key list --binding KILN --remote --prefix <prefix>`, then
   `npx wrangler kv key delete --binding KILN --remote <key>`).
4. Delete `firstseen:<origin>` for each site address only if the person is not
   to be offered a second trial; otherwise leave it.
5. Ask them to uninstall the Kiln GitHub App from their repositories. Until
   they do, an API token or a schedule left in KV could still commit, so step 3
   comes before telling them it is done.
6. In Lemon Squeezy, delete the customer if they ask for their billing record
   to go too.
7. The daily backups still hold the data until they roll over (14 days). Say so
   in the answer.

## A site's owner leaves Kiln but keeps their site

Their repository keeps everything Kiln committed, which is theirs. The
`kiln-drafts` branch, `kiln/suggest-…` branches and `kiln/…` tags can be deleted
in GitHub. The worker's entries are deleted as in steps 2 to 5 above.
