// Pure chart math, kept framework-free so vitest (src/livechart.test.ts) can import it.
// The old vanilla LiveChart class is replaced by liveline in the React build; only the
// pure helpers survive (still used by the live-chart Y-range easing).

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** A padded [min,max] for a chart Y axis; never zero-height. */
export function niceRange(min: number, max: number): [number, number] {
  if (!isFinite(min) || !isFinite(max)) return [-0.5, 0.5];
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }
  const pad = (max - min) * 0.12 || 0.5;
  return [min - pad, max + pad];
}
