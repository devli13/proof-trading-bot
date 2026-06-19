"use client";

// Fleet hero strip — the at-a-glance top of the page. Four tiles that reuse the existing
// .kpis/.card layout, but each now carries a small fleet-level trend so the numbers have
// shape: Fleet PnL leads with a filled area chart (the single overall fleet-PnL visual),
// Volume gets per-bucket bars, Equity a line, and Active bots a live ratio bar. The
// sparklines are intentionally small/integrated — additive, not another big chart.
import { motion, useReducedMotion } from "framer-motion";
import type { Aggregate, FleetPoint } from "@/lib/types";
import { usd, pnlStr, sign } from "@/lib/dashboard-lib";
import { EASE_OUT } from "@/lib/motion";
import { AnimatedNumber } from "./animated-number";

export function FleetHero({
  aggregate,
  fleetSeries,
  range,
  loading,
}: {
  aggregate: Aggregate | null;
  fleetSeries: FleetPoint[];
  range: string;
  loading: boolean;
}) {
  const reduced = useReducedMotion() ?? false;

  if (loading || !aggregate) {
    return (
      <section className="kpis" aria-label="Fleet totals" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card skel skel-card" />
        ))}
      </section>
    );
  }

  // Carry forward null equity buckets so the line/area are continuous.
  const eqRaw: number[] = [];
  let last = 0;
  for (const p of fleetSeries) {
    if (p.equity != null) last = p.equity;
    eqRaw.push(last);
  }
  const base = eqRaw.length ? eqRaw[0]! : 0;
  const pnlVals = eqRaw.map((v) => (v - base) / 1e6); // $ delta vs window start
  const eqVals = eqRaw.map((v) => v / 1e6);
  const volVals = fleetSeries.map((p) => p.volume / 1e6);

  const s = sign(aggregate.pnl);
  const pnlClass = "card card-pnl" + (s === "pos" ? " is-pos" : s === "neg" ? " is-neg" : "");
  const pnlColor = s === "pos" ? "var(--money-pos)" : s === "neg" ? "var(--money-neg)" : "var(--tx-3)";
  const activeFrac = aggregate.bots > 0 ? aggregate.activeBots / aggregate.bots : 0;

  const anim = (i: number) =>
    reduced
      ? {}
      : {
          initial: { opacity: 0, y: 8 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.32, ease: EASE_OUT, delay: i * 0.04 },
        };

  return (
    <section className="kpis" aria-label="Fleet totals" aria-busy="false">
      <motion.div className={pnlClass} {...anim(0)}>
        <div className="k">
          Fleet PnL <span className="muted">· {range}</span>
        </div>
        <div className="v">
          <AnimatedNumber value={aggregate.pnl} format={pnlStr} />
        </div>
        {pnlVals.length >= 2 && <MiniChart values={pnlVals} kind="area" color={pnlColor} height={46} baseline={0} />}
      </motion.div>

      <motion.div className="card" {...anim(1)}>
        <div className="k">
          Volume <span className="muted">· {range}</span>
        </div>
        <div className="v">
          <AnimatedNumber value={aggregate.volume} format={usd} />
        </div>
        {volVals.length >= 2 && <MiniChart values={volVals} kind="bars" color="var(--accent-2)" height={26} />}
      </motion.div>

      <motion.div className="card" {...anim(2)}>
        <div className="k">Equity</div>
        <div className="v">
          <AnimatedNumber value={aggregate.equity} format={usd} />
        </div>
        {eqVals.length >= 2 && <MiniChart values={eqVals} kind="line" color="var(--accent)" height={26} />}
      </motion.div>

      <motion.div className="card" {...anim(3)}>
        <div className="k">Active bots</div>
        <div className="v">
          {aggregate.activeBots} <span className="muted">/ {aggregate.bots}</span>
        </div>
        <div className="ratio-bar" aria-hidden="true">
          <motion.div
            className="ratio-fill"
            initial={reduced ? false : { scaleX: 0 }}
            animate={{ scaleX: activeFrac }}
            transition={{ duration: 0.5, ease: EASE_OUT }}
          />
        </div>
      </motion.div>
    </section>
  );
}

/** Tiny axis-less fleet chart: filled area (PnL), line (equity), or per-bucket bars (volume).
 *  Stretches to the tile width via a 0..100 viewBox + non-uniform scaling. */
function MiniChart({
  values,
  kind,
  color,
  height = 26,
  baseline,
}: {
  values: number[];
  kind: "area" | "line" | "bars";
  color: string;
  height?: number;
  baseline?: number;
}) {
  const W = 100;
  const H = height;
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (kind === "bars") lo = Math.min(0, lo);
  if (baseline != null) {
    lo = Math.min(lo, baseline);
    hi = Math.max(hi, baseline);
  }
  const span = hi - lo || 1;
  const pad = kind === "bars" ? 0 : span * 0.12;
  const min = lo - pad;
  const max = hi + pad;
  const range = max - min || 1;
  const n = values.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : W / 2);
  const y = (v: number) => H - ((v - min) / range) * H;
  const gid = `g-${kind}-${Math.round(values[n - 1] ?? 0)}`;

  if (kind === "bars") {
    const bw = Math.max(0.6, (W / n) * 0.7);
    const y0 = y(Math.max(0, min));
    return (
      <svg className="card-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" height={H} aria-hidden="true">
        {values.map((v, i) => {
          const yy = y(v);
          return <rect key={i} x={x(i) - bw / 2} y={Math.min(yy, y0)} width={bw} height={Math.max(0.5, Math.abs(y0 - yy))} fill={color} opacity={0.75} rx={0.3} />;
        })}
      </svg>
    );
  }

  const pts = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  return (
    <svg className="card-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" height={H} aria-hidden="true">
      {kind === "area" && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <polygon points={`0,${H} ${pts} ${W},${H}`} fill={`url(#${gid})`} stroke="none" />
        </>
      )}
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
