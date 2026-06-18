import { ExchangeClient, Side } from "@proof/trading-sdk";
import type {
  AccountInfo,
  AtomicBasketLeg,
  OpenOrder,
  PositionInfo,
  TxResult,
} from "@proof/trading-sdk";
import { decode } from "@msgpack/msgpack";
import type { Config } from "./config.js";
import type { Wallet } from "./wallet.js";

/** Build an ExchangeClient pinned to the configured network. */
export function createClient(config: Config): ExchangeClient {
  const client = new ExchangeClient({
    rpcUrl: config.gatewayUrl,
    apiUrl: config.gatewayUrl,
    gatewayUrl: config.gatewayUrl,
    chainId: config.chainId,
    apiKey: config.apiKey,
  });
  // submitTxCommit's /tx inclusion-poll times out on the devnet gateway
  // (PROOF_SDK_FEEDBACK.md #1b). We submit via submitTx (CheckTx) instead and
  // disable the background DeliverTx verifier that would otherwise just time out.
  client.setUnsafeFastSubmit(true);
  return client;
}

export interface LimitOrderParams {
  market: number;
  side: Side;
  /** Limit price in micro-USDC (bigint, 1e6 scale). */
  price: bigint;
  /** Quantity in 10^-szDecimals contract units (bigint). */
  quantity: bigint;
  /** Reject if it would cross the book on placement (guarantees maker). */
  postOnly?: boolean;
  /** Only reduce an existing position. */
  reduceOnly?: boolean;
  /** Client-assigned id for tracking/correlation. */
  clientOrderId?: bigint | null;
}

/**
 * Submit a limit order via `submitTx` (CheckTx). We avoid `submitTxCommit`
 * because the gateway's `/tx` inclusion-poll currently times out
 * (PROOF_SDK_FEEDBACK.md #1b). `code === 0` = the engine admitted the order.
 */
export function placeLimitOrder(
  client: ExchangeClient,
  wallet: Wallet,
  p: LimitOrderParams,
): Promise<TxResult> {
  return client.submitTx({
    type: "PlaceOrder",
    data: {
      market: p.market,
      owner: wallet.address,
      side: p.side,
      price: p.price,
      quantity: p.quantity,
      postOnly: p.postOnly,
      reduceOnly: p.reduceOnly,
      clientOrderId: p.clientOrderId,
    },
  });
}

/**
 * Cancel resting orders. ALWAYS pass a `market` from a strategy — an undefined
 * market cancels across ALL markets, which in a multi-strategy account would
 * cancel other strategies' orders (PROOF review #multi-strategy-cancel-collision).
 * The account-wide form (market=undefined) is reserved for the kill-switch/shutdown.
 */
export function cancelAllOrders(
  client: ExchangeClient,
  wallet: Wallet,
  market?: number,
): Promise<TxResult> {
  return client.submitTx({
    type: "CancelAllOrders",
    data: { owner: wallet.address, market: market ?? null },
  });
}

/** Submit an all-or-revert multi-leg basket (each leg is a FOK taker order). */
export function placeBasket(
  client: ExchangeClient,
  wallet: Wallet,
  legs: AtomicBasketLeg[],
  maxSlippageBps?: number,
): Promise<TxResult> {
  return client.submitTx({
    type: "AtomicBasketOrder",
    data: { owner: wallet.address, legs, maxSlippageBps },
  });
}

/** Market-close a position on one market (IOC at oracle±spread). */
export function closePosition(
  client: ExchangeClient,
  wallet: Wallet,
  market: number,
): Promise<TxResult> {
  return client.submitTx({
    type: "ClosePosition",
    data: { market, owner: wallet.address },
  });
}

const big = (v: unknown, d = 0n): bigint =>
  v === undefined || v === null ? d : BigInt(v as number | bigint);
const optBig = (v: unknown): bigint | undefined =>
  v === undefined || v === null ? undefined : BigInt(v as number | bigint);

/**
 * Read an account via the gateway's `POST /info` `clearinghouseState` request —
 * the same path the web app uses. The SDK's own `queryAccount`
 * (`GET /v1/account/<hex>`) returns 404 for web-funded accounts on this gateway
 * (PROOF_SDK_FEEDBACK.md #1), so we replicate the working read here. The response
 * is base64-msgpack with the same array layout `queryAccount` decodes. Returns
 * `null` when the account has no record.
 */
export async function queryAccountViaInfo(
  apiUrl: string,
  address0x: string,
): Promise<AccountInfo | null> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: address0x }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/info clearinghouseState failed (${res.status})`);
  const json = (await res.json()) as { data?: string };
  if (!json.data) return null;
  const raw = decode(Uint8Array.from(Buffer.from(json.data, "base64"))) as unknown[];
  if (!Array.isArray(raw)) return null;

  const positions: PositionInfo[] = ((raw[1] ?? []) as unknown[][]).map((p) => ({
    owner: p[0] as Uint8Array,
    market: Number(p[1]),
    side: p[2] as "Buy" | "Sell",
    entryPrice: big(p[3]),
    size: big(p[4]),
    lastFundingIndex: big(p[5]),
    upnlNow: optBig(p[6]),
    mmNow: optBig(p[7]),
    imNow: optBig(p[8]),
    pnlIfFires: optBig(p[9]),
    pnlIfDies: optBig(p[10]),
    fundingSince: optBig(p[11]),
    adlScore: optBig(p[12]),
  }));

  return {
    balance: big(raw[0]),
    positions,
    equity: big(raw[2]),
    totalMm: big(raw[3]),
    totalIm: big(raw[4]),
    marginRatioBps: big(raw[5]),
    bindingScenario: undefined,
    feesAccrued: optBig(raw[7]),
    volume30dMicroUsdc: optBig(raw[8]),
  };
}

/**
 * Read resting orders, tolerating the gateway's broken `/v1` open-orders read
 * (PROOF_SDK_FEEDBACK.md #1) — returns `[]` (with the caller free to warn) rather
 * than throwing, so a broken read doesn't block order submission.
 */
export async function queryOpenOrdersSafe(
  client: ExchangeClient,
): Promise<OpenOrder[]> {
  try {
    return await client.queryOpenOrders();
  } catch (err) {
    if (/not found|404/i.test((err as Error).message ?? "")) return [];
    throw err;
  }
}
