"use client";
// Live PnL leaderboard. Each bot is its own <motion.tbody> so framer's shared
// layout (parent <LayoutGroup>) makes rows GLIDE to their new slot when the sort
// order changes — that reorder is the headline interaction. Table semantics
// (thead/tbody/tr/td) are preserved so the existing global CSS + the <560px
// data-k card layout in globals.css both still apply.
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { BotsTableProps } from "./contracts";
import type { BotStat, Range } from "@/lib/types";
import { dotClass, dotWord, mkt, pnlStr, relTime, sign, usd } from "@/lib/dashboard-lib";
import { drawerVariants, layoutSpring } from "@/lib/motion";
import { BotDrawer } from "./bot-drawer";
import { Sparkline } from "./sparkline";

// Column model mirrors public/index.html's COLS, extended (per spec) with the
// Trend sparkline + Avg/Win metric columns. `key` doubles as the sort key the
// shell understands; `label` is the visible header AND the mobile card data-k.
interface Col {
  key: string;
  label: string;
  /** left-aligned text column (gets td.l / th.l) vs right-aligned numeric. */
  left?: boolean;
  /** purely visual column — not sortable (Trend sparkline). */
  noSort?: boolean;
}

const COLS: Col[] = [
  { key: "bot", label: "Bot", left: true },
  { key: "strategies", label: "Strategies", left: true },
  { key: "markets", label: "Markets", left: true },
  { key: "series", label: "Trend", noSort: true },
  { key: "pnl", label: "PnL" },
  { key: "equity", label: "Equity" },
  { key: "volume", label: "Vol" },
  { key: "trades", label: "Trades" },
  { key: "avgTradeSize", label: "Avg", noSort: true },
  { key: "winRate", label: "Win", noSort: true },
  { key: "lastTrade", label: "Last trade" },
];

// One <td> per column for the visible row. data-k carries the column label so the
// <560px card layout (td::before { content: attr(data-k) }) can label each cell.
function pctOrDash(v: number | null | undefined): string {
  return v != null ? Math.round(v * 100) + "%" : "—";
}

function RowCells({ bot, color, now }: { bot: BotStat; color: string; now: number }) {
  const dc = dotClass(bot, now);
  const strat = bot.strategies ?? [];
  const shownStrat = strat.slice(0, 2);
  const extraStrat = strat.length - shownStrat.length;
  const mk =
    bot.markets === "all"
      ? "all"
      : (bot.markets ?? []).slice(0, 2).map(mkt).join(", ") || "—";
  const extraMk = bot.markets !== "all" && (bot.markets ?? []).length > 2 ? ` +${(bot.markets as number[]).length - 2}` : "";
  const m = bot.metrics;

  return (
    <>
      {/* Bot: caret + status dot + id. caret-cell so the mobile layout spans full width. */}
      <td className="l caret-cell" data-k="Bot">
        <span className="caret" aria-hidden="true">›</span>
        <span className={`dot ${dc}`} aria-hidden="true" />
        <span className="sr-only">{dotWord(dc)} </span>
        {bot.bot}
      </td>

      <td className="l" data-k="Strategies">
        {shownStrat.length
          ? shownStrat.map((s) => (
              <span key={s} className="chip chip-strat">
                {s}
              </span>
            ))
          : "—"}
        {extraStrat > 0 ? <span className="chip">+{extraStrat}</span> : null}
      </td>

      <td className="l muted" data-k="Markets">
        {mk}
        {extraMk}
      </td>

      <td data-k="Trend">
        <Sparkline series={bot.series ?? []} color={color} />
      </td>

      <td className={`num pnl ${sign(bot.pnl)}`} data-k="PnL">
        {pnlStr(bot.pnl)}
      </td>
      <td className="num" data-k="Equity">
        {usd(bot.equity)}
      </td>
      <td className="num" data-k="Vol">
        {usd(bot.volume)}
      </td>
      <td className="num" data-k="Trades">
        {bot.trades ?? 0}
      </td>
      <td className="num" data-k="Avg">
        {m?.avgTradeSize != null ? usd(m.avgTradeSize) : "—"}
      </td>
      <td className="num" data-k="Win">
        {pctOrDash(m?.winRate)}
      </td>
      <td className="num" data-k="Last trade">
        <time dateTime={bot.lastTrade ?? undefined}>{relTime(bot.lastTrade, now)}</time>
      </td>

      {/* trailing spacer matches the reference's empty <th>; hidden on mobile. */}
      <td aria-hidden="true" />
    </>
  );
}

