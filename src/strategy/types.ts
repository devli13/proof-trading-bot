import type {
  AtomicBasketLeg,
  Orderbook,
  PositionInfo,
  Side,
  TxResult,
} from "@proof/trading-sdk";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Wallet } from "../wallet.js";
import type { EventLegs } from "../impact.js";

/** Per-market gates/scales needed to build valid orders. */
export interface MarketMeta {
  market: number;
  tickSize: bigint;
  lotSize: bigint;
  szDecimals: number;
  takerFeeBps: number;
  makerFeeBps: number;
}

export interface PlaceArgs {
  market: number;
  side: Side;
  price: bigint; // micro-USDC (pre-snap; the runner snaps to tick)
  quantity: bigint; // pre-snap (the runner snaps to lot + caps)
  postOnly?: boolean;
  reduceOnly?: boolean;
}

/** A basket leg the strategy wants; the runner snaps price/qty + assigns ids. */
export interface BasketLegArg {
  market: number;
  side: Side;
  price: bigint;
  quantity: bigint;
  reduceOnly?: boolean;
}

/**
 * Everything a strategy needs for one tick. All writes go through the runner's
 * context impl, which snaps to tick/lot, caps qty, serializes submits (nonce
 * safety), records to the tracker, and honors DRY_RUN. Strategies can't bypass
 * these. Each strategy gets its own context with `name` baked in.
 */
export interface StrategyContext {
  readonly name: string;
  config: Config;
  logger: Logger;
  wallet: Wallet;
  legs: EventLegs;
  /** Shared account snapshot for this tick (null if unreadable). */
  account: { positions: PositionInfo[]; equity: bigint } | null;
  nowMs: number;

  marketMeta(market: number): MarketMeta | undefined;
  orderbook(market: number): Promise<Orderbook>;
  positionFor(market: number): PositionInfo | undefined;

  /** Place a single limit order. Returns null if blocked (caps/empty/dry-run). */
  place(p: PlaceArgs): Promise<TxResult | null>;
  /** Cancel this strategy's resting orders on ONE market (never account-wide). */
  cancelMarket(market: number): Promise<TxResult | null>;
  /** Submit an atomic FOK basket. */
  basket(legs: BasketLegArg[], maxSlippageBps?: number): Promise<TxResult | null>;

  recordDecision(action: string, detail: Record<string, unknown>): void;
}

export interface Strategy {
  readonly name: string;
  init?(ctx: StrategyContext): Promise<void>;
  onTick(ctx: StrategyContext): Promise<void>;
  shutdown?(ctx: StrategyContext): Promise<void>;
}

/** Re-export for convenience. */
export type { AtomicBasketLeg };
