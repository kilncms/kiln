-- A new domain through Kiln, included with the yearly form of the hosting
-- plan (worker/register.js). Kiln registers the name in its own Cloudflare
-- account and puts the site on it. Switched off unless REGISTER_DOMAINS is "on".
--
-- One row for each time Kiln asked Cloudflare to register a name.
--   state         'asking'       written before the call; Cloudflare's word is not in yet
--                 'registered'   the name is registered
--                 'failed'       Cloudflare itself said nothing was registered (`reason`)
--                 'stuck'        needs a person
--                 'handed_over'  the name left with its customer
--                 'ran_out'      the name was not renewed and its year ended
--   subscription_id  the billing subscription the name came with
--   holder        who the name was registered to: 'kiln' or 'customer'
--   price_first, price_renew  what Cloudflare asked for the first year and for
--                 each year after, in US cents, as checked just before the call
--   asked_at, answered_at  when the call to register was sent and when its answer came
--   expires_at    the day the name runs out, as Cloudflare says it
--   renews        1 while the name renews by itself
--   zone_id       Cloudflare's id for the name's zone. Never shown to anybody.
--   told_at, reminded_at  when the operator and the customer were last written to
--   leave_asked_at, handed_at  when the customer asked to take the name away, and when it left
-- Times are epoch milliseconds. The row outlives its site and is found by account.
CREATE TABLE IF NOT EXISTS registrations (
  id               TEXT PRIMARY KEY,
  site_id          TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  subscription_id  TEXT NOT NULL,
  name             TEXT NOT NULL,
  state            TEXT NOT NULL,
  reason           TEXT,
  holder           TEXT NOT NULL DEFAULT 'kiln',
  price_first      INTEGER,
  price_renew      INTEGER,
  asked_at         INTEGER,
  answered_at      INTEGER,
  registered_at    INTEGER,
  expires_at       INTEGER,
  renews           INTEGER NOT NULL DEFAULT 1,
  renew_changed_at INTEGER,
  zone_id          TEXT,
  checked_at       INTEGER,
  told_at          INTEGER,
  reminded_at      INTEGER,
  leave_asked_at   INTEGER,
  handed_at        INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
-- These three rules are kept by the database and not by code.
-- One name for a subscription, for good.
CREATE UNIQUE INDEX IF NOT EXISTS registrations_one_for_subscription ON registrations(subscription_id) WHERE state != 'failed';
-- One at a time for a site.
CREATE UNIQUE INDEX IF NOT EXISTS registrations_one_for_site ON registrations(site_id) WHERE state IN ('asking','stuck','registered');
-- Two customers cannot race for one name.
CREATE UNIQUE INDEX IF NOT EXISTS registrations_one_for_name ON registrations(name) WHERE state != 'failed';
CREATE INDEX IF NOT EXISTS registrations_account ON registrations(account_id);
CREATE INDEX IF NOT EXISTS registrations_state ON registrations(state);

-- Whether a subscription is paid by the month or by the year ('month', 'year'),
-- and up to when it is paid, as the billing company says it.
ALTER TABLE sites ADD COLUMN billing_period TEXT;
ALTER TABLE sites ADD COLUMN paid_until INTEGER;

-- 1 for a domain Kiln registered itself: there are no name servers for anybody to enter.
ALTER TABLE domains ADD COLUMN registered INTEGER NOT NULL DEFAULT 0;
