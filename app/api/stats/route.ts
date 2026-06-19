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
  type MetricsRow,
} from "../../../src/stats-core.js";

// Postgres (TCP) + the pure core need Node, and fleet data must never be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only multi-bot trading stats for the dashboard, sourced from the tracking
 * ledger + bot registry (Supabase). Ported 1:1 from the previous Vercel function.
 * NEVER selects the private_key_enc column.
 */
export async function GET(req: Request): Promise<Response> {
  const url = process.env.DATABASE_URL;
  const schema = process.env.DB_SCHEMA || "proof_bot";
  if (!url) return Response.json({ ok: false, error: "tracking not configured" }, { status: 503 });
  const params = new URL(req.url).searchParams;

  try {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    const t = (name: string) => sql`${sql(schema)}.${sql(name)}`;

    // Global strategy-change log (?changes=1) — fleet-wide audit timeline.
    if (params.get("changes") === "1") {
      let changes: unknown = [];
      try {
        changes = await sql`select bot, kind, before, after, note, ts from ${t("bot_changes")} order by ts desc limit 200`;
      } catch {
        changes = [];
      }
      await sql.end({ timeout: 3 });
      return Response.json({ ok: true, changes });
    }

    // Per-bot deep history (?bot=<id>) — drill-down drawer.
    const botParam = params.get("bot") ?? undefined;
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
      let changes: unknown = [];
      try {
        changes = await sql`select kind, before, after, note, ts from ${t("bot_changes")}
          where bot = ${botParam} order by ts desc limit 100`;
      } catch {
        changes = [];
      }
      await sql.end({ timeout: 3 });
      return Response.json({ ok: true, bot: botParam, recentOrders: orders, decisions: decs, changes });
    }

    let registry: Array<Record<string, unknown>> = [];
    try {
      registry = await sql`select id, strategies, markets, tags, enabled from ${t("bots")} order by id`;
    } catch {
      registry = [];
    }

    const latest = await sql`select distinct on (bot) bot, equity, balance, positions, ts
      from ${t("bot_snapshots")} order by bot, ts desc`;

    const vol = await sql`select bot,
        count(*)::int as trades,
        coalesce(sum((price::numeric) * (quantity::numeric) / 100), 0)::text as volume_micro,
        max(ts) as last_trade
      from ${t("bot_orders")}
      where (note is null or note <> 'dry-run') and strategy <> 'audit-prep'
      group by bot`;

    const { key: rangeKey, interval, bucket } = rangeConfig(params.get("range"));
    const sinceClause = interval ? sql`and ts > now() - ${interval}::interval` : sql``;
    const series = await sql`select bot, date_trunc(${bucket}, ts) as m,
        (array_agg(equity order by ts desc))[1] as equity
      from ${t("bot_snapshots")}
      where equity::numeric > 0 ${sinceClause}
      group by bot, m order by m asc`;

    // Fleet trading volume per bucket (micro-USDC) — for the top-strip volume sparkline.
    const fleetVol = await sql`select date_trunc(${bucket}, ts) as m,
        coalesce(sum((price::numeric) * (quantity::numeric) / 100), 0) as vol
      from ${t("bot_orders")}
      where (note is null or note <> 'dry-run') and strategy <> 'audit-prep' ${sinceClause}
      group by m order by m asc`;

    const metricsRows = await sql`select bot,
        coalesce(avg((price::numeric) * (quantity::numeric) / 100), 0) as avg_trade_micro,
        count(*) filter (where ts > now() - interval '1 hour') as last_hour_trades,
        extract(epoch from (max(ts) - min(ts))) / 3600 as span_hours,
        count(*)::int as trades_window,
        avg((kind = 'order' and strategy = 'market-maker')::int) as maker_pct,
        avg((check_tx_code is not null and check_tx_code <> 0)::int) as reject_rate,
        coalesce(sum(case when side = 'Buy' then 1 else -1 end * (price::numeric) * (quantity::numeric) / 100), 0) as net_flow_micro
      from ${t("bot_orders")}
      where (note is null or note <> 'dry-run') and strategy <> 'audit-prep' ${sinceClause}
      group by bot`;

    const sinceRow = await sql`select min(ts) as since from ${t("bot_snapshots")}`;
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
      metricsRows as unknown as MetricsRow[],
    );

    // Fleet aggregate series for the top strip: per bucket, sum each bot's latest equity
    // (→ fleet equity + a fleet-PnL trend = equity − window-start equity) and the bucket's
    // trading volume. All in micro-USDC; the client divides by 1e6 for labels.
    const eqByM = new Map<number, number>();
    for (const r of series as unknown as { m: string; equity: string }[]) {
      const k = new Date(r.m).getTime();
      eqByM.set(k, (eqByM.get(k) ?? 0) + Number(r.equity));
    }
    const volByM = new Map<number, number>();
    for (const r of fleetVol as unknown as { m: string; vol: string }[]) {
      volByM.set(new Date(r.m).getTime(), Number(r.vol));
    }
    const fleetSeries = [...new Set([...eqByM.keys(), ...volByM.keys()])]
      .sort((a, b) => a - b)
      .map((k) => ({ ts: new Date(k).toISOString(), equity: eqByM.get(k) ?? null, volume: volByM.get(k) ?? 0 }));

    return Response.json({
      ok: true,
      asOf: pickAsOf(latest as unknown as SnapshotRow[]),
      range: rangeKey,
      dataSince: sinceRow[0]?.since ?? null,
      aggregate: computeAggregate(bots),
      fleetSeries,
      bots,
      decisions,
      recentOrders: recent,
      strategyLogic: STRATEGY_LOGIC,
      makerInferred: true,
    });
  } catch (err) {
    console.error("stats error:", (err as Error).message);
    return Response.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
