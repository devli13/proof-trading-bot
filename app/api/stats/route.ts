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
    // A small pool (not max:1) so the independent dashboard queries below can run
    // CONCURRENTLY via Promise.all instead of serializing on one connection — that
    // sequential add-up was the bulk of the ~2.6s baseline latency.
    // Small pool (max:3) so each invocation uses few session-pooler slots — the worker's
    // writers + multiple API invocations were exhausting the ~40-client SESSION pooler
    // (port 5432), starving the API into a connection hang. The queries are fast now
    // (~2s) so a tiny pool still finishes quickly. connect_timeout fails fast instead of
    // hanging; statement_timeout aborts a slow scan. REAL FIX: point DATABASE_URL at the
    // TRANSACTION pooler (port 6543) — the code is prepare:false (pooler-ready).
    const sql = postgres(url, {
      max: 3, prepare: false, idle_timeout: 5, connect_timeout: 8, onnotice: () => {},
      connection: { statement_timeout: 20000 },
    });
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

    const { key: rangeKey, interval, bin } = rangeConfig(params.get("range"));
    const sinceClause = interval ? sql`and ts > now() - ${interval}::interval` : sql``;

    // Every query below is independent → run them CONCURRENTLY (the pool makes this real
    // parallelism, so total latency ≈ the slowest query, not the sum of all nine).
    const [registry, latest, cellAgg, series, fleetVol, metricsRows, sinceRow, decisions, recent] = await Promise.all([
      sql`select id, strategies, markets, tags, enabled from ${t("bots")} order by id`.catch(
        () => [] as Array<Record<string, unknown>>,
      ),
      sql`select distinct on (bot) bot, equity, balance, positions, ts
        from ${t("bot_snapshots")} order by bot, ts desc`,
      // ONE windowed bot×market scan that feeds per-bot volume, the per-market breakdown,
      // AND the bot×market cells — instead of three separate heavy scans (each casting
      // text→numeric over the whole window). Derived in JS below. Windowed (was an unbounded
      // O(table) lifetime scan that blew past the function timeout as MM churn grew the table).
      sql`select bot, market,
          count(*)::int as trades,
          coalesce(sum((price::numeric) * (quantity::numeric) / 100), 0) as vol_micro,
          count(*) filter (where kind = 'order' and strategy = 'market-maker')::int as maker_n,
          max(ts) as last_trade
        from ${t("bot_orders")}
        where (note is null or note <> 'dry-run') and strategy <> 'audit-prep' ${sinceClause}
        group by bot, market`,
      // Bucketed equity per bot via date_bin (coarse stride → a few hundred points, not thousands).
      sql`select bot, date_bin(${bin}::interval, ts, timestamptz '2000-01-01 00:00:00+00') as m,
          (array_agg(equity order by ts desc))[1] as equity
        from ${t("bot_snapshots")}
        where equity::numeric > 0 ${sinceClause}
        group by bot, m order by m asc`,
      // Fleet trading volume per bucket (micro-USDC) — for the top-strip volume sparkline.
      sql`select date_bin(${bin}::interval, ts, timestamptz '2000-01-01 00:00:00+00') as m,
          coalesce(sum((price::numeric) * (quantity::numeric) / 100), 0) as vol
        from ${t("bot_orders")}
        where (note is null or note <> 'dry-run') and strategy <> 'audit-prep' ${sinceClause}
        group by m order by m asc`,
      sql`select bot,
          coalesce(avg((price::numeric) * (quantity::numeric) / 100), 0) as avg_trade_micro,
          count(*) filter (where ts > now() - interval '1 hour') as last_hour_trades,
          extract(epoch from (max(ts) - min(ts))) / 3600 as span_hours,
          count(*)::int as trades_window,
          avg((kind = 'order' and strategy = 'market-maker')::int) as maker_pct,
          avg((check_tx_code is not null and check_tx_code <> 0)::int) as reject_rate,
          coalesce(sum(case when side = 'Buy' then 1 else -1 end * (price::numeric) * (quantity::numeric) / 100), 0) as net_flow_micro
        from ${t("bot_orders")}
        where (note is null or note <> 'dry-run') and strategy <> 'audit-prep' ${sinceClause}
        group by bot`,
      sql`select min(ts) as since from ${t("bot_snapshots")}`,
      sql`select bot, strategy, action, count(*)::int as c, max(ts) as last
        from ${t("bot_decisions")} where ts > now() - interval '24 hours'
        group by bot, strategy, action order by c desc limit 200`,
      sql`select bot, ts, strategy, kind, market, side, price, quantity, check_tx_code
        from ${t("bot_orders")} where (note is null or note <> 'dry-run') and strategy <> 'audit-prep'
        order by ts desc limit 60`,
    ]);

    await sql.end({ timeout: 3 });

    // Derive per-bot volume, per-market breakdown, and the bot×market cells from the single
    // bot×market scan (one heavy scan instead of three).
    const cellRows = cellAgg as unknown as Array<{ bot: string; market: number; trades: number; vol_micro: string; maker_n: number; last_trade: string }>;
    const cells = cellRows.map((r) => ({ bot: r.bot, market: Number(r.market), trades: Number(r.trades), volume: Number(r.vol_micro) }));

    const byBot = new Map<string, { trades: number; vol: number; last: string | null }>();
    for (const r of cellRows) {
      const b = byBot.get(r.bot) ?? { trades: 0, vol: 0, last: null };
      b.trades += Number(r.trades);
      b.vol += Number(r.vol_micro);
      if (r.last_trade && (!b.last || r.last_trade > b.last)) b.last = r.last_trade;
      byBot.set(r.bot, b);
    }
    const vol = [...byBot.entries()].map(([bot, b]) => ({ bot, trades: b.trades, volume_micro: String(Math.round(b.vol)), last_trade: b.last }));

    const byMkt = new Map<number, { trades: number; vol: number; bots: Set<string>; makerN: number }>();
    for (const r of cellRows) {
      const m = Number(r.market);
      const e = byMkt.get(m) ?? { trades: 0, vol: 0, bots: new Set<string>(), makerN: 0 };
      e.trades += Number(r.trades);
      e.vol += Number(r.vol_micro);
      e.makerN += Number(r.maker_n);
      e.bots.add(r.bot);
      byMkt.set(m, e);
    }
    const markets = [...byMkt.entries()]
      .map(([market, e]) => ({ market, trades: e.trades, volume: e.vol, bots: e.bots.size, makerPct: e.trades > 0 ? e.makerN / e.trades : null }))
      .sort((a, b) => b.volume - a.volume);

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
      marketStats: { markets, cells },
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
