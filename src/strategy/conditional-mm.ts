import { Side } from "@proof/trading-sdk";
import type { Strategy, StrategyContext } from "./types.js";
import type { BasketLegArg } from "./types.js";
import { computeQuotes, signedSize } from "./market-maker.js";
import { impliedProbBps, conditionalParityResidual, nearResolution } from "../impact.js";
import { bookMid, stepToward } from "./signals.js";
import { QuoteThrottle } from "./quote-throttle.js";

type CondRole = "cpy" | "cpn";

/**
 * Conditional-perp market-maker — trades the actual impact-market primitive that the
 * vanilla mm-* bots ignore (they all quote legs.underlying). Each impact event has two
 * CONDITIONAL perps: CPY (settles to the base perp IF the event resolves YES, else voids
 * + refunds) and CPN (settles to base IF NO, else voids). They trade at a premium/discount
 * to base encoding the event probability — and NO bot currently quotes them.
 *
 * MAKER (default): post-only two-sided quotes on CPY and/or CPN, anchored to the leg's own
 * mid (fallback base ± COND_PREMIUM_OFFSET_BPS when its book is empty) at a wide spread, with
 * inventory skew/cap via computeQuotes. Net conditional inventory is DELTA-HEDGED on the base
 * perp so the book stays market-neutral pre-resolution.
 *
 * TAKER / CPB (gated COND_TAKER_ENABLED, default off): when the conditional-parity residual
 * base − (p·CPY + (1−p)·CPN) clears COND_TAKER_EDGE_BPS, fire the base-vs-in-branch-twin
 * convergence as an atomic FOK basket.
 *
 * Risk: a VOID breaks the hedge into a naked book AT resolution — so we hard-skip + flatten
 * via nearResolution(), deadband out near-certain branches (COND_PROB_FLOOR/CEIL_BPS, also
 * avoids degenerate pricing), and keep inventory + hedge bounded. DEVNET bootstrapping: our
 * own maker/taker may be the main flow on these thin legs (acceptable, like volume-driver).
 */
export class ConditionalMmStrategy implements Strategy {
  readonly name = "conditional-mm";
  private readonly throttle = new QuoteThrottle();

  constructor(private readonly role: "cpy" | "cpn" | "both") {}

  private roles(): CondRole[] {
    return this.role === "both" ? ["cpy", "cpn"] : [this.role];
  }

  async onTick(ctx: StrategyContext): Promise<void> {
    const legs = ctx.legs;
    const base = legs.underlying;
    const roleMarket: Record<CondRole, number> = { cpy: legs.cpy, cpn: legs.cpn };
    const active = this.roles();

    // VOID/branch guard: near resolution, stop quoting + flatten conditional inventory and
    // the base hedge (reduce-only), so a void/settlement can't strand a one-sided book.
    if (nearResolution(legs, ctx.config.resolutionGuardMs, ctx.nowMs)) {
      for (const r of active) {
        await ctx.cancelMarket(roleMarket[r]);
        await this.flatten(ctx, roleMarket[r]);
      }
      await this.hedge(ctx, base, active.map((r) => roleMarket[r]), true);
      ctx.recordDecision("cond-skip", { reason: "near resolution", status: legs.status });
      return;
    }

    const baseBook = await ctx.orderbook(base);
    const baseMid = bookMid(baseBook);
    if (baseMid === undefined) {
      ctx.recordDecision("cond-skip", { reason: "empty base book", base });
      return;
    }

    // Implied YES probability from the binaries; deadband out near-certain branches.
    const [ebyBook, ebnBook] = await Promise.all([ctx.orderbook(legs.eby), ctx.orderbook(legs.ebn)]);
    const ebyMid = bookMid(ebyBook);
    const ebnMid = bookMid(ebnBook);
    const probBps = ebyMid !== undefined && ebnMid !== undefined ? impliedProbBps(ebyMid, ebnMid) : null;
    if (probBps !== null && (probBps < ctx.config.condProbFloorBps || probBps > ctx.config.condProbCeilBps)) {
      for (const r of active) await ctx.cancelMarket(roleMarket[r]);
      ctx.recordDecision("cond-skip", { reason: "prob deadband", probBps });
      return;
    }

    // ── MAKER: quote each active conditional role, anchored to its own mid (fallback
    //    base ± offset), wide spread, inventory-skewed/capped. ──
    const off = (BigInt(ctx.config.condPremiumOffsetBps) * baseMid) / 10000n;
    for (const r of active) {
      const market = roleMarket[r];
      const book = await ctx.orderbook(market);
      const ownMid = bookMid(book);
      const anchor = ownMid ?? (r === "cpy" ? baseMid + off : baseMid - off);
      const position = signedSize(ctx.positionFor(market));
      const quotes = computeQuotes(anchor, position, {
        spreadBps: ctx.config.condSpreadBps,
        orderQty: ctx.config.condOrderQty,
        maxPosition: ctx.config.condMaxPosition,
      });
      if (!this.throttle.shouldRequote(market, quotes.bid?.price, quotes.ask?.price, position, ctx.nowMs, ctx.config.requoteToleranceBps, ctx.config.requoteForceMs)) {
        ctx.recordDecision("cond-hold", { role: r, market });
        continue;
      }
      await ctx.cancelMarket(market);
      if (quotes.bid) await ctx.place({ market, side: Side.Buy, price: quotes.bid.price, quantity: quotes.bid.qty, postOnly: true });
      if (quotes.ask) await ctx.place({ market, side: Side.Sell, price: quotes.ask.price, quantity: quotes.ask.qty, postOnly: true });
      this.throttle.record(market, quotes.bid?.price, quotes.ask?.price, position, ctx.nowMs);
      ctx.recordDecision("cond-quote", { role: r, market, anchor: anchor.toString(), position: position.toString(), probBps });
    }

    // ── DELTA-HEDGE: net conditional inventory (both twins settle to base in-branch, so
    //    long-conditional ≈ long-base) hedged on the base perp, bounded. ──
    if (ctx.config.condHedgeEnabled) {
      await this.hedge(ctx, base, active.map((r) => roleMarket[r]), false);
    }

    // ── CPB TAKER (gated): trade the conditional-parity residual as an atomic basket. ──
    if (ctx.config.condTakerEnabled && probBps !== null) {
      await this.takerConverge(ctx, base, baseMid, legs.cpy, legs.cpn, probBps);
    }
  }

