import type { Sql } from "postgres";
import type { Logger } from "../logger.js";
import type {
  Tracker,
  OrderRecord,
  PositionSnapshot,
  DecisionRecord,
} from "./types.js";

/**
 * Idempotent schema, isolated in a dedicated Postgres SCHEMA so this project's
 * tables don't collide with other projects sharing the same database. `schema`
 * is a config-validated bare identifier (safe to interpolate into DDL).
 */
export function migrationSql(schema: string): string {
  return `
create schema if not exists ${schema};
create table if not exists ${schema}.bot_orders (
  id bigserial primary key,
  client_order_id text not null,
  strategy text not null,
  kind text not null,
  market int not null,
  side text not null,
  price text not null,
  quantity text not null,
  tx_hash text,
  check_tx_code int,
  note text,
  ts timestamptz not null default now()
);
alter table ${schema}.bot_orders add column if not exists bot text not null default 'main';
create index if not exists bot_orders_bot_ts_idx on ${schema}.bot_orders (bot, ts);
create index if not exists bot_orders_strategy_ts_idx on ${schema}.bot_orders (strategy, ts);

create table if not exists ${schema}.bot_snapshots (
  id bigserial primary key,
  balance text not null,
  equity text not null,
  margin_ratio_bps text not null,
  positions jsonb not null default '[]',
  ts timestamptz not null default now()
);
alter table ${schema}.bot_snapshots add column if not exists bot text not null default 'main';
create index if not exists bot_snapshots_bot_ts_idx on ${schema}.bot_snapshots (bot, ts);

create table if not exists ${schema}.bot_decisions (
  id bigserial primary key,
  strategy text not null,
  action text not null,
  detail jsonb not null default '{}',
  ts timestamptz not null default now()
);
alter table ${schema}.bot_decisions add column if not exists bot text not null default 'main';
alter table ${schema}.bot_decisions add column if not exists market int;

create table if not exists ${schema}.bots (
  id text primary key,
  strategies text[] not null default '{}',
  markets jsonb not null default '"all"',
  tags text[] not null default '{}',
  private_key_enc text not null,
  params jsonb not null default '{}',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- ── Realtime streaming + RLS (Supabase). anon may READ the 3 non-sensitive tables
-- (for the public dashboard); the bots table (private_key_enc) is NEVER granted to
-- anon. A trigger broadcasts a lightweight signal on each new snapshot so the
-- dashboard streams over WebSocket instead of polling. Idempotent + guarded so it's
-- a no-op on a plain (non-Supabase) Postgres that lacks the anon role / realtime.
do $$
declare s text := '${schema}';
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute format('alter table %I.bot_snapshots enable row level security', s);
    execute format('alter table %I.bot_orders enable row level security', s);
    execute format('alter table %I.bot_decisions enable row level security', s);
    execute format('alter table %I.bots enable row level security', s);
    execute format('grant usage on schema %I to anon', s);
    execute format('grant select on %I.bot_snapshots to anon', s);
    execute format('grant select on %I.bot_orders to anon', s);
    execute format('grant select on %I.bot_decisions to anon', s);
    execute format('revoke all on %I.bots from anon', s); -- keys: anon gets nothing
    execute format('drop policy if exists anon_read on %I.bot_snapshots', s);
    execute format('create policy anon_read on %I.bot_snapshots for select to anon using (true)', s);
    execute format('drop policy if exists anon_read on %I.bot_orders', s);
    execute format('create policy anon_read on %I.bot_orders for select to anon using (true)', s);
    execute format('drop policy if exists anon_read on %I.bot_decisions', s);
    execute format('create policy anon_read on %I.bot_decisions for select to anon using (true)', s);
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname=s and tablename='bot_snapshots') then
      execute format('alter publication supabase_realtime add table %I.bot_snapshots', s); end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname=s and tablename='bot_orders') then
      execute format('alter publication supabase_realtime add table %I.bot_orders', s); end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname=s and tablename='bot_decisions') then
      execute format('alter publication supabase_realtime add table %I.bot_decisions', s); end if;
  end if;
end $$;

create or replace function ${schema}.notify_realtime() returns trigger
language plpgsql security definer as $body$
begin
  perform realtime.send(jsonb_build_object('src', tg_table_name), 'change', 'proof_bot_fleet', false);
  return null;
exception when undefined_function then
  return null; -- non-Supabase Postgres: no realtime.send, no-op
end $body$;
drop trigger if exists trg_notify_snapshots on ${schema}.bot_snapshots;
create trigger trg_notify_snapshots after insert on ${schema}.bot_snapshots
  for each statement execute function ${schema}.notify_realtime();
`;
}

