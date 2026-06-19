/**
 * Pure, side-effect-free core of the multi-bot stats endpoint — extracted from
 * api/stats.ts so it is unit-testable. Takes raw DB rows and produces the per-bot
 * breakdown + aggregate the dashboard consumes. NEVER touches private keys.
 */

/** Chart timeframe windows for the equity series (?range=). */
export const RANGES: Record<string, { interval: string | null; bucket: string }> = {
  "1h": { interval: "1 hour", bucket: "minute" },
  "1d": { interval: "24 hours", bucket: "minute" },
  "7d": { interval: "7 days", bucket: "hour" },
  "30d": { interval: "30 days", bucket: "hour" },
  all: { interval: null, bucket: "hour" },
};

/** Resolve a ?range value to its window config (defaults to 1d). Uses hasOwnProperty
 *  (not `in`) so prototype keys like "toString"/"constructor" fall back to 1d. */
export function rangeConfig(range: unknown): { key: string; interval: string | null; bucket: string } {
  const key = typeof range === "string" && Object.prototype.hasOwnProperty.call(RANGES, range) ? range : "1d";
  const cfg = RANGES[key] ?? { interval: "24 hours", bucket: "minute" };
  return { key, interval: cfg.interval, bucket: cfg.bucket };
}

export const STRATEGY_LOGIC: Record<string, string> = {
  "market-maker":
    "Quotes a post-only bid+ask around mid (±MM_SPREAD_BPS/2), inventory-skewed; suppresses the side that grows |position| past the cap. Earns the spread; market-neutral.",
  "parity-arb":
    "Captures EBY+EBN ≠ $1 dislocations with a 2-leg atomic FOK basket (past fees + a VOID safety margin). Inventory-capped so it can't drift. Near market-neutral.",
  momentum:
    "Enters with the short-term trend (mid vs a rolling mean) and exits on reversal. Directional; small, position-capped.",
  "mean-reversion":
    "Fades deviations from a rolling mean — buys dips, sells rips. Directional; position-capped.",
  "funding-harvest":
    "Holds the side that RECEIVES funding and flattens when funding flips. Carry strategy.",
  "conditional-basket":
    "Expresses a directional view across the 3 conditional legs (base vs p·CPY+(1−p)·CPN) as one atomic basket.",
  "max-profit":
    "Opportunistic: each tick takes the highest-EV of {parity, funding, momentum} with looser thresholds + bigger size. Aggressive, kill-switched.",
  "volume-driver":
    "Maximizes turnover/volatility on a stale book — opens real positions and unwinds when sensible (not wash trades). Loss-capped; devnet-only.",
};

export const num = (v: unknown): number => (v == null ? 0 : Number(v));

export function parseMarkets(m: unknown): number[] | "all" {
  if (m === "all" || m == null) return "all";
  if (Array.isArray(m)) return m.map(Number);
  if (typeof m === "string") {
    try {
      return parseMarkets(JSON.parse(m));
    } catch {
      return "all";
    }
  }
  return "all";
}

export function parsePositions(p: unknown): unknown[] {
  if (Array.isArray(p)) return p;
  if (typeof p === "string") {
    try {
      const x = JSON.parse(p);
      return Array.isArray(x) ? x : [];
    } catch {
      return [];
    }
  }
  return [];
}

export interface RegistryRow { id: string; strategies?: string[]; markets?: unknown; tags?: string[]; enabled?: boolean }
export interface SnapshotRow { bot: string; equity?: unknown; balance?: unknown; positions?: unknown; ts: string }
export interface VolRow { bot: string; trades?: unknown; volume_micro?: unknown; last_trade?: string | null }
export interface SeriesRow { bot: string; m: string; equity?: unknown }

export interface BotStat {
  bot: string;
  strategies: string[];
  tags: string[];
  markets: number[] | "all";
  enabled: boolean | null;
  pnl: number | null;
  equity: number | null;
  balance: number | null;
  volume: number;
  trades: number;
  positions: unknown[];
  lastTick: string | null;
  lastTrade: string | null;
  series: Array<{ ts: string; equity: number }>;
}

/** Build the per-bot breakdown from the raw query rows. Pure. */
export function computeBots(registry: RegistryRow[], latest: SnapshotRow[], vol: VolRow[], series: SeriesRow[]): BotStat[] {
  const seriesByBot = new Map<string, Array<{ ts: string; equity: number }>>();
  for (const r of series) {
    if (!seriesByBot.has(r.bot)) seriesByBot.set(r.bot, []);
    seriesByBot.get(r.bot)!.push({ ts: r.m, equity: num(r.equity) });
  }
  const latestByBot = new Map(latest.map((r) => [r.bot, r]));
  const volByBot = new Map(vol.map((r) => [r.bot, r]));
  const regById = new Map(registry.map((r) => [r.id, r]));
  const botIds = new Set<string>([...registry.map((r) => r.id), ...latest.map((r) => r.bot), ...vol.map((r) => r.bot)]);

  return Array.from(botIds).map((id) => {
    const reg = regById.get(id);
    const snap = latestByBot.get(id);
    const v = volByBot.get(id);
    const s = seriesByBot.get(id) ?? [];
    // series is already filtered to equity > 0 and ordered asc, so the oldest point
    // is the right PnL baseline (works for any starting balance).
    const startEq = s[0]?.equity ?? null;
    const curEq = snap ? num(snap.equity) : (s.at(-1)?.equity ?? null);
    return {
      bot: id,
      strategies: reg?.strategies ?? [],
      tags: reg?.tags ?? [],
      markets: parseMarkets(reg?.markets),
      enabled: reg ? (reg.enabled ?? null) : null,
      pnl: startEq != null && curEq != null ? curEq - startEq : null,
      equity: curEq,
      balance: snap ? num(snap.balance) : null,
      volume: v ? num(v.volume_micro) : 0,
      trades: v ? num(v.trades) : 0,
      positions: snap ? parsePositions(snap.positions) : [],
      lastTick: snap ? snap.ts : null,
      lastTrade: v?.last_trade ?? null,
      series: s,
    };
  });
}

/** Fleet totals. "active" = registry-enabled bots only (enabled === true). */
export function computeAggregate(bots: BotStat[]): { bots: number; activeBots: number; pnl: number; equity: number; volume: number; trades: number } {
  return {
    bots: bots.length,
    activeBots: bots.filter((b) => b.enabled === true).length,
    pnl: bots.reduce((a, b) => a + (b.pnl ?? 0), 0),
    equity: bots.reduce((a, b) => a + (b.equity ?? 0), 0),
    volume: bots.reduce((a, b) => a + b.volume, 0),
    trades: bots.reduce((a, b) => a + b.trades, 0),
  };
}

/** Most-recent snapshot across the whole fleet (NOT latest[0], which is alphabetical). */
export function pickAsOf(latest: SnapshotRow[]): string | null {
  return latest.reduce<string | null>((m, r) => (m == null || r.ts > m ? r.ts : m), null);
}
