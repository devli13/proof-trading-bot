import { describe, it, expect } from "vitest";
import { QuoteThrottle } from "./quote-throttle.js";

describe("QuoteThrottle", () => {
  const TOL = 8; // bps
  const FORCE = 30_000;

  it("always re-quotes a market it has never seen", () => {
    const q = new QuoteThrottle();
    expect(q.shouldRequote(7, 100n, 102n, 0n, 1000, TOL, FORCE)).toBe(true);
  });

  it("holds when quotes + inventory are unchanged within tolerance", () => {
    const q = new QuoteThrottle();
    q.record(7, 100_000n, 102_000n, 0n, 1000);
    // tiny move (< 8bps of 100_000 = 80) → hold
    expect(q.shouldRequote(7, 100_050n, 102_050n, 0n, 2000, TOL, FORCE)).toBe(false);
  });

  it("re-quotes when a quote moves beyond tolerance", () => {
    const q = new QuoteThrottle();
    q.record(7, 100_000n, 102_000n, 0n, 1000);
    // bid moves 200 (> 80 tol) → re-quote
    expect(q.shouldRequote(7, 100_200n, 102_000n, 0n, 2000, TOL, FORCE)).toBe(true);
  });

  it("re-quotes when inventory changed (a fill shifts skew/gates)", () => {
    const q = new QuoteThrottle();
    q.record(7, 100_000n, 102_000n, 0n, 1000);
    expect(q.shouldRequote(7, 100_000n, 102_000n, 10n, 2000, TOL, FORCE)).toBe(true);
  });

  it("force-refreshes after the staleness window even if unchanged", () => {
    const q = new QuoteThrottle();
    q.record(7, 100_000n, 102_000n, 0n, 1000);
    expect(q.shouldRequote(7, 100_000n, 102_000n, 0n, 1000 + FORCE, TOL, FORCE)).toBe(true);
  });

  it("re-quotes when a side appears or disappears", () => {
    const q = new QuoteThrottle();
    q.record(7, 100_000n, undefined, 0n, 1000); // was bid-only (at cap)
    expect(q.shouldRequote(7, 100_000n, 102_000n, 0n, 2000, TOL, FORCE)).toBe(true); // ask appeared
  });
});
