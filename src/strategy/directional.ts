import type { Strategy, StrategyContext } from "./types.js";
import type { EventLegs } from "../impact.js";
import { signedSize } from "./market-maker.js";
import { bookMid, RollingMeans, directionalTarget, stepToward } from "./signals.js";

/**
 * Directional strategy on the base perp, driven by mid vs a rolling mean.
 *   sign = +1  → momentum (trade WITH the move)
 *   sign = -1  → mean-reversion (fade the move)
 * Inside the threshold band the target is flat. Positions are capped and entered
 * one step per tick (taker). The persistent worker keeps the rolling window alive.
 */
export class DirectionalStrategy implements Strategy {
  private readonly means: RollingMeans;

  constructor(
    readonly name: string,
    private readonly sign: 1 | -1,
    private readonly configuredMarket: number,
    private readonly window: number,
  ) {
    this.means = new RollingMeans(window);
  }

  private market(legs: EventLegs): number {
    return this.configuredMarket > 0 ? this.configuredMarket : legs.underlying;
  }

  async onTick(ctx: StrategyContext): Promise<void> {
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

    this.means.push(market, mid);
    const mean = this.means.mean(market, this.window);
    if (mean === undefined) {
      ctx.recordDecision("warming", { market, have: this.means.count(market), need: this.window });
      return;
    }

    const cur = signedSize(ctx.positionFor(market));
    const target = directionalTarget(mid, mean, ctx.config.dirThresholdBps, ctx.config.dirMaxPosition, this.sign);
    const acted = await stepToward(ctx, market, cur, target, ctx.config.dirOrderQty, ctx.config.dirMaxPosition, book);

    ctx.recordDecision(acted ? "step" : "hold", {
      market,
      mid: mid.toString(),
      mean: mean.toString(),
      position: cur.toString(),
      target: target.toString(),
    });
  }
}
