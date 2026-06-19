"use client";
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { fetchTradeAnalysis } from "@/lib/api";
import type { TradeBucket } from "@/lib/types";
import { usd } from "@/lib/dashboard-lib";
import { enter } from "@/lib/motion";

const fmtBps = (v: number | null): string => (v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(1) + " bps");
const pct = (v: number | null): string => (v == null ? "—" : Math.round(v * 100) + "%");
// Diverging tint for the favorable-move signal (green = trades that won, red = lost).
const favTint = (v: number | null): string =>
  v == null ? "var(--tx-4)" : v > 0 ? "var(--money-pos)" : v < 0 ? "var(--money-neg)" : "var(--tx-3)";

/**
 * Trade-size analysis — does size pay, and how much do big trades move the book?
 * Buckets every real order by notional and shows, per bucket: the distribution, win rate,
 * avg favorable move, and market impact (next-price move, bps). Refetched every 30s.
 */
export function TradeAnalysis() {
  const reduce = useReducedMotion() ?? false;
  const [buckets, setBuckets] = useState<TradeBucket[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchTradeAnalysis(24)
        .then((j) => {
          if (alive && j.ok) setBuckets(j.buckets ?? []);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const ready = buckets != null && buckets.length > 0;
  const maxTrades = ready ? Math.max(...buckets.map((b) => b.trades), 1) : 1;
  const maxImpact = ready ? Math.max(...buckets.map((b) => b.avgImpactBps ?? 0), 1) : 1;
  const totalTrades = ready ? buckets.reduce((a, b) => a + b.trades, 0) : 0;

  const animBar = (frac: number, i: number) =>
    reduce ? { width: `${frac * 100}%` } : { initial: { width: 0 }, animate: { width: `${frac * 100}%` }, transition: { ...enter, delay: i * 0.04 } };

  return (
    <section aria-label="Trade-size analysis">
      <h2>
        Trade-size analysis{" "}
        <span className="muted" style={{ fontWeight: "var(--fw-reg)", fontSize: "var(--fz-1)" }}>
          · does size pay, and how much do big trades move the book? · last 24h
        </span>
      </h2>

      {buckets == null ? (
        <div className="skel skel-row" style={{ height: 120, marginTop: "var(--s3)" }} />
      ) : !buckets.length ? (
        <div className="empty" style={{ marginTop: "var(--s3)" }}>not enough trades yet — building as the fleet trades</div>
      ) : (
        <>
          {/* ── Distribution ribbon: width ∝ trade count, tinted by avg favorable move ── */}
          <div className="seg-cap" style={{ marginTop: "var(--s3)", marginBottom: "var(--s1)" }}>
            distribution ({totalTrades.toLocaleString()} trades)
          </div>
          <div style={{ display: "flex", gap: 3, height: 34, borderRadius: "var(--r-sm)", overflow: "hidden" }}>
            {buckets.map((b, i) => {
              const fav = b.avgFavBps;
              const bg =
                fav == null
                  ? "var(--surface-2)"
                  : fav > 0
                    ? "color-mix(in srgb, var(--money-pos) 22%, var(--surface))"
                    : "color-mix(in srgb, var(--money-neg) 22%, var(--surface))";
              return (
                <motion.div
                  key={b.bk}
                  title={`${b.label}: ${b.trades.toLocaleString()} trades · win ${pct(b.winRate)} · ${fmtBps(fav)}`}
                  style={{
                    flex: `${b.trades + maxTrades * 0.04} 0 0`,
                    minWidth: 44,
                    background: bg,
                    border: "1px solid var(--border)",
                    borderRadius: "var(--r-sm)",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    alignItems: "center",
                    fontSize: "var(--fz-0)",
                    color: "var(--tx-2)",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                  }}
                  {...(reduce ? {} : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { ...enter, delay: i * 0.04 } })}
                  layout={!reduce}
                >
                  <span style={{ fontWeight: "var(--fw-semi)" }}>{b.label}</span>
                  <span className="muted">{b.trades.toLocaleString()}</span>
                </motion.div>
              );
            })}
          </div>

          {/* ── Per-bucket metrics ── */}
          <div className="tablewrap" style={{ marginTop: "var(--s4)" }}>
            <table className="mini" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th className="l">Size</th>
                  <th>Trades</th>
                  <th>Avg</th>
                  <th>Win rate</th>
                  <th>Favorable</th>
                  <th>Market impact</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b, i) => (
                  <tr key={b.bk}>
                    <td className="l" style={{ fontWeight: "var(--fw-semi)", color: "var(--tx)" }}>
                      {b.label}
                    </td>
                    <td>{b.trades.toLocaleString()}</td>
                    <td>{usd(b.avgNotional)}</td>
                    <td>
                      <Bar frac={b.winRate ?? 0} color="var(--accent)" label={pct(b.winRate)} anim={animBar(b.winRate ?? 0, i)} />
                    </td>
                    <td style={{ color: favTint(b.avgFavBps), fontWeight: "var(--fw-med)" }}>{fmtBps(b.avgFavBps)}</td>
                    <td>
                      <Bar
                        frac={(b.avgImpactBps ?? 0) / maxImpact}
                        color="var(--accent-2)"
                        label={b.avgImpactBps == null ? "—" : b.avgImpactBps.toFixed(1) + " bps"}
                        anim={animBar((b.avgImpactBps ?? 0) / maxImpact, i)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="sub" style={{ marginTop: "var(--s3)", lineHeight: 1.5 }}>
            <b style={{ color: "var(--tx-3)" }}>Win rate</b> = share of trades the market moved favorably right after.{" "}
            <b style={{ color: "var(--tx-3)" }}>Favorable</b> = avg favorable move, and <b style={{ color: "var(--tx-3)" }}>market impact</b> = avg
            |next-price move|, both in bps so cheap binary legs (~$0.46) and the HYPE perp (~$69) compare. It&apos;s a directional/impact proxy,
            not realized PnL.
          </p>
        </>
      )}
    </section>
  );
}

function Bar({
  frac,
  color,
  label,
  anim,
}: {
  frac: number;
  color: string;
  label: string;
  anim: Record<string, unknown>;
}) {
  const f = Math.max(0, Math.min(1, frac));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", justifyContent: "flex-end" }}>
      <span style={{ minWidth: 48, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{label}</span>
      <div style={{ flex: "0 0 56px", height: 5, background: "var(--surface-2)", borderRadius: 3, overflow: "hidden" }}>
        {"initial" in anim ? (
          <motion.div style={{ height: "100%", background: color, borderRadius: 3 }} {...anim} />
        ) : (
          <div style={{ height: "100%", background: color, borderRadius: 3, width: `${f * 100}%` }} />
        )}
      </div>
    </div>
  );
}
