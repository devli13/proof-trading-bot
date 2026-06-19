"use client";

// Count-up number that tweens from its previous value to the new one and briefly
// flashes a directional tint on change (green up / red down). Honors reduced motion:
// the value jumps and no flash plays. Mirrors the vanilla dashboard's per-KPI rollers
// (setDigits + .changed valtint) but generalized so any formatter can drive the text.
import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "framer-motion";
import type { AnimatedNumberProps } from "./contracts";
import { enter } from "@/lib/motion";

export function AnimatedNumber({ value, format, className, flash }: AnimatedNumberProps) {
  const reduced = useReducedMotion() ?? false;
  const prev = useRef<number>(value);
  // `display` is the number we actually render through format(); it tweens toward `value`.
  const [display, setDisplay] = useState<number>(value);
  // null = no flash; +1 = rose (green), -1 = fell (red).
  const [dir, setDir] = useState<-1 | 0 | 1 | null>(null);

  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (from === value) return;

    // Directional flash: explicit `flash` prop forces it on; otherwise derive from delta.
    if (flash !== false) {
      const d = value > from ? 1 : value < from ? -1 : 0;
      setDir(d);
    }

    if (reduced) {
      setDisplay(value);
      return;
    }

    const controls = animate(from, value, {
      ...enter,
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value, flash, reduced]);

  // Clear the flash tint a beat after it starts. Skipped entirely under reduced motion.
  useEffect(() => {
    if (dir == null || reduced) return;
    const t = setTimeout(() => setDir(null), 520);
    return () => clearTimeout(t);
  }, [dir, reduced]);

  const flashing = dir != null && dir !== 0 && !reduced;
  // Tint the glyphs toward the delta direction; a transition fades it back to the
  // inherited card color (.card-pnl colors by sign) once `dir` clears.
  const tint =
    dir === 1 ? "var(--money-pos)" : dir === -1 ? "var(--money-neg)" : undefined;
  // Background wash recolored from the design's --flash token by direction.
  const wash = flashing
    ? dir === 1
      ? "rgba(61,220,132,.12)"
      : "rgba(255,107,107,.12)"
    : undefined;
  const ring = flashing
    ? dir === 1
      ? "0 0 0 4px rgba(61,220,132,.10)"
      : "0 0 0 4px rgba(255,107,107,.10)"
    : undefined;

  return (
    <span
      className={className}
      style={{
        color: tint,
        backgroundColor: wash,
        boxShadow: ring,
        borderRadius: "var(--r-sm)",
        transition: reduced ? undefined : "color 320ms var(--ease, ease), background-color 320ms var(--ease, ease)",
      }}
    >
      {format(display)}
    </span>
  );
}
