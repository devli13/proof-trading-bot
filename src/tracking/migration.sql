-- proof-trading-bot tracking schema (idempotent), isolated in a dedicated schema
-- so it doesn't collide with other projects in the same database. Auto-runs on
-- PostgresTracker.connect() (see src/tracking/postgres.ts migrationSql()); this
-- copy is for manual runs via the Supabase SQL editor / psql. Replace `proof_bot`
-- if you set a different DB_SCHEMA.

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
create index if not exists bot_orders_strategy_ts_idx on proof_bot.bot_orders (strategy, ts);

create table if not exists proof_bot.bot_snapshots (
  id bigserial primary key,
  balance text not null,
  equity text not null,
  margin_ratio_bps text not null,
  positions jsonb not null default '[]',
  ts timestamptz not null default now()
);

create table if not exists proof_bot.bot_decisions (
  id bigserial primary key,
  strategy text not null,
  action text not null,
  detail jsonb not null default '{}',
  ts timestamptz not null default now()
);
