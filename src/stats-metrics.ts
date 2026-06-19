/**
 * Pure, unit-testable per-bot metric math. Series-derived stats (win rate, max
 * drawdown, Sharpe) reuse the SAME windowed equity series the chart/PnL use, so the
 * numbers stay consistent with the headline PnL. Order-derived stats (avg trade size,
 * throughput, maker/taker, reject rate, net flow) arrive as pre-aggregated SQL rows
 * (MetricsRow) and are merged in stats-core. No DB, no side effects.
 */

export interface SeriesPoint {
  ts: string;
  equity: number;
}

export interface SeriesMetrics {
  winRate: number | null; // 0..1 share of up-ticks
  maxDrawdown: number | null; // micro-USDC, <= 0 (worst peak-to-trough dip)
  sharpe: number | null; // unitless per-tick mean/stddev of returns
}

/** Per-bot SQL aggregate over bot_orders (the "real-order predicate" applied upstream). */
export interface MetricsRow {
  bot: string;
  avg_trade_micro?: unknown;
  last_hour_trades?: unknown;
  span_hours?: unknown;
  trades_window?: unknown;
  maker_pct?: unknown; // 0..1 (inferred: market-maker orders = maker, else taker)
  reject_rate?: unknown; // 0..1 (check_tx_code != 0)
  net_flow_micro?: unknown; // signed, +buy / -sell notional
}

const numOr = (v: unknown, d = 0): number => {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function seriesMetrics(s: SeriesPoint[]): SeriesMetrics {
  const n = s.length;

  // win rate — share of consecutive steps where equity strictly rose
  let ups = 0;
  let steps = 0;
  for (let i = 1; i < n; i++) {
    steps++;
    if (s[i]!.equity > s[i - 1]!.equity) ups++;
  }
  const winRate = steps >= 1 ? ups / steps : null;

  // max drawdown — worst (equity - running peak)
  let peak = -Infinity;
  let mdd = 0;
  for (const p of s) {
    if (p.equity > peak) peak = p.equity;
    mdd = Math.min(mdd, p.equity - peak);
  }
  const maxDrawdown = n >= 2 ? mdd : null;

  // Sharpe-ish — mean/stddev of per-tick simple returns (no annualization)
  const rets: number[] = [];
  for (let i = 1; i < n; i++) {
    const prev = s[i - 1]!.equity;
    if (prev > 0) rets.push((s[i]!.equity - prev) / prev);
  }
  let sharpe: number | null = null;
  if (rets.length >= 2) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    const sd = Math.sqrt(variance);
    sharpe = sd > 0 ? mean / sd : null;
  }

  return { winRate, maxDrawdown, sharpe };
}

/** Σ |size|·entryPrice over open positions — magnitude of capital currently at risk. */
export function inventoryNotional(positions: unknown[]): number {
  let sum = 0;
  for (const p of positions as Array<{ size?: unknown; entryPrice?: unknown }>) {
    const size = Math.abs(numOr(p?.size));
    const entry = numOr(p?.entryPrice);
    sum += size * entry;
  }
  return sum;
}

/** Trades per hour over the observed activity span (needs ≥2 trades to be a rate). */
export function tradesPerHour(trades: number, spanHours: number | null): number | null {
  if (!trades || trades < 2 || spanHours == null) return null;
  return trades / Math.max(spanHours, 1 / 60); // floor span at 1 min so a burst isn't ∞
}

export interface BotMetrics {
  avgTradeSize: number | null;
  tradesPerHour: number | null;
  lastHourTrades: number;
  makerPct: number | null;
  takerPct: number | null;
  rejectRate: number | null;
  winRate: number | null;
  maxDrawdown: number | null;
  pnlPerTrade: number | null;
  netFlow: number | null;
  sharpe: number | null;
  inventory: number | null;
}

/** Merge a SQL MetricsRow + the series block + pnl/positions into the BotMetrics surface. */
export function buildMetrics(
  row: MetricsRow | undefined,
  series: SeriesPoint[],
  pnl: number | null,
  positions: unknown[],
): BotMetrics {
  const sm = seriesMetrics(series);
  const tradesWindow = numOr(row?.trades_window);
  const hasOrders = tradesWindow > 0;
  return {
    avgTradeSize: hasOrders ? numOr(row?.avg_trade_micro) : null,
    tradesPerHour: tradesPerHour(tradesWindow, row?.span_hours == null ? null : numOr(row?.span_hours)),
    lastHourTrades: numOr(row?.last_hour_trades),
    makerPct: hasOrders ? numOr(row?.maker_pct) : null,
    takerPct: hasOrders ? 1 - numOr(row?.maker_pct) : null,
    rejectRate: hasOrders ? numOr(row?.reject_rate) : null,
    winRate: sm.winRate,
    maxDrawdown: sm.maxDrawdown,
    pnlPerTrade: hasOrders && pnl != null ? pnl / tradesWindow : null,
    netFlow: row ? numOr(row.net_flow_micro) : null,
    sharpe: sm.sharpe,
    inventory: inventoryNotional(positions),
  };
}
