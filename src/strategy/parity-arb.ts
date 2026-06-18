import { Side } from "@proof/trading-sdk";
import type { Orderbook } from "@proof/trading-sdk";
import type { BasketLegArg, Strategy, StrategyContext } from "./types.js";
import {
  ONE_DOLLAR,
  nearResolution,
  impliedProbBps,
  conditionalParityResidual,
} from "../impact.js";
import { signedSize } from "./market-maker.js";

function top(book: Orderbook): { bid?: bigint; ask?: bigint; mid?: bigint } {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2n : undefined;
  return { bid, ask, mid };
}

/**
 * True when a `side` basket would GROW either binary leg's |position| past the
 * cap, so it should be skipped. Buying grows long; selling grows short. Once at
 * the cap the arb only takes the inventory-reducing side, so net position can't
 * drift unbounded.
 */
export function arbBlockedByCap(
  side: "Buy" | "Sell",
  ebyPos: bigint,
  ebnPos: bigint,
  cap: bigint,
): boolean {
  if (cap <= 0n) return false;
  return side === "Buy"
    ? ebyPos >= cap || ebnPos >= cap
    : ebyPos <= -cap || ebnPos <= -cap;
}

/**
 * Parity / atomic-basket strategy on the impact event's legs.
 *
 * PRIMARY (safe-ish): binary parity. EBY + EBN should ≈ $1 (exactly one settles
 * to $1) — when the pair is mispriced past fees + a VOID safety margin, capture
 * it with a 2-leg FOK AtomicBasketOrder. NOT riskless: a VOID can break the $1
 * invariant, so we only act while status == Trading and far from the deadline,
 * and require an edge that clears fees + ARB_VOID_SAFETY_BPS.
 *
 * OPTIONAL (off by default): a 3-leg directional basket on the conditional legs.
 * This is NOT an arb — conditional legs settle to the underlying price in-branch,
 * so it is an explicit directional bet (capped, ARB_CONDITIONAL_ENABLED).
 *
 * Uses only FOK baskets ⇒ no resting orders ⇒ no cancels (no cross-strategy
 * cancel collision).
 */
export class ParityArbStrategy implements Strategy {
  readonly name = "parity-arb";

  async onTick(ctx: StrategyContext): Promise<void> {
    const legs = ctx.legs;
    if (nearResolution(legs, ctx.config.resolutionGuardMs, ctx.nowMs)) {
      ctx.recordDecision("skip", { reason: "near resolution / not Trading", status: legs.status });
      return;
    }

    const [ebyBook, ebnBook] = await Promise.all([
      ctx.orderbook(legs.eby),
      ctx.orderbook(legs.ebn),
    ]);
    const eby = top(ebyBook);
    const ebn = top(ebnBook);
    if (eby.bid === undefined || eby.ask === undefined || ebn.bid === undefined || ebn.ask === undefined) {
      ctx.recordDecision("skip", { reason: "empty binary book" });
    } else {
      const takerEby = ctx.marketMeta(legs.eby)?.takerFeeBps ?? 5;
      const takerEbn = ctx.marketMeta(legs.ebn)?.takerFeeBps ?? 5;
      const reqBps =
        ctx.config.arbMinEdgeBps + ctx.config.arbVoidSafetyBps + takerEby + takerEbn;
      const edge = (ONE_DOLLAR * BigInt(reqBps)) / 10000n;
      const qty = ctx.config.arbOrderQty;
      const cap = ctx.config.arbMaxPosition;
      const ebyPos = signedSize(ctx.positionFor(legs.eby));
      const ebnPos = signedSize(ctx.positionFor(legs.ebn));
      const buyCost = eby.ask + ebn.ask; // pay asks to BUY both → payout $1
      const sellRev = eby.bid + ebn.bid; // collect bids to SELL both → pay $1

      if (ONE_DOLLAR - buyCost > edge) {
        if (arbBlockedByCap("Buy", ebyPos, ebnPos, cap)) {
          ctx.recordDecision("skip-cap", { side: "Buy", ebyPos: ebyPos.toString(), ebnPos: ebnPos.toString(), cap: cap.toString() });
        } else {
          const basket: BasketLegArg[] = [
            { market: legs.eby, side: Side.Buy, price: eby.ask, quantity: qty },
            { market: legs.ebn, side: Side.Buy, price: ebn.ask, quantity: qty },
          ];
          ctx.recordDecision("binary-arb-buy", { buyCost: buyCost.toString(), edge: edge.toString() });
          await ctx.basket(basket, ctx.config.arbMinEdgeBps);
        }
      } else if (sellRev - ONE_DOLLAR > edge) {
        if (arbBlockedByCap("Sell", ebyPos, ebnPos, cap)) {
          ctx.recordDecision("skip-cap", { side: "Sell", ebyPos: ebyPos.toString(), ebnPos: ebnPos.toString(), cap: cap.toString() });
        } else {
          const basket: BasketLegArg[] = [
            { market: legs.eby, side: Side.Sell, price: eby.bid, quantity: qty },
            { market: legs.ebn, side: Side.Sell, price: ebn.bid, quantity: qty },
          ];
          ctx.recordDecision("binary-arb-sell", { sellRev: sellRev.toString(), edge: edge.toString() });
          await ctx.basket(basket, ctx.config.arbMinEdgeBps);
        }
      } else {
        ctx.recordDecision("no-edge", {
          buyCost: buyCost.toString(),
          sellRev: sellRev.toString(),
          reqEdge: edge.toString(),
        });
      }
    }

    if (ctx.config.arbConditionalEnabled) {
      await this.conditionalDirectional(ctx);
    }
  }

