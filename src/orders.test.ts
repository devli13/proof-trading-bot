import { describe, it, expect } from "vitest";
import { snapPrice, snapQty } from "./orders.js";

describe("snapQty (lot gating)", () => {
  it("floors to the nearest lot", () => {
    expect(snapQty(250n, 100n)).toBe(200n);
    expect(snapQty(100n, 100n)).toBe(100n);
    expect(snapQty(99n, 100n)).toBe(0n); // below one lot
  });
  it("no gate when lotSize is 0", () => {
    expect(snapQty(5n, 0n)).toBe(5n);
  });
  it("clamps negatives to 0", () => {
    expect(snapQty(-5n, 100n)).toBe(0n);
  });
});

describe("snapPrice (tick gating, side-aware)", () => {
  it("floors a buy, ceils a sell", () => {
    expect(snapPrice(470123n, 100n, "Buy")).toBe(470100n);
    expect(snapPrice(470123n, 100n, "Sell")).toBe(470200n);
  });
  it("integer tick leaves integer prices unchanged", () => {
    expect(snapPrice(470123n, 1n, "Buy")).toBe(470123n);
    expect(snapPrice(470123n, 1n, "Sell")).toBe(470123n);
  });
  it("no gate when tickSize is 0", () => {
    expect(snapPrice(470123n, 0n, "Buy")).toBe(470123n);
  });
});
