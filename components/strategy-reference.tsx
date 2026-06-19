"use client";
import { useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { StrategyReferenceProps } from "./contracts";
import { enter } from "@/lib/motion";

/**
 * Collapsible glossary of the strategies the fleet is actually running. We take the
 * union of every bot's `strategies`, sort it, and look each one up in `strategyLogic`
 * (falling back to "—" when no description exists). The native <details> element drives
 * the open/close + caret rotation via the global CSS (details[open] summary .caret).
 */
export function StrategyReference({ strategyLogic, bots }: StrategyReferenceProps) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);

  // Sorted, de-duplicated union of in-use strategy ids across the fleet.
  const strategies = useMemo(() => {
    const set = new Set<string>();
    for (const b of bots) {
      for (const s of b.strategies ?? []) {
        if (s) set.add(s);
      }
    }
    return [...set].sort((a, c) => a.localeCompare(c));
  }, [bots]);

  return (
    <details
      id="reference"
      className="reference"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="caret" aria-hidden="true">
          ›
        </span>{" "}
        Strategy reference
      </summary>

      <AnimatePresence initial={false}>
        {open ? (
          strategies.length ? (
            <motion.dl
              id="reference-dl"
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0 }}
              transition={enter}
            >
              {strategies.map((s) => (
                <div key={s} style={{ display: "contents" }}>
                  <dt>{s}</dt>
                  <dd>{strategyLogic[s] ?? "—"}</dd>
                </div>
              ))}
            </motion.dl>
          ) : (
            <motion.dl
              id="reference-dl"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduce ? undefined : { opacity: 0 }}
              transition={enter}
            >
              <div className="empty" style={{ gridColumn: "1 / -1" }}>
                no strategies
              </div>
            </motion.dl>
          )
        ) : null}
      </AnimatePresence>
    </details>
  );
}
