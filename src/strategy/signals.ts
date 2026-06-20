import { Side } from "@proof/trading-sdk";
import type { Orderbook } from "@proof/trading-sdk";
import type { StrategyContext } from "./types.js";

/** Top-of-book mid (micro-USDC), or undefined if the book is one-sided/empty. */
export function bookMid(book: Orderbook): bigint | undefined {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  return bid !== undefined && ask !== undefined ? (bid + ask) / 2n : undefined;
}

export const absBig = (x: bigint): bigint => (x < 0n ? -x : x);

/** Fixed-size rolling window of recent values, keyed by market (per strategy instance). */
export class RollingMeans {
  private readonly windows = new Map<number, bigint[]>();
  constructor(private readonly size: number) {}

  push(market: number, value: bigint): void {
    const w = this.windows.get(market) ?? [];
    w.push(value);
    if (w.length > this.size) w.shift();
    this.windows.set(market, w);
  }

  /** Mean of the window, or undefined until it holds at least `min` samples. */
  mean(market: number, min: number): bigint | undefined {
    const w = this.windows.get(market);
    if (!w || w.length < min) return undefined;
    let sum = 0n;
    for (const v of w) sum += v;
    return sum / BigInt(w.length);
  }

  count(market: number): number {
    return this.windows.get(market)?.length ?? 0;
  }
}

/**
 * Target signed position from a mid-vs-mean signal. `sign = +1` trends WITH the
 * move (momentum), `sign = -1` fades it (mean-reversion). Inside the threshold
 * band the target is 0 (flat) — no edge, no exposure.
 */
export function directionalTarget(
  mid: bigint,
  mean: bigint,
  thresholdBps: number,
  maxPos: bigint,
  sign: 1 | -1,
): bigint {
  const thresh = (mean * BigInt(thresholdBps)) / 10000n;
  if (mid > mean + thresh) return sign > 0 ? maxPos : -maxPos;
  if (mid < mean - thresh) return sign > 0 ? -maxPos : maxPos;
  return 0n;
}

/**
 * Move `market` one step toward a signed target (clamped to ±maxPos). Steps by at most
 * `orderQty` per tick. When `postOnly` is false it crosses at the opposite top of book
 * (taker — pays the spread); when true it rests PASSIVELY at the near top (maker — earns
 * the spread, fills only when the market comes to it). Returns true if it placed an order.
 */
export async function stepToward(
  ctx: StrategyContext,
  market: number,
  current: bigint,
  target: bigint,
  orderQty: bigint,
  maxPos: bigint,
  book: Orderbook,
  postOnly = false,
): Promise<boolean> {
  let tgt = target;
  if (tgt > maxPos) tgt = maxPos;
  if (tgt < -maxPos) tgt = -maxPos;
  const delta = tgt - current;
  if (delta === 0n) return false;
  const side = delta > 0n ? Side.Buy : Side.Sell;
  let qty = absBig(delta);
  if (qty > orderQty) qty = orderQty;
  // taker crosses at the OPPOSITE top; maker rests at the NEAR top (Buy→bid, Sell→ask).
  const top = postOnly
    ? side === Side.Buy
      ? book.bids[0]?.price
      : book.asks[0]?.price
    : side === Side.Buy
      ? book.asks[0]?.price
      : book.bids[0]?.price;
  if (top === undefined || qty <= 0n) return false;
  // crossing toward the position's reducing direction is reduce-only-safe; growing is capped above
  const reduceOnly = (current > 0n && side === Side.Sell) || (current < 0n && side === Side.Buy);
  await ctx.place({ market, side, price: top, quantity: qty, postOnly, reduceOnly });
  return true;
}
