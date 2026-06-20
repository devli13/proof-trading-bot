import { describe, it, expect } from "vitest";
import {
  impliedProbBps,
  binaryParityResidual,
  conditionalParityResidual,
  nearResolution,
  normalizeStatus,
  discoverImpactEventIds,
  type EventLegs,
} from "./impact.js";
import type { MarketConfig } from "@proof/trading-sdk";

describe("normalizeStatus", () => {
  it("passes strings through and names object variants", () => {
    expect(normalizeStatus("Trading")).toBe("Trading");
    expect(normalizeStatus({ PreResolution: [1] })).toBe("PreResolution");
    expect(normalizeStatus({ Resolved: [] })).toBe("Resolved");
    expect(normalizeStatus(undefined)).toBe("Unknown");
    expect(normalizeStatus(null)).toBe("Unknown");
  });
});

describe("discoverImpactEventIds", () => {
  const m = (market: number, kind?: MarketConfig["kind"]): MarketConfig => ({ market, kind }) as MarketConfig;
  it("extracts distinct, sorted event ids from conditional/binary market kinds", () => {
    const markets = [
      m(7, "Perp"),
      m(20302, { PredictionBinary: [203, "Yes"] }),
      m(20300, { ConditionalPerp: [203, "Yes"] }),
      m(20102, { PredictionBinary: [201, "No"] }),
      m(1, "Perp"),
      m(20303, { PredictionBinary: [203, "No"] }), // dup event 203
    ];
    expect(discoverImpactEventIds(markets)).toEqual([201, 203]);
  });
  it("ignores plain perps and malformed kinds", () => {
    expect(discoverImpactEventIds([m(7, "Perp"), m(8, undefined)])).toEqual([]);
  });
});

describe("impliedProbBps", () => {
  it("computes YES probability in bps", () => {
    expect(impliedProbBps(490000n, 510000n)).toBe(4900);
    expect(impliedProbBps(500000n, 500000n)).toBe(5000);
  });
  it("null on empty book", () => {
    expect(impliedProbBps(0n, 0n)).toBeNull();
  });
});

describe("binaryParityResidual ($1 = 1_000_000)", () => {
  it("zero when the pair sums to $1", () => {
    expect(binaryParityResidual(490000n, 510000n)).toBe(0n);
  });
  it("positive when overpriced (sell both)", () => {
    expect(binaryParityResidual(495000n, 510000n)).toBe(5000n);
  });
  it("negative when underpriced (buy both)", () => {
    expect(binaryParityResidual(480000n, 510000n)).toBe(-10000n);
  });
});

describe("conditionalParityResidual", () => {
  it("zero when base equals the p-weighted synthetic", () => {
    // p=50% → synthetic = (760000+680000)/2 = 720000 = base
    expect(conditionalParityResidual(720000n, 760000n, 680000n, 5000)).toBe(0n);
  });
  it("positive when base is rich vs synthetic", () => {
    expect(conditionalParityResidual(725000n, 760000n, 680000n, 5000)).toBe(5000n);
  });
});

describe("nearResolution", () => {
  const legs: EventLegs = {
    impactId: 1, underlying: 7, cpy: 0, cpn: 0, eby: 0, ebn: 0,
    question: "", deadlineMs: 1_000_000_000_000, resolutionWindowMs: 0, status: "Trading",
  };
  it("false when far from deadline and Trading", () => {
    expect(nearResolution(legs, 1000, 999_999_000_000)).toBe(false);
  });
  it("true within the guard window", () => {
    expect(nearResolution(legs, 1000, 999_999_999_500)).toBe(true);
  });
  it("true whenever status is not Trading", () => {
    expect(nearResolution({ ...legs, status: "PreResolution" }, 1000, 0)).toBe(true);
  });
});
