import type { Range } from "./types.js";

export const RANGES: Range[] = ["1h", "1d", "7d", "30d", "all"];

// Minimum history span (ms) before a range option is worth offering. 1h/1d/all are
// always shown; 7d/30d only once dataSince implies we actually have that much history.
export const RANGE_NEED: Record<Range, number> = { "1h": 0, "1d": 0, "7d": 7 * 864e5, "30d": 30 * 864e5, all: 0 };

/** The range buttons worth showing given how much history exists. */
export function availableRanges(dataSince: string | null | undefined, now: number): Range[] {
  const span = dataSince ? now - Date.parse(dataSince) : 0;
  return RANGES.filter((r) => !(RANGE_NEED[r] > 0 && span < RANGE_NEED[r]));
}
