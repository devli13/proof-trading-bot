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
create index if not exists bot_orders_strategy_ts_idx on ${schema}.bot_orders (strategy, ts);
create table if not exists ${schema}.bot_snapshots (
  id bigserial primary key,
  balance text not null,
  equity text not null,
  margin_ratio_bps text not null,
  positions jsonb not null default '[]',
  ts timestamptz not null default now()
);
create table if not exists ${schema}.bot_decisions (
  id bigserial primary key,
  strategy text not null,
  action text not null,
  detail jsonb not null default '{}',
  ts timestamptz not null default now()
);
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
      max: 2,
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
        strategy: d.strategy,
        action: d.action,
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
