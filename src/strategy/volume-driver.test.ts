import { describe, it, expect } from "vitest";
import { Side } from "@proof/trading-sdk";
import { VolumeDriverStrategy } from "./volume-driver.js";

const META = { market: 7, tickSize: 0n, lotSize: 0n, szDecimals: 2, takerFeeBps: 5, makerFeeBps: 2 };
const book = { bids: [{ price: 67700000n }], asks: [{ price: 67710000n }] }; // mid 67705000
const cfg = (over = {}) => ({ network: "devnet", volOrderQty: 20n, volMaxPosition: 40n, volTakeProfitBps: 15, volStopBps: 25, volHoldMs: 60000, ...over });

function fakeCtx(opts: { config?: object; pos?: unknown; nowMs?: number; meta?: unknown; book?: unknown } = {}) {
  const calls = { place: [] as Record<string, unknown>[], decisions: [] as { action: string; detail: unknown }[] };
  const ctx = {
    config: opts.config ?? cfg(),
    legs: { underlying: 7 },
    nowMs: opts.nowMs ?? 1000,
    marketMeta: () => (opts.meta === undefined ? META : opts.meta),
    orderbook: async () => opts.book ?? book,
    positionFor: () => opts.pos,
    place: async (p: Record<string, unknown>) => { calls.place.push(p); return null; },
    recordDecision: (action: string, detail: unknown) => calls.decisions.push({ action, detail }),
    logger: { error: () => {}, debug: () => {} },
  };
  return { ctx, calls };
}

describe("VolumeDriverStrategy", () => {
  it("is devnet-gated", async () => {
    const { ctx, calls } = fakeCtx({ config: cfg({ network: "custom" }) });
    await new VolumeDriverStrategy(0).onTick(ctx as never);
    expect(calls.place).toHaveLength(0);
    expect(calls.decisions[0]?.action).toBe("skip");
  });

  it("opens a sized taker position when flat (clamped to volMaxPosition)", async () => {
    const { ctx, calls } = fakeCtx({ pos: undefined, config: cfg({ volOrderQty: 100n, volMaxPosition: 40n }) });
    await new VolumeDriverStrategy(0).onTick(ctx as never);
    expect(calls.place).toHaveLength(1);
    expect(calls.place[0]).toMatchObject({ market: 7, side: Side.Buy, quantity: 40n }); // clamped 100→40
    expect(calls.place[0]!.price).toBe(67710000n); // taker at the ask
    expect(calls.decisions.some((d) => d.action === "vol-open")).toBe(true);
  });

  it("takes profit (reduce-only close) once unrealized clears the TP threshold", async () => {
    // long, entry well below mid → big positive unrealized
    const { ctx, calls } = fakeCtx({ pos: { side: "Buy", size: 20n, entryPrice: 67000000n } });
    await new VolumeDriverStrategy(0).onTick(ctx as never);
    expect(calls.place).toHaveLength(1);
    expect(calls.place[0]).toMatchObject({ side: Side.Sell, reduceOnly: true, quantity: 20n });
    const close = calls.decisions.find((d) => d.action === "vol-close");
    expect((close?.detail as { reason: string }).reason).toBe("take-profit");
  });

  it("holds when in a position within the TP/SL band", async () => {
    const { ctx, calls } = fakeCtx({ pos: { side: "Buy", size: 20n, entryPrice: 67705000n } }); // ~flat PnL
    await new VolumeDriverStrategy(0).onTick(ctx as never);
    expect(calls.place).toHaveLength(0);
    expect(calls.decisions.some((d) => d.action === "vol-hold")).toBe(true);
  });

  it("skips on missing market meta", async () => {
    const { ctx, calls } = fakeCtx({ meta: null });
    await new VolumeDriverStrategy(0).onTick(ctx as never);
    expect(calls.place).toHaveLength(0);
    expect(calls.decisions.some((d) => d.action === "skip")).toBe(true);
  });
});
