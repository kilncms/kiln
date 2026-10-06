-- Until when a site keeps editing after its subscription stopped renewing:
-- the end of the paid period after a cancellation, or the end of the grace
-- after a failed payment. Epoch milliseconds. NULL = no such allowance, the
-- status alone decides.
ALTER TABLE sites ADD COLUMN access_until INTEGER;
