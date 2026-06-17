import { describe, it, expect } from "vitest";
import {
  formatCents,
  formatMicroUsdc,
  parseUsdcToCents,
  parseUsdcToMicro,
} from "./units";

describe("units", () => {
  it("formats microUSDC (6dp)", () => {
    expect(formatMicroUsdc(100_000_000_000n)).toBe("100,000.000000");
    expect(formatMicroUsdc(0n)).toBe("0.000000");
    expect(formatMicroUsdc(-1_500_000n)).toBe("-1.500000");
  });

  it("formats cents (2dp)", () => {
    expect(formatCents(6_675_000n)).toBe("66,750.00");
    expect(formatCents(50_000_00n)).toBe("50,000.00");
    expect(formatCents(5n)).toBe("0.05");
  });

  it("parses dollar strings into microUSDC and cents", () => {
    expect(parseUsdcToMicro("1,234.56")).toBe(1_234_560_000n);
    expect(parseUsdcToMicro("$10")).toBe(10_000_000n);
    expect(parseUsdcToCents("66,750")).toBe(6_675_000n);
    expect(parseUsdcToCents("0.05")).toBe(5n);
  });
});
