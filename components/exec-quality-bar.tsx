"use client";

// ExecQualityBar — a thin maker/taker split bar with a reject tick overlaid at the right.
// Maker segment (--accent) sized by makerPct, the remainder (taker) in --tx-4, and a small
// red (--money-neg) reject segment pinned to the right sized by rejectRate. A caption line
// reads "{~?}maker N% · taker N% · reject N%". Null inputs collapse to a muted "—".
import { motion, useReducedMotion } from "framer-motion";
import type { ExecQualityBarProps } from "./contracts";
import { EASE_OUT } from "@/lib/motion";

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const pct = (n: number): string => Math.round(clamp01(n) * 100) + "%";

export function ExecQualityBar({ makerPct, rejectRate, inferred }: ExecQualityBarProps) {
  const reduce = useReducedMotion();
  const hasMaker = makerPct != null && !isNaN(makerPct);
  const hasReject = rejectRate != null && !isNaN(rejectRate);

  if (!hasMaker && !hasReject) {
    return (
      <span style={{ color: "var(--tx-5)", fontSize: "var(--fz-0)", fontVariantNumeric: "tabular-nums" }}>—</span>
    );
  }

  const maker = hasMaker ? clamp01(makerPct) : 0;
  const taker = hasMaker ? 1 - maker : 0;
  const reject = hasReject ? clamp01(rejectRate) : 0;
  const trans = reduce ? { duration: 0 } : { duration: 0.5, ease: EASE_OUT };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s1)", minWidth: 120 }}>
      <div
        role="img"
        aria-label={`maker ${pct(maker)}, taker ${pct(taker)}, reject ${pct(reject)}`}
        style={{
          position: "relative",
          height: 8,
          width: "100%",
          borderRadius: 999,
          overflow: "hidden",
          background: "var(--inset)",
          border: "1px solid var(--border)",
        }}
      >
        {/* maker fill */}
        {hasMaker && (
          <motion.div
            initial={reduce ? false : { width: 0 }}
            animate={{ width: pct(maker) }}
            transition={trans}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              background: "var(--accent)",
              opacity: maker > 0 ? 1 : 0,
            }}
          />
        )}
        {/* taker fill — fills the remainder after maker */}
        {hasMaker && (
          <motion.div
            initial={reduce ? false : { width: 0 }}
            animate={{ width: pct(taker) }}
            transition={trans}
            style={{
              position: "absolute",
              left: pct(maker),
              top: 0,
              bottom: 0,
              background: "var(--tx-4)",
              opacity: taker > 0 ? 0.55 : 0,
            }}
          />
        )}
        {/* reject tick — pinned right, sized by rejectRate, capped so it stays a "tick" */}
        {hasReject && reject > 0 && (
          <motion.div
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={trans}
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: Math.max(3, Math.min(40, reject * 100)) + "%",
              background: "var(--money-neg)",
              boxShadow: "-1px 0 0 var(--surface)",
            }}
          />
        )}
      </div>
      <div
        style={{
          fontSize: "var(--fz-0)",
          color: "var(--tx-4)",
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        }}
      >
        {inferred ? "~" : ""}maker{" "}
        <span style={{ color: "var(--accent)" }}>{hasMaker ? pct(maker) : "—"}</span>
        {" · "}taker <span style={{ color: "var(--tx-2)" }}>{hasMaker ? pct(taker) : "—"}</span>
        {" · "}reject{" "}
        <span style={{ color: reject > 0 ? "var(--money-neg)" : "var(--tx-4)" }}>{hasReject ? pct(reject) : "—"}</span>
      </div>
    </div>
  );
}
