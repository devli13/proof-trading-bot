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
  return Response.json({ ok: true, network });
}
