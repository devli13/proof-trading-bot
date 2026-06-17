import { ExchangeClient, Side } from "@proof/trading-sdk";
import type { AccountInfo, TxResult } from "@proof/trading-sdk";
import type { Config } from "./config.js";
import type { Wallet } from "./wallet.js";

/** Build an ExchangeClient pinned to the configured network. */
export function createClient(config: Config): ExchangeClient {
  return new ExchangeClient({
    rpcUrl: config.gatewayUrl,
    apiUrl: config.gatewayUrl,
    gatewayUrl: config.gatewayUrl,
    chainId: config.chainId,
    apiKey: config.apiKey,
  });
}

export interface LimitOrderParams {
  market: number;
  side: Side;
  /** Limit price in cents (bigint). */
  price: bigint;
  /** Quantity in contracts (bigint). */
  quantity: bigint;
  /** Reject if it would cross the book on placement (guarantees maker). */
  postOnly?: boolean;
  /** Only reduce an existing position. */
  reduceOnly?: boolean;
}

/** Submit a limit order and wait for block inclusion (submitTxCommit). */
export function placeLimitOrder(
  client: ExchangeClient,
  wallet: Wallet,
  p: LimitOrderParams,
): Promise<TxResult> {
  return client.submitTxCommit({
    type: "PlaceOrder",
    data: {
      market: p.market,
      owner: wallet.address,
      side: p.side,
      price: p.price,
      quantity: p.quantity,
      postOnly: p.postOnly,
      reduceOnly: p.reduceOnly,
    },
  });
}

/**
 * Query the signer's account, returning `null` when the address has no on-chain
 * record yet (a fresh/never-funded key makes the gateway return "not found",
 * which the SDK surfaces as a thrown error rather than null).
 */
export async function queryAccountSafe(
  client: ExchangeClient,
): Promise<AccountInfo | null> {
  try {
    return await client.queryAccount();
  } catch (err) {
    if (/not found|404/i.test((err as Error).message ?? "")) return null;
    throw err;
  }
}

/** Cancel all resting orders (optionally scoped to one market). */
export function cancelAllOrders(
  client: ExchangeClient,
  wallet: Wallet,
  market?: number,
): Promise<TxResult> {
  return client.submitTxCommit({
    type: "CancelAllOrders",
    data: { owner: wallet.address, market: market ?? null },
  });
}
