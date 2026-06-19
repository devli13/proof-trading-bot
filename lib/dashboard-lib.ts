// Pure, DOM-free dashboard helpers — the single tested source (src/dashboard-lib.test.ts
// imports this) reused by the React components. Time helpers accept an injectable `now`
// for deterministic tests (default Date.now() for the live dashboard).
import type { FilterState, PillLevel } from "./types.js";

/** Minimal structural shape the filter/sort/chart helpers read off a bot. */
export interface BotLike {
  bot: string;
  enabled?: boolean | null;
  strategies?: string[];
  tags?: string[];
  markets?: number[] | "all";
  lastTick?: string | null;
  series?: Array<{ ts: string; equity: number }>;
  [k: string]: unknown;
}

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export const MKT: Record<number, string> = { 7: "HYPE", 20300: "HYPE-CPY", 20301: "HYPE-CPN", 20302: "HYPE-EBY", 20303: "HYPE-EBN", 203: "HYPE #203" };
export const mkt = (m: number): string => MKT[m] ?? "m" + m;

export const usd = (m: number | null | undefined): string => {
  if (m == null || isNaN(m)) return "—";
  const v = m / 1e6;
  return (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const pnlStr = (m: number | null | undefined): string => {
  if (m == null || isNaN(m)) return "—";
  const v = m / 1e6;
  const g = v > 0 ? "+" : v < 0 ? "-" : "";
  return g + "$" + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const sign = (n: number | null | undefined): "pos" | "neg" | "" => (n == null ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "");

export const relTime = (t: string | null | undefined, now: number = Date.now()): string => {
  if (!t) return "—";
  const s = (now - Date.parse(t)) / 1000;
  if (s < 0) return "just now";
  if (s < 10) return "just now";
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};

export const absTime = (t: string | null | undefined): string => (t ? new Date(t).toLocaleString() : "");

// Only registry-enabled bots can be alive/stale; legacy (enabled=null) and disabled
// bots get a hollow "off" dot — they aren't part of the running fleet.
export const dotClass = (b: { enabled?: boolean | null; lastTick?: string | null }, now: number = Date.now()): "off" | "alive" | "stale" =>
  b.enabled !== true ? "off" : b.lastTick && now - Date.parse(b.lastTick) < 10000 ? "alive" : "stale";
export const dotWord = (c: string): string => ({ off: "Inactive", alive: "Alive", stale: "Stale" })[c] ?? "";

export const dim = (hex: string, a: number): string => hex + Math.round(a * 255).toString(16).padStart(2, "0");

export const num = (v: unknown): number => (v == null ? 0 : Number(v));

export interface XY {
  x: number;
  y: number | null;
}

// Insert a null point between samples >5min apart so the chart shows a gap, not a line.
export const withGaps = (pts: XY[]): XY[] => {
  const out: XY[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const prev = pts[i - 1];
    if (i && prev && p.x - prev.x > 5 * 60000) out.push({ x: (p.x + prev.x) / 2, y: null });
    out.push(p);
  }
  return out;
};

// Filter predicate against the current filter state F = {scope,strategy,tag,market}.
export const botMatches = (b: BotLike, F: FilterState): boolean => {
  if (F.scope === "active" && b.enabled !== true) return false;
  if (F.strategy !== "all" && !(b.strategies ?? []).includes(F.strategy)) return false;
  if (F.tag !== "all" && !(b.tags ?? []).includes(F.tag)) return false;
  if (F.market !== "all" && b.markets !== "all" && !(b.markets ?? []).map(String).includes(F.market)) return false;
  return true;
};

export function filteredSorted<T extends BotLike>(bots: T[], F: FilterState, sortKey: string, sortDir: number): T[] {
  const list = bots.filter((b) => botMatches(b, F));
  const val = (b: T): number | string => (sortKey === "bot" ? b.bot : ((b[sortKey] as number | undefined) ?? -Infinity));
  list.sort((a, c) => {
    const x = val(a);
    const y = val(c);
    if (x < y) return -1 * sortDir;
    if (x > y) return 1 * sortDir;
    return a.bot < c.bot ? -1 : 1;
  });
  return list;
}

export interface LineDataset {
  botId: string;
  label: string;
  data: XY[];
  borderColor: string;
  backgroundColor: string;
  borderWidth: number;
  pointRadius: number;
  pointHoverRadius: number;
  tension: number;
  spanGaps: boolean;
}

// Chart.js datasets for the History view: one line per visible bot with >=2 points.
export function buildDatasets(bots: BotLike[], F: FilterState, chartMode: string, COLOR: Record<string, string>): LineDataset[] {
  return bots
    .filter((b) => botMatches(b, F) && (b.series ?? []).length >= 2)
    .map((b) => {
      const s = b.series ?? [];
      const base = s[0]?.equity ?? 0;
      return {
        botId: b.bot,
        label: b.bot,
        data: withGaps(s.map((p) => ({ x: Date.parse(p.ts), y: chartMode === "pnl" ? (p.equity - base) / 1e6 : p.equity / 1e6 }))),
        borderColor: COLOR[b.bot] ?? "#7aa2ff",
        backgroundColor: COLOR[b.bot] ?? "#7aa2ff",
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.15,
        spanGaps: false,
      };
    });
}

// Status-pill level: green = fresh + both endpoints up; red = no data / very stale; else degraded.
export function recomputePillLevel(statsOk: boolean, statusOk: boolean, dataAgeMs: number): PillLevel {
  if (statsOk && statusOk && dataAgeMs < 30000) return "green";
  if (!statsOk || dataAgeMs > 180000) return "red";
  return "yellow";
}
