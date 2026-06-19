"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { motion, useReducedMotion } from "framer-motion";
import type { ChartData, ChartOptions, Plugin, TooltipItem } from "chart.js";
import {
  Chart as ChartJS,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Filler,
  Tooltip,
} from "chart.js";

import type { BotDrawerProps } from "./contracts";
import type { BotDetail, ChangeRow, DecisionAgg, OrderRow } from "@/lib/types";
import {
  mkt,
  num,
  usd,
  pnlStr,
  sign,
  relTime,
  absTime,
  dotClass,
  dotWord,
  dim,
} from "@/lib/dashboard-lib";
import { enter } from "@/lib/motion";
import { Sparkline } from "./sparkline";
import { WinRateRadial } from "./win-rate-radial";
import { ExecQualityBar } from "./exec-quality-bar";

// Chart.js wants its parts registered once on the client; react-chartjs-2's auto
// bundle pulls in everything, so we register the minimal set and load <Line> lazily
// (ssr:false) — the drawer is interactive-only, never server-rendered.
ChartJS.register(LineController, LineElement, PointElement, LinearScale, Filler, Tooltip);

const Line = dynamic(() => import("react-chartjs-2").then((m) => m.Line), {
  ssr: false,
  loading: () => <div className="empty">loading chart…</div>,
});

/** Side glyph (parity with public/dashboard-lib.js side()). */
function Side({ side }: { side: string | null | undefined }) {
  const buy = side === "Buy";
  return (
    <span className="side">
      <span className="glyph">{buy ? "▲" : "▼"}</span> {buy ? "Buy" : "Sell"}
    </span>
  );
}

/** Compact stringify of a change-log before/after value (arbitrary JSON). */
function compact(v: unknown): string {
  if (v == null) return "∅";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  try {
    const j = JSON.stringify(v);
    return j.length > 64 ? j.slice(0, 63) + "…" : j;
  } catch {
    return String(v);
  }
}

interface PosLike {
  market?: unknown;
  side?: unknown;
  size?: unknown;
  entryPrice?: unknown;
}

const Q = {
  k: { fontSize: "var(--fz-0)", color: "var(--tx-4)", textTransform: "uppercase" as const, letterSpacing: ".04em" },
  v: { fontSize: "var(--fz-1)", color: "var(--tx)", fontVariantNumeric: "tabular-nums" as const, fontWeight: 500 },
};

