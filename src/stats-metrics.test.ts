import { describe, it, expect } from "vitest";
import { seriesMetrics, inventoryNotional, tradesPerHour, buildMetrics } from "./stats-metrics.js";

const pts = (eqs: number[]) => eqs.map((equity, i) => ({ ts: `t${i}`, equity }));

describe("seriesMetrics", () => {
  it("win rate = share of up-ticks", () => {
    expect(seriesMetrics(pts([100, 101, 100, 102])).winRate).toBeCloseTo(2 / 3);
    expect(seriesMetrics(pts([100])).winRate).toBeNull();
  });
  it("max drawdown = worst peak-to-trough", () => {
    expect(seriesMetrics(pts([100, 120, 90, 130])).maxDrawdown).toBe(-30);
    expect(seriesMetrics(pts([100])).maxDrawdown).toBeNull();
  });
  it("sharpe positive for steady up, null for too-few/flat", () => {
    expect(seriesMetrics(pts([100, 110, 121, 133])).sharpe!).toBeGreaterThan(0);
    expect(seriesMetrics(pts([100, 100])).sharpe).toBeNull(); // sd=0
    expect(seriesMetrics(pts([100])).sharpe).toBeNull();
  });
});

describe("inventoryNotional", () => {
  it("sums |size|*entryPrice across positions", () => {
    expect(inventoryNotional([{ size: "2", entryPrice: "1000" }, { size: "-3", entryPrice: "500" }])).toBe(3500);
    expect(inventoryNotional([])).toBe(0);
  });
});

describe("tradesPerHour", () => {
  it("needs >=2 trades + a span", () => {
    expect(tradesPerHour(120, 1)).toBeCloseTo(120);
    expect(tradesPerHour(1, 1)).toBeNull();
    expect(tradesPerHour(50, null)).toBeNull();
    expect(tradesPerHour(10, 0)).toBeCloseTo(600); // span floored at 1 min
  });
});

describe("buildMetrics", () => {
  it("nulls order-derived stats when no trades; keeps series stats", () => {
    const m = buildMetrics(undefined, pts([100, 110]), 10, []);
    expect(m.avgTradeSize).toBeNull();
    expect(m.makerPct).toBeNull();
    expect(m.pnlPerTrade).toBeNull();
    expect(m.winRate).toBeCloseTo(1);
    expect(m.inventory).toBe(0);
  });
  it("computes maker/taker, pnl-per-trade, net flow from a row", () => {
    const m = buildMetrics(
      { bot: "x", avg_trade_micro: "250", trades_window: "4", maker_pct: "0.75", reject_rate: "0.25", net_flow_micro: "-100", span_hours: "2", last_hour_trades: "3" },
      pts([100, 90, 95]),
      -20,
      [{ size: "1", entryPrice: "100" }],
    );
    expect(m.avgTradeSize).toBe(250);
    expect(m.makerPct).toBeCloseTo(0.75);
    expect(m.takerPct).toBeCloseTo(0.25);
    expect(m.rejectRate).toBeCloseTo(0.25);
    expect(m.pnlPerTrade).toBeCloseTo(-5);
    expect(m.netFlow).toBe(-100);
    expect(m.tradesPerHour).toBeCloseTo(2);
    expect(m.lastHourTrades).toBe(3);
    expect(m.inventory).toBe(100);
  });
});
