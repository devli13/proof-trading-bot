import { describe, it, expect } from "vitest";
import type { PositionInfo } from "@proof/trading-sdk";
import { computeQuotes, signedSize } from "./market-maker.js";

const P = { spreadBps: 100, orderQty: 10n, maxPosition: 100n };

describe("computeQuotes", () => {
  it("symmetric around mid at zero inventory", () => {
    const q = computeQuotes(1_000_000n, 0n, P); // half = 1e6*100/20000 = 5000
    expect(q.bid?.price).toBe(995_000n);
    expect(q.ask?.price).toBe(1_005_000n);
    expect(q.bid?.qty).toBe(10n);
  });
  it("skews both quotes down when long", () => {
    const q = computeQuotes(1_000_000n, 50n, P); // skew = 1e6*100/40000 = 2500
    expect(q.bid?.price).toBe(992_500n);
    expect(q.ask?.price).toBe(1_002_500n);
  });
  it("suppresses the bid at max long position", () => {
    const q = computeQuotes(1_000_000n, 100n, P);
    expect(q.bid).toBeUndefined();
    expect(q.ask).toBeDefined();
  });
  it("suppresses the ask at max short position", () => {
    const q = computeQuotes(1_000_000n, -100n, P);
    expect(q.ask).toBeUndefined();
    expect(q.bid).toBeDefined();
  });
  it("returns nothing for a degenerate mid", () => {
    expect(computeQuotes(0n, 0n, P)).toEqual({});
  });
});

describe("signedSize", () => {
  it("signs long positive / short negative", () => {
    expect(signedSize({ side: "Buy", size: 5n } as PositionInfo)).toBe(5n);
    expect(signedSize({ side: "Sell", size: 5n } as PositionInfo)).toBe(-5n);
    expect(signedSize(undefined)).toBe(0n);
  });
});
