/**
 * Tracking ledger — our own record of orders/positions/decisions, because the
 * SDK can't read open orders or fills and `/tx` can't confirm inclusion
 * (PROOF_SDK_FEEDBACK.md #1/#1b). Storage-agnostic: in-memory by default, or
 * Supabase/Postgres when DATABASE_URL is set.
 */

export interface OrderRecord {
  bot: string; // which bot/wallet (registry id)
  clientOrderId: string; // bigint serialized
  strategy: string;
  kind: "order" | "basket";
  market: number;
  side: "Buy" | "Sell";
  price: string; // micro-USDC bigint serialized
  quantity: string;
  txHash?: string;
  checkTxCode?: number;
  note?: string;
  ts: number; // epoch ms
}

export interface PositionRow {
  market: number;
  side: string;
  size: string;
  entryPrice: string;
}

export interface PositionSnapshot {
  bot: string;
  ts: number;
  balance: string;
  equity: string;
  marginRatioBps: string;
  positions: PositionRow[];
}

export interface DecisionRecord {
  bot: string;
  ts: number;
  strategy: string;
  action: string;
  market?: number;
  detail: Record<string, unknown>;
}

export interface Tracker {
  readonly backend: string;
  recordOrder(o: OrderRecord): Promise<void>;
  recordSnapshot(s: PositionSnapshot): Promise<void>;
  recordDecision(d: DecisionRecord): Promise<void>;
  /** Delete bot_orders/bot_decisions older than `retentionHours` (0 = no-op). Batched.
   *  Returns the number of rows pruned. Keeps the ledger (+ dashboard queries) bounded. */
  prune(retentionHours: number): Promise<number>;
  close(): Promise<void>;
}
