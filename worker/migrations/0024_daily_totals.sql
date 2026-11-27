-- Daily totals (worker/daily-totals.js): one line a day for the whole of
-- Kiln, so that the operator can see how it is doing over time. It names no
-- one. Written by the first run of the five-minute schedule after midnight
-- Eastern, only while the service's DAILY_TOTALS setting is "on", which waits
-- for the privacy page to say so.
--
--   day        the date in Eastern time, YYYY-MM-DD: how things stood as that day began
--   at         when the line was written, in milliseconds
--   accounts   accounts on Kiln
--   sites      sites on Kiln
--   paying     sites whose subscription is active
--   mrr_cents  what the paying sites bring in a month, in cents, counted as the
--              operator's overview counts it (billing.js monthlyPrice)
--   trialing   sites on their free days
--
-- Kept for as long as Kiln runs. A second run on the same day writes nothing.
-- Apply this before the service that writes it. A service running on a
-- database this has not reached works as before and records nothing.
CREATE TABLE IF NOT EXISTS daily_totals (
  day TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  accounts INTEGER NOT NULL,
  sites INTEGER NOT NULL,
  paying INTEGER NOT NULL,
  mrr_cents INTEGER NOT NULL,
  trialing INTEGER NOT NULL
);
