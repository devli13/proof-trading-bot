import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createClient, queryAccountSafe } from "../src/client.js";
import { loadWallet } from "../src/wallet.js";
import { formatMicroUsdc } from "../src/units.js";

/**
 * Read-only status endpoint — chain height plus (if PROOF_PRIVATE_KEY is set)
 * the bot's balance/equity. Handy as a "is it alive while I sleep" check.
 */
export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  try {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const client = createClient(config);

    const health = await client.queryHealth();

    let account: Record<string, unknown> | null = null;
    try {
      const wallet = await loadWallet(config, logger);
      client.setPrivateKey(wallet.privateKey);
      const a = await queryAccountSafe(client);
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
    res.status(200).json({
      ok: true,
      network: config.network,
      chainId: config.chainId,
      height: health.height,
      account,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
}
