// Shared client/server types for the dashboard. The per-bot stat shape is the
// single source of truth from the pure core (type-only import — erased at build).
import type { BotStat, BotMetrics } from "../src/stats-core.js";

export type { BotStat, BotMetrics };

export interface OrderRow {
  bot?: string;
  ts: string;
  strategy: string;
  kind: string;
  market: number;
  side: string;
  price: string;
  quantity: string;
  check_tx_code: number | null;
}

export interface DecisionAgg {
  bot?: string;
  strategy: string;
  action: string;
  c: number;
  last: string;
}

export interface ChangeRow {
  bot?: string;
  kind: string;
  before: unknown;
  after: unknown;
  note: string | null;
  ts: string;
}

export interface Aggregate {
  bots: number;
  activeBots: number;
  pnl: number;
  equity: number;
  volume: number;
  trades: number;
}

export interface StatsResponse {
  ok: true;
  asOf: string | null;
  range: string;
  dataSince: string | null;
  aggregate: Aggregate;
  bots: BotStat[];
  decisions: DecisionAgg[];
  recentOrders: OrderRow[];
  strategyLogic: Record<string, string>;
  makerInferred?: boolean;
}

export interface BotDetail {
  ok: true;
  bot: string;
  recentOrders: OrderRow[];
  decisions: DecisionAgg[];
  changes: ChangeRow[];
}

export interface StatusAccount {
  address: string;
  balance: string;
  equity: string;
  positions: number;
}

export interface StatusResponse {
  ok: boolean;
  network?: string;
  chainId?: string;
  height?: number;
  account?: StatusAccount | null;
  error?: string;
}

export type Range = "1h" | "1d" | "7d" | "30d" | "all";
export type ChartMode = "pnl" | "equity";
export type ChartView = "history" | "live";

export interface FilterState {
  scope: "active" | "all";
  strategy: string;
  tag: string;
  market: string;
}

export type PillLevel = "green" | "yellow" | "red";
