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
--   want_address, want_inbox, want_inbox_id, want_asked_at, want_since
--                a change that waits beside a row that is 'on': the address
--                and the inbox its owner asked to change to, Cloudflare's id
--                for that inbox, when Cloudflare last wrote to it, and when
--                the change was asked for. The row keeps its address, inbox
--                and rule, and stays 'on', until the new inbox confirms. Then
--                it takes these values and they are emptied. A change that
--                never confirms is emptied too, and nothing else is touched.
--                All five are empty when no change waits.
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
  want_address  TEXT,
  want_inbox    TEXT,
  want_inbox_id TEXT,
  want_asked_at INTEGER,
  want_since    INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS forwards_state ON forwards(state);
