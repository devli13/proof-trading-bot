export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Trade-size analysis: bucket every real order by notional ($ = price·qty/100) and, for
 * each bucket, report count, the $ range, win rate, avg favorable move, and market impact.
 *
 * "Outcome" is the market's NEXT price move in that market relative to the trade's side
 * (Buy wants price up, Sell down) — expressed in BPS so cheap binary legs (~$0.46) and the
 * HYPE perp (~$69) are comparable. It's a directional/impact proxy, not realized PnL (the
 * ledger has no per-trade PnL), but it answers "do bigger trades win more, and move the
 * book more?". `impact_bps` = |next-price − price| / price.
 */
export async function GET(req: Request): Promise<Response> {
  const url = process.env.DATABASE_URL;
  const schema = process.env.DB_SCHEMA || "proof_bot";
  if (!url) return Response.json({ ok: false, error: "tracking not configured" }, { status: 503 });
  const hours = Math.min(168, Math.max(1, Number(new URL(req.url).searchParams.get("hours")) || 24));

  try {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    const t = (name: string) => sql`${sql(schema)}.${sql(name)}`;

    const rows = await sql`
      with o as (
        select market, side, ts,
          (price::numeric) as price,
          (price::numeric * quantity::numeric / 100) as notional_micro,
          lead(price::numeric) over (partition by market order by ts, id) as next_price
        from ${t("bot_orders")}
        where (note is null or note <> 'dry-run') and strategy <> 'audit-prep'
          and ts > now() - ${hours + " hours"}::interval
          and price::numeric > 0 and quantity::numeric > 0
      ),
      b as (
        select notional_micro,
          width_bucket(notional_micro / 1e6, array[1, 10, 50, 200]::numeric[]) as bk,
          case when next_price is null or price = 0 then null
               when side = 'Buy' then (next_price - price) / price * 10000
               else (price - next_price) / price * 10000 end as fav_bps,
          case when next_price is null or price = 0 then null
               else abs(next_price - price) / price * 10000 end as impact_bps
        from o
      )
      select bk::int as bk,
        count(*)::int as trades,
        avg(notional_micro) as avg_notional,
        min(notional_micro) as min_notional,
        max(notional_micro) as max_notional,
        avg((fav_bps > 0)::int) filter (where fav_bps is not null) as win_rate,
        avg(fav_bps) filter (where fav_bps is not null) as avg_fav_bps,
        avg(impact_bps) filter (where impact_bps is not null) as avg_impact_bps
      from b
      group by bk order by bk`;

    await sql.end({ timeout: 3 });

    const LABEL = ["< $1", "$1–10", "$10–50", "$50–200", "$200+"];
    const buckets = rows.map((r) => ({
      bk: Number(r.bk),
      label: LABEL[Number(r.bk)] ?? "?",
      trades: Number(r.trades),
      avgNotional: r.avg_notional == null ? null : Number(r.avg_notional),
      minNotional: r.min_notional == null ? null : Number(r.min_notional),
      maxNotional: r.max_notional == null ? null : Number(r.max_notional),
      winRate: r.win_rate == null ? null : Number(r.win_rate),
      avgFavBps: r.avg_fav_bps == null ? null : Number(r.avg_fav_bps),
      avgImpactBps: r.avg_impact_bps == null ? null : Number(r.avg_impact_bps),
    }));

    return Response.json({ ok: true, hours, buckets });
  } catch (err) {
    console.error("trade-analysis error:", (err as Error).message);
    return Response.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
