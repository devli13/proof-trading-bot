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
      const concurrent = new URL(req.url).searchParams.get("concurrent") === "1";
      const sql = postgres(raw, { max: deep ? 5 : 1, prepare: false, connect_timeout: 8, idle_timeout: 3, onnotice: () => {}, connection: { statement_timeout: 12000 } });
      const t0 = Date.now();
      await sql`select 1 as ok`;
      db.ping = `ok ${Date.now() - t0}ms`;
      void concurrent;
      if (deep) {
        // The heavy query — run 3 ways to find what works over the pooler from Vercel:
        // (A) transaction pooler + parameterized (current, hangs), (B) transaction pooler +
        // sql.unsafe() SIMPLE protocol, (C) session pooler (5432) + parameterized.
        const HEAVY = "select bot, market, count(*)::int trades, coalesce(sum((price::numeric)*(quantity::numeric)/100),0) v from proof_bot.bot_orders where (note is null or note<>'dry-run') and strategy<>'audit-prep' and ts > now() - interval '24 hours' group by bot, market";
        const withTimeout = async <T>(label: string, p: Promise<T>): Promise<void> => {
          const s = Date.now();
          try {
            const r = (await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("hung>10s")), 10000))])) as { length?: number };
            db[label] = `ok ${Date.now() - s}ms (${r?.length ?? "?"} rows)`;
          } catch (e) { db[label] = `${(e as Error).message.slice(0, 60)} @${Date.now() - s}ms`; }
        };
        // (A) parameterized on the raw (transaction) pooler
        await withTimeout("A_tx_param", sql`select bot, market, count(*)::int trades from proof_bot.bot_orders where ts > now() - ${"24 hours"}::interval group by bot, market`);
        // (B) simple protocol via unsafe on the transaction pooler
        await withTimeout("B_tx_unsafe", sql.unsafe(HEAVY));
        // (C) session pooler (5432) with a fresh client, parameterized
        try {
          const sessUrl = raw.replace(":6543/", ":5432/");
          const { default: pg2 } = await import("postgres");
          const sess = pg2(sessUrl, { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 2, onnotice: () => {} });
          await withTimeout("C_session_param", sess`select bot, market, count(*)::int trades from proof_bot.bot_orders where ts > now() - ${"24 hours"}::interval group by bot, market`);
          await sess.end({ timeout: 3 });
        } catch (e) { db.C_session_param = `setup ERR ${(e as Error).message.slice(0, 50)}`; }
      }
      await sql.end({ timeout: 3 });
    } catch (e) {
      db.error = (e as Error).message.slice(0, 140);
    }
  }
  return Response.json({ ok: true, network, db });
}
