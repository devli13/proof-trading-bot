import { decode } from "@msgpack/msgpack";
import type { ExchangeClient } from "@proof/trading-sdk";

/**
 * Impact-market data layer + parity math.
 *
 * The SDK has no `queryImpactMarketInfo` (PROOF feedback), so we read the event
 * via `POST /info {type:"impactMarket",id}` — which returns base64 msgpack as a
 * positional array. Verified shape (impact #203):
 *   [impactId, underlying, cpy, cpn, eby, ebn, question, deadlineMs,
 *    resolutionWindowMs, status, createdMs, resolvedMs, _, description, rules]
 *
 * Prices are micro-USDC. Binary (EBY/EBN) legs trade in 0..1_000_000 ($0–$1),
 * tick=1, lot=100; perp/conditional legs have no tick/lot gate. $1 = 1_000_000.
 */

export const ONE_DOLLAR = 1_000_000n;

export interface EventLegs {
  impactId: number;
  underlying: number;
  cpy: number;
  cpn: number;
  eby: number;
  ebn: number;
  question: string;
  deadlineMs: number;
  resolutionWindowMs: number;
  status: string; // "Trading" | "PreResolution" | "Resolved" | ...
}

export async function discoverEventLegs(
  apiUrl: string,
  impactId: number,
): Promise<EventLegs> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "impactMarket", id: impactId }),
  });
  if (!res.ok) throw new Error(`/info impactMarket ${impactId} failed (${res.status})`);
  const json = (await res.json()) as { data?: string };
  if (!json.data) throw new Error(`/info impactMarket ${impactId}: empty response`);
  const raw = decode(Uint8Array.from(Buffer.from(json.data, "base64"))) as unknown[];
  if (!Array.isArray(raw) || raw.length < 10) {
    throw new Error(`/info impactMarket ${impactId}: unexpected shape`);
  }
  const num = (v: unknown): number => Number(v);
  return {
    impactId: num(raw[0]),
    underlying: num(raw[1]),
    cpy: num(raw[2]),
    cpn: num(raw[3]),
    eby: num(raw[4]),
    ebn: num(raw[5]),
    question: String(raw[6] ?? ""),
    deadlineMs: num(raw[7]),
    resolutionWindowMs: num(raw[8]),
    status: String(raw[9] ?? "Unknown"),
  };
}

export interface BookTop {
  market: number;
  bid?: bigint;
  ask?: bigint;
  mid?: bigint;
  bidQty?: bigint;
  askQty?: bigint;
  empty: boolean;
}

export async function bookTop(
  client: ExchangeClient,
  market: number,
): Promise<BookTop> {
  const ob = await client.queryOrderbook(market);
  const bid = ob.bids[0]?.price;
  const ask = ob.asks[0]?.price;
  const mid =
    bid !== undefined && ask !== undefined ? (bid + ask) / 2n : (bid ?? ask);
  return {
    market,
    bid,
    ask,
    mid,
    bidQty: ob.bids[0]?.totalQty,
    askQty: ob.asks[0]?.totalQty,
    empty: bid === undefined && ask === undefined,
  };
}

export interface LegSnapshot {
  base: BookTop;
  cpy: BookTop;
  cpn: BookTop;
  eby: BookTop;
  ebn: BookTop;
}

export async function legSnapshot(
  client: ExchangeClient,
  legs: EventLegs,
): Promise<LegSnapshot> {
  const [base, cpy, cpn, eby, ebn] = await Promise.all([
    bookTop(client, legs.underlying),
    bookTop(client, legs.cpy),
    bookTop(client, legs.cpn),
    bookTop(client, legs.eby),
    bookTop(client, legs.ebn),
  ]);
  return { base, cpy, cpn, eby, ebn };
}

// ── Pure parity math (bigint micro-USDC; $1 = ONE_DOLLAR) ───────────────────

/** Implied YES probability in bps (0..10000) from binary mids; null if undefined. */
export function impliedProbBps(ebyMid: bigint, ebnMid: bigint): number | null {
  const sum = ebyMid + ebnMid;
  if (sum <= 0n) return null;
  return Number((ebyMid * 10000n) / sum);
}

/**
 * Binary parity residual (micro-USDC): (EBY + EBN) − $1.
 * >0 ⇒ pair overpriced (sell both); <0 ⇒ underpriced (buy both).
 * NB: only "near-riskless" if the event does NOT void (PROOF review #binary-void-risk).
 */
export function binaryParityResidual(eby: bigint, ebn: bigint): bigint {
  return eby + ebn - ONE_DOLLAR;
}

/**
 * Conditional parity residual (micro-USDC): base − (p·CPY + (1−p)·CPN), p in bps.
 * This is a SOFT relationship, not an arb — conditional legs settle to the
 * underlying price in-branch, so trading it carries directional/branch risk.
 */
export function conditionalParityResidual(
  base: bigint,
  cpy: bigint,
  cpn: bigint,
  probBps: number,
): bigint {
  const p = BigInt(probBps);
  const synthetic = (p * cpy + (10000n - p) * cpn) / 10000n;
  return base - synthetic;
}

/** True when it's unsafe to hold conditional/binary positions through resolution. */
export function nearResolution(
  legs: EventLegs,
  guardMs: number,
  nowMs: number,
): boolean {
  if (legs.status !== "Trading") return true;
  return legs.deadlineMs > 0 && legs.deadlineMs - nowMs < guardMs;
}
