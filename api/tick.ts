import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { executeTick } from "../src/runner.js";
import { NoopStrategy } from "../src/strategy/noop.js";

/**
 * Vercel Cron entrypoint — runs ONE strategy tick per invocation (see
 * vercel.json `crons`). Vercel attaches `Authorization: Bearer <CRON_SECRET>`
 * to scheduled requests; we reject anything else when CRON_SECRET is set.
 *
 * Requires PROOF_PRIVATE_KEY in the project env (there's no writable keystore
 * on Vercel). Defaults to devnet paper money unless PROOF_ALLOW_REAL=1.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  try {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const result = await executeTick(config, logger, new NoopStrategy());
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
}
