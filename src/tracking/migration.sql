-- proof-trading-bot tracking + registry schema (idempotent), isolated in a dedicated
-- schema so it doesn't collide with other projects in the same database. Auto-runs on
-- PostgresTracker.connect() (see src/tracking/postgres.ts migrationSql()); this copy is
-- for manual runs via the Supabase SQL editor / psql. Replace `proof_bot` if you set a
-- different DB_SCHEMA.

create schema if not exists proof_bot;

create table if not exists proof_bot.bot_orders (
  id bigserial primary key,
  client_order_id text not null,
  strategy text not null,
  kind text not null,            -- 'order' | 'basket'
  market int not null,
  side text not null,            -- 'Buy' | 'Sell'
  price text not null,           -- micro-USDC (bigint as text)
  quantity text not null,
  tx_hash text,
  check_tx_code int,             -- 0 = CheckTx accepted (NOT execution-confirmed)
  note text,
  ts timestamptz not null default now()
);
alter table proof_bot.bot_orders add column if not exists bot text not null default 'main';
create index if not exists bot_orders_bot_ts_idx on proof_bot.bot_orders (bot, ts);
create index if not exists bot_orders_strategy_ts_idx on proof_bot.bot_orders (strategy, ts);

create table if not exists proof_bot.bot_snapshots (
  id bigserial primary key,
  balance text not null,
  equity text not null,
  margin_ratio_bps text not null,
  positions jsonb not null default '[]',
  ts timestamptz not null default now()
);
alter table proof_bot.bot_snapshots add column if not exists bot text not null default 'main';
create index if not exists bot_snapshots_bot_ts_idx on proof_bot.bot_snapshots (bot, ts);

create table if not exists proof_bot.bot_decisions (
  id bigserial primary key,
  strategy text not null,
  action text not null,
  detail jsonb not null default '{}',
  ts timestamptz not null default now()
);
alter table proof_bot.bot_decisions add column if not exists bot text not null default 'main';
alter table proof_bot.bot_decisions add column if not exists market int;

-- Bot registry: the roster. Keys are AES-256-GCM encrypted (BOTS_ENC_KEY).
-- Scale by inserting a row (`pnpm bots add`). NEVER expose private_key_enc via an API.
create table if not exists proof_bot.bots (
  id text primary key,
  strategies text[] not null default '{}',
  markets jsonb not null default '"all"',   -- event ids array, or "all"
  tags text[] not null default '{}',
  private_key_enc text not null,
  params jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
