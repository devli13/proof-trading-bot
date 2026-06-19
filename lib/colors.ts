// Per-bot line colors for the charts/legend/sparklines. Assigned by sorted bot id so a
// bot keeps the same color across renders.
export const LINE_COLORS = [
  "#7aa2ff", "#c792ea", "#4dd0e1", "#ffd166", "#a3e635", "#f78fb3",
  "#60a5fa", "#34d399", "#e0a3ff", "#5eead4", "#fbbf24", "#93c5fd",
];

export function assignColors(botIds: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  [...botIds].sort().forEach((id, i) => {
    out[id] = LINE_COLORS[i % LINE_COLORS.length]!;
  });
  return out;
}
