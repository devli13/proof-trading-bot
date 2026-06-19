import { describe, it, expect } from "vitest";
import { lerp, niceRange } from "../public/livechart.js";

describe("lerp", () => {
  it("interpolates", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(-4, 4, 0.25)).toBe(-2);
  });
});

describe("niceRange", () => {
  it("pads a range and never returns zero height", () => {
    const [lo, hi] = niceRange(0, 10);
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(10);
    const [a, b] = niceRange(5, 5);
    expect(a).toBeLessThan(5);
    expect(b).toBeGreaterThan(5);
  });
  it("falls back on non-finite input", () => {
    expect(niceRange(Infinity, -Infinity)).toEqual([-0.5, 0.5]);
  });
});
