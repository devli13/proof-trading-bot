export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lightweight status — network + reachability for the status pill's latency probe.
 *
 * The chain-height + main-account probe (via the Proof SDK) was intentionally dropped
 * from the web build: the SDK's @noble crypto deps use ".js" deep imports that don't
 * bundle on Vercel's pnpm layout, and only this endpoint needed them. The dashboard's
 * real liveness signal is data freshness (`asOf` from /api/stats) + the realtime stream,
 * which the status pill already weighs most heavily.
 */
export async function GET(req: Request): Promise<Response> {
  const network = process.env.PROOF_NETWORK || "devnet";
  const raw = process.env.DATABASE_URL;
  const db: Record<string, unknown> = { set: !!raw };
  if (raw) {
    try {
      const u = new URL(raw);
      db.host = u.hostname;
      db.port = u.port;
    } catch {
      db.parseError = true;
    }
    const deep = new URL(req.url).searchParams.get("deep") === "1";
    try {
      const { default: postgres } = await import("postgres");
      const sql = postgres(raw, { max: deep ? 5 : 1, prepare: false, connect_timeout: 8, idle_timeout: 3, onnotice: () => {}, connection: { statement_timeout: 12000 } });
      const t0 = Date.now();
      await sql`select 1 as ok`;
      db.ping = `ok ${Date.now() - t0}ms`;
      if (deep) {
        // Replicate the stats route's heavy queries CONCURRENTLY (the real workload) so we can
        // see which one — or the concurrency itself — stalls from Vercel. TEMPORARY diagnostic.
        const sc = sql`and ts > now() - ${"24 hours"}::interval`;
        const t = (n: string) => sql`proof_bot.${sql(n)}`;
        const time = async (label: string, q: Promise<unknown[]>): Promise<void> => {
          const s = Date.now();
          try { const r = await q; db[label] = `${Date.now() - s}ms (${(r as unknown[]).length} rows)`; }
          catch (e) { db[label] = `ERR ${(e as Error).message.slice(0, 80)}`; }
        };
        await Promise.all([
          time("q_cells", sql`select bot, market, count(*)::int trades, coalesce(sum((price::numeric)*(quantity::numeric)/100),0) v from ${t("bot_orders")} where (note is null or note<>'dry-run') and strategy<>'audit-prep' ${sc} group by bot, market`),
          time("q_series", sql`select bot, date_bin('5 minutes'::interval, ts, timestamptz '2000-01-01 00:00:00+00') m, (array_agg(equity order by ts desc))[1] e from ${t("bot_snapshots")} where equity::numeric>0 ${sc} group by bot, m`),
          time("q_metrics", sql`select bot, coalesce(avg((price::numeric)*(quantity::numeric)/100),0) a, count(*)::int n from ${t("bot_orders")} where (note is null or note<>'dry-run') and strategy<>'audit-prep' ${sc} group by bot`),
          time("q_latest", sql`select distinct on (bot) bot, equity, ts from ${t("bot_snapshots")} order by bot, ts desc`),
        ]);
      }
      await sql.end({ timeout: 3 });
    } catch (e) {
      db.error = (e as Error).message.slice(0, 140);
    }
  }
  return Response.json({ ok: true, network, db });
}
