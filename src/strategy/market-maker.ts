import { Side } from "@proof/trading-sdk";
import type { PositionInfo } from "@proof/trading-sdk";
import type { Strategy, StrategyContext } from "./types.js";
import type { EventLegs } from "../impact.js";

export interface MMParams {
  spreadBps: number;
  orderQty: bigint;
  maxPosition: bigint;
}
export interface Quote {
  price: bigint;
  qty: bigint;
}
export interface Quotes {
  bid?: Quote;
  ask?: Quote;
}

/** Signed position size: long positive, short negative. */
export function signedSize(p: PositionInfo | undefined): bigint {
  if (!p) return 0n;
  return p.side === "Buy" ? p.size : -p.size;
}

/**
 * Pure quote computation: bid/ask = mid ∓ half-spread, nudged by inventory, and
 * the inventory-growing side is suppressed once |position| ≥ maxPosition. Prices
 * are pre-snap (the runner snaps to tick); qty is pre-snap/cap.
 */
export function computeQuotes(
  mid: bigint,
  position: bigint,
  p: MMParams,
): Quotes {
  if (mid <= 0n || p.spreadBps <= 0 || p.orderQty <= 0n) return {};
  const half = (mid * BigInt(p.spreadBps)) / 20000n; // half of spreadBps
  const skew = (mid * BigInt(p.spreadBps)) / 40000n; // quarter-spread inventory nudge
  let bidPrice = mid - half;
  let askPrice = mid + half;
  if (position > 0n) {
    bidPrice -= skew; // long → lean down to encourage selling
    askPrice -= skew;
  } else if (position < 0n) {
    bidPrice += skew; // short → lean up to encourage buying
    askPrice += skew;
  }
  const q: Quotes = {};
  if (position < p.maxPosition) q.bid = { price: bidPrice, qty: p.orderQty }; // bid grows long
  if (-position < p.maxPosition) q.ask = { price: askPrice, qty: p.orderQty }; // ask grows short
  return q;
}

/**
 * Cancel-replace market maker on ONE leg. Each tick: read inventory (from /info)
 * + orderbook, cancel our orders on this market only, re-quote post-only. Robust
 * to the SDK's missing open-orders read (cancel-all-then-requote; fills inferred
 * from position deltas).
 */
export class MarketMakerStrategy implements Strategy {
  readonly name = "market-maker";

  constructor(private readonly configuredMarket: number) {}

  private market(legs: EventLegs): number {
    return this.configuredMarket > 0 ? this.configuredMarket : legs.underlying;
  }

  restingMarkets(legs: EventLegs): number[] {
    return [this.market(legs)];
  }

  async onTick(ctx: StrategyContext): Promise<void> {
    const market = this.market(ctx.legs);
    const meta = ctx.marketMeta(market);
    if (!meta) {
      ctx.recordDecision("skip", { reason: "no market meta", market });
      return;
    }
    const book = await ctx.orderbook(market);
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (bid === undefined || ask === undefined) {
      ctx.recordDecision("skip", { reason: "empty/one-sided book", market });
      return;
    }
    const mid = (bid + ask) / 2n;
    const position = signedSize(ctx.positionFor(market));
    const quotes = computeQuotes(mid, position, {
      spreadBps: ctx.config.mmSpreadBps,
      orderQty: ctx.config.mmOrderQty,
      maxPosition: ctx.config.mmMaxPosition,
    });

    await ctx.cancelMarket(market); // scoped — never touches other strategies' orders
    if (quotes.bid) {
      await ctx.place({ market, side: Side.Buy, price: quotes.bid.price, quantity: quotes.bid.qty, postOnly: true });
    }
    if (quotes.ask) {
      await ctx.place({ market, side: Side.Sell, price: quotes.ask.price, quantity: quotes.ask.qty, postOnly: true });
    }
    ctx.recordDecision("quote", {
      market,
      mid: mid.toString(),
      position: position.toString(),
      bid: quotes.bid?.price.toString() ?? null,
      ask: quotes.ask?.price.toString() ?? null,
    });
  }
}