// One <motion.tbody> per bot (stable key=bot.bot). `layout` + the parent
// <LayoutGroup> drive the glide-on-reorder; reduced motion makes it instant.
function BotGroup({
  bot,
  color,
  now,
  isOpen,
  onToggle,
  strategyLogic,
  range,
  reduce,
}: {
  bot: BotStat;
  color: string;
  now: number;
  isOpen: boolean;
  onToggle: (id: string) => void;
  strategyLogic: Record<string, string>;
  range: Range;
  reduce: boolean;
}) {
  const rowId = `r-${bot.bot}`;
  const drawerId = `d-${bot.bot}`;

  return (
    <motion.tbody
      className="bot-group"
      data-bot={bot.bot}
      layout={reduce ? false : "position"}
      transition={layoutSpring}
      style={{ position: "relative" }}
    >
      <tr
        className="bot-row"
        role="button"
        tabIndex={0}
        id={rowId}
        aria-controls={drawerId}
        aria-expanded={isOpen}
        onClick={() => onToggle(bot.bot)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle(bot.bot);
          }
        }}
      >
        <RowCells bot={bot} color={color} now={now} />
      </tr>

      <tr className="drawer-row">
        <td className="drawer-cell" colSpan={COLS.length + 1}>
          <div id={drawerId} role="region" aria-labelledby={rowId}>
            <AnimatePresence initial={false}>
              {isOpen ? (
                <motion.div
                  key="drawer"
                  className="drawer-inner show"
                  style={{ overflow: "hidden" }}
                  variants={drawerVariants}
                  initial={reduce ? false : "collapsed"}
                  animate="open"
                  exit={reduce ? { opacity: 0 } : "collapsed"}
                >
                  <BotDrawer bot={bot} color={color} now={now} strategyLogic={strategyLogic} range={range} />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </td>
      </tr>
    </motion.tbody>
  );
}

export function BotsTable({
  bots,
  colors,
  now,
  sortKey,
  sortDir,
  onSort,
  expanded,
  onToggle,
  strategyLogic,
  range,
}: BotsTableProps) {
  const reduce = useReducedMotion() ?? false;

  const ariaSort = (key: string): "ascending" | "descending" | "none" => {
    if (key !== sortKey) return "none";
    return sortDir > 0 ? "ascending" : "descending";
  };

  const pnlLabel = `PnL · ${range}`;

  return (
    <section className="bots-hub" id="bots-hub">
      <div className="tablewrap" role="region" aria-label="Bots fleet" tabIndex={0}>
        <table>
          <thead>
            <tr>
              {COLS.map((c) => {
                const sortable = !c.noSort;
                const label = c.key === "pnl" ? pnlLabel : c.label;
                return (
                  <th
                    key={c.key}
                    className={c.left ? "l" : undefined}
                    role="columnheader"
                    aria-sort={sortable ? ariaSort(c.key) : undefined}
                    tabIndex={sortable ? 0 : undefined}
                    onClick={sortable ? () => onSort(c.key) : undefined}
                    onKeyDown={
                      sortable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onSort(c.key);
                            }
                          }
                        : undefined
                    }
                    style={sortable ? { cursor: "pointer" } : undefined}
                  >
                    {label}
                  </th>
                );
              })}
              <th aria-hidden="true" />
            </tr>
          </thead>

          {bots.map((b) => (
            <BotGroup
              key={b.bot}
              bot={b}
              color={colors[b.bot] ?? "#7aa2ff"}
              now={now}
              isOpen={expanded.has(b.bot)}
              onToggle={onToggle}
              strategyLogic={strategyLogic}
              range={range}
              reduce={reduce}
            />
          ))}
        </table>
      </div>
    </section>
  );
}
