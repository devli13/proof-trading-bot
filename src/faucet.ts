import type { Logger } from "./logger.js";

export interface FaucetResult {
  funded: boolean;
  status: number;
  message?: string;
}

/**
 * Privileged devnet faucet drip. Requires a faucet token (internal/Proof-team).
 * Paper-trading participants do NOT use this directly — they redeem an access
 * code instead (see wallet.redeemAccessCode).
 */
export async function requestFaucetDrip(opts: {
  faucetUrl: string;
  token: string;
  address0x: string;
  logger: Logger;
}): Promise<FaucetResult> {
  const { faucetUrl, token, address0x, logger } = opts;
  const res = await fetch(`${faucetUrl.replace(/\/$/, "")}/drip`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ address: address0x }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };

  if (res.ok) {
    logger.info({ address: address0x }, "faucet: funded (~10,000 USDC)");
    return { funded: true, status: res.status };
  }
  if (res.status === 429) {
    logger.warn("faucet: rate limited — try again later");
  }
  logger.warn(
    { status: res.status, error: data.error },
    "faucet: drip failed",
  );
  return { funded: false, status: res.status, message: data.error };
}
