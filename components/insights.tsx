"use client";

import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { InsightsProps } from "./contracts";
import type { BotStat } from "@/lib/types";
import { dim, pnlStr, sign } from "@/lib/dashboard-lib";
import { layoutSpring, enter } from "@/lib/motion";

// The design tokens (--money-pos/--money-neg) resolved to their literal hex so dim()
// (which expects "#rrggbb") can append an alpha channel for the low-opacity tile tints.
const POS_HEX = "#3ddc84";
const NEG_HEX = "#ff6b6b";

/**
 * Insights — two compact, non-gimmicky visualizations of the currently-visible bots:
 *  (1) Fleet treemap: one flex tile per bot, area ∝ sqrt(volume), tinted by pnl sign.
 *  (2) Buy/sell flow ribbon: total net-flow split into buy(+)/sell(−) pressure as a
 *      centered, stacked horizontal bar with a net caption.
 * Renders nothing when there are no visible bots.
 */
export function Insights({ bots, colors }: InsightsProps) {
  const reduce = useReducedMotion() ?? false;

  // Treemap tiles: flex-grow weight ∝ sqrt(volume) so area (not edge) tracks volume.
  // A floor of 1 keeps zero-volume bots visible as the smallest legible tile.
  const tiles = useMemo(() => {
    return bots.map((b: BotStat) => ({
      id: b.bot,
      grow: Math.max(1, Math.sqrt(Math.max(0, b.volume))),
      pnl: b.pnl ?? 0,
      sgn: sign(b.pnl),
      color: colors[b.bot] ?? "var(--accent)",
    }));
  }, [bots, colors]);

  // Aggregate net-flow into directional pressure. netFlow > 0 = net buying, < 0 = net selling.
  const flow = useMemo(() => {
    let buy = 0;
    let sell = 0;
    for (const b of bots) {
      const nf = b.metrics?.netFlow ?? 0;
      if (nf > 0) buy += nf;
      else if (nf < 0) sell += -nf;
    }
    const total = buy + sell;
    const net = buy - sell;
    return {
      buy,
      sell,
      net,
      buyPct: total > 0 ? buy / total : 0.5,
      sellPct: total > 0 ? sell / total : 0.5,
      hasFlow: total > 0,
    };
  }, [bots]);

  if (bots.length === 0) return null;

  const labelStyle: React.CSSProperties = {
    fontSize: "var(--fz-0)",
    textTransform: "uppercase",
    letterSpacing: ".05em",
    fontWeight: "var(--fw-semi)" as unknown as number,
    color: "var(--tx-4)",
  };

  return (
    <section aria-label="Insights">
      <h2>Insights</h2>

      <div
        style={{ display: "flex", flexDirection: "column", gap: "var(--s4)", marginTop: "var(--s3)" }}
      >
        {/* (1) Fleet treemap — tile area ∝ sqrt(volume), tinted by pnl sign. */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...enter, delay: reduce ? 0 : 0 * 0.05 }}
        >
          <div style={{ ...labelStyle, marginBottom: "var(--s2)" }}>Fleet by volume</div>
          <div
            role="img"
            aria-label="Fleet treemap: tile size reflects trading volume, color reflects PnL"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--s1)",
              alignContent: "flex-start",
            }}
          >
            {tiles.map((t) => {
              const tint =
                t.sgn === "pos" ? dim(POS_HEX, 0.16) : t.sgn === "neg" ? dim(NEG_HEX, 0.16) : "var(--surface-2)";
              const ring =
                t.sgn === "pos" ? dim(POS_HEX, 0.4) : t.sgn === "neg" ? dim(NEG_HEX, 0.4) : "var(--border)";
              const pnlColor =
                t.sgn === "pos" ? "var(--money-pos)" : t.sgn === "neg" ? "var(--money-neg)" : "var(--tx-4)";
              return (
                <motion.div
                  key={t.id}
                  layout={reduce ? false : true}
                  transition={layoutSpring}
                  style={{
                    flex: `${t.grow} 1 56px`,
                    minWidth: 56,
                    minHeight: 52,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: "var(--s1)",
                    padding: "var(--s2)",
                    borderRadius: "var(--r-md)",
                    background: tint,
                    border: `1px solid ${ring}`,
                    overflow: "hidden",
                  }}
                  title={`${t.id} · ${pnlStr(t.pnl)}`}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--s1)",
                      minWidth: 0,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        flexShrink: 0,
                        background: t.color,
                      }}
                    />
                    <span
                      style={{
                        fontSize: "var(--fz-1)",
                        color: "var(--tx-2)",
                        fontWeight: "var(--fw-med)" as unknown as number,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        minWidth: 0,
                      }}
                    >
                      {t.id}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: "var(--fz-1)",
                      fontVariantNumeric: "tabular-nums",
                      color: pnlColor,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {pnlStr(t.pnl)}
                  </span>
                </motion.div>
              );
            })}
          </div>
        </motion.div>

        {/* (2) Buy/sell flow ribbon — centered stacked bar of net buy/sell pressure. */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...enter, delay: reduce ? 0 : 1 * 0.05 }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: "var(--s2)",
              marginBottom: "var(--s2)",
            }}
          >
            <span style={labelStyle}>Buy / Sell flow</span>
            <span
              style={{
                fontSize: "var(--fz-1)",
                fontVariantNumeric: "tabular-nums",
                color:
                  flow.net > 0 ? "var(--money-pos)" : flow.net < 0 ? "var(--money-neg)" : "var(--tx-4)",
              }}
            >
              net {pnlStr(flow.net)}
            </span>
          </div>

          <div
            role="img"
            aria-label={`Net flow: ${pnlStr(flow.buy)} buy pressure, ${pnlStr(-flow.sell)} sell pressure`}
            style={{
              display: "flex",
              alignItems: "stretch",
              height: 14,
              borderRadius: "var(--r-sm)",
              overflow: "hidden",
              background: "var(--inset)",
              border: "1px solid var(--border)",
            }}
          >
            {/* Left half (sell) grows from the center outward. */}
            <div style={{ flex: "1 1 50%", display: "flex", justifyContent: "flex-end", minWidth: 0 }}>
              <motion.div
                layout={reduce ? false : true}
                transition={layoutSpring}
                style={{
                  width: `${(flow.hasFlow ? flow.sellPct : 0) * 100}%`,
                  background: dim(NEG_HEX, 0.85),
                }}
              />
            </div>
            <span aria-hidden style={{ width: 1, background: "var(--zero-line)" }} />
            {/* Right half (buy). */}
            <div style={{ flex: "1 1 50%", display: "flex", justifyContent: "flex-start", minWidth: 0 }}>
              <motion.div
                layout={reduce ? false : true}
                transition={layoutSpring}
                style={{
                  width: `${(flow.hasFlow ? flow.buyPct : 0) * 100}%`,
                  background: dim(POS_HEX, 0.85),
                }}
              />
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: "var(--s1)",
              fontSize: "var(--fz-0)",
              fontVariantNumeric: "tabular-nums",
              color: "var(--tx-4)",
            }}
          >
            <span style={{ color: "var(--money-neg)" }}>sell {pnlStr(-flow.sell)}</span>
            <span style={{ color: "var(--money-pos)" }}>buy {pnlStr(flow.buy)}</span>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
