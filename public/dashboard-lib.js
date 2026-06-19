// Pure, DOM-free dashboard helpers — imported by index.html (browser, native ESM)
// AND by src/dashboard-lib.test.ts (vitest). Single source of truth so the tested
// logic IS the shipped logic. Time-based helpers accept an injectable `now` for
// deterministic tests (defaulting to Date.now() for the live dashboard).

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const MKT = { 7: "HYPE", 20300: "HYPE-CPY", 20301: "HYPE-CPN", 20302: "HYPE-EBY", 20303: "HYPE-EBN", 203: "HYPE #203" };
export const mkt = (m) => MKT[m] || ("m" + m);

export const usd = (m) => {
  if (m == null || isNaN(m)) return "—";
  const v = m / 1e6;
  return (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const pnlStr = (m) => {
  if (m == null || isNaN(m)) return "—";
  const v = m / 1e6;
  const g = v > 0 ? "+" : v < 0 ? "-" : "";
  return g + "$" + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const sign = (n) => (n == null ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "");

export const relTime = (t, now = Date.now()) => {
  if (!t) return "—";
  const s = (now - Date.parse(t)) / 1000;
  if (s < 0) return "just now";
  if (s < 10) return "just now";
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
};

export const absTime = (t) => (t ? new Date(t).toLocaleString() : "");

// Only registry-enabled bots can be alive/stale; legacy (main, enabled=null) and
// disabled bots get a hollow "off" dot — they aren't part of the running fleet.
export const dotClass = (b, now = Date.now()) =>
  b.enabled !== true ? "off" : b.lastTick && now - Date.parse(b.lastTick) < 10000 ? "alive" : "stale";
export const dotWord = (c) => ({ off: "Inactive", alive: "Alive", stale: "Stale" }[c] || "");

export const dim = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, "0");

export const side = (s) =>
  s === "Buy"
    ? '<span class="side"><span class="glyph">▲</span> Buy</span>'
    : '<span class="side"><span class="glyph">▼</span> Sell</span>';

export const num = (v) => (v == null ? 0 : Number(v));

// Insert a null point between samples >5min apart so the chart shows a gap, not a line.
export const withGaps = (pts) => {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (i && pts[i].x - pts[i - 1].x > 5 * 60000) out.push({ x: (pts[i].x + pts[i - 1].x) / 2, y: null });
    out.push(pts[i]);
  }
  return out;
};

// Filter predicate against the current filter state F = {scope,strategy,tag,market}.
export const botMatches = (b, F) => {
  if (F.scope === "active" && b.enabled !== true) return false;
  if (F.strategy !== "all" && !(b.strategies || []).includes(F.strategy)) return false;
  if (F.tag !== "all" && !(b.tags || []).includes(F.tag)) return false;
  if (F.market !== "all" && b.markets !== "all" && !(b.markets || []).map(String).includes(F.market)) return false;
  return true;
};

export function filteredSorted(bots, F, sortKey, sortDir) {
  const list = bots.filter((b) => botMatches(b, F));
  const val = (b) => (sortKey === "bot" ? b.bot : b[sortKey] ?? -Infinity);
  list.sort((a, c) => {
    const x = val(a), y = val(c);
    if (x < y) return -1 * sortDir;
    if (x > y) return 1 * sortDir;
    return a.bot < c.bot ? -1 : 1;
  });
  return list;
}

// Chart.js datasets for the History view: one line per visible bot with >=2 points.
export function buildDatasets(bots, F, chartMode, COLOR) {
  return bots
    .filter((b) => botMatches(b, F) && (b.series || []).length >= 2)
    .map((b) => ({
      botId: b.bot,
      label: b.bot,
      data: withGaps(
        b.series.map((p) => ({ x: Date.parse(p.ts), y: chartMode === "pnl" ? (p.equity - b.series[0].equity) / 1e6 : p.equity / 1e6 })),
      ),
      borderColor: COLOR[b.bot],
      backgroundColor: COLOR[b.bot],
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.15,
      spanGaps: false,
    }));
}

// Status-pill level: green = fresh + both endpoints up; red = no data / very stale; else degraded.
export function recomputePillLevel(statsOk, statusOk, dataAgeMs) {
  if (statsOk && statusOk && dataAgeMs < 30000) return "green";
  if (!statsOk || dataAgeMs > 180000) return "red";
  return "yellow";
}
