import { describe, it, expect } from "vitest";
import { Side } from "@proof/trading-sdk";
import { ConditionalMmStrategy } from "./conditional-mm.js";

const LEGS = { underlying: 7, cpy: 20300, cpn: 20301, eby: 20302, ebn: 20303, question: "q", deadlineMs: 9_000_000_000_000, resolutionWindowMs: 0, status: "Trading" };
const cfg = (over = {}) => ({
  resolutionGuardMs: 86_400_000,
  condSpreadBps: 120, condOrderQty: 10n, condMaxPosition: 100n,
  condHedgeEnabled: true, condHedgeQty: 10n, condHedgeMax: 200n,
  condPremiumOffsetBps: 300, condProbFloorBps: 500, condProbCeilBps: 9500,
  condTakerEnabled: false, condTakerEdgeBps: 80,
  ...over,
});

// market id → {bids,asks}. Missing → empty book.
function fakeCtx(opts: { config?: object; legs?: object; books?: Record<number, unknown>; pos?: Record<number, unknown>; nowMs?: number } = {}) {
  const books = opts.books ?? {};
  const pos = opts.pos ?? {};
  const calls = {
    place: [] as Record<string, unknown>[],
    cancels: [] as number[],
    baskets: [] as unknown[],
    decisions: [] as { action: string; detail: unknown }[],
  };
  const empty = { bids: [], asks: [] };
  const ctx = {
    config: opts.config ?? cfg(),
    legs: opts.legs ?? LEGS,
    nowMs: opts.nowMs ?? 1_000_000,
    marketMeta: () => ({ market: 0, tickSize: 0n, lotSize: 0n, szDecimals: 2, takerFeeBps: 5, makerFeeBps: 2 }),
    orderbook: async (m: number) => books[m] ?? empty,
    positionFor: (m: number) => pos[m],
    place: async (p: Record<string, unknown>) => { calls.place.push(p); return null; },
    cancelMarket: async (m: number) => { calls.cancels.push(m); return null; },
    basket: async (legs: unknown) => { calls.baskets.push(legs); return null; },
    recordDecision: (action: string, detail: unknown) => calls.decisions.push({ action, detail }),
    logger: { error: () => {}, debug: () => {} },
  };
  return { ctx, calls };
}

// base mid 70.0, binaries imply 43% YES (in the deadband).
const baseBook = { bids: [{ price: 69_990_000n }], asks: [{ price: 70_010_000n }] }; // mid 70_000_000
const ebyBook = { bids: [{ price: 429_000n }], asks: [{ price: 431_000n }] }; // ~0.43
const ebnBook = { bids: [{ price: 569_000n }], asks: [{ price: 571_000n }] }; // ~0.57

describe("ConditionalMmStrategy", () => {
  it("quotes BOTH conditional legs post-only, anchored base±offset when their books are empty", async () => {
    const { ctx, calls } = fakeCtx({ books: { 7: baseBook, 20302: ebyBook, 20303: ebnBook } });
    await new ConditionalMmStrategy("both").onTick(ctx as never);
    // cancel-replace on cpy + cpn
    expect(calls.cancels).toEqual(expect.arrayContaining([20300, 20301]));
    const cpy = calls.place.filter((p) => p.market === 20300);
    const cpn = calls.place.filter((p) => p.market === 20301);
    expect(cpy).toHaveLength(2); // two-sided
    expect(cpn).toHaveLength(2);
    expect(cpy.every((p) => p.postOnly === true)).toBe(true);
    // CPY anchored to a PREMIUM over base (70.0 + 3%), CPN to a DISCOUNT — quotes straddle each anchor
    const cpyBid = cpy.find((p) => p.side === Side.Buy)!.price as bigint;
    const cpnAsk = cpn.find((p) => p.side === Side.Sell)!.price as bigint;
    expect(cpyBid).toBeGreaterThan(70_000_000n); // CPY quotes sit above base mid
    expect(cpnAsk).toBeLessThan(70_000_000n); // CPN quotes sit below base mid
    expect(calls.decisions.some((d) => d.action === "cond-quote")).toBe(true);
  });

  it("deadbands out a near-certain branch (no quoting)", async () => {
    // binaries imply ~99% YES → above the 9500 ceiling
    const eby = { bids: [{ price: 989_000n }], asks: [{ price: 991_000n }] };
    const ebn = { bids: [{ price: 9_000n }], asks: [{ price: 11_000n }] };
    const { ctx, calls } = fakeCtx({ books: { 7: baseBook, 20302: eby, 20303: ebn } });
    await new ConditionalMmStrategy("both").onTick(ctx as never);
    expect(calls.place).toHaveLength(0);
    expect(calls.decisions.some((d) => d.action === "cond-skip" && (d.detail as { reason: string }).reason === "prob deadband")).toBe(true);
  });

  it("near resolution → cancels + flattens, no new quotes", async () => {
    const { ctx, calls } = fakeCtx({
      legs: { ...LEGS, status: "Resolved" },
      books: { 7: baseBook, 20300: { bids: [{ price: 72_000_000n }], asks: [{ price: 72_100_000n }] } },
      pos: { 20300: { side: "Buy", size: 20n, entryPrice: 71_000_000n } }, // long cpy → must flatten
    });
    await new ConditionalMmStrategy("both").onTick(ctx as never);
    expect(calls.cancels).toEqual(expect.arrayContaining([20300, 20301]));
    const flatten = calls.place.find((p) => p.market === 20300 && p.reduceOnly === true);
    expect(flatten).toMatchObject({ side: Side.Sell, reduceOnly: true }); // reduce the long
    expect(calls.decisions.some((d) => d.action === "cond-skip" && (d.detail as { reason: string }).reason === "near resolution")).toBe(true);
  });

  it("delta-hedges net conditional inventory on the base perp", async () => {
    const { ctx, calls } = fakeCtx({
      books: { 7: baseBook, 20302: ebyBook, 20303: ebnBook },
      pos: { 20300: { side: "Buy", size: 40n, entryPrice: 72_000_000n } }, // long CPY → hedge SHORT base
    });
    await new ConditionalMmStrategy("cpy").onTick(ctx as never);
    const baseOrder = calls.place.find((p) => p.market === 7);
    expect(baseOrder).toBeDefined();
    expect(baseOrder!.side).toBe(Side.Sell); // short base to offset the long conditional
    expect(calls.decisions.some((d) => d.action === "cond-hedge")).toBe(true);
  });
});
