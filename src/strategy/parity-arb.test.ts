import { describe, it, expect } from "vitest";
import { arbBlockedByCap } from "./parity-arb.js";

const cap = 500n;

describe("arbBlockedByCap (inventory cap)", () => {
  it("allows a buy when below the long cap (incl. reducing a short)", () => {
    expect(arbBlockedByCap("Buy", 0n, 0n, cap)).toBe(false);
    expect(arbBlockedByCap("Buy", -700n, -700n, cap)).toBe(false); // short → buy reduces
    expect(arbBlockedByCap("Buy", 400n, 0n, cap)).toBe(false);
  });

  it("blocks a buy at/over the long cap on either leg", () => {
    expect(arbBlockedByCap("Buy", 500n, 0n, cap)).toBe(true);
    expect(arbBlockedByCap("Buy", 0n, 600n, cap)).toBe(true);
  });

  it("allows a sell when above the short cap (incl. reducing a long)", () => {
    expect(arbBlockedByCap("Sell", 0n, 0n, cap)).toBe(false);
    expect(arbBlockedByCap("Sell", 700n, 700n, cap)).toBe(false); // long → sell reduces
  });

  it("blocks a sell at/over the short cap on either leg", () => {
    expect(arbBlockedByCap("Sell", -500n, 0n, cap)).toBe(true);
    expect(arbBlockedByCap("Sell", 0n, -700n, cap)).toBe(true);
  });

  it("no cap when set to 0", () => {
    expect(arbBlockedByCap("Buy", 9999n, 9999n, 0n)).toBe(false);
  });
});
