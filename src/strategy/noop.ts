import type { Strategy, StrategyContext } from "./types.js";

/**
 * Read-only baseline strategy: observes the configured market and account but
 * never places orders. It's the safe default and a template — copy it, give it
 * a new `name`, and use `ctx.placeLimit` / `ctx.cancelAll` to actually trade.
 */
export class NoopStrategy implements Strategy {
  readonly name = "noop";

  async init(ctx: StrategyContext): Promise<void> {
    const markets = await ctx.markets();
    ctx.logger.info(
      { strategy: this.name, markets: markets.length, market: ctx.config.market },
      "noop: initialized (read-only — places no orders)",
    );
  }

  async onTick(ctx: StrategyContext): Promise<void> {
    const [account, book] = await Promise.all([
      ctx.account(),
      ctx.orderbook(ctx.config.market),
    ]);
    ctx.logger.info(
      {
        market: ctx.config.market,
        bestBid: book.bids[0]?.price?.toString() ?? null,
        bestAsk: book.asks[0]?.price?.toString() ?? null,
        equity: account?.equity?.toString() ?? null,
        positions: account?.positions.length ?? 0,
      },
      "noop: tick",
    );
  }
}