/**
 * Supabase/Postgres-backed tracker. Writes are best-effort (a DB hiccup must
 * never crash a trading tick) — every write swallows + logs errors. For Vercel
 * serverless point DATABASE_URL at the TRANSACTION pooler (:6543) and keep the
 * pool tiny. All tables are schema-qualified to keep the project isolated.
 */
export class PostgresTracker implements Tracker {
  readonly backend = "postgres";

  private constructor(
    private readonly sql: Sql,
    private readonly schema: string,
    private readonly logger?: Logger,
  ) {}

  static async connect(
    databaseUrl: string,
    schema: string,
    logger?: Logger,
  ): Promise<PostgresTracker> {
    const { default: postgres } = await import("postgres");
    const sql = postgres(databaseUrl, {
      max: 10, // shared across all concurrent bots in the worker — avoid write contention
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false, // transaction-pooler friendly
      onnotice: () => {}, // silence idempotent "already exists" notices
    });
    try {
      await sql.unsafe(migrationSql(schema));
    } catch (err) {
      await sql.end({ timeout: 5 }).catch(() => {}); // don't leak the pool on failure
      throw err;
    }
    logger?.info({ schema }, "track: connected to postgres + migrated");
    return new PostgresTracker(sql, schema, logger);
  }

  /** Schema-qualified table reference, e.g. "proof_bot"."bot_orders". */
  private table(name: string) {
    return this.sql`${this.sql(this.schema)}.${this.sql(name)}`;
  }

  async recordOrder(o: OrderRecord): Promise<void> {
    try {
      await this.sql`insert into ${this.table("bot_orders")} ${this.sql({
        bot: o.bot,
        client_order_id: o.clientOrderId,
        strategy: o.strategy,
        kind: o.kind,
        market: o.market,
        side: o.side,
        price: o.price,
        quantity: o.quantity,
        tx_hash: o.txHash ?? null,
        check_tx_code: o.checkTxCode ?? null,
        note: o.note ?? null,
        ts: new Date(o.ts).toISOString(),
      })}`;
    } catch (err) {
      this.logger?.warn({ err: (err as Error).message }, "track: recordOrder failed");
    }
  }

  async recordSnapshot(s: PositionSnapshot): Promise<void> {
    try {
      await this.sql`insert into ${this.table("bot_snapshots")} ${this.sql({
        bot: s.bot,
        balance: s.balance,
        equity: s.equity,
        margin_ratio_bps: s.marginRatioBps,
        positions: this.sql.json(s.positions as never), // jsonb (not a stringified scalar)
        ts: new Date(s.ts).toISOString(),
      })}`;
    } catch (err) {
      this.logger?.warn({ err: (err as Error).message }, "track: recordSnapshot failed");
    }
  }

  async recordDecision(d: DecisionRecord): Promise<void> {
    try {
      await this.sql`insert into ${this.table("bot_decisions")} ${this.sql({
        bot: d.bot,
        strategy: d.strategy,
        action: d.action,
        market: d.market ?? null,
        detail: this.sql.json(d.detail as never), // jsonb, not a stringified scalar
        ts: new Date(d.ts).toISOString(),
      })}`;
    } catch (err) {
      this.logger?.warn({ err: (err as Error).message }, "track: recordDecision failed");
    }
  }

  async close(): Promise<void> {
    try {
      await this.sql.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
  }
}
