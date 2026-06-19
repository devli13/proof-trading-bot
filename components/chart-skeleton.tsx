"use client";
import { useEffect, useState } from "react";

/**
 * Graph-shaped loading state for the Performance chart — a faint self-drawing line over
 * placeholder gridlines with a shimmer sweep, plus a live elapsed-seconds counter so a
 * slow window load reads as "progressing", never "stuck" or "no data". Replaces the bare
 * "no equity history" text whenever we're actually still fetching.
 */
export function ChartSkeleton({ range }: { range: string }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setSecs(Math.max(0, Math.round((Date.now() - t0) / 1000))), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="chart-skel" role="status" aria-label={`Loading ${range} data`}>
      <svg className="chart-skel-svg" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        {[8, 16, 24, 32].map((y) => (
          <line key={y} x1="0" y1={y} x2="100" y2={y} className="csk-grid" />
        ))}
        <path className="csk-line" fill="none" d="M0,31 C9,30 15,21 24,23 S40,12 52,17 70,27 82,11 100,16" />
      </svg>
      <div className="chart-skel-label">
        <span className="csk-dot" aria-hidden="true" />
        Loading {range} data… <span className="csk-secs">{secs}s</span>
      </div>
    </div>
  );
}
