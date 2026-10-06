-- Kiln Cloud — accounts, sites, and their subscription status.
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,        -- uuid
  github_login   TEXT UNIQUE NOT NULL,    -- GitHub OAuth identity
  email          TEXT,
  ls_customer_id TEXT,                    -- Lemon Squeezy customer id
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id                 TEXT PRIMARY KEY,    -- uuid
  account_id         TEXT NOT NULL,
  repo               TEXT NOT NULL,       -- owner/name
  origin             TEXT NOT NULL UNIQUE,-- https://site.example (the allowlist key)
  plan               TEXT NOT NULL,       -- 'cloud' | 'managed'
  status             TEXT NOT NULL,       -- 'trialing' | 'active' | 'past_due' | 'canceled'
  ls_subscription_id TEXT,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sites_origin  ON sites(origin);
CREATE INDEX IF NOT EXISTS sites_account ON sites(account_id);
