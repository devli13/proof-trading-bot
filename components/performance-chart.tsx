"use client";

// Performance chart — the dashboard's centerpiece. Two views over the same fleet:
//   • "history" → Chart.js (react-chartjs-2 <Line>) of buildDatasets() per-bot equity/pnl
//     lines, with a dark theme, a dashed zero line for pnl, and legend-driven isolation.
//   • "live"    → liveline multi-series canvas fed one growing buffer per visible bot.
// Ports public/index.html's mountChart/updateChart/applyIsolation/renderLegend +
// seedLive/feedLive + updateRangeOptions to React. Charts never render during SSR
// (next/dynamic ssr:false) so canvas-only libs don't touch the server.
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import dynamic from "next/dynamic";
import {
  Chart as ChartJS,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Tooltip,
  type ChartOptions,
  type ChartData,
  type Plugin,
} from "chart.js";
import type { Liveline as LivelineComp, LivelineSeries } from "liveline";
import type { PerformanceChartProps } from "./contracts";
import type { BotStat, Range } from "@/lib/types";
import { buildDatasets, botMatches, dim, pnlStr, sign, filteredSorted, type BotLike } from "@/lib/dashboard-lib";
import { fast } from "@/lib/motion";

// `BotStat` is structurally a superset of the helpers' `BotLike` (it has every field
// BotLike reads, with compatible types) but lacks BotLike's `[k: string]: unknown`
// index signature, so TS won't implicitly widen the array. This local view bridges
// that one gap without weakening the helpers — same pattern the shell needs. The cast
// is sound: we never read an unmodeled key off the result.
const asLike = (b: BotStat[]): BotLike[] => b as unknown as BotLike[];

ChartJS.register(LineController, LineElement, PointElement, LinearScale, Tooltip);

// Canvas libs are client-only; defer them past SSR. Chart.js needs `window`, and
// liveline draws to a <canvas>, so both load lazily with no server render.
const Line = dynamic(() => import("react-chartjs-2").then((m) => m.Line), { ssr: false });
const Liveline = dynamic(() => import("liveline").then((m) => m.Liveline as typeof LivelineComp), {
  ssr: false,
}) as typeof LivelineComp;

const RANGES: Range[] = ["1h", "1d", "7d", "30d", "all"];
// Minimum history span (ms) before a range option is worth offering. 1h/1d/all are
// always shown; 7d/30d only once dataSince implies we actually have that much history.
const RANGE_NEED: Record<Range, number> = { "1h": 0, "1d": 0, "7d": 7 * 864e5, "30d": 30 * 864e5, all: 0 };

