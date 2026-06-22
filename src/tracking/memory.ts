import type { Logger } from "../logger.js";
import type {
  Tracker,
  OrderRecord,
  PositionSnapshot,
  DecisionRecord,
} from "./types.js";

/** Default tracker: keeps recent records in memory (bounded). No persistence. */
export class MemoryTracker implements Tracker {
  readonly backend = "memory";
  readonly orders: OrderRecord[] = [];
  readonly snapshots: PositionSnapshot[] = [];
  readonly decisions: DecisionRecord[] = [];

  constructor(private readonly logger?: Logger) {}

  async recordOrder(o: OrderRecord): Promise<void> {
    this.orders.push(o);
    if (this.orders.length > 5000) this.orders.shift();
  }

  async recordSnapshot(s: PositionSnapshot): Promise<void> {
    this.snapshots.push(s);
    if (this.snapshots.length > 5000) this.snapshots.shift();
  }

  async recordDecision(d: DecisionRecord): Promise<void> {
    this.decisions.push(d);
    if (this.decisions.length > 5000) this.decisions.shift();
  }

  async prune(): Promise<number> {
    return 0; // in-memory ring buffers are already bounded
  }

  async close(): Promise<void> {}
}
