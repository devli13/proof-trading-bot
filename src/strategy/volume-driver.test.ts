import { describe, it, expect } from "vitest";
import { Side } from "@proof/trading-sdk";
import { VolumeDriverStrategy } from "./volume-driver.js";

const META = { market: 7, tickSize: 0n, lotSize: 0n, szDecimals: 2, takerFeeBps: 5, makerFeeBps: 2 };
const book = { bids: [{ price: 67700000n }], asks: [{ price: 67710000n }] }; // mid 67705000
const cfg = (over = {}) => ({ network: "devnet", volOrderQty: 20n, volMaxPosition: 40n, volSpreadBps: 30, ...over });

function fakeCtx(opts: { config?: object; pos?: unknown; nowMs?: number; meta?: unknown; book?: unknown } = {}) {
  const calls = {
    place: [] as Record<string, unknown>[],
    cancels: [] as number[],
    decisions: [] as { action: string; detail: unknown }[],
  };
  const ctx = {
    config: opts.config ?? cfg(),
    legs: { underlying: 7 },
    nowMs: opts.nowMs ?? 1000,
    marketMeta: () => (opts.meta === undefined ? META : opts.meta),
    orderbook: async () => opts.book ?? book,
    positionFor: () => opts.pos,
    place: async (p: Record<string, unknown>) => { calls.place.push(p); return null; },
    cancelMarket: async (m: number) => { calls.cancels.push(m); return null; },
    recordDecision: (action: string, detail: unknown) => calls.decisions.push({ action, detail }),
    logger: { error: () => {}, debug: () => {} },
  };
  return { ctx, calls };
}

describe("VolumeDriverStrategy (post-only maker)", () => {
  it("is devnet-gated", async () => {
    const { ctx, calls } = fakeCtx({ config: cfg({ network: "custom" }) });
    await new VolumeDriverStrategy(0).onTick(ctx as never);
    expect(calls.place).toHaveLength(0);
    expect(calls.decisions[0]?.action).toBe("skip");
  });

  it("quotes BOTH sides post-only when flat (cancel-replace), straddling mid", async () => {
    const { ctx, calls } = fakeCtx({ pos: undefined });
    await new VolumeDriverStrategy(0).onTick(ctx as never);
    expect(calls.cancels).toEqual([7]); // cancel-replace, scoped to this market only
    expect(calls.place).toHaveLength(2);
    const buy = calls.place.find((p) => p.side === Side.Buy);
    const sell = calls.place.find((p) => p.side === Side.Sell);
    expect(buy).toMatchObject({ market: 7, postOnly: true, quantity: 20n });
    expect(sell).toMatchObject({ market: 7, postOnly: true, quantity: 20n });
    // maker quotes straddle mid (67705000): bid below, ask above — never crosses (post-only)
    expect(buy!.price as bigint).toBeLessThan(67705000n);
    expect(sell!.price as bigint).toBeGreaterThan(67705000n);
    expect(calls.decisions.some((d) => d.action === "quote")).toBe(true);
  });

  it("suppresses the inventory-growing side at the position cap", async () => {
    // long at the cap → posting another bid would grow long past max; only the ask (reduces) posts
    const { ctx, calls } = fakeCtx({ pos: { side: "Buy", size: 40n } });
    await new VolumeDriverStrategy(0).onTick(ctx as never);
    expect(calls.place).toHaveLength(1);
    expect(calls.place[0]).toMatchObject({ side: Side.Sell, postOnly: true });
  });

  it("skips on missing market meta", async () => {
    const { ctx, calls } = fakeCtx({ meta: null });
    await new VolumeDriverStrategy(0).onTick(ctx as never);
    expect(calls.place).toHaveLength(0);
    expect(calls.decisions.some((d) => d.action === "skip")).toBe(true);
  });

  it("skips on a one-sided book", async () => {
    const { ctx, calls } = fakeCtx({ book: { bids: [], asks: [{ price: 67710000n }] } });
    await new VolumeDriverStrategy(0).onTick(ctx as never);
    expect(calls.place).toHaveLength(0);
    expect(calls.decisions.some((d) => d.action === "skip")).toBe(true);
  });
});
