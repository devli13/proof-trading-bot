"use client";

// Fleet filter bar + "Bots" caption. Mirrors public/index.html's .filters block:
// a scope radiogroup (Active|All), three labelled <select> groups (strategy/tag/market),
// and a clear button — followed by the hub-caption showing the filtered tallies. All
// state is owned by the shell; we only emit new FilterState via onChange.
import { useId } from "react";
import { useReducedMotion } from "framer-motion";
import type { FiltersProps } from "./contracts";
import type { FilterState } from "@/lib/types";
import { mkt, pnlStr, usd } from "@/lib/dashboard-lib";

export function Filters({ filter, onChange, strategies, tags, markets, count }: FiltersProps) {
  const reduce = useReducedMotion();
  const uid = useId();
  const stratId = `f-strategy-${uid}`;
  const tagId = `f-tag-${uid}`;
  const marketId = `f-market-${uid}`;

  const setScope = (scope: FilterState["scope"]) => onChange({ ...filter, scope });
  const setStrategy = (strategy: string) => onChange({ ...filter, strategy });
  const setTag = (tag: string) => onChange({ ...filter, tag });
  const setMarket = (market: string) => onChange({ ...filter, market });
  const clear = () => onChange({ scope: "active", strategy: "all", tag: "all", market: "all" });

  // Token-styled <select> — globals.css only colours .seg/.fctl, so the control surface
  // itself uses the design tokens inline (no new global CSS).
  const selectStyle: React.CSSProperties = {
    appearance: "none",
    background: "var(--surface-2)",
    color: "var(--tx)",
    border: "1px solid var(--border)",
    borderRadius: "var(--r-md)",
    padding: "4px 8px",
    font: "inherit",
    fontVariantNumeric: "tabular-nums",
    cursor: "pointer",
    transition: reduce ? "none" : "border-color .12s, background .12s",
  };

  return (
    <>
      <div className="filters" role="group" aria-label="Filters">
        <div className="seg f-scope" id="f-scope" role="radiogroup" aria-label="Scope">
          <button
            type="button"
            role="radio"
            aria-checked={filter.scope === "active"}
            data-scope="active"
            onClick={() => setScope("active")}
          >
            Active
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={filter.scope === "all"}
            data-scope="all"
            onClick={() => setScope("all")}
          >
            All
          </button>
        </div>

        <span className="fctl">
          <label htmlFor={stratId}>strategy</label>
          <select
            id={stratId}
            value={filter.strategy}
            onChange={(e) => setStrategy(e.target.value)}
            style={selectStyle}
          >
            <option value="all">all strategies</option>
            {strategies.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </span>

        <span className="fctl">
          <label htmlFor={tagId}>tag</label>
          <select
            id={tagId}
            value={filter.tag}
            onChange={(e) => setTag(e.target.value)}
            style={selectStyle}
          >
            <option value="all">all tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </span>

        <span className="fctl">
          <label htmlFor={marketId}>market</label>
          <select
            id={marketId}
            value={filter.market}
            onChange={(e) => setMarket(e.target.value)}
            style={selectStyle}
          >
            <option value="all">all markets</option>
            {markets.map((m) => (
              <option key={m} value={m}>
                {mkt(Number(m))}
              </option>
            ))}
          </select>
        </span>

        <button
          type="button"
          className="hdr-btn ghost-btn f-clear clear"
          aria-label="Clear all filters"
          onClick={clear}
        >
          clear
        </button>
      </div>

      <div className="hub-caption">
        <strong>Bots</strong>
        <span className="muted">
          showing {count.shown} of {count.total} · PnL {pnlStr(count.pnl)} · vol {usd(count.volume)}
        </span>
      </div>
    </>
  );
}
