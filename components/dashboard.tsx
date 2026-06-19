"use client";
import { useMemo, useRef, useState } from "react";
import { LayoutGroup } from "framer-motion";
import { useFleet } from "@/lib/use-fleet";
import { filteredSorted, relTime, pnlStr } from "@/lib/dashboard-lib";
import { assignColors } from "@/lib/colors";

const PILL_LABEL = { green: "live", yellow: "degraded", red: "down" } as const;
import type { StatsResponse, FilterState, ChartMode, ChartView } from "@/lib/types";
import { Topbar } from "./topbar";
import { KpiCards } from "./kpi-cards";
import { PerformanceChart } from "./performance-chart";
import { Insights } from "./insights";
import { Filters } from "./filters";
import { BotsTable } from "./bots-table";
import { Activity } from "./activity";
import { StrategyReference } from "./strategy-reference";
import { JsonModal } from "./json-modal";

/** Root client component: owns all UI state, derives the filtered/sorted view + filter
 *  options, and wires everything to the live fleet data (realtime + poll). */
export function Dashboard({ initial }: { initial: StatsResponse | null }) {
  const fleet = useFleet(initial, "1h");
  const data = fleet.data;
  const bots = useMemo(() => data?.bots ?? [], [data]);

  const [filter, setFilter] = useState<FilterState>({ scope: "active", strategy: "all", tag: "all", market: "all" });
  const [sortKey, setSortKey] = useState<string>("pnl");
  const [sortDir, setSortDir] = useState<number>(-1);
  const [chartView, setChartView] = useState<ChartView>("history");
  const [chartMode, setChartMode] = useState<ChartMode>("pnl");
  const [iso, setIso] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [jsonOpen, setJsonOpen] = useState(false);

  const colors = useMemo(() => assignColors(bots.map((b) => b.bot)), [bots]);

  // Filtered + sorted, BUT the row order is FROZEN while any drawer is open — so reading
  // an expanded bot isn't disrupted by the fleet constantly re-sorting under it. New data
  // still flows into each row; only the ordering holds. When everything collapses it
  // re-sorts (and the rows glide via framer-motion layout in <BotsTable/>).
  const orderRef = useRef<string[]>([]);
  const visible = useMemo(() => {
    const sorted = filteredSorted(bots, filter, sortKey, sortDir);
    if (expanded.size === 0) {
      orderRef.current = sorted.map((b) => b.bot);
      return sorted;
    }
    const byId = new Map(sorted.map((b) => [b.bot, b]));
    const held = orderRef.current.map((id) => byId.get(id)).filter((b): b is (typeof sorted)[number] => b != null);
    const heldIds = new Set(orderRef.current);
    const fresh = sorted.filter((b) => !heldIds.has(b.bot)); // bots that newly appeared
    return [...held, ...fresh];
  }, [bots, filter, sortKey, sortDir, expanded]);

  const { strategies, tags, markets } = useMemo(() => {
    const s = new Set<string>();
    const tg = new Set<string>();
    const mk = new Set<string>();
    for (const b of bots) {
      (b.strategies ?? []).forEach((x) => s.add(x));
      (b.tags ?? []).forEach((x) => tg.add(x));
      if (b.markets !== "all") (b.markets ?? []).forEach((x) => mk.add(String(x)));
    }
    return { strategies: [...s].sort(), tags: [...tg].sort(), markets: [...mk].sort() };
  }, [bots]);

  const count = useMemo(
    () => ({
      shown: visible.length,
      total: bots.length,
      pnl: visible.reduce((a, b) => a + (b.pnl ?? 0), 0),
      volume: visible.reduce((a, b) => a + b.volume, 0),
    }),
    [visible, bots],
  );

  const onSort = (key: string) => {
    if (key === sortKey) setSortDir((d) => -d);
    else {
      setSortKey(key);
      setSortDir(key === "bot" ? 1 : -1);
    }
  };
  const onToggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const aliveCount = useMemo(
    () => bots.filter((b) => b.enabled === true && b.lastTick && fleet.now - Date.parse(b.lastTick) < 10000).length,
    [bots, fleet.now],
  );
  const liveMsg = data
    ? `Updated ${relTime(data.asOf, fleet.now)}. Fleet PnL ${pnlStr(data.aggregate.pnl)}, ${aliveCount} of ${data.aggregate.activeBots} bots alive. Status: ${PILL_LABEL[fleet.pill]}.`
    : "";

  return (
    <div className="wrap">
      <a href="#bots-hub" className="sr-only skip">Skip to fleet</a>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{liveMsg}</div>
      <Topbar fleet={fleet} onOpenJson={() => setJsonOpen(true)} />
      <KpiCards aggregate={data?.aggregate ?? null} range={fleet.range} loading={!data} />
      <PerformanceChart
        bots={bots}
        filter={filter}
        colors={colors}
        view={chartView}
        onView={setChartView}
        mode={chartMode}
        onMode={setChartMode}
        range={fleet.range}
        onRange={fleet.setRange}
        iso={iso}
        onIso={setIso}
        dataSince={data?.dataSince ?? null}
      />
      <Insights bots={visible} colors={colors} />
      <Filters filter={filter} onChange={setFilter} strategies={strategies} tags={tags} markets={markets} count={count} />
      <LayoutGroup>
        <BotsTable
          bots={visible}
          colors={colors}
          now={fleet.now}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={onSort}
          expanded={expanded}
          onToggle={onToggle}
          strategyLogic={data?.strategyLogic ?? {}}
          range={fleet.range}
        />
      </LayoutGroup>
      <Activity decisions={data?.decisions ?? []} recentOrders={data?.recentOrders ?? []} now={fleet.now} />
      <StrategyReference strategyLogic={data?.strategyLogic ?? {}} bots={bots} />
      <JsonModal open={jsonOpen} onClose={() => setJsonOpen(false)} data={data} />
    </div>
  );
}
