import type { Sql } from "postgres";
import type { Logger } from "../logger.js";
import type {
  Tracker,
  OrderRecord,
  PositionSnapshot,
  DecisionRecord,
} from "./types.js";

/** Idempotent schema — safe to run on every connect. */
export const MIGRATION = `
create table if not exists bot_orders (
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
create index if not exists bot_orders_strategy_ts_idx on bot_orders (strategy, ts);
create table if not exists bot_snapshots (
  id bigserial primary key,
  balance text not null,
  equity text not null,
  margin_ratio_bps text not null,
  positions jsonb not null default '[]',
  ts timestamptz not null default now()
);
create table if not exists bot_decisions (
  id bigserial primary key,
  strategy text not null,
  action text not null,
  detail jsonb not null default '{}',
  ts timestamptz not null default now()
);
`;

/**
 * Supabase/Postgres-backed tracker. Writes are best-effort (a DB hiccup must
 * never crash a trading tick), so every write swallows + logs errors. For Vercel
 * serverless, point DATABASE_URL at the TRANSACTION pooler (:6543) and keep the
 * pool tiny.
 */
export class PostgresTracker implements Tracker {
  readonly backend = "postgres";

  private constructor(
    private readonly sql: Sql,
    private readonly logger?: Logger,
  ) {}

  static async connect(
    databaseUrl: string,
    logger?: Logger,
  ): Promise<PostgresTracker> {
    const { default: postgres } = await import("postgres");
    const sql = postgres(databaseUrl, {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false, // pooler-friendly (transaction mode)
    });
    await sql.unsafe(MIGRATION);
    logger?.info("track: connected to postgres + migrated");
    return new PostgresTracker(sql, logger);
  }

  async recordOrder(o: OrderRecord): Promise<void> {
    try {
      await this.sql`insert into bot_orders ${this.sql({
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
      await this.sql`insert into bot_snapshots ${this.sql({
        balance: s.balance,
        equity: s.equity,
        margin_ratio_bps: s.marginRatioBps,
        positions: JSON.stringify(s.positions),
        ts: new Date(s.ts).toISOString(),
      })}`;
    } catch (err) {
      this.logger?.warn({ err: (err as Error).message }, "track: recordSnapshot failed");
    }
  }

  async recordDecision(d: DecisionRecord): Promise<void> {
    try {
      await this.sql`insert into bot_decisions ${this.sql({
        strategy: d.strategy,
        action: d.action,
        detail: JSON.stringify(d.detail),
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