const fmtTime = (t: number): string =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ── History view (Chart.js) ───────────────────────────────────────────────────
function HistoryChart({
  bots,
  filter,
  colors,
  mode,
  iso,
}: Pick<PerformanceChartProps, "bots" | "filter" | "colors" | "mode" | "iso">) {
  // Coarse pointer (touch): use a single-line "nearest" tooltip that doesn't blanket the
  // chart and dismisses when you tap empty space. The desktop index-mode tooltip lists all
  // ~10 bots → a huge box that covers the graph and won't clear on a phone.
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    setCoarse(typeof window !== "undefined" && !!window.matchMedia?.("(pointer:coarse)").matches);
  }, []);

  // Dashed zero baseline, only in pnl mode (equity has no meaningful zero here).
  const zeroLinePlugin = useMemo<Plugin<"line">>(
    () => ({
      id: "zeroLine",
      beforeDatasetsDraw(c) {
        if (mode !== "pnl") return;
        const yScale = c.scales.y;
        if (!yScale) return;
        const y = yScale.getPixelForValue(0);
        const { left, right } = c.chartArea;
        const ctx = c.ctx;
        ctx.save();
        ctx.strokeStyle = "#2a3142";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.restore();
      },
    }),
    [mode],
  );

  const data = useMemo<ChartData<"line">>(() => {
    const ds = buildDatasets(asLike(bots), filter, mode, colors).map((d) => {
      const isolated = iso === null;
      const me = iso === d.botId;
      // Isolation: full-strength self, dimmed/thinned others, normal when nothing isolated.
      const borderColor = isolated || me ? d.borderColor : dim(d.borderColor, 0.12);
      const borderWidth = isolated ? 1.5 : me ? 2.5 : 1;
      const pointHoverRadius = isolated ? 4 : me ? 5 : 0;
      return {
        ...d,
        // `botId` rides along on the dataset so the tooltip filter/sort can read it.
        botId: d.botId,
        borderColor,
        borderWidth,
        pointHoverRadius,
      };
    });
    return { datasets: ds as unknown as ChartData<"line">["datasets"] };
  }, [bots, filter, mode, colors, iso]);

  const options = useMemo<ChartOptions<"line">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: coarse
        ? { mode: "nearest", intersect: true }
        : { mode: "index", intersect: false, axis: "x" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#11141c",
          borderColor: "#1e2230",
          borderWidth: 1,
          titleColor: "#c7ccda",
          bodyColor: "#e6e8ee",
          padding: 8,
          cornerRadius: 8,
          boxWidth: 8,
          boxHeight: 8,
          displayColors: true,
          itemSort: (a, b) => (b.parsed.y ?? 0) - (a.parsed.y ?? 0),
          filter: (it) => {
            const botId = (it.dataset as { botId?: string }).botId;
            return !iso || botId === iso;
          },
          callbacks: {
            title: (items) => {
              const x = items[0]?.parsed.x;
              return x == null ? "" : fmtTime(x);
            },
            label: (it) => {
              const v = it.parsed.y ?? 0;
              const botId = (it.dataset as { botId?: string }).botId ?? "";
              const money =
                mode === "pnl"
                  ? (v >= 0 ? "+" : "") + "$" + v.toFixed(2)
                  : "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return " " + botId + "  " + money;
            },
            labelColor: (it) => {
              const c = (it.dataset as { borderColor?: string }).borderColor ?? "#7aa2ff";
              return { borderColor: c, backgroundColor: c };
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          bounds: "data",
          offset: false,
          grid: { color: "#181c27" },
          ticks: {
            color: "#8b93a7",
            maxTicksLimit: 6,
            maxRotation: 0,
            autoSkip: true,
            callback: (v) => fmtTime(Number(v)),
          },
        },
        y: {
          beginAtZero: false,
          grid: { color: "#181c27" },
          ticks: {
            color: "#8b93a7",
            callback: (v) => {
              const n = Number(v);
              return mode === "pnl"
                ? (n > 0 ? "+" : "") + "$" + n.toLocaleString(undefined, { maximumFractionDigits: 2 })
                : "$" + n.toLocaleString();
            },
          },
        },
      },
    }),
    [mode, iso, coarse],
  );

  return (
    <Line
      data={data}
      options={options}
      plugins={[zeroLinePlugin]}
      role="img"
      aria-label={(mode === "pnl" ? "P&L since start" : "Equity") + " per bot"}
    />
  );
}

// ── Live view (liveline multi-series) ─────────────────────────────────────────
const liveVal = (b: BotStat, mode: PerformanceChartProps["mode"]): number =>
  (mode === "pnl" ? b.pnl ?? 0 : b.equity ?? 0) / 1e6;

