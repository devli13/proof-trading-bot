import { Side } from "@proof/trading-sdk";
import type { Strategy, StrategyContext } from "./types.js";
import type { EventLegs } from "../impact.js";
import { computeQuotes, signedSize } from "./market-maker.js";

/**
 * Volume driver (devnet-only) — REDESIGNED. It used to cycle real taker positions
 * (open→hold→exit), which placed orders on only ~15% of ticks and PAID the spread
 * twice per cycle (it was the worst-bleeding bot). It is now a continuous post-only
 * two-sided maker — the same proven engine as the market-maker — so it drives volume
 * by quoting both sides every tick and EARNING the spread instead of paying it.
 *
 * Sizing/spread are its own params (VOL_ORDER_QTY / VOL_MAX_POSITION / VOL_SPREAD_BPS)
 * and it should be pointed at a leg de-conflicted from the main market-makers (VOL_MARKET)
 * so it adds fresh flow rather than quoting inside another of our bots. DEVNET-ONLY:
 * deliberately adding volume is rule-sensitive on a real market — this is platform testing.
 */
export class VolumeDriverStrategy implements Strategy {
  readonly name = "volume-driver";

  constructor(private readonly configuredMarket: number) {}

  private market(legs: EventLegs): number {
    return this.configuredMarket > 0 ? this.configuredMarket : legs.underlying;
  }

  async onTick(ctx: StrategyContext): Promise<void> {
    // Hard devnet gate — never deliberately add volume on a real market.
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
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (bid === undefined || ask === undefined) {
      ctx.recordDecision("skip", { reason: "empty/one-sided book", market });
      return;
    }
    const mid = (bid + ask) / 2n;
    const position = signedSize(ctx.positionFor(market));
    const quotes = computeQuotes(mid, position, {
      spreadBps: ctx.config.volSpreadBps,
      orderQty: ctx.config.volOrderQty,
      maxPosition: ctx.config.volMaxPosition,
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