  /** Step the base perp toward the negative of net conditional inventory (or 0 to unwind). */
  private async hedge(ctx: StrategyContext, base: number, condMarkets: number[], unwind: boolean): Promise<void> {
    const net = unwind ? 0n : condMarkets.reduce((a, m) => a + signedSize(ctx.positionFor(m)), 0n);
    const cur = signedSize(ctx.positionFor(base));
    const target = unwind ? 0n : -net; // offset long-conditional with short-base (and vice versa)
    const book = await ctx.orderbook(base);
    const acted = await stepToward(ctx, base, cur, target, ctx.config.condHedgeQty, ctx.config.condHedgeMax, book, false);
    if (acted) ctx.recordDecision("cond-hedge", { base, cur: cur.toString(), target: target.toString() });
  }

  /** Reduce a market's position to flat with a single reduce-only taker order. */
  private async flatten(ctx: StrategyContext, market: number): Promise<void> {
    const pos = signedSize(ctx.positionFor(market));
    if (pos === 0n) return;
    const book = await ctx.orderbook(market);
    const side = pos > 0n ? Side.Sell : Side.Buy;
    const top = side === Side.Buy ? book.asks[0]?.price : book.bids[0]?.price;
    if (top === undefined) return;
    const qty = pos > 0n ? pos : -pos;
    await ctx.place({ market, side, price: top, quantity: qty, postOnly: false, reduceOnly: true });
  }

  /** CPB convergence: when base − (p·CPY + (1−p)·CPN) is large, take the cheap vs rich side
   *  as a 2-leg atomic FOK (base against the prob-dominant in-branch twin). */
  private async takerConverge(ctx: StrategyContext, base: number, baseMid: bigint, cpy: number, cpn: number, probBps: number): Promise<void> {
    const cpyBook = await ctx.orderbook(cpy);
    const cpnBook = await ctx.orderbook(cpn);
    const cpyMid = bookMid(cpyBook);
    const cpnMid = bookMid(cpnBook);
    if (cpyMid === undefined || cpnMid === undefined) return;
    const resid = conditionalParityResidual(baseMid, cpyMid, cpnMid, probBps); // base − synthetic
    const edge = (baseMid * BigInt(ctx.config.condTakerEdgeBps)) / 10000n;
    if (resid > edge) {
      // base rich vs the conditional synthetic → SELL base, BUY the dominant in-branch twin.
      const twin = probBps >= 5000 ? cpy : cpn;
      const twinAsk = (probBps >= 5000 ? cpyBook : cpnBook).asks[0]?.price;
      const baseBid = ctx.positionFor(base) ? bookMid(await ctx.orderbook(base)) : baseMid;
      if (twinAsk === undefined || baseBid === undefined) return;
      const qty = ctx.config.condOrderQty;
      const basket: BasketLegArg[] = [
        { market: base, side: Side.Sell, price: baseBid, quantity: qty },
        { market: twin, side: Side.Buy, price: twinAsk, quantity: qty },
      ];
      ctx.recordDecision("cond-converge", { side: "base-rich", resid: resid.toString(), edge: edge.toString() });
      await ctx.basket(basket, ctx.config.condTakerEdgeBps);
    } else if (-resid > edge) {
      // base cheap vs synthetic → BUY base, SELL the dominant in-branch twin.
      const twin = probBps >= 5000 ? cpy : cpn;
      const twinBid = (probBps >= 5000 ? cpyBook : cpnBook).bids[0]?.price;
      const baseAsk = bookMid(await ctx.orderbook(base));
      if (twinBid === undefined || baseAsk === undefined) return;
      const qty = ctx.config.condOrderQty;
      const basket: BasketLegArg[] = [
        { market: base, side: Side.Buy, price: baseAsk, quantity: qty },
        { market: twin, side: Side.Sell, price: twinBid, quantity: qty },
      ];
      ctx.recordDecision("cond-converge", { side: "base-cheap", resid: resid.toString(), edge: edge.toString() });
      await ctx.basket(basket, ctx.config.condTakerEdgeBps);
    }
  }
}
