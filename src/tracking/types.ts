/**
 * Tracking ledger — our own record of orders/positions/decisions, because the
 * SDK can't read open orders or fills and `/tx` can't confirm inclusion
 * (PROOF_SDK_FEEDBACK.md #1/#1b). Storage-agnostic: in-memory by default, or
 * Supabase/Postgres when DATABASE_URL is set.
 */

export interface OrderRecord {
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
  ts: number;
  balance: string;
  equity: string;
  marginRatioBps: string;
  positions: PositionRow[];
}

export interface DecisionRecord {
  ts: number;
  strategy: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface Tracker {
  readonly backend: string;
  recordOrder(o: OrderRecord): Promise<void>;
  recordSnapshot(s: PositionSnapshot): Promise<void>;
  recordDecision(d: DecisionRecord): Promise<void>;
  close(): Promise<void>;
}