function LiveChart({
  bots,
  filter,
  colors,
  mode,
  iso,
  reduced,
}: Pick<PerformanceChartProps, "bots" | "filter" | "colors" | "mode" | "iso"> & { reduced: boolean }) {
  // Growing per-bot buffer of {time,value}. We append a sample whenever the fleet
  // payload changes (each refetch), so the stream scrolls in real time. The buffer
  // is keyed by `mode` so switching P&L↔Equity reseeds rather than mixing units.
  const [series, setSeries] = useState<LivelineSeries[]>([]);
  const modeRef = useRef(mode);

  // Reseed from history when the visible set or mode changes identity.
  const visible = useMemo(
    () =>
      (filteredSorted(asLike(bots), filter, "pnl", -1) as unknown as BotStat[]).filter(
        (b) => (b.series ?? []).length >= 1,
      ),
    [bots, filter],
  );
  const visibleIds = useMemo(() => visible.map((b) => b.bot).join("|"), [visible]);

  // Seed each series with the LAST ~window of history (≤120s) plus a "now" anchor, so
  // the stream starts as a live edge and grows from appends. Seeding the full 1h history
  // would put almost every point outside liveline's 120s window (nothing visible).
  useEffect(() => {
    modeRef.current = mode;
    const now = Date.now() / 1000;
    const cutoff = now - 120;
    const seeded: LivelineSeries[] = visible.map((b) => {
      const s = b.series ?? [];
      const base = s[0]?.equity ?? 0;
      const recent = s
        .map((p) => ({
          time: Date.parse(p.ts) / 1000,
          value: mode === "pnl" ? (p.equity - base) / 1e6 : p.equity / 1e6,
        }))
        .filter((p) => p.time >= cutoff);
      const v = liveVal(b, mode);
      const data = [...recent, { time: now, value: v }];
      return { id: b.bot, color: colors[b.bot] ?? "#7aa2ff", label: b.bot, data, value: v };
    });
    setSeries(seeded);
    // visibleIds collapses the array identity to a stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIds, mode]);

  // Append the current value for each visible bot whenever the payload updates.
  // Keyed on `visibleIds` too so filter changes update the live series immediately
  // (otherwise the stream lags the filter by up to a full refetch interval).
  useEffect(() => {
    if (modeRef.current !== mode) return; // seed effect above owns mode flips
    const now = Date.now() / 1000;
    setSeries((prev) => {
      const byId = new Map(prev.map((s) => [s.id, s]));
      return visible.map((b) => {
        const existing = byId.get(b.bot);
        const v = liveVal(b, mode);
        const data = existing ? [...existing.data, { time: now, value: v }] : [{ time: now, value: v }];
        return { id: b.bot, color: colors[b.bot] ?? "#7aa2ff", label: b.bot, data, value: v };
      });
    });
  }, [bots, visibleIds, mode, visible, colors]);

  // Isolation: dim non-iso series in place (liveline takes color per series).
  const themed = useMemo<LivelineSeries[]>(() => {
    if (iso === null) return series;
    return series.map((s) => ({ ...s, color: s.id === iso ? s.color : dim(s.color, 0.12) }));
  }, [series, iso]);

  return (
    // liveline owns its <canvas>; the accessible label lives on the wrapper.
    <div role="img" aria-label="live PnL stream per bot" style={{ width: "100%", height: "100%" }}>
      <Liveline
        // Multi-series mode reads `series`; top-level data/value are ignored but
        // required by LivelineProps, so feed the inert defaults.
        data={[]}
        value={0}
        series={themed}
        theme="dark"
        grid
        window={120}
        momentum={!reduced}
        formatValue={(v) => (mode === "pnl" ? (v >= 0 ? "+" : "") + "$" + v.toFixed(2) : "$" + v.toFixed(2))}
        formatTime={(t) => fmtTime(t * 1000)}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────
export function PerformanceChart({
  bots,
  filter,
  colors,
  view,
  onView,
  mode,
  onMode,
  range,
  onRange,
  iso,
  onIso,
  dataSince,
}: PerformanceChartProps) {
  const reduced = useReducedMotion() ?? false;
  const [mounted, setMounted] = useState(false);
  const [legendAll, setLegendAll] = useState(false);
  useEffect(() => setMounted(true), []);

  // Which range buttons to offer — gate 7d/30d on having that much history.
  const span = dataSince ? Date.now() - Date.parse(dataSince) : 0;
  const ranges = RANGES.filter((r) => !(RANGE_NEED[r] > 0 && span < RANGE_NEED[r]));

  // Legend: visible bots with ≥2 series points (mirrors buildDatasets), sorted by pnl desc.
  const legend = useMemo(
    () =>
      bots
        .filter((b) => botMatches(b as unknown as BotLike, filter) && (b.series ?? []).length >= 2)
        .slice()
        .sort((a, c) => (c.pnl ?? 0) - (a.pnl ?? 0)),
    [bots, filter],
  );

  // Cap the legend so it doesn't dwarf the chart (esp. on mobile, where 10 bots stacked
  // ~10 rows tall). Show the top few by PnL + a "+N more" expander; collapsing onto one
  // line keeps the chart the focus. Sorted desc, so the cap keeps the biggest movers.
  const LEG_CAP = 6;
  const shownLegend = legendAll ? legend : legend.slice(0, LEG_CAP);
  const moreCount = legend.length - shownLegend.length;

  // SR summary: best/worst of the shown set.
  const summary = useMemo(() => {
    if (!legend.length) return "";
    const best = legend[0]!;
    const worst = legend[legend.length - 1]!;
    return `${legend.length} bots shown. Best ${best.bot} ${pnlStr(best.pnl)}. Worst ${worst.bot} ${pnlStr(worst.pnl)}.`;
  }, [legend]);

  const hasData = legend.length > 0;

  return (
    <section id="chart-sec" className="chart-sec">
      <div className="chart-head">
        <h2>
          Performance <span className="seg-cap" style={{ marginLeft: "var(--s2)" }}>live</span>
        </h2>
        <span className="spacer" />

        <span
          className="seg-cap"
          title="Time window — applies to the chart AND every per-bot PnL metric below"
        >
          window
        </span>

        <div
          className="seg"
          id="chart-range"
          role="tablist"
          aria-label="Time window (applies to the chart and all per-bot PnL metrics)"
        >
          {ranges.map((r) => (
            <button
              key={r}
              type="button"
              data-range={r}
              role="tab"
              aria-selected={range === r}
              onClick={() => onRange(r)}
            >
              {r}
            </button>
          ))}
        </div>

        <div className="seg" id="chart-mode" role="tablist" aria-label="Chart metric">
          {(["pnl", "equity"] as const).map((m) => (
            <button
              key={m}
              type="button"
              data-mode={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => onMode(m)}
            >
              {m === "pnl" ? "P&L" : "Equity"}
            </button>
          ))}
        </div>
      </div>

      <div className="chartbox" aria-busy={!mounted}>
        {!mounted ? (
          <div className="skel skel-chart" />
        ) : hasData ? (
          <HistoryChart bots={bots} filter={filter} colors={colors} mode={mode} iso={iso} />
        ) : (
          <div className="chart-empty muted">no equity history in range</div>
        )}
      </div>

      <div id="chart-legend" className={"legend" + (iso !== null ? " has-iso" : "")}>
        {iso !== null && (
          <button
            type="button"
            className="leg leg-reset"
            onClick={() => onIso(null)}
            style={{ color: "var(--accent)", fontWeight: "var(--fw-semi)" }}
            title="Show all bots"
          >
            ↺ show all
          </button>
        )}
        {shownLegend.map((b) => {
          const c = colors[b.bot] ?? "#7aa2ff";
          const pressed = iso === b.bot;
          return (
            <motion.button
              key={b.bot}
              type="button"
              className="leg"
              data-bot={b.bot}
              aria-pressed={pressed}
              onClick={() => onIso(iso === b.bot ? null : b.bot)}
              whileTap={reduced ? undefined : { scale: 0.97 }}
              transition={fast}
            >
              <span className="sw" style={{ background: c }} />
              <span className="nm">{b.bot}</span>
              <span className={"pv " + sign(b.pnl)}>{pnlStr(b.pnl)}</span>
            </motion.button>
          );
        })}
        {(moreCount > 0 || legendAll) && legend.length > LEG_CAP && (
          <button
            type="button"
            className="leg leg-more"
            onClick={() => setLegendAll((a) => !a)}
            aria-expanded={legendAll}
          >
            {legendAll ? "show less" : `+${moreCount} more`}
          </button>
        )}
      </div>

      <div id="chart-summary" className="sr-only">
        {summary}
      </div>
    </section>
  );
}
