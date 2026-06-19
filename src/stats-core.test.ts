import { describe, it, expect } from "vitest";
import {
  rangeConfig,
  parseMarkets,
  parsePositions,
  computeBots,
  computeAggregate,
  pickAsOf,
  RANGES,
  STRATEGY_LOGIC,
  type RegistryRow,
  type SnapshotRow,
  type VolRow,
  type SeriesRow,
} from "./stats-core.js";

describe("rangeConfig", () => {
  it("defaults to 1d for missing / invalid", () => {
    expect(rangeConfig(undefined).key).toBe("1d");
    expect(rangeConfig("nonsense").key).toBe("1d");
    expect(rangeConfig(7 as unknown).key).toBe("1d");
  });
  it("resolves each valid range to its window + bin", () => {
    expect(rangeConfig("1h")).toEqual({ key: "1h", interval: "1 hour", bin: "1 minute" });
    expect(rangeConfig("7d")).toEqual({ key: "7d", interval: "7 days", bin: "30 minutes" });
    expect(rangeConfig("all")).toEqual({ key: "all", interval: null, bin: "1 hour" });
  });
  it("rejects prototype-chain keys (hasOwnProperty, not `in`)", () => {
    // "toString"/"constructor" are inherited — must fall back to 1d, not crash.
    expect(rangeConfig("toString").key).toBe("1d");
    expect(rangeConfig("constructor").key).toBe("1d");
    expect(rangeConfig("__proto__").key).toBe("1d");
  });
  it("every RANGES key round-trips", () => {
    for (const k of Object.keys(RANGES)) expect(rangeConfig(k).key).toBe(k);
  });
});

describe("parseMarkets", () => {
  it('returns "all" for null/undefined/"all"/garbage', () => {
    expect(parseMarkets(null)).toBe("all");
    expect(parseMarkets(undefined)).toBe("all");
    expect(parseMarkets("all")).toBe("all");
    expect(parseMarkets({})).toBe("all");
    expect(parseMarkets("not json")).toBe("all");
  });
  it("parses arrays and JSON-string arrays to number[]", () => {
    expect(parseMarkets([203, 7])).toEqual([203, 7]);
    expect(parseMarkets("[203,7]")).toEqual([203, 7]);
    expect(parseMarkets('"all"')).toBe("all");
  });
});

describe("parsePositions", () => {
  it("passes arrays through, parses JSON strings, else []", () => {
    expect(parsePositions([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(parsePositions('[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(parsePositions("{}")).toEqual([]);
    expect(parsePositions(null)).toEqual([]);
    expect(parsePositions("bad")).toEqual([]);
  });
});

describe("computeBots", () => {
  const registry: RegistryRow[] = [
    { id: "mm", strategies: ["market-maker"], markets: [203], tags: ["mm"], enabled: true },
    { id: "off", strategies: ["parity-arb"], markets: "all", tags: [], enabled: false },
  ];
  const latest: SnapshotRow[] = [
    { bot: "mm", equity: "10000500", balance: "10000000", positions: "[]", ts: "2026-06-19T01:00:10Z" },
    { bot: "off", equity: "9999000", balance: "9999000", positions: [], ts: "2026-06-18T18:00:00Z" },
  ];
  const vol: VolRow[] = [
    { bot: "mm", trades: 34, volume_micro: "230000000", last_trade: "2026-06-19T01:00:09Z" },
  ];
  const series: SeriesRow[] = [
    { bot: "mm", m: "2026-06-19T00:00:00Z", equity: "10000000" },
    { bot: "mm", m: "2026-06-19T01:00:00Z", equity: "10000500" },
  ];

  it("unions bot ids across registry, snapshots, and volume", () => {
    const bots = computeBots(registry, latest, vol, series);
    expect(bots.map((b) => b.bot).sort()).toEqual(["mm", "off"]);
  });

  it("computes PnL as latest equity minus the oldest series point", () => {
    const mm = computeBots(registry, latest, vol, series).find((b) => b.bot === "mm")!;
    expect(mm.pnl).toBe(500); // 10000500 - 10000000
    expect(mm.equity).toBe(10000500);
    expect(mm.balance).toBe(10000000);
    expect(mm.volume).toBe(230000000);
    expect(mm.trades).toBe(34);
    expect(mm.lastTrade).toBe("2026-06-19T01:00:09Z");
    expect(mm.lastTick).toBe("2026-06-19T01:00:10Z");
    expect(mm.series).toHaveLength(2);
  });

  it("null PnL/volume/lastTrade for a bot with no series/trades", () => {
    const off = computeBots(registry, latest, vol, series).find((b) => b.bot === "off")!;
    expect(off.pnl).toBeNull(); // no series → no baseline
    expect(off.volume).toBe(0);
    expect(off.trades).toBe(0);
    expect(off.lastTrade).toBeNull();
    expect(off.enabled).toBe(false);
    expect(off.markets).toBe("all");
  });

  it("enabled is null for a bot present in data but absent from the registry", () => {
    const orphan = computeBots([], latest, vol, series).find((b) => b.bot === "mm")!;
    expect(orphan.enabled).toBeNull();
    expect(orphan.strategies).toEqual([]);
  });
});

describe("computeAggregate", () => {
  it("counts only enabled===true as active; sums pnl/equity/volume/trades", () => {
    const bots = computeBots(
      [
        { id: "a", strategies: [], markets: [], tags: [], enabled: true },
        { id: "b", strategies: [], markets: [], tags: [], enabled: false },
        { id: "c", strategies: [], markets: [], tags: [], enabled: undefined }, // null-ish
      ],
      [
        { bot: "a", equity: "100", balance: "0", positions: [], ts: "2026-06-19T01:00:00Z" },
        { bot: "b", equity: "200", balance: "0", positions: [], ts: "2026-06-19T01:00:00Z" },
      ],
      [{ bot: "a", trades: 3, volume_micro: "50", last_trade: "2026-06-19T01:00:00Z" }],
      [],
    );
    const agg = computeAggregate(bots);
    expect(agg.bots).toBe(3);
    expect(agg.activeBots).toBe(1); // only "a"
    expect(agg.equity).toBe(300);
    expect(agg.volume).toBe(50);
    expect(agg.trades).toBe(3);
  });
});

describe("pickAsOf", () => {
  it("returns the MAX ts across the fleet (not the first/alphabetical row)", () => {
    expect(
      pickAsOf([
        { bot: "arb-binary", equity: "1", balance: "1", positions: [], ts: "2026-06-18T18:00:00Z" },
        { bot: "mm-hype", equity: "1", balance: "1", positions: [], ts: "2026-06-19T01:00:10Z" },
      ]),
    ).toBe("2026-06-19T01:00:10Z");
  });
  it("null for an empty fleet", () => {
    expect(pickAsOf([])).toBeNull();
  });
});

describe("STRATEGY_LOGIC", () => {
  it("covers every strategy the registry can run", () => {
    for (const s of ["market-maker", "parity-arb", "momentum", "mean-reversion", "max-profit", "volume-driver"]) {
      expect(STRATEGY_LOGIC[s]).toBeTruthy();
    }
  });
});
