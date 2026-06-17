import type {
  AccountInfo,
  ExchangeClient,
  MarketConfig,
  OpenOrder,
  Orderbook,
  Side,
  TxResult,
} from "@proof/trading-sdk";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Wallet } from "../wallet.js";

export interface PlaceLimitArgs {
  market: number;
  side: Side;
  price: bigint;
  quantity: bigint;
  postOnly?: boolean;
  reduceOnly?: boolean;
}

/**
 * Everything a strategy needs. Read helpers wrap the SDK queries; write helpers
 * (`placeLimit`, `cancelAll`) are risk-guarded by the runner (MAX_ORDER_QTY,
 * MAX_OPEN_ORDERS) so a strategy can't exceed configured caps.
 */
export interface StrategyContext {
  client: ExchangeClient;
  wallet: Wallet;
  config: Config;
  logger: Logger;

  markets(): Promise<MarketConfig[]>;
  orderbook(market: number): Promise<Orderbook>;
  account(): Promise<AccountInfo | null>;
  openOrders(): Promise<OpenOrder[]>;

  placeLimit(args: PlaceLimitArgs): Promise<TxResult>;
  cancelAll(market?: number): Promise<TxResult>;
}

/**
 * A pluggable trading strategy. Implement the hooks you need:
 *   - `init`     once at startup (long-lived runner only)
 *   - `onTick`   on a fixed interval (also the serverless/cron entrypoint)
 *   - `onBlock`  on each chain block (long-lived runner only; needs a WS)
 *   - `shutdown` on SIGINT/SIGTERM (cancel orders, flatten, etc.)
 */
export interface Strategy {
  readonly name: string;
  init?(ctx: StrategyContext): Promise<void>;
  onTick?(ctx: StrategyContext): Promise<void>;
  onBlock?(ctx: StrategyContext, event: Record<string, unknown>): Promise<void>;
  shutdown?(ctx: StrategyContext): Promise<void>;
}
