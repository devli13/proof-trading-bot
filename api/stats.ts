import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Read-only multi-bot trading stats for the dashboard, sourced from the tracking
 * ledger + the bot registry (Supabase). Returns an aggregate plus a per-bot
 * breakdown (profit, volume, trades, equity, tags, markets) and per-bot equity
 * series. NEVER selects the private_key_enc column.
 */

const STRATEGY_LOGIC: Record<string, string> = {
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

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  const schema = process.env.DB_SCHEMA || "proof_bot";
  if (!url) {
    res.status(503).json({ ok: false, error: "tracking not configured" });
    return;
  }
  try {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, {
      max: 1,
      prepare: false,
      idle_timeout: 5,
      connect_timeout: 10,
      onnotice: () => {},
    });
    const t = (name: string) => sql`${sql(schema)}.${sql(name)}`;

    // Registry (NO keys). Tolerate the table not existing yet.
    let registry: Array<Record<string, unknown>> = [];
    try {
      registry = await sql`select id, strategies, markets, tags, enabled from ${t("bots")} order by id`;
    } catch {
      registry = [];
    }

    // Latest snapshot per bot (equity / balance / positions).
    const latest = await sql`select distinct on (bot) bot, equity, balance, positions, ts
      from ${t("bot_snapshots")} order by bot, ts desc`;

    // Volume (Σ price·qty/100, micro-USDC notional) + trade count per bot.
    const vol = await sql`select bot,
        count(*)::int as trades,
        coalesce(sum((price::numeric) * (quantity::numeric) / 100), 0)::text as volume_micro
      from ${t("bot_orders")}
      where (note is null or note <> 'dry-run') and strategy <> 'audit-prep'
      group by bot`;

    // Minute-bucketed equity series per bot (bounded points for the chart).
    const series = await sql`select bot, date_trunc('minute', ts) as m,
        (array_agg(equity order by ts desc))[1] as equity
      from ${t("bot_snapshots")}
      where ts > now() - interval '24 hours' and equity::numeric > 0
      group by bot, m order by m asc`;

    // Strategy-tagged decision activity + recent orders.
    const decisions = await sql`select bot, strategy, action, count(*)::int as c, max(ts) as last
      from ${t("bot_decisions")} where ts > now() - interval '24 hours'
      group by bot, strategy, action order by c desc limit 200`;
    const recent = await sql`select bot, ts, strategy, kind, market, side, price, quantity, check_tx_code
      from ${t("bot_orders")} where (note is null or note <> 'dry-run') and strategy <> 'audit-prep'
      order by ts desc limit 60`;

    await sql.end({ timeout: 3 });

    const num = (v: unknown): number => (v == null ? 0 : Number(v));
    const parseMarkets = (m: unknown): number[] | "all" => {
      if (m === "all" || m == null) return "all";
      if (Array.isArray(m)) return m.map(Number);
      if (typeof m === "string") { try { return parseMarkets(JSON.parse(m)); } catch { return "all"; } }
      return "all";
    };
    const parsePositions = (p: unknown): unknown[] => {
      if (Array.isArray(p)) return p;
      if (typeof p === "string") { try { const x = JSON.parse(p); return Array.isArray(x) ? x : []; } catch { return []; } }
      return [];
    };

    // Per-bot equity series → PnL (first vs last).
    const seriesByBot = new Map<string, Array<{ ts: string; equity: number }>>();
    for (const r of series) {
      const bot = r.bot as string;
      if (!seriesByBot.has(bot)) seriesByBot.set(bot, []);
      seriesByBot.get(bot)!.push({ ts: r.m as string, equity: num(r.equity) });
    }

    const latestByBot = new Map(latest.map((r) => [r.bot as string, r]));
    const volByBot = new Map(vol.map((r) => [r.bot as string, r]));
    const regById = new Map(registry.map((r) => [r.id as string, r]));

    const botIds = new Set<string>([
      ...registry.map((r) => r.id as string),
      ...latest.map((r) => r.bot as string),
      ...vol.map((r) => r.bot as string),
    ]);

    const bots = Array.from(botIds).map((id) => {
      const reg = regById.get(id);
      const snap = latestByBot.get(id);
      const v = volByBot.get(id);
      const s = seriesByBot.get(id) ?? [];
      // series is already filtered to equity > 0 and ordered asc, so the oldest
      // point is the right PnL baseline (works for any starting balance).
      const startEq = s[0]?.equity ?? null;
      const curEq = snap ? num(snap.equity) : (s.at(-1)?.equity ?? null);
      return {
        bot: id,
        strategies: (reg?.strategies as string[]) ?? [],
        tags: (reg?.tags as string[]) ?? [],
        markets: parseMarkets(reg?.markets),
        enabled: reg ? (reg.enabled as boolean) : null,
        pnl: startEq != null && curEq != null ? curEq - startEq : null,
        equity: curEq,
        balance: snap ? num(snap.balance) : null,
        volume: v ? num(v.volume_micro) : 0,
        trades: v ? num(v.trades) : 0,
        positions: snap ? parsePositions(snap.positions) : [],
        lastTick: snap ? (snap.ts as string) : null,
        series: s,
      };
    });

    const aggregate = {
      bots: bots.length,
      activeBots: bots.filter((b) => b.enabled !== false).length,
      pnl: bots.reduce((a, b) => a + (b.pnl ?? 0), 0),
      equity: bots.reduce((a, b) => a + (b.equity ?? 0), 0),
      volume: bots.reduce((a, b) => a + b.volume, 0),
      trades: bots.reduce((a, b) => a + b.trades, 0),
    };

    res.status(200).json({
      ok: true,
      asOf: latest[0]?.ts ?? null,
      aggregate,
      bots,
      decisions,
      recentOrders: recent,
      strategyLogic: STRATEGY_LOGIC,
    });
  } catch (err) {
    console.error("stats error:", (err as Error).message);
    res.status(500).json({ ok: false, error: "internal error" });
  }
}
