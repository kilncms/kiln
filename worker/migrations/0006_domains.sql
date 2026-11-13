-- A hosted site's own domain: the zone in the hosting account that answers
-- for it once its owner has changed the domain's name servers, and how far
-- that has got. One domain for a site, and one site for a domain.
--   state        'waiting'   everything is ready and the name servers are not changed yet
--                'live'      the name servers point at Kiln and the site answers at `name`
--                'put_away'  the set-up was stopped, or nobody finished it (`reason` says why)
--                'failed'    the set-up could not be made (`reason`); nothing was left behind
--   zone_id      Cloudflare's id for the zone. Never shown to anybody.
--   ns1, ns2     the two name servers the owner enters where the domain was bought
--   old_name_servers  the name servers the domain had before (JSON text), so the
--                owner can see what is being replaced, and what to go back to
--   seller       who the domain was bought from, as the registry names it
--   seller_id    that seller's registered number (its IANA id)
--   records      the records that were kept when the zone was made (JSON text),
--                so the owner can compare them with the seller's list
--   reminded_at  when the owner was reminded that the name servers are not changed
-- Only a row that is waiting or live holds its name: worker/domain.js clears a
-- put-away or failed row out of the way of whoever asks for the name next.
-- Times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS domains (
  site_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  zone_id      TEXT,
  state        TEXT NOT NULL,
  reason       TEXT,
  ns1          TEXT,
  ns2          TEXT,
  old_name_servers TEXT,
  seller       TEXT,
  seller_id    INTEGER,
  records      TEXT,
  checked_at   INTEGER,
  reminded_at  INTEGER,
  live_at      INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS domains_state ON domains(state);
