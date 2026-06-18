import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Read-only trading stats for the dashboard, sourced from the tracking ledger
 * (Supabase). No secrets — aggregated orders/snapshots/decisions only.
 */
export default async function handler(
  _req: VercelRequest,
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

    const [counts] = await sql`select
      (select count(distinct tx_hash) from ${t("bot_orders")} where kind = 'basket')::int as baskets,
      (select count(*) from ${t("bot_orders")} where kind = 'basket')::int as basket_legs,
      (select count(*) from ${t("bot_orders")} where strategy <> 'audit-prep' and (note is null or note <> 'dry-run'))::int as total_orders,
      (select min(ts) from ${t("bot_orders")} where kind = 'basket') as first_order,
      (select max(ts) from ${t("bot_orders")} where kind = 'basket') as last_order`;

    const [pnl] = await sql`select
      (select equity from ${t("bot_snapshots")} where equity::numeric > 1000000000 order by ts asc limit 1) as start_equity,
      (select equity from ${t("bot_snapshots")} order by ts desc limit 1) as cur_equity,
      (select balance from ${t("bot_snapshots")} order by ts desc limit 1) as cur_balance,
      (select positions from ${t("bot_snapshots")} order by ts desc limit 1) as positions,
      (select ts from ${t("bot_snapshots")} order by ts desc limit 1) as as_of`;

    const series = await sql`select ts, equity from ${t("bot_snapshots")} where equity::numeric > 0 order by ts desc limit 200`;
    const recent = await sql`select ts, strategy, kind, market, side, price, quantity, check_tx_code, tx_hash
      from ${t("bot_orders")} where strategy <> 'audit-prep' and (note is null or note <> 'dry-run') order by ts desc limit 30`;
    const decisions = await sql`select strategy, action, count(*)::int as c, max(ts) as last
      from ${t("bot_decisions")} group by strategy, action order by c desc`;

    await sql.end({ timeout: 3 });

    const start = pnl?.start_equity != null ? Number(pnl.start_equity) : null;
    const cur = pnl?.cur_equity != null ? Number(pnl.cur_equity) : null;
    // older rows double-encoded positions as a jsonb string — parse if needed
    let positions = pnl?.positions ?? [];
    if (typeof positions === "string") {
      try {
        positions = JSON.parse(positions);
      } catch {
        positions = [];
      }
    }

    res.status(200).json({
      ok: true,
      asOf: pnl?.as_of ?? null,
      counts,
      pnl: {
        startEquity: start,
        currentEquity: cur,
        currentBalance: pnl?.cur_balance != null ? Number(pnl.cur_balance) : null,
        netPnl: start != null && cur != null ? cur - start : null,
      },
      positions,
      equitySeries: series.reverse().map((r) => ({ ts: r.ts, equity: Number(r.equity) })),
      recentOrders: recent,
      decisions,
    });
  } catch (err) {
    console.error("stats error:", (err as Error).message);
    res.status(500).json({ ok: false, error: "internal error" });
  }
}
