"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabase } from "./supabase-browser.js";
import { fetchStats, fetchStatus } from "./api.js";
import { recomputePillLevel } from "./dashboard-lib.js";
import type { StatsResponse, StatusResponse, Range, PillLevel } from "./types.js";

export interface Fleet {
  data: StatsResponse | null;
  status: StatusResponse | null;
  range: Range;
  setRange: (r: Range) => void;
  streamConnected: boolean;
  latencyMs: number | null;
  pill: PillLevel;
  now: number;
  refetch: () => void;
}

/**
 * Owns the live fleet data: seed from the RSC `initial`, then hydrate to realtime —
 * a Supabase broadcast (channel "proof_bot_fleet", event "change") debounce-refetches
 * /api/stats, with a 5s/20s poll fallback, a 10s /api/status latency loop, a 15s clock
 * for relative timestamps, and a derived status-pill level. Filters/sort stay in the UI.
 */
export function useFleet(initial: StatsResponse | null, initialRange: Range = "1h"): Fleet {
  const [data, setData] = useState<StatsResponse | null>(initial);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [range, setRange] = useState<Range>(initialRange);
  const [streamConnected, setStreamConnected] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [pill, setPill] = useState<PillLevel>("yellow");
  const [now, setNow] = useState<number>(() => Date.now());

  const rangeRef = useRef(range);
  rangeRef.current = range;
  const acRef = useRef<AbortController | null>(null);
  const firstRun = useRef(true);

  const refetch = useCallback(() => {
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    fetchStats(rangeRef.current, ac.signal)
      .then((j) => {
        if (j && j.ok) setData(j);
      })
      .catch(() => {
        /* aborted or network blip — keep last good data */
      });
  }, []);

  // Realtime broadcast + polling fallback. Re-runs on range change (immediate refetch).
  useEffect(() => {
    let alive = true;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let connected = false;

    if (firstRun.current && initial) {
      firstRun.current = false; // use the seeded data; don't double-fetch on mount
    } else {
      refetch();
    }

    const schedule = () => {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(
        () => {
          if (!document.hidden) refetch();
          schedule();
        },
        connected ? 20000 : 5000,
      );
    };
    schedule();

    const sb = getSupabase();
    let channel: RealtimeChannel | undefined;
    if (sb) {
      channel = sb
        .channel("proof_bot_fleet")
        .on("broadcast", { event: "change" }, () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            if (!document.hidden) refetch();
          }, 1200);
        })
        .subscribe((s) => {
          connected = s === "SUBSCRIBED";
          if (alive) setStreamConnected(connected);
          schedule();
        });
    }

    const onVis = () => {
      if (!document.hidden) refetch();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      alive = false;
      clearTimeout(pollTimer);
      clearTimeout(debounceTimer);
      document.removeEventListener("visibilitychange", onVis);
      if (sb && channel) sb.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, refetch]);

  // Status loop (latency + liveness).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const t0 = performance.now();
      try {
        const s = await fetchStatus();
        if (!alive) return;
        setStatus(s);
        setLatencyMs(Math.round(performance.now() - t0));
      } catch {
        if (alive) setStatus({ ok: false });
      }
      timer = setTimeout(tick, 10000);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // Ticking clock for relative timestamps + staleness.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  // Derived status-pill level.
  useEffect(() => {
    const statsOk = !!data?.ok;
    const statusOk = !!status?.ok;
    const dataAge = data?.asOf ? now - Date.parse(data.asOf) : Infinity;
    setPill(recomputePillLevel(statsOk, statusOk, dataAge));
  }, [data, status, now]);

  return { data, status, range, setRange, streamConnected, latencyMs, pill, now, refetch };
}
