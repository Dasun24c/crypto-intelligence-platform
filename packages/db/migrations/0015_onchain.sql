-- Phase 11: the Whale Tracker's on-chain side (REQUIREMENTS §7, WH-02; proposal 003; ADR 025).
-- Exchange flow needs no table: it reads market.large_trades and market.orderbook_walls.

CREATE SCHEMA onchain;

-- Exchange addresses, curated by hand from what the exchanges publish (proposal 003): admins keep
-- them through the API; a transfer to or from one is labelled with its owner.
CREATE TABLE onchain.labels (
  id          uuid PRIMARY KEY,
  chain       text NOT NULL CHECK (chain IN ('bitcoin', 'ethereum', 'solana')),
  address     text NOT NULL,                                 -- Ethereum: lowercase hex
  owner       text NOT NULL CHECK (length(owner) BETWEEN 1 AND 60),
  wallet      text NOT NULL DEFAULT 'unknown' CHECK (wallet IN ('cold', 'hot', 'reserve', 'unknown')),
  source      text NOT NULL CHECK (length(source) BETWEEN 1 AND 500), -- where it was published
  created_by  uuid REFERENCES app.users (id),                -- null: seeded with the migrations
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address),
  CHECK (chain <> 'ethereum' OR address ~ '^0x[0-9a-f]{40}$')
);

-- Large transfers, and PAXG mints and burns, as detected. One row per (chain, transaction, asset,
-- position): a block read twice, or a message delivered twice, adds nothing (criterion 11.2).
CREATE TABLE onchain.events (
  id            uuid PRIMARY KEY,
  chain         text NOT NULL CHECK (chain IN ('bitcoin', 'ethereum', 'solana')),
  asset         text NOT NULL CHECK (asset IN ('BTC', 'ETH', 'SOL', 'PAXG')),
  kind          text NOT NULL CHECK (kind IN ('transfer', 'mint', 'burn')),
  tx_hash       text NOT NULL,
  position      int NOT NULL CHECK (position >= 0),          -- the log index on Ethereum, else 0
  block_number  bigint NOT NULL CHECK (block_number >= 0),   -- height, or the slot on Solana
  block_time    timestamptz NOT NULL,
  from_address  text,                                        -- null for a mint
  to_address    text,                                        -- null for a burn
  amount        numeric NOT NULL CHECK (amount > 0),         -- in the asset's units
  price_usd     numeric CHECK (price_usd > 0),               -- the platform's own price at detection
  usd_value     numeric CHECK (usd_value >= 0),
  provider      text NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}',                 -- e.g. a Bitcoin transaction's input and output counts
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, tx_hash, asset, position),
  CHECK (kind = 'transfer' OR asset = 'PAXG'),
  CHECK (kind <> 'mint' OR (from_address IS NULL AND to_address IS NOT NULL)),
  CHECK (kind <> 'burn' OR (to_address IS NULL AND from_address IS NOT NULL)),
  CHECK ((price_usd IS NULL) = (usd_value IS NULL))
);
CREATE INDEX ON onchain.events (block_time DESC);
CREATE INDEX ON onchain.events (asset, block_time DESC);

-- How far each chain's watcher got, so a restart reads the blocks it missed.
CREATE TABLE onchain.cursors (
  chain         text PRIMARY KEY CHECK (chain IN ('bitcoin', 'ethereum', 'solana')),
  block_number  bigint NOT NULL CHECK (block_number >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

GRANT USAGE ON SCHEMA onchain TO svc_api, svc_jobs;
-- The jobs service detects and records events; it deletes one only when its block was replaced (a reorg).
GRANT SELECT, INSERT, DELETE ON onchain.events TO svc_jobs;
GRANT SELECT, INSERT, UPDATE ON onchain.cursors TO svc_jobs;
GRANT SELECT ON onchain.labels TO svc_jobs;
-- The api reads events and keeps the labels for the admins.
GRANT SELECT ON onchain.events, onchain.cursors TO svc_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON onchain.labels TO svc_api;
