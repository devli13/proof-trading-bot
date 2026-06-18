import { describe, it, expect } from "vitest";
import { Side } from "@proof/trading-sdk";
import type { Orderbook } from "@proof/trading-sdk";
import { RollingMeans, directionalTarget, bookMid, stepToward } from "./signals.js";
import type { StrategyContext } from "./types.js";

const book = (bid?: bigint, ask?: bigint): Orderbook =>
  ({ bids: bid !== undefined ? [{ price: bid }] : [], asks: ask !== undefined ? [{ price: ask }] : [] }) as unknown as Orderbook;

function fakeCtx(): { ctx: StrategyContext; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const ctx = {
    place: async (p: Record<string, unknown>) => {
      calls.push(p);
      return null;
    },
  } as unknown as StrategyContext;
  return { ctx, calls };
}

describe("RollingMeans", () => {
  it("returns a mean only after `min` samples and caps the window", () => {
    const r = new RollingMeans(3);
    expect(r.mean(7, 3)).toBeUndefined();
    r.push(7, 10n);
    r.push(7, 20n);
    expect(r.mean(7, 3)).toBeUndefined(); // only 2 samples
    r.push(7, 30n);
    expect(r.mean(7, 3)).toBe(20n); // (10+20+30)/3
    r.push(7, 60n); // window slides to [20,30,60]
    expect(r.mean(7, 3)).toBe(36n); // (20+30+60)/3
    expect(r.count(7)).toBe(3);
  });

  it("keeps a separate window per market", () => {
    const r = new RollingMeans(2);
    r.push(1, 100n);
    r.push(2, 200n);
    expect(r.count(1)).toBe(1);
    expect(r.count(2)).toBe(1);
  });
});

describe("directionalTarget", () => {
  const mean = 1000n;
  const maxPos = 50n;
  const bps = 100; // ±1% band → [990, 1010]

  it("momentum (sign +1) trades WITH the move", () => {
    expect(directionalTarget(1020n, mean, bps, maxPos, 1)).toBe(50n); // above band → long
    expect(directionalTarget(980n, mean, bps, maxPos, 1)).toBe(-50n); // below → short
    expect(directionalTarget(1005n, mean, bps, maxPos, 1)).toBe(0n); // in band → flat
  });

  it("mean-reversion (sign -1) FADES the move", () => {
    expect(directionalTarget(1020n, mean, bps, maxPos, -1)).toBe(-50n); // above → short
    expect(directionalTarget(980n, mean, bps, maxPos, -1)).toBe(50n); // below → long
    expect(directionalTarget(1005n, mean, bps, maxPos, -1)).toBe(0n);
  });
});

describe("bookMid", () => {
  it("is the mid of the top of book", () => {
    expect(bookMid(book(100n, 102n))).toBe(101n);
  });
  it("is undefined when the book is one-sided", () => {
    expect(bookMid(book(undefined, 102n))).toBeUndefined();
    expect(bookMid(book(100n, undefined))).toBeUndefined();
  });
});

describe("stepToward", () => {
  it("buys at the ask toward a higher target (no reduce-only from flat)", async () => {
    const { ctx, calls } = fakeCtx();
    const acted = await stepToward(ctx, 7, 0n, 50n, 20n, 50n, book(100n, 102n));
    expect(acted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ market: 7, side: Side.Buy, price: 102n, quantity: 20n, reduceOnly: false });
  });

  it("sells at the bid toward a lower target", async () => {
    const { ctx, calls } = fakeCtx();
    await stepToward(ctx, 7, 0n, -50n, 20n, 50n, book(100n, 102n));
    expect(calls[0]).toMatchObject({ side: Side.Sell, price: 100n, quantity: 20n });
  });

  it("steps by at most orderQty", async () => {
    const { ctx, calls } = fakeCtx();
    await stepToward(ctx, 7, 0n, 50n, 20n, 50n, book(100n, 102n));
    expect(calls[0]!.quantity).toBe(20n); // delta 50 capped to the 20 step
  });

  it("clamps the target to ±maxPos", async () => {
    const { ctx, calls } = fakeCtx();
    await stepToward(ctx, 7, 0n, 999n, 5n, 50n, book(100n, 102n)); // target → 50, step 5
    expect(calls[0]!.quantity).toBe(5n);
  });

  it("sets reduce-only when reducing a long", async () => {
    const { ctx, calls } = fakeCtx();
    await stepToward(ctx, 7, 30n, 0n, 20n, 50n, book(100n, 102n));
    expect(calls[0]).toMatchObject({ side: Side.Sell, reduceOnly: true });
  });

  it("sets reduce-only when reducing a short", async () => {
    const { ctx, calls } = fakeCtx();
    await stepToward(ctx, 7, -30n, 0n, 20n, 50n, book(100n, 102n));
    expect(calls[0]).toMatchObject({ side: Side.Buy, reduceOnly: true });
  });

  it("does nothing when already at target", async () => {
    const { ctx, calls } = fakeCtx();
    const acted = await stepToward(ctx, 7, 50n, 50n, 20n, 50n, book(100n, 102n));
    expect(acted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does nothing when the needed side of the book is empty", async () => {
    const { ctx, calls } = fakeCtx();
    const acted = await stepToward(ctx, 7, 0n, 50n, 20n, 50n, book(100n, undefined));
    expect(acted).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
