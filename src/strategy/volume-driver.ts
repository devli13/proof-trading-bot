import { Side } from "@proof/trading-sdk";
import type { Strategy, StrategyContext } from "./types.js";
import type { EventLegs } from "../impact.js";
import { signedSize } from "./market-maker.js";
import { bookMid, absBig } from "./signals.js";

/**
 * Volume / volatility driver — un-stales a quiet book by cycling REAL positions:
 * open a sizable taker position (which moves the book), hold it, and unwind when
 * it makes sense (take-profit / stop-loss / max hold time). It alternates
 * direction each cycle to create two-way flow, and is loss-capped — explicitly
 * NOT instant open+close (that's wash trading). DEVNET-ONLY: deliberately adding
 * volatility is rule-sensitive on a real market; this is for platform testing.
 */
export class VolumeDriverStrategy implements Strategy {
  readonly name = "volume-driver";
  private readonly entryAt = new Map<number, number>();
  private nextLong = true;

  constructor(private readonly configuredMarket: number) {}

  private market(legs: EventLegs): number {
    return this.configuredMarket > 0 ? this.configuredMarket : legs.underlying;
  }

  async onTick(ctx: StrategyContext): Promise<void> {
    // Hard devnet gate — never deliberately move a real market.
    if (ctx.config.network !== "devnet" && ctx.config.network !== "local") {
      ctx.recordDecision("skip", { reason: "volume-driver is devnet-only" });
      return;
    }
    const market = this.market(ctx.legs);
    const meta = ctx.marketMeta(market);
    if (!meta) {
      ctx.recordDecision("skip", { reason: "no market meta", market });
      return;
    }
    const book = await ctx.orderbook(market);
    const mid = bookMid(book);
    if (mid === undefined) {
      ctx.recordDecision("skip", { reason: "empty/one-sided book", market });
      return;
    }

    const posInfo = ctx.positionFor(market);
    const pos = signedSize(posInfo);

    if (pos === 0n) {
      // Flat → clear any prior cycle's clock and open a fresh one, alternating
      // direction for two-way volatility. Cap the open size at VOL_MAX_POSITION.
      this.entryAt.delete(market);
      const qty = ctx.config.volOrderQty > ctx.config.volMaxPosition ? ctx.config.volMaxPosition : ctx.config.volOrderQty;
      if (qty <= 0n) {
        ctx.recordDecision("skip", { reason: "volOrderQty/volMaxPosition is 0", market });
        return;
      }
      const side = this.nextLong ? Side.Buy : Side.Sell;
      this.nextLong = !this.nextLong;
      const top = side === Side.Buy ? book.asks[0]?.price : book.bids[0]?.price;
      if (top === undefined) {
        ctx.recordDecision("skip", { reason: "no opposite top", market });
        return;
      }
      await ctx.place({ market, side, price: top, quantity: qty, postOnly: false });
      this.entryAt.set(market, ctx.nowMs);
      ctx.recordDecision("vol-open", { market, side: side === Side.Buy ? "Buy" : "Sell", qty: qty.toString(), mid: mid.toString() });
      return;
    }

    // In a position → exit on TP / SL / time, else hold. Start the clock if we hold
    // a position with no recorded entry (carried in). entryAt is cleared ONLY by the
    // flat branch above, so a close that doesn't fill can't reset the hold timer.
    if (!this.entryAt.has(market)) this.entryAt.set(market, ctx.nowMs);
    const entry = posInfo?.entryPrice ?? 0n;
    const unrealBps = entry > 0n ? Number(((mid - entry) * (pos > 0n ? 1n : -1n) * 10000n) / entry) : 0;
    const heldMs = ctx.nowMs - (this.entryAt.get(market) ?? ctx.nowMs);

    let reason = "";
    if (unrealBps >= ctx.config.volTakeProfitBps) reason = "take-profit";
    else if (unrealBps <= -ctx.config.volStopBps) reason = "stop-loss";
    else if (heldMs >= ctx.config.volHoldMs) reason = "time-exit";

    if (!reason) {
      ctx.recordDecision("vol-hold", { market, unrealBps, heldMs });
      return;
    }

    const side = pos > 0n ? Side.Sell : Side.Buy;
    const top = side === Side.Buy ? book.asks[0]?.price : book.bids[0]?.price;
    if (top !== undefined) {
      await ctx.place({ market, side, price: top, quantity: absBig(pos), postOnly: false, reduceOnly: true });
    }
    ctx.recordDecision("vol-close", { market, reason, unrealBps, heldMs });
  }
}
