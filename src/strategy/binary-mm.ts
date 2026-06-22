import { Side } from "@proof/trading-sdk";
import type { Strategy, StrategyContext } from "./types.js";
import { signedSize } from "./market-maker.js";
import { ONE_DOLLAR, impliedProbBps, nearResolution } from "../impact.js";
import { bookMid } from "./signals.js";
import { QuoteThrottle } from "./quote-throttle.js";

type BinRole = "eby" | "ebn";
const TICK = 1n; // binary legs trade with tick=1, lot=100, bounded 0..$1 (ONE_DOLLAR)

/** Clamp a price into the open binary range (never 0 or $1). */
function clampBinary(p: bigint): bigint {
  if (p < TICK) return TICK;
  if (p > ONE_DOLLAR - TICK) return ONE_DOLLAR - TICK;
  return p;
}

/**
 * Two-sided post-only quotes for ONE binary leg, centered on its parity-fair value
 * (fair = implied probability in $, so EBY≈p and EBN≈1−p → the pair sums to $1). Spread
 * is bps of $1 (binaries are bounded, not a % of a moving mid); inventory skews quotes to
 * mean-revert toward flat. Prices are clamped into (0,$1) and the inventory-growing side is
 * suppressed at the cap — mirrors computeQuotes' gating but bounded for a 0..$1 book.
 */
export function binaryQuotes(
  fair: bigint,
  position: bigint,
  spreadBps: number,
  orderQty: bigint,
  maxPosition: bigint,
): { bid?: { price: bigint; qty: bigint }; ask?: { price: bigint; qty: bigint } } {
  const half = (ONE_DOLLAR * BigInt(spreadBps)) / 20000n;
  const skew = maxPosition > 0n ? (half * position) / maxPosition : 0n; // long → shift down
  const bidPrice = clampBinary(fair - half - skew);
  const askPrice = clampBinary(fair + half - skew);
  const out: { bid?: { price: bigint; qty: bigint }; ask?: { price: bigint; qty: bigint } } = {};
  if (bidPrice < askPrice) {
    if (position < maxPosition) out.bid = { price: bidPrice, qty: orderQty };
    if (-position < maxPosition) out.ask = { price: askPrice, qty: orderQty };
  }
  return out;
}

/**
 * Prediction-binary market-maker — provides the missing liquidity on the EBY/EBN tokens
 * (the 0..$1 YES/NO legs of an impact event), which only ever saw rare parity-arb fills.
 * Quotes are pinned to the implied probability (EBY≈p, EBN≈1−p) so they hold EBY+EBN≈$1 by
 * construction — providing liquidity AND passively absorbing parity dislocations as fills.
 *
 * No base hedge (binaries are bounded probability tokens, not delta); inventory is bounded
 * and flattened via nearResolution() before settlement; a prob deadband skips near-certain
 * (degenerate) outcomes. DEVNET bootstrapping of thin binary books (acceptable).
 */
export class BinaryMmStrategy implements Strategy {
  readonly name = "binary-mm";
  private readonly throttle = new QuoteThrottle();

  constructor(private readonly role: "eby" | "ebn" | "both") {}

  private roles(): BinRole[] {
    return this.role === "both" ? ["eby", "ebn"] : [this.role];
  }

  async onTick(ctx: StrategyContext): Promise<void> {
    const legs = ctx.legs;
    const roleMarket: Record<BinRole, number> = { eby: legs.eby, ebn: legs.ebn };
    const active = this.roles();

    if (nearResolution(legs, ctx.config.resolutionGuardMs, ctx.nowMs)) {
      for (const r of active) {
        await ctx.cancelMarket(roleMarket[r]);
        await this.flatten(ctx, roleMarket[r]);
      }
      ctx.recordDecision("bin-skip", { reason: "near resolution", status: legs.status });
      return;
    }

    const [ebyBook, ebnBook] = await Promise.all([ctx.orderbook(legs.eby), ctx.orderbook(legs.ebn)]);
    const ebyMid = bookMid(ebyBook);
    const ebnMid = bookMid(ebnBook);
    const probBps = ebyMid !== undefined && ebnMid !== undefined ? impliedProbBps(ebyMid, ebnMid) : null;
    if (probBps === null) {
      ctx.recordDecision("bin-skip", { reason: "no implied prob (thin books)" });
      return;
    }
    if (probBps < ctx.config.binProbFloorBps || probBps > ctx.config.binProbCeilBps) {
      for (const r of active) await ctx.cancelMarket(roleMarket[r]);
      ctx.recordDecision("bin-skip", { reason: "prob deadband", probBps });
      return;
    }

    // Parity-fair: EBY = p·$1, EBN = (1−p)·$1 (probBps in [0,10000] → micro = probBps·100).
    const fair: Record<BinRole, bigint> = {
      eby: BigInt(probBps) * 100n,
      ebn: BigInt(10000 - probBps) * 100n,
    };

    for (const r of active) {
      const market = roleMarket[r];
      const position = signedSize(ctx.positionFor(market));
      const q = binaryQuotes(fair[r], position, ctx.config.binSpreadBps, ctx.config.binOrderQty, ctx.config.binMaxPosition);
      if (!this.throttle.shouldRequote(market, q.bid?.price, q.ask?.price, position, ctx.nowMs, ctx.config.requoteToleranceBps, ctx.config.requoteForceMs)) {
        ctx.recordDecision("bin-hold", { role: r, market });
        continue;
      }
      await ctx.cancelMarket(market);
      if (q.bid) await ctx.place({ market, side: Side.Buy, price: q.bid.price, quantity: q.bid.qty, postOnly: true });
      if (q.ask) await ctx.place({ market, side: Side.Sell, price: q.ask.price, quantity: q.ask.qty, postOnly: true });
      this.throttle.record(market, q.bid?.price, q.ask?.price, position, ctx.nowMs);
      ctx.recordDecision("bin-quote", { role: r, market, fair: fair[r].toString(), position: position.toString(), probBps });
    }
  }

  private async flatten(ctx: StrategyContext, market: number): Promise<void> {
    const pos = signedSize(ctx.positionFor(market));
    if (pos === 0n) return;
    const book = await ctx.orderbook(market);
    const side = pos > 0n ? Side.Sell : Side.Buy;
    const top = side === Side.Buy ? book.asks[0]?.price : book.bids[0]?.price;
    if (top === undefined) return;
    await ctx.place({ market, side, price: top, quantity: pos > 0n ? pos : -pos, postOnly: false, reduceOnly: true });
  }
}
