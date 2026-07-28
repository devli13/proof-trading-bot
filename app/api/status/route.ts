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
export async function GET(): Promise<Response> {
  const network = process.env.PROOF_NETWORK || "devnet";
  // Non-secret DB endpoint report (host + port only — never user/password) to diagnose the
  // pooler config. Also live-tests a transaction-pooler connection so we can see if it works
  // from Vercel's runtime. TEMPORARY diagnostic.
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
    try {
      const { txPoolerUrl } = await import("../../../lib/db-url.js");
      const swapped = new URL(txPoolerUrl(raw));
      db.swappedPort = swapped.port;
      const { default: postgres } = await import("postgres");
      const sql = postgres(txPoolerUrl(raw), { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 2, onnotice: () => {}, connection: { statement_timeout: 8000 } });
      const t0 = Date.now();
      await sql`select 1 as ok`;
      db.txPoolerPing = `ok ${Date.now() - t0}ms`;
      await sql.end({ timeout: 3 });
    } catch (e) {
      db.txPoolerError = (e as Error).message.slice(0, 120);
    }
  }
  return Response.json({ ok: true, network, db });
}
