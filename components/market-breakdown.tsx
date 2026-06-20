"use client";
import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { MarketStats } from "@/lib/types";
import { mkt, eventOf, usd } from "@/lib/dashboard-lib";
import { enter } from "@/lib/motion";
import { useDefaultOpen } from "@/lib/use-default-open";

const pct = (v: number | null): string => (v == null ? "—" : Math.round(v * 100) + "%");
const compactUsd = (micro: number): string => {
  const v = micro / 1e6;
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "k";
  return "$" + v.toFixed(0);
};

/**
 * Market breakdown — stats split BY market + a which-bots-trade-which-markets matrix.
 * Reads marketStats from the fleet payload (windowed by the page range). Surfaces the
 * spread of activity now that bots auto-trade every live Proof event, not just one.
 */
export function MarketBreakdown({ marketStats, colors }: { marketStats: MarketStats | undefined; colors: Record<string, string> }) {
  const reduce = useReducedMotion() ?? false;
  const [open, setOpen] = useDefaultOpen();

  const markets = useMemo(() => (marketStats?.markets ?? []).filter((m) => m.trades > 0), [marketStats]);
  const cells = marketStats?.cells ?? [];

  // Matrix: rows = bots, cols = markets (sorted by total volume, already from the API).
  const matrix = useMemo(() => {
    const cols = markets.map((m) => m.market);
    const byBot = new Map<string, Map<number, number>>();
    for (const c of cells) {
      if (!byBot.has(c.bot)) byBot.set(c.bot, new Map());
      byBot.get(c.bot)!.set(c.market, c.volume);
    }
    const rows = [...byBot.entries()]
      .map(([bot, m]) => ({ bot, vols: m, total: [...m.values()].reduce((a, b) => a + b, 0) }))
      .sort((a, b) => b.total - a.total);
    const maxCell = Math.max(1, ...cells.map((c) => c.volume));
    return { cols, rows, maxCell };
  }, [markets, cells]);

  const maxVol = Math.max(1, ...markets.map((m) => m.volume));

  return (
    <details
      className="analysis"
      aria-label="Market breakdown"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="caret" aria-hidden="true">
          ›
        </span>
        <span className="sum-h2">Markets</span>
        <span className="muted" style={{ fontWeight: "var(--fw-reg)", fontSize: "var(--fz-1)" }}>
          · stats by market + who trades what
        </span>
      </summary>

      {!markets.length ? (
        <div className="empty" style={{ marginTop: "var(--s3)" }}>no market activity in range</div>
      ) : (
        <>
          {/* ── Per-market rows ── */}
          <div className="seg-cap" style={{ marginTop: "var(--s3)", marginBottom: "var(--s1)" }}>
            {markets.length} market{markets.length === 1 ? "" : "s"} traded
          </div>
          <div className="tablewrap trade-table-wrap">
            <table className="mini" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th className="l">Market</th>
                  <th>Volume</th>
                  <th>Trades</th>
                  <th>Bots</th>
                  <th>Maker</th>
                </tr>
              </thead>
              <tbody>
                {markets.map((m, i) => {
                  const ev = eventOf(m.market);
                  return (
                    <motion.tr
                      key={m.market}
                      {...(reduce ? {} : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { ...enter, delay: Math.min(i * 0.03, 0.2) } })}
                    >
                      <td className="l" style={{ fontWeight: "var(--fw-semi)", color: "var(--tx)" }}>
                        {mkt(m.market)}
                        {ev !== null && <span className="muted" style={{ fontWeight: "var(--fw-reg)", marginLeft: "var(--s2)" }}>#{ev}</span>}
                      </td>
                      <td data-k="Volume">
                        <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", justifyContent: "flex-end" }}>
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>{usd(m.volume)}</span>
                          <div style={{ flex: "0 0 52px", height: 5, background: "var(--surface-2)", borderRadius: 3, overflow: "hidden" }}>
                            <motion.div
                              style={{ height: "100%", background: "var(--accent)", borderRadius: 3 }}
                              initial={reduce ? false : { width: 0 }}
                              animate={{ width: `${(m.volume / maxVol) * 100}%` }}
                              transition={{ ...enter, delay: Math.min(i * 0.03, 0.2) }}
                            />
                          </div>
                        </div>
                      </td>
                      <td data-k="Trades">{m.trades.toLocaleString()}</td>
                      <td data-k="Bots">{m.bots}</td>
                      <td data-k="Maker">{pct(m.makerPct)}</td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── Bot × market matrix ── */}
          <div className="seg-cap" style={{ marginTop: "var(--s4)", marginBottom: "var(--s1)" }}>
            who trades what · cell = volume
          </div>
          <div className="tablewrap" style={{ overflowX: "auto" }}>
            <table className="mini matrix" style={{ minWidth: "100%" }}>
              <thead>
                <tr>
                  <th className="l">Bot</th>
                  {matrix.cols.map((c) => (
                    <th key={c} title={`market ${c}`}>{mkt(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((r) => (
                  <tr key={r.bot}>
                    <td className="l" style={{ whiteSpace: "nowrap" }}>
                      <span className="sw" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: colors[r.bot] ?? "var(--accent)", marginRight: "var(--s2)" }} />
                      {r.bot}
                    </td>
                    {matrix.cols.map((c) => {
                      const v = r.vols.get(c) ?? 0;
                      if (!v) return <td key={c} className="muted" style={{ textAlign: "center", opacity: 0.35 }}>·</td>;
                      const intensity = 0.12 + 0.5 * (v / matrix.maxCell);
                      return (
                        <td key={c} style={{ textAlign: "center", background: `color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, transparent)`, fontVariantNumeric: "tabular-nums" }} title={`${r.bot} · ${mkt(c)}: ${usd(v)}`}>
                          {compactUsd(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </details>
  );
}
