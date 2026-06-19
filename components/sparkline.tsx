"use client";

// Inline row micro-sparkline: a tiny axis-less SVG trend line. Mirrors the vanilla
// dashboard's spark math (normalize equity to series[0] for "pnl", stroke green/red by
// the sign of the last value) but rendered as a single <polyline> instead of Chart.js —
// cheap enough to live in every bot row. Pure + deterministic: no motion, no state.
import type { SparklineProps } from "./contracts";

export function Sparkline({ series, color, width = 72, height = 18, mode = "pnl" }: SparklineProps) {
  // Need at least two points to draw a line; otherwise an empty, same-size box keeps layout stable.
  if (series.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        style={{ display: "block", overflow: "visible" }}
      />
    );
  }

  const base = series[0]?.equity ?? 0;
  // "pnl" normalizes to a 0 baseline (delta vs first sample); "equity" plots absolute values.
  const ys = series.map((p) => (mode === "pnl" ? p.equity - base : p.equity));

  let lo = Infinity;
  let hi = -Infinity;
  for (const y of ys) {
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  // Small pad so the trend never grazes the top/bottom edge; flat series get a synthetic span.
  const rawSpan = hi - lo;
  const span = rawSpan > 0 ? rawSpan : 1;
  const pad = span * 0.12;
  const min = lo - pad;
  const max = hi + pad;
  const range = max - min || 1;

  const n = ys.length;
  const points = ys
    .map((y, i) => {
      const x = n > 1 ? (i / (n - 1)) * width : width / 2;
      // SVG y grows downward, so invert: higher value -> smaller y.
      const yy = height - ((y - min) / range) * height;
      return `${x.toFixed(2)},${yy.toFixed(2)}`;
    })
    .join(" ");

  const last = ys[n - 1] ?? 0;
  // For "pnl", color by sign of the last value (green up / red down); else fall back to the bot color.
  const stroke =
    mode === "pnl"
      ? last > 0
        ? "var(--money-pos)"
        : last < 0
          ? "var(--money-neg)"
          : color
      : color;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: "block", overflow: "visible" }}
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
