import { loadConfig } from "../../../src/config.js";
import { createLogger } from "../../../src/logger.js";
import { createClient, queryAccountViaInfo } from "../../../src/client.js";
import { loadWallet } from "../../../src/wallet.js";
import { formatMicroUsdc } from "../../../src/units.js";

// Uses the Proof SDK (msgpack/Buffer/fetch) → Node runtime; never cache health.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only status — chain height plus (if PROOF_PRIVATE_KEY is set) the main
 * account's balance/equity. Drives the status pill's latency + liveness check.
 */
export async function GET(): Promise<Response> {
  try {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const client = createClient(config);

    const health = await client.queryHealth();

    let account: Record<string, unknown> | null = null;
    try {
      const wallet = await loadWallet(config, logger);
      client.setPrivateKey(wallet.privateKey);
      const a = await queryAccountViaInfo(config.gatewayUrl, wallet.address0x);
      if (a) {
        account = {
          address: wallet.address0x,
          balance: `$${formatMicroUsdc(a.balance)}`,
          equity: `$${formatMicroUsdc(a.equity)}`,
          positions: a.positions.length,
        };
      }
    } catch {
      // No key configured — return health only.
    }

    client.disconnect();
    return Response.json({ ok: true, network: config.network, chainId: config.chainId, height: health.height, account });
  } catch (err) {
    console.error("status error:", (err as Error).message);
    return Response.json({ ok: false, error: "internal error" }, { status: 500 });
  }
}
