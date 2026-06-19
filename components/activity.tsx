"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ActivityProps } from "./contracts";
import type { ChangeRow } from "@/lib/types";
import { mkt, num, relTime, usd } from "@/lib/dashboard-lib";
import { enter } from "@/lib/motion";
import { fetchChangelog } from "@/lib/api";

type Tab = "orders" | "decisions" | "changes";

/**
 * Collapsible activity feed mirroring the vanilla dashboard's <details id="activity">.
 * A .seg switches between three panels: recent Orders and aggregated Decisions (both
 * passed in from the shell), plus a Changes (strategy changelog) tab that is lazily
 * fetched from /api/stats?changes=1 the first time it is opened. The native <details>
 * drives the caret rotation via global CSS (details[open] summary .caret); we mirror
 * `open` into state only to gate the body animation and the lazy fetch.
 */
export function Activity({ decisions, recentOrders, now }: ActivityProps) {
  const reduce = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("orders");

  // Lazy changelog: fetched once, the first time the Changes panel becomes visible.
  const [changes, setChanges] = useState<ChangeRow[] | null>(null);
  const [changesLoading, setChangesLoading] = useState(false);

  useEffect(() => {
    if (!open || tab !== "changes" || changes !== null || changesLoading) return;
    let alive = true;
    const ac = new AbortController();
    setChangesLoading(true);
    fetchChangelog(ac.signal)
      .then((j) => {
        if (alive) setChanges(j && j.ok ? (j.changes ?? []) : []);
      })
      .catch(() => {
        if (alive) setChanges([]); // network/abort — show empty rather than spin forever
      })
      .finally(() => {
        if (alive) setChangesLoading(false);
      });
    return () => {
      alive = false;
      ac.abort();
    };
  }, [open, tab, changes, changesLoading]);

  const orders = recentOrders.slice(0, 60);
  const decs = decisions.slice(0, 80);

  const bodyMotion = {
    initial: reduce ? false : ({ opacity: 0, y: 4 } as const),
    animate: { opacity: 1, y: 0 },
    transition: enter,
  };

  return (
    <details
      id="activity"
      className="activity"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="caret" aria-hidden="true">
          ›
        </span>{" "}
        Activity{" "}
        <span className="muted">
          · {recentOrders.length} orders · {decisions.length} decision groups
        </span>
      </summary>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div className="activity-body" {...bodyMotion}>
            <div className="seg" role="tablist" aria-label="Activity views">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "orders"}
                onClick={() => setTab("orders")}
              >
                Orders
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "decisions"}
                onClick={() => setTab("decisions")}
              >
                Decisions
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "changes"}
                onClick={() => setTab("changes")}
              >
                Changes
              </button>
            </div>

            {/* ── Orders ── */}
            <div
              className="tablewrap"
              role="region"
              aria-label="Recent orders"
              tabIndex={0}
              hidden={tab !== "orders"}
            >
              <table>
                <thead>
                  <tr>
                    <th className="l">Time</th>
                    <th className="l">Bot</th>
                    <th className="l">Strategy</th>
                    <th className="l">Market</th>
                    <th className="l">Side</th>
                    <th>Price</th>
                    <th>Qty</th>
                    <th className="l">tx</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.length ? (
                    orders.map((o, i) => (
                      <tr key={`${o.bot ?? ""}-${o.ts}-${i}`}>
                        <td className="l muted">{relTime(o.ts, now)}</td>
                        <td className="l">{o.bot ?? "—"}</td>
                        <td className="l">
                          <span className="chip chip-strat">{o.strategy}</span>
                        </td>
                        <td className="l">{mkt(o.market)}</td>
                        <td className="l">
                          <Side side={o.side} />
                        </td>
                        <td>{usd(num(o.price))}</td>
                        <td>{o.quantity}</td>
                        <td className="muted">{o.check_tx_code ?? ""}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="l empty" colSpan={8}>
                        no orders
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* ── Decisions ── */}
            <div
              className="tablewrap"
              role="region"
              aria-label="Decisions"
              tabIndex={0}
              hidden={tab !== "decisions"}
            >
              <table>
                <thead>
                  <tr>
                    <th className="l">Bot</th>
                    <th className="l">Strategy</th>
                    <th className="l">Action</th>
                    <th>Count</th>
                    <th>Last</th>
                  </tr>
                </thead>
                <tbody>
                  {decs.length ? (
                    decs.map((d, i) => (
                      <tr key={`${d.bot ?? ""}-${d.strategy}-${d.action}-${i}`}>
                        <td className="l">{d.bot ?? "—"}</td>
                        <td className="l muted">{d.strategy}</td>
                        <td className="l">
                          <span className="chip chip-action">{d.action}</span>
                        </td>
                        <td>{d.c}</td>
                        <td className="muted">{relTime(d.last, now)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="l empty" colSpan={5}>
                        no decisions
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* ── Changes (lazy changelog) ── */}
            <div
              className="tablewrap"
              role="region"
              aria-label="Strategy changes"
              tabIndex={0}
              hidden={tab !== "changes"}
            >
              <table>
                <thead>
                  <tr>
                    <th className="l">Time</th>
                    <th className="l">Bot</th>
                    <th className="l">Kind</th>
                    <th className="l">Change</th>
                    <th className="l">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {changesLoading && changes === null ? (
                    <tr>
                      <td className="l muted" colSpan={5}>
                        loading…
                      </td>
                    </tr>
                  ) : changes && changes.length ? (
                    changes.map((c, i) => (
                      <tr key={`${c.bot ?? ""}-${c.ts}-${i}`}>
                        <td className="l muted">{relTime(c.ts, now)}</td>
                        <td className="l">{c.bot ?? "—"}</td>
                        <td className="l">
                          <span className="chip">{c.kind}</span>
                        </td>
                        <td
                          className="l muted"
                          style={{
                            maxWidth: 280,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={changeSummary(c.before, c.after)}
                        >
                          {changeSummary(c.before, c.after)}
                        </td>
                        <td className="l muted">{c.note ?? ""}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="l empty" colSpan={5}>
                        no changes
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </details>
  );
}

/** Buy ▲ (green) / Sell ▼ (red) — mirrors the vanilla `side()` markup, tinted per spec. */
function Side({ side }: { side: string }) {
  const buy = side === "Buy";
  return (
    <span className="side">
      <span
        className="glyph"
        style={{ color: buy ? "var(--money-pos)" : "var(--money-neg)" }}
      >
        {buy ? "▲" : "▼"}
      </span>{" "}
      {buy ? "Buy" : "Sell"}
    </span>
  );
}

/** Compact before→after diff. Trims long JSON so the cell stays a single dense line. */
function changeSummary(before: unknown, after: unknown): string {
  const b = trim(before);
  const a = trim(after);
  if (b === a) return a;
  return `${b} → ${a}`;
}

function trim(v: unknown, max = 80): string {
  if (v == null) return "—";
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s == null) return "—";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
