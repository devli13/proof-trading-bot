import type { Strategy, StrategyContext } from "./types.js";

/**
 * "Go for returns" — an opportunistic composite that each tick takes BOTH the
 * market-neutral parity capture and a directional momentum lean on the base perp.
 * Aggression (looser edge thresholds, bigger size) comes from the bot's own
 * params in the registry. Because the sub-strategies run on the shared context,
 * all orders/decisions are attributed to this strategy ("max-profit"), and the
 * engine's per-bot kill-switch + caps still bound the risk.
 */
export class MaxProfitStrategy implements Strategy {
  readonly name = "max-profit";

  constructor(
    private readonly arb: Strategy,
    private readonly momentum: Strategy,
  ) {}

  async onTick(ctx: StrategyContext): Promise<void> {
    // Parity first (near-neutral, capture any dislocation), then a directional lean.
    // Isolate each so one sub-strategy throwing can't skip the other. Decisions are
    // attributed to "max-profit" (the shared context); the action name still tells
    // parity ("binary-arb-*", "no-edge") from momentum ("step", "hold") apart.
    try {
      await this.arb.onTick(ctx);
    } catch (err) {
      ctx.logger.error({ sub: this.arb.name, err: (err as Error).message }, "max-profit: sub-strategy error");
    }
    try {
      await this.momentum.onTick(ctx);
    } catch (err) {
      ctx.logger.error({ sub: this.momentum.name, err: (err as Error).message }, "max-profit: sub-strategy error");
    }
  }
}
