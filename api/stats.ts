import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  STRATEGY_LOGIC,
  rangeConfig,
  computeBots,
  computeAggregate,
  pickAsOf,
  type RegistryRow,
  type SnapshotRow,
  type VolRow,
  type SeriesRow,
} from "../src/stats-core.js";

/**
 * Read-only multi-bot trading stats for the dashboard, sourced from the tracking
 * ledger + the bot registry (Supabase). Returns an aggregate plus a per-bot
 * breakdown (profit, volume, trades, equity, last-trade, tags, markets) and per-bot
 * equity series. NEVER selects the private_key_enc column. The pure shaping logic
 * lives in src/stats-core.ts (unit-tested).
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  const schema = process.env.DB_SCHEMA || "proof_bot";
  if (!url) {
    res.status(503).json({ ok: false, error: "tracking not configured" });
    return;
  }
  try {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, {
      max: 1,
      prepare: false,
      idle_timeout: 5,
      connect_timeout: 10,
      onnotice: () => {},
    });
    const t = (name: string) => sql`${sql(schema)}.${sql(name)}`;

    // Per-bot deep history (?bot=<id>) — the drill-down drawer asks for ONE bot's
    // full 24h orders + decision breakdown, beyond the global 60/200 firehose caps.
    // Additive + read-only; never selects the key column.
    const botParam = typeof req.query.bot === "string" ? req.query.bot : undefined;
    if (botParam) {
      const [orders, decs] = await Promise.all([
        sql`select bot, ts, strategy, kind, market, side, price, quantity, check_tx_code
            from ${t("bot_orders")}
            where bot = ${botParam} and (note is null or note <> 'dry-run') and strategy <> 'audit-prep'
            order by ts desc limit 300`,
        sql`select strategy, action, count(*)::int as c, max(ts) as last
            from ${t("bot_decisions")}
            where bot = ${botParam} and ts > now() - interval '24 hours'
            group by strategy, action order by c desc`,
      ]);
      await sql.end({ timeout: 3 });
      res.status(200).json({ ok: true, bot: botParam, recentOrders: orders, decisions: decs });
      return;
    }

    // Registry (NO keys). Tolerate the table not existing yet.
    let registry: Array<Record<string, unknown>> = [];
    try {
      registry = await sql`select id, strategies, markets, tags, enabled from ${t("bots")} order by id`;
    } catch {
      registry = [];
    }

    // Latest snapshot per bot (equity / balance / positions).
    const latest = await sql`select distinct on (bot) bot, equity, balance, positions, ts
      from ${t("bot_snapshots")} order by bot, ts desc`;

    // Volume (Σ price·qty/100, micro-USDC notional) + trade count + LAST-TRADE time per bot.
    const vol = await sql`select bot,
        count(*)::int as trades,
        coalesce(sum((price::numeric) * (quantity::numeric) / 100), 0)::text as volume_micro,
        max(ts) as last_trade
      from ${t("bot_orders")}
      where (note is null or note <> 'dry-run') and strategy <> 'audit-prep'
      group by bot`;

    // Equity series per bot, windowed + bucketed by the selected chart range
    // (?range=1h|1d|7d|30d|all, default 1d). Drives the chart + per-bot PnL baseline.
    const { key: rangeKey, interval, bucket } = rangeConfig(req.query.range);
    const sinceClause = interval ? sql`and ts > now() - ${interval}::interval` : sql``;
    const series = await sql`select bot, date_trunc(${bucket}, ts) as m,
        (array_agg(equity order by ts desc))[1] as equity
      from ${t("bot_snapshots")}
      where equity::numeric > 0 ${sinceClause}
      group by bot, m order by m asc`;

    // Earliest snapshot overall — lets the client hide timeframe options that would
    // just duplicate "all" (e.g. hide 7d/30d when there's <7d/<30d of history).
    const sinceRow = await sql`select min(ts) as since from ${t("bot_snapshots")}`;

    // Strategy-tagged decision activity + recent orders.
    const decisions = await sql`select bot, strategy, action, count(*)::int as c, max(ts) as last
      from ${t("bot_decisions")} where ts > now() - interval '24 hours'
      group by bot, strategy, action order by c desc limit 200`;
    const recent = await sql`select bot, ts, strategy, kind, market, side, price, quantity, check_tx_code
      from ${t("bot_orders")} where (note is null or note <> 'dry-run') and strategy <> 'audit-prep'
      order by ts desc limit 60`;

    await sql.end({ timeout: 3 });

    const bots = computeBots(
      registry as unknown as RegistryRow[],
      latest as unknown as SnapshotRow[],
      vol as unknown as VolRow[],
      series as unknown as SeriesRow[],
    );

    res.status(200).json({
      ok: true,
      asOf: pickAsOf(latest as unknown as SnapshotRow[]),
      range: rangeKey,
      dataSince: sinceRow[0]?.since ?? null,
      aggregate: computeAggregate(bots),
      bots,
      decisions,
      recentOrders: recent,
      strategyLogic: STRATEGY_LOGIC,
    });
  } catch (err) {
    console.error("stats error:", (err as Error).message);
    res.status(500).json({ ok: false, error: "internal error" });
  }
}
