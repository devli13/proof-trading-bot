"use client";

// WinRateRadial — a tiny SVG donut for a bot's win rate (0..1). Background ring in
// --border; a foreground arc whose sweep is proportional to the value, color-ramped
// red(0) -> amber(.5) -> green(1). Center text is the rounded percent; null -> muted "—".
// The arc draws in via framer-motion (instant under reduced motion).
import { motion, useReducedMotion } from "framer-motion";
import { useId } from "react";
import type { WinRateRadialProps } from "./contracts";
import { EASE_OUT } from "@/lib/motion";

// Linear interpolate two hex colors (#rrggbb) by t in [0,1].
function lerpHex(a: string, b: string, t: number): string {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const ch = (i: number): string => {
    const x = Math.round((pa[i] ?? 0) + ((pb[i] ?? 0) - (pa[i] ?? 0)) * t);
    return Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0");
  };
  return "#" + ch(0) + ch(1) + ch(2);
}

// red -> amber -> green ramp matching the design's --money-neg / --money-pos endpoints.
function ramp(v: number): string {
  const t = Math.max(0, Math.min(1, v));
  const RED = "#ff6b6b"; // --money-neg
  const AMBER = "#ffb454";
  const GREEN = "#3ddc84"; // --money-pos
  return t <= 0.5 ? lerpHex(RED, AMBER, t / 0.5) : lerpHex(AMBER, GREEN, (t - 0.5) / 0.5);
}

export function WinRateRadial({ value, size = 44 }: WinRateRadialProps) {
  const reduce = useReducedMotion();
  const titleId = useId();
  const stroke = Math.max(3, Math.round(size * 0.1));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const empty = value == null || isNaN(value);
  const v = empty ? 0 : Math.max(0, Math.min(1, value));
  const color = empty ? "var(--tx-5)" : ramp(v);
  const label = empty ? "—" : Math.round(v * 100) + "%";

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-labelledby={titleId}
      style={{ display: "block", flex: "0 0 auto" }}
    >
      <title id={titleId}>{empty ? "Win rate unavailable" : `Win rate ${label}`}</title>
      {/* background ring */}
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
      {/* foreground arc (top-anchored, clockwise) */}
      {!empty && (
        <motion.circle
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cx})`}
          strokeDasharray={c}
          initial={reduce ? false : { strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - v) }}
          transition={reduce ? { duration: 0 } : { duration: 0.7, ease: EASE_OUT }}
        />
      )}
      <text
        x={cx}
        y={cx}
        textAnchor="middle"
        dominantBaseline="central"
        fill={empty ? "var(--tx-5)" : "var(--tx-2)"}
        style={{
          fontSize: Math.round(size * 0.3),
          fontVariantNumeric: "tabular-nums",
          fontWeight: 600,
          letterSpacing: "-0.02em",
        }}
      >
        {label}
      </text>
    </svg>
  );
}