export function BotDrawer({ bot, color, now, strategyLogic, range }: BotDrawerProps) {
  const reduce = useReducedMotion() ?? false;

  const [detail, setDetail] = useState<BotDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // Fetch the per-bot drill-down (orders / decisions / changes). Static bot data
  // (series, metrics, positions, balance) renders immediately from props.
  useEffect(() => {
    const ac = new AbortController();
    let alive = true;
    setLoading(true);
    setDetail(null);
    // Lazy-import the api module so the drawer chunk stays lean.
    import("@/lib/api")
      .then((m) => m.fetchBotDetail(bot.bot, ac.signal))
      .then((d) => {
        if (!alive) return;
        if (d && d.ok) setDetail(d);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false); // aborted or network blip — keep static view
      });
    return () => {
      alive = false;
      ac.abort();
    };
  }, [bot.bot]);

  const m = bot.metrics;
  const series = bot.series ?? [];
  const positions = (bot.positions ?? []) as PosLike[];
  const dc = dotClass(bot, now);

  const decisions: DecisionAgg[] = detail?.decisions ?? [];
  const orders: OrderRow[] = (detail?.recentOrders ?? []).slice(0, 12);
  const changes: ChangeRow[] = detail?.changes ?? [];

  // ── PnL line (normalized to series[0]) + change annotations ────────────────
  const base = series[0]?.equity ?? 0;
  const points = useMemo(
    () => series.map((p) => ({ x: Date.parse(p.ts), y: (p.equity - base) / 1e6 })),
    [series, base],
  );
  const lastY = points.at(-1)?.y ?? 0;
  const stroke = lastY > 0 ? "var(--money-pos)" : lastY < 0 ? "var(--money-neg)" : color;
  // Resolve the CSS-var stroke to a concrete hex for Chart.js (it draws on a canvas).
  const strokeHex = lastY > 0 ? "#3ddc84" : lastY < 0 ? "#ff6b6b" : color;

  // Change markers placed at the nearest in-range timestamp on the x-axis.
  const xMin = points[0]?.x ?? 0;
  const xMax = points.at(-1)?.x ?? 0;
  const markers = useMemo(
    () =>
      changes
        .map((c) => {
          const x = Date.parse(c.ts);
          return { x, c };
        })
        .filter((mk) => Number.isFinite(mk.x) && mk.x >= xMin && mk.x <= xMax),
    [changes, xMin, xMax],
  );

  const chartData: ChartData<"line"> = useMemo(
    () => ({
      datasets: [
        {
          data: points,
          borderColor: strokeHex,
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 3,
          tension: 0.2,
          fill: {
            target: "origin",
            above: "rgba(61,220,132,0.08)",
            below: "rgba(255,107,107,0.08)",
          },
        },
      ],
    }),
    [points, strokeHex],
  );

  // Custom plugin: vertical dashed annotation lines at each change ts. The hover
  // tooltips live in the absolutely-positioned overlay below (accessible title attr).
  const annotationPlugin: Plugin<"line"> = useMemo(
    () => ({
      id: "changeLines",
      afterDatasetsDraw(c) {
        const xScale = c.scales["x"];
        if (!xScale) return;
        const { top, bottom } = c.chartArea;
        const ctx = c.ctx;
        ctx.save();
        ctx.strokeStyle = "#aeb6c8";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        for (const mk of markers) {
          const px = xScale.getPixelForValue(mk.x);
          if (px < c.chartArea.left || px > c.chartArea.right) continue;
          ctx.beginPath();
          ctx.moveTo(px, top);
          ctx.lineTo(px, bottom);
          ctx.stroke();
        }
        ctx.restore();
      },
    }),
    [markers],
  );

  const chartOpts: ChartOptions<"line"> = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: reduce ? false : { duration: 240 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          displayColors: false,
          backgroundColor: "#11141c",
          borderColor: "#1e2230",
          borderWidth: 1,
          titleColor: "#c7ccda",
          bodyColor: "#e6e8ee",
          padding: 8,
          cornerRadius: 8,
          callbacks: {
            title: (i: TooltipItem<"line">[]) =>
              new Date((i[0]?.parsed.x as number) ?? 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            label: (it: TooltipItem<"line">) => {
              const v = it.parsed.y as number;
              return (v >= 0 ? "+" : "") + "$" + v.toFixed(2);
            },
          },
        },
      },
      scales: {
        x: { type: "linear", display: false, bounds: "data", offset: false },
        y: { display: false },
      },
    }),
    [reduce],
  );

  const hasPnl = points.length >= 2;

  return (
    <motion.div className="drawer-grid" initial={false} animate={{ opacity: 1 }}>
      {/* ───────────────────────────── LEFT ───────────────────────────── */}
      <motion.div className="dr-left" initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={enter}>
        <div className="dr-id">
          <span className="nm">{bot.bot}</span>
          <span className="chip">{dotWord(dc)}</span>
          {(bot.strategies ?? []).map((s) => (
            <span className="chip chip-strat" key={s}>
              {s}
            </span>
          ))}
          {bot.markets !== "all" &&
            (bot.markets ?? []).map((mk0) => (
              <span className="chip" key={mk0}>
                {mkt(mk0)}
              </span>
            ))}
          <span className="dr-money">
            <span>
              Bal <b>{usd(bot.balance)}</b>
            </span>
            <span>
              Eq <b>{usd(bot.equity)}</b>
            </span>
            <span>
              Tick <b>{relTime(bot.lastTick, now)}</b>
            </span>
          </span>
        </div>

        <div className="dr-h">Equity ({range})</div>
        <Sparkline series={series} color={color} width={240} height={54} mode="pnl" />
        <div className="spark-meta">
          <span className={`pv ${sign(bot.pnl)}`}>{pnlStr(bot.pnl)}</span>
          <span className="muted">{series.length} pts</span>
          {series.length >= 1 && series[0] && (
            <span className="muted">
              {relTime(series[0].ts, now)} → now
            </span>
          )}
        </div>

        <div className="dr-h">Metrics</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))",
            gap: "var(--s2) var(--s3)",
            marginBottom: "var(--s2)",
          }}
        >
          <Stat k="Avg trade" v={usd(m.avgTradeSize)} />
          <Stat k="Trades / hr" v={m.tradesPerHour?.toFixed(1) ?? "—"} />
          <Stat k="Last hr" v={String(m.lastHourTrades)} />
          <Stat k="PnL / trade" v={pnlStr(m.pnlPerTrade)} tone={sign(m.pnlPerTrade)} />
          <Stat k="Max DD" v={pnlStr(m.maxDrawdown)} tone={sign(m.maxDrawdown)} />
          <Stat k="Net flow" v={pnlStr(m.netFlow)} tone={sign(m.netFlow)} />
          <Stat k="Inventory" v={usd(m.inventory)} />
        </div>

        <div
          style={{
            display: "flex",
            gap: "var(--s4)",
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: "var(--s1)",
          }}
        >
          <WinRateRadial value={m.winRate} />
          <div style={{ flex: "1 1 160px", minWidth: 0 }}>
            <ExecQualityBar makerPct={m.makerPct} rejectRate={m.rejectRate} inferred />
          </div>
        </div>

        <div className="dr-h">Open positions</div>
        {positions.length ? (
          <div className="mini-wrap">
            <table className="mini">
              <thead>
                <tr>
                  <th className="l">Market</th>
                  <th className="l">Side</th>
                  <th>Size</th>
                  <th>Entry</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => (
                  <tr key={i}>
                    <td className="l">{mkt(num(p.market))}</td>
                    <td className="l">
                      <Side side={p.side as string} />
                    </td>
                    <td>{p.size == null ? "" : String(p.size)}</td>
                    <td>{usd(num(p.entryPrice))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">flat — no open positions</div>
        )}
      </motion.div>

      {/* ───────────────────────────── RIGHT ──────────────────────────── */}
      <motion.div className="dr-right" initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={enter}>
        <div className="dr-h">PnL + strategy changes</div>
        {hasPnl ? (
          <div
            style={{
              position: "relative",
              height: 132,
              border: "1px solid var(--border)",
              borderRadius: "var(--r-md)",
              background: "var(--inset)",
              padding: "var(--s1)",
              marginBottom: "var(--s2)",
            }}
          >
            <Line data={chartData} options={chartOpts} plugins={[annotationPlugin]} />
            {/* Annotation markers — absolutely positioned by x-fraction over the plot.
                Native title gives an accessible tooltip (kind · before→after · note). */}
            {markers.map((mk, i) => {
              const frac = xMax > xMin ? (mk.x - xMin) / (xMax - xMin) : 0.5;
              const note = mk.c.note ? ` — ${mk.c.note}` : "";
              const title = `${mk.c.kind}: ${compact(mk.c.before)} → ${compact(mk.c.after)}${note}\n${absTime(mk.c.ts)}`;
              return (
                <div
                  key={`${mk.c.ts}-${i}`}
                  title={title}
                  aria-label={title}
                  style={{
                    position: "absolute",
                    top: 2,
                    left: `calc(${(frac * 100).toFixed(2)}% )`,
                    transform: "translateX(-50%)",
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    background: "var(--surface)",
                    border: `1.5px solid ${strokeHex}`,
                    cursor: "help",
                    zIndex: 2,
                  }}
                />
              );
            })}
          </div>
        ) : (
          <div className="empty" style={{ marginBottom: "var(--s2)" }}>
            insufficient history for a PnL chart
          </div>
        )}

        <div className="dr-h">Decisions (24h)</div>
        {loading && !detail ? (
          <div className="empty">loading decisions…</div>
        ) : decisions.length ? (
          decisions.slice(0, 14).map((d, i) => (
            <div className="dec-row" key={`${d.strategy}-${d.action}-${i}`}>
              <span className="chip chip-action">{d.action}</span>{" "}
              <span className="muted">{d.strategy}</span> ×{d.c}{" "}
              <span className="muted">· {relTime(d.last, now)}</span>
            </div>
          ))
        ) : (
          <div className="empty">no decisions in 24h</div>
        )}

        <div className="dr-h">Recent orders</div>
        {loading && !detail ? (
          <div className="empty">loading orders…</div>
        ) : orders.length ? (
          <div className="mini-wrap">
            <table className="mini">
              <thead>
                <tr>
                  <th className="l">Time</th>
                  <th className="l">Mkt</th>
                  <th className="l">Side</th>
                  <th>Price</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => (
                  <tr key={`${o.ts}-${i}`}>
                    <td className="l muted">{relTime(o.ts, now)}</td>
                    <td className="l">{mkt(o.market)}</td>
                    <td className="l">
                      <Side side={o.side} />
                    </td>
                    <td>{usd(num(o.price))}</td>
                    <td>{o.quantity == null ? "" : String(o.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">no recent orders</div>
        )}

        <div className="dr-h">Strategy</div>
        {(bot.strategies ?? []).length ? (
          (bot.strategies ?? []).map((s) => (
            <div className="logic" key={s}>
              <b>{s}</b> — {strategyLogic[s] ?? "—"}
            </div>
          ))
        ) : (
          <div className="empty">no strategies</div>
        )}

        <div className="dr-h">Change log</div>
        {loading && !detail ? (
          <div className="empty">loading changes…</div>
        ) : changes.length ? (
          <ol
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              borderLeft: "1px solid var(--border)",
            }}
          >
            {changes.map((c, i) => (
              <motion.li
                key={`${c.ts}-${i}`}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...enter, delay: reduce ? 0 : Math.min(i * 0.03, 0.3) }}
                style={{
                  position: "relative",
                  paddingLeft: "var(--s3)",
                  margin: "var(--s2) 0",
                  fontSize: "var(--fz-1)",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: -4,
                    top: 6,
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "var(--surface)",
                    border: `1.5px solid ${dim("#7aa2ff", 0.9)}`,
                  }}
                />
                <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s2)", flexWrap: "wrap" }}>
                  <span className="chip">{c.kind}</span>
                  <span style={{ color: "var(--tx-3)", fontVariantNumeric: "tabular-nums" }}>
                    {compact(c.before)} <span className="muted">→</span> {compact(c.after)}
                  </span>
                  <span className="muted" title={absTime(c.ts)} style={{ marginLeft: "auto" }}>
                    {relTime(c.ts, now)}
                  </span>
                </div>
                {c.note ? (
                  <div className="muted" style={{ fontSize: "var(--fz-0)", marginTop: 2, overflowWrap: "anywhere" }}>
                    {c.note}
                  </div>
                ) : null}
              </motion.li>
            ))}
          </ol>
        ) : (
          <div className="empty">no recorded changes</div>
        )}
      </motion.div>
    </motion.div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: "pos" | "neg" | "" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <span style={Q.k}>{k}</span>
      <span
        style={{
          ...Q.v,
          color: tone === "pos" ? "var(--money-pos)" : tone === "neg" ? "var(--money-neg)" : "var(--tx)",
        }}
      >
        {v}
      </span>
    </div>
  );
}
