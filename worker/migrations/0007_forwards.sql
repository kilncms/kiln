-- One forwarded email address on a hosted site's own domain: mail sent to
-- `address` (such as hello@theirdomain.com) reaches `inbox`, a mailbox its
-- owner already has somewhere else. One address for a site.
--   address      the whole address at the site's domain, in lowercase
--   inbox        where its mail goes, in lowercase. Never at the same domain.
--   inbox_id     Cloudflare's id for that inbox in the hosting account's list
--                of addresses it may forward to. Never shown to anybody.
--   rule_id      Cloudflare's id for the forwarding rule in the domain's zone.
--                Empty until the inbox has confirmed. Never shown to anybody.
--   state        'confirming'  Cloudflare has emailed the inbox and nobody has
--                              pressed the button in that email yet
--                'on'          the inbox confirmed and the rule is in place
--                'off'         its owner switched it off: the rule is gone and
--                              the domain's mail records are left as they were
--                'failed'      it could not be made (`reason` says why)
--   reason       one of worker/domain-mail.js's codes, for a row that stopped short
--   asked_at     when Cloudflare was last asked to send its confirmation email,
--                so that "Send it again" can be held to once every ten minutes
--   on_at        when the forwarding was switched on
-- Times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS forwards (
  site_id      TEXT PRIMARY KEY,
  address      TEXT NOT NULL,
  inbox        TEXT NOT NULL,
  inbox_id     TEXT,
  rule_id      TEXT,
  state        TEXT NOT NULL,
  reason       TEXT,
  asked_at     INTEGER,
  on_at        INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS forwards_state ON forwards(state);
