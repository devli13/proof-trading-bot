import { describe, it, expect } from "vitest";
import {
  esc,
  mkt,
  usd,
  pnlStr,
  sign,
  relTime,
  dotClass,
  dim,
  withGaps,
  botMatches,
  filteredSorted,
  buildDatasets,
  recomputePillLevel,
} from "../lib/dashboard-lib.js";

describe("formatting helpers", () => {
  it("usd / pnlStr format micro-USDC with sign discipline", () => {
    expect(usd(10000500)).toBe("$10.00");
    expect(usd(-2500000)).toBe("-$2.50");
    expect(usd(null)).toBe("—");
    expect(pnlStr(500000)).toBe("+$0.50");
    expect(pnlStr(-500000)).toBe("-$0.50");
    expect(pnlStr(0)).toBe("$0.00");
    expect(pnlStr(null)).toBe("—");
  });
  it("sign → css class", () => {
    expect(sign(5)).toBe("pos");
    expect(sign(-5)).toBe("neg");
    expect(sign(0)).toBe("");
    expect(sign(null)).toBe("");
  });
  it("esc escapes HTML (XSS guard)", () => {
    expect(esc('<img src=x onerror=alert(1)>')).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(esc('a&b"c\'')).toBe("a&amp;b&quot;c&#39;");
  });
  it("mkt maps known market ids, falls back to m<id>", () => {
    expect(mkt(7)).toBe("HYPE");
    expect(mkt(20302)).toBe("HYPE-EBY");
    expect(mkt(203)).toBe("HYPE #203");
    expect(mkt(99)).toBe("m99");
  });
  it("dim appends an alpha hex", () => {
    expect(dim("#7aa2ff", 0.12)).toBe("#7aa2ff1f");
  });
});

describe("relTime (injectable now)", () => {
  const now = Date.parse("2026-06-19T01:00:00Z");
  const at = (sAgo: number) => new Date(now - sAgo * 1000).toISOString();
  it("buckets ages", () => {
    expect(relTime(null, now)).toBe("—");
    expect(relTime(at(3), now)).toBe("just now");
    expect(relTime(at(42), now)).toBe("42s ago");
    expect(relTime(at(125), now)).toBe("2m ago");
    expect(relTime(at(3 * 3600), now)).toBe("3h ago");
    expect(relTime(at(2 * 86400), now)).toBe("2d ago");
    expect(relTime(at(-5), now)).toBe("just now"); // future / clock skew
  });
});

describe("dotClass (liveness)", () => {
  const now = Date.parse("2026-06-19T01:00:00Z");
  it("alive only when registry-enabled AND ticked recently", () => {
    expect(dotClass({ enabled: true, lastTick: new Date(now - 3000).toISOString() }, now)).toBe("alive");
    expect(dotClass({ enabled: true, lastTick: new Date(now - 60000).toISOString() }, now)).toBe("stale");
    expect(dotClass({ enabled: false, lastTick: new Date(now - 1000).toISOString() }, now)).toBe("off");
    expect(dotClass({ enabled: null, lastTick: new Date(now - 1000).toISOString() }, now)).toBe("off");
  });
});

describe("botMatches", () => {
  const b = { bot: "mm", enabled: true, strategies: ["market-maker"], tags: ["mm"], markets: [203] };
  it("scope active hides non-enabled", () => {
    expect(botMatches({ ...b, enabled: false }, { scope: "active", strategy: "all", tag: "all", market: "all" })).toBe(false);
    expect(botMatches({ ...b, enabled: false }, { scope: "all", strategy: "all", tag: "all", market: "all" })).toBe(true);
  });
  it("filters by strategy / tag / market", () => {
    expect(botMatches(b, { scope: "all", strategy: "momentum", tag: "all", market: "all" })).toBe(false);
    expect(botMatches(b, { scope: "all", strategy: "market-maker", tag: "all", market: "all" })).toBe(true);
    expect(botMatches(b, { scope: "all", strategy: "all", tag: "mm", market: "all" })).toBe(true);
    expect(botMatches(b, { scope: "all", strategy: "all", tag: "all", market: "203" })).toBe(true);
    expect(botMatches(b, { scope: "all", strategy: "all", tag: "all", market: "999" })).toBe(false);
    expect(botMatches({ ...b, markets: "all" }, { scope: "all", strategy: "all", tag: "all", market: "999" })).toBe(true);
  });
});

describe("filteredSorted", () => {
  const F = { scope: "all", strategy: "all", tag: "all", market: "all" } as const;
  const bots = [
    { bot: "a", enabled: true, pnl: 10 },
    { bot: "b", enabled: true, pnl: 30 },
    { bot: "c", enabled: true, pnl: 20 },
  ];
  it("sorts by key + direction; ties broken by bot id", () => {
    expect(filteredSorted(bots, F, "pnl", -1).map((b: { bot: string }) => b.bot)).toEqual(["b", "c", "a"]);
    expect(filteredSorted(bots, F, "pnl", 1).map((b: { bot: string }) => b.bot)).toEqual(["a", "c", "b"]);
    expect(filteredSorted(bots, F, "bot", 1).map((b: { bot: string }) => b.bot)).toEqual(["a", "b", "c"]);
  });
});

describe("buildDatasets", () => {
  const F = { scope: "all", strategy: "all", tag: "all", market: "all" } as const;
  const COLOR = { a: "#111111" };
  const bots = [
    { bot: "a", enabled: true, series: [{ ts: "2026-06-19T00:00:00Z", equity: 1000000 }, { ts: "2026-06-19T00:01:00Z", equity: 1500000 }] },
    { bot: "thin", enabled: true, series: [{ ts: "2026-06-19T00:00:00Z", equity: 1000000 }] }, // <2 pts → excluded
  ];
  it("excludes bots with <2 points; PnL normalizes to first point", () => {
    const ds = buildDatasets(bots, F, "pnl", COLOR);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.botId).toBe("a");
    expect(ds[0]!.data[0]!.y).toBe(0); // first point baseline
    expect(ds[0]!.data[1]!.y).toBeCloseTo(0.5); // (1.5 - 1.0)
    expect(ds[0]!.borderColor).toBe("#111111");
  });
  it("equity mode uses absolute equity", () => {
    const ds = buildDatasets(bots, F, "equity", COLOR);
    expect(ds[0]!.data[1]!.y).toBeCloseTo(1.5);
  });
});

describe("withGaps", () => {
  it("inserts a null point across a >5min gap", () => {
    const pts = [{ x: 0, y: 1 }, { x: 4 * 60000, y: 2 }, { x: 20 * 60000, y: 3 }];
    const out = withGaps(pts);
    expect(out).toHaveLength(4); // one null inserted before the 16-min jump
    expect(out.some((p) => p.y === null)).toBe(true);
  });
});

describe("recomputePillLevel", () => {
  it("green only when fresh + both endpoints up", () => {
    expect(recomputePillLevel(true, true, 5000)).toBe("green");
    expect(recomputePillLevel(true, true, 60000)).toBe("yellow"); // stale-ish
    expect(recomputePillLevel(true, false, 5000)).toBe("yellow"); // status down
    expect(recomputePillLevel(false, true, 5000)).toBe("red"); // stats down
    expect(recomputePillLevel(true, true, 200000)).toBe("red"); // very stale
  });
});
