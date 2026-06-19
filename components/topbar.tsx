"use client";
import { Fragment } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { TopbarProps } from "./contracts";
import { relTime, absTime } from "@/lib/dashboard-lib";
import { fadeUp, fast, pressable } from "@/lib/motion";

const PILL_LABEL = { green: "live", yellow: "degraded", red: "down" } as const;

export function Topbar({ fleet, onOpenJson }: TopbarProps) {
  const reduce = useReducedMotion() ?? false;
  const { data, status, pill } = fleet;
  const asOf = data?.asOf ?? null;
  const bots = data?.bots ?? [];

  // Mirror vanilla public/index.html renderPillTip — 7 rows derived from fleet data.
  const alive = bots.filter((b) => b.enabled === true && b.lastTick && fleet.now - Date.parse(b.lastTick) < 10000).length;
  const active = data?.aggregate.activeBots ?? 0;
  const lastTick = bots.reduce((m, b) => (b.lastTick && (!m || b.lastTick > m) ? b.lastTick : m), null as string | null);
  const tipRows: Array<[string, string]> = [
    ["Network", status?.network ?? "—"],
    ["Chain height", status?.height != null ? String(status.height) : "—"],
    ["API latency", fleet.latencyMs != null ? `${fleet.latencyMs} ms` : "—"],
    ["Data fresh", relTime(asOf, fleet.now)],
    ["Stream", fleet.streamConnected ? "● websocket" : "polling"],
    ["Bots alive", `${alive} / ${active}`],
    ["Last tick", relTime(lastTick, fleet.now)],
  ];

  const label = PILL_LABEL[pill];

  return (
    <motion.header
      className="topbar"
      initial={reduce ? false : "hidden"}
      animate="show"
      variants={fadeUp}
    >
      <div className="topbar-id">
        <h1>
          proof-trading-bot <span className="muted">· fleet</span>
        </h1>
        <p className="sub">
          Proof devnet · paper money · updated{" "}
          <time dateTime={asOf ?? ""} title={absTime(asOf)}>
            {relTime(asOf, fleet.now)}
          </time>
        </p>
      </div>

      <div className="topbar-actions">
        <motion.button
          type="button"
          className="pill"
          data-level={pill}
          aria-describedby="pill-tip"
          aria-label={`Status: ${label}`}
          whileHover={reduce ? undefined : pressable.whileHover}
          whileTap={reduce ? undefined : pressable.whileTap}
          transition={fast}
        >
          <span className="pill-dot" aria-hidden="true" />
          <span className="pill-label">{label}</span>
        </motion.button>
        <div id="pill-tip" className="pill-tip" role="tooltip">
          {tipRows.map(([k, v]) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </Fragment>
          ))}
        </div>

        <motion.button
          type="button"
          className="hdr-btn"
          onClick={onOpenJson}
          whileHover={reduce ? undefined : pressable.whileHover}
          whileTap={reduce ? undefined : pressable.whileTap}
          transition={fast}
        >
          {"{ } JSON"}
        </motion.button>
      </div>
    </motion.header>
  );
}