  /** Explicitly DIRECTIONAL: express base-vs-synthetic mispricing as a small basket. */
  private async conditionalDirectional(ctx: StrategyContext): Promise<void> {
    const legs = ctx.legs;
    const [baseB, cpyB, cpnB, ebyB, ebnB] = await Promise.all([
      ctx.orderbook(legs.underlying),
      ctx.orderbook(legs.cpy),
      ctx.orderbook(legs.cpn),
      ctx.orderbook(legs.eby),
      ctx.orderbook(legs.ebn),
    ]);
    const base = top(baseB);
    const cpy = top(cpyB);
    const cpn = top(cpnB);
    const eby = top(ebyB);
    const ebn = top(ebnB);
    if (
      base.mid === undefined || cpy.mid === undefined || cpn.mid === undefined ||
      eby.mid === undefined || ebn.mid === undefined ||
      base.bid === undefined || base.ask === undefined ||
      cpy.ask === undefined || cpn.ask === undefined
    ) {
      return;
    }
    const probBps = impliedProbBps(eby.mid, ebn.mid);
    if (probBps === null) return;
    const resid = conditionalParityResidual(base.mid, cpy.mid, cpn.mid, probBps);
    const threshold = (base.mid * BigInt(ctx.config.arbMinEdgeBps)) / 10000n;
    const qty = ctx.config.mmOrderQty;

    if (resid > threshold) {
      // base rich vs synthetic → short base + long the YES-conditional (directional)
      ctx.recordDecision("conditional-directional", { side: "short-base", resid: resid.toString() });
      await ctx.basket(
        [
          { market: legs.underlying, side: Side.Sell, price: base.bid, quantity: qty },
          { market: legs.cpy, side: Side.Buy, price: cpy.ask, quantity: qty },
        ],
        ctx.config.arbMinEdgeBps,
      );
    } else if (resid < -threshold) {
      ctx.recordDecision("conditional-directional", { side: "long-base", resid: resid.toString() });
      await ctx.basket(
        [
          { market: legs.underlying, side: Side.Buy, price: base.ask, quantity: qty },
          { market: legs.cpn, side: Side.Buy, price: cpn.ask, quantity: qty },
        ],
        ctx.config.arbMinEdgeBps,
      );
    }
  }
}
