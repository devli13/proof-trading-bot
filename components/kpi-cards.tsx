"use client";

// Fleet totals strip — four .card tiles (PnL · range / Volume / Equity / Active bots).
// Reuses the vanilla dashboard's exact labels, class set, and column emphasis (the PnL
// card spans 2fr and recolors by sign). Numbers tween + flash via <AnimatedNumber/>;
// the "Active bots" tile is a plain count ("active / total"), no money formatting.
import { motion, useReducedMotion } from "framer-motion";
import type { KpiCardsProps } from "./contracts";
import { usd, pnlStr, sign } from "@/lib/dashboard-lib";
import { EASE_OUT } from "@/lib/motion";
import { AnimatedNumber } from "./animated-number";

export function KpiCards({ aggregate, range, loading }: KpiCardsProps) {
  const reduced = useReducedMotion();

  if (loading || !aggregate) {
    return (
      <section className="kpis" aria-label="Fleet totals" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card skel skel-card" />
        ))}
      </section>
    );
  }

  const s = sign(aggregate.pnl); // "pos" | "neg" | ""
  const pnlClass =
    "card card-pnl" + (s === "pos" ? " is-pos" : s === "neg" ? " is-neg" : "");

  // Direct per-card initial/animate (a stagger-parent variant wasn't reliably
  // propagating to the children, which left the cards stuck at opacity:0).
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
      </motion.div>

      <motion.div className="card" {...anim(1)}>
        <div className="k">Volume</div>
        <div className="v">
          <AnimatedNumber value={aggregate.volume} format={usd} />
        </div>
      </motion.div>

      <motion.div className="card" {...anim(2)}>
        <div className="k">Equity</div>
        <div className="v">
          <AnimatedNumber value={aggregate.equity} format={usd} />
        </div>
      </motion.div>

      <motion.div className="card" {...anim(3)}>
        <div className="k">Active bots</div>
        <div className="v">
          {aggregate.activeBots} / {aggregate.bots}
        </div>
      </motion.div>
    </section>
  );
}
