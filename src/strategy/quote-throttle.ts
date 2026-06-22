import { absBig } from "./signals.js";

/**
 * Per-market re-quote throttle for cancel-replace makers. A maker normally cancels and
 * re-posts both quotes EVERY tick, which floods the order ledger with churn (most ticks the
 * target quote barely moved). This lets a strategy skip the cancel-replace when nothing
 * material changed — re-quoting only when a quote moved more than `tolBps` (of its own price),
 * the inventory changed (which shifts skew/gates), or the resting orders are older than
 * `forceMs` (a staleness bound so they still refresh periodically). One instance per strategy.
 */
export class QuoteThrottle {
  private last = new Map<number, { bid?: bigint; ask?: bigint; pos: bigint; at: number }>();

  /** True if the strategy should cancel-replace this market's quotes this tick. */
  shouldRequote(
    market: number,
    bid: bigint | undefined,
    ask: bigint | undefined,
    pos: bigint,
    nowMs: number,
    tolBps: number,
    forceMs: number,
  ): boolean {
    const p = this.last.get(market);
    if (!p) return true; // never quoted this market yet
    if (p.pos !== pos) return true; // a fill / inventory change shifts skew + gates
    if (nowMs - p.at >= forceMs) return true; // staleness refresh
    return this.moved(p.bid, bid, tolBps) || this.moved(p.ask, ask, tolBps);
  }

  private moved(a: bigint | undefined, b: bigint | undefined, tolBps: number): boolean {
    if (a === undefined || b === undefined) return a !== b; // a side appeared/disappeared
    const tol = (absBig(a) * BigInt(tolBps)) / 10000n;
    return absBig(a - b) > tol;
  }

  /** Record what was just placed (call only when a re-quote actually happened). */
  record(market: number, bid: bigint | undefined, ask: bigint | undefined, pos: bigint, nowMs: number): void {
    this.last.set(market, { bid, ask, pos, at: nowMs });
  }
}
