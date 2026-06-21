import { describe, it, expect } from "vitest";
import { Side } from "@proof/trading-sdk";
import { BinaryMmStrategy, binaryQuotes } from "./binary-mm.js";

const ONE = 1_000_000n;
const LEGS = { underlying: 7, cpy: 20300, cpn: 20301, eby: 20302, ebn: 20303, question: "q", deadlineMs: 9_000_000_000_000, resolutionWindowMs: 0, status: "Trading" };
const cfg = (over = {}) => ({
  resolutionGuardMs: 86_400_000,
  binSpreadBps: 200, binOrderQty: 100n, binMaxPosition: 1000n,
  binProbFloorBps: 300, binProbCeilBps: 9700,
  ...over,
});

function fakeCtx(opts: { config?: object; legs?: object; books?: Record<number, unknown>; pos?: Record<number, unknown> } = {}) {
  const books = opts.books ?? {}; const pos = opts.pos ?? {};
  const calls = { place: [] as Record<string, unknown>[], cancels: [] as number[], decisions: [] as { action: string; detail: unknown }[] };
  const empty = { bids: [], asks: [] };
  const ctx = {
    config: opts.config ?? cfg(), legs: opts.legs ?? LEGS, nowMs: 1_000_000,
    marketMeta: () => ({ market: 0, tickSize: 1n, lotSize: 100n, szDecimals: 2, takerFeeBps: 5, makerFeeBps: 2 }),
    orderbook: async (m: number) => books[m] ?? empty,
    positionFor: (m: number) => pos[m],
    place: async (p: Record<string, unknown>) => { calls.place.push(p); return null; },
    cancelMarket: async (m: number) => { calls.cancels.push(m); return null; },
    basket: async () => null,
    recordDecision: (action: string, detail: unknown) => calls.decisions.push({ action, detail }),
    logger: { error: () => {}, debug: () => {} },
  };
  return { ctx, calls };
}

describe("binaryQuotes (bounded 0..$1 pricing)", () => {
  it("centers on fair, never crosses 0 or $1, gates the cap side", () => {
    const q = binaryQuotes(430_000n, 0n, 200, 100n, 1000n); // fair $0.43, ±$0.01
    expect(q.bid!.price).toBe(420_000n);
    expect(q.ask!.price).toBe(440_000n);
    // near the $1 boundary the ask clamps below $1, bid below it
    const hi = binaryQuotes(ONE - 5n, 0n, 200, 100n, 1000n);
    expect(hi.ask === undefined || hi.ask.price < ONE).toBe(true);
    // at the long cap, only the inventory-reducing ask is offered
    const capped = binaryQuotes(430_000n, 1000n, 200, 100n, 1000n);
    expect(capped.bid).toBeUndefined();
    expect(capped.ask).toBeDefined();
  });
});

const ebyBook = { bids: [{ price: 429_000n }], asks: [{ price: 431_000n }] }; // ~0.43
const ebnBook = { bids: [{ price: 569_000n }], asks: [{ price: 571_000n }] }; // ~0.57

describe("BinaryMmStrategy", () => {
  it("quotes EBY≈p and EBN≈1−p post-only (parity-pinned, sums to ≈$1)", async () => {
    const { ctx, calls } = fakeCtx({ books: { 20302: ebyBook, 20303: ebnBook } });
    await new BinaryMmStrategy("both").onTick(ctx as never);
    expect(calls.cancels).toEqual(expect.arrayContaining([20302, 20303]));
    const eby = calls.place.filter((p) => p.market === 20302);
    const ebn = calls.place.filter((p) => p.market === 20303);
    expect(eby).toHaveLength(2);
    expect(ebn).toHaveLength(2);
    expect(eby.every((p) => p.postOnly === true)).toBe(true);
    // EBY centered ~0.43, EBN ~0.57 → the two fair midpoints sum to ≈ $1
    const ebyMid = ((eby[0]!.price as bigint) + (eby[1]!.price as bigint)) / 2n;
    const ebnMid = ((ebn[0]!.price as bigint) + (ebn[1]!.price as bigint)) / 2n;
    expect(ebyMid + ebnMid).toBeGreaterThan(990_000n);
    expect(ebyMid + ebnMid).toBeLessThan(1_010_000n);
  });

  it("deadbands out a near-certain outcome", async () => {
    const eby = { bids: [{ price: 989_000n }], asks: [{ price: 991_000n }] }; // ~99%
    const ebn = { bids: [{ price: 9_000n }], asks: [{ price: 11_000n }] };
    const { ctx, calls } = fakeCtx({ books: { 20302: eby, 20303: ebn } });
    await new BinaryMmStrategy("both").onTick(ctx as never);
    expect(calls.place).toHaveLength(0);
    expect(calls.decisions.some((d) => d.action === "bin-skip" && (d.detail as { reason: string }).reason === "prob deadband")).toBe(true);
  });

  it("near resolution → cancels + flattens", async () => {
    const { ctx, calls } = fakeCtx({
      legs: { ...LEGS, status: "Resolved" },
      books: { 20302: ebyBook }, pos: { 20302: { side: "Buy", size: 100n, entryPrice: 430_000n } },
    });
    await new BinaryMmStrategy("both").onTick(ctx as never);
    expect(calls.cancels).toEqual(expect.arrayContaining([20302, 20303]));
    expect(calls.place.find((p) => p.market === 20302 && p.reduceOnly === true)).toMatchObject({ side: Side.Sell });
  });
});
