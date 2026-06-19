// Prop contracts for the dashboard components. The shell (dashboard.tsx) owns all
// state and passes these down; each component imports its Props from here so the
// signatures stay in lockstep. Pure types only.
import type {
  StatsResponse,
  Aggregate,
  BotStat,
  DecisionAgg,
  OrderRow,
  FilterState,
  Range,
  ChartMode,
  ChartView,
} from "@/lib/types";
import type { Fleet } from "@/lib/use-fleet";

export interface TopbarProps {
  fleet: Fleet;
  onOpenJson: () => void;
}

export interface KpiCardsProps {
  aggregate: Aggregate | null;
  range: Range;
  loading: boolean;
}

export interface AnimatedNumberProps {
  value: number;
  /** Map the (animated) numeric value to display text, e.g. usd/pnlStr. */
  format: (n: number) => string;
  className?: string;
  /** Flash tint direction on change; default derives from delta sign. */
  flash?: boolean;
}

export interface SparklineProps {
  series: Array<{ ts: string; equity: number }>;
  color: string;
  width?: number;
  height?: number;
  /** "pnl" normalizes to the first point; "equity" plots absolute. Default "pnl". */
  mode?: ChartMode;
}

export interface PerformanceChartProps {
  bots: BotStat[];
  filter: FilterState;
  colors: Record<string, string>;
  view: ChartView;
  onView: (v: ChartView) => void;
  mode: ChartMode;
  onMode: (m: ChartMode) => void;
  range: Range;
  onRange: (r: Range) => void;
  iso: string | null;
  onIso: (id: string | null) => void;
  dataSince: string | null;
  loading: boolean;
}

export interface FiltersProps {
  filter: FilterState;
  onChange: (f: FilterState) => void;
  strategies: string[];
  tags: string[];
  markets: string[];
  count: { shown: number; total: number; pnl: number; volume: number };
}

export interface BotsTableProps {
  bots: BotStat[]; // already filtered + sorted by the shell
  colors: Record<string, string>;
  now: number;
  sortKey: string;
  sortDir: number;
  onSort: (key: string) => void;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  strategyLogic: Record<string, string>;
  range: Range;
}

export interface BotDrawerProps {
  bot: BotStat;
  color: string;
  now: number;
  strategyLogic: Record<string, string>;
  range: Range;
}

export interface WinRateRadialProps {
  value: number | null; // 0..1
  size?: number;
}

export interface ExecQualityBarProps {
  makerPct: number | null;
  rejectRate: number | null;
  inferred?: boolean;
}

export interface InsightsProps {
  bots: BotStat[]; // filtered + sorted
  colors: Record<string, string>;
}

export interface ActivityProps {
  decisions: DecisionAgg[];
  recentOrders: OrderRow[];
  now: number;
}

export interface StrategyReferenceProps {
  strategyLogic: Record<string, string>;
  bots: BotStat[];
}

export interface JsonModalProps {
  open: boolean;
  onClose: () => void;
  data: StatsResponse | null;
}
