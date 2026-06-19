import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccountInfo } from "@proof/trading-sdk";

// Mock the SDK/network client layer before importing the engine. The mock fns ignore
// the (client, wallet)/(gatewayUrl, address) args — we only assert on call behavior.
const cancelAllOrders = vi.fn(async () => ({ hash: "0xcancel", code: 0 }));
const queryAccountViaInfo = vi.fn(async (): Promise<AccountInfo | null> => null);
vi.mock("./client.js", () => ({
  createClient: () => ({ setPrivateKey() {}, disconnect() {}, queryOrderbook: async () => ({ bids: [], asks: [] }) }),
  queryAccountViaInfo: () => queryAccountViaInfo(),
  placeLimitOrder: vi.fn(async () => ({ hash: "0xorder", code: 0 })),
  cancelAllOrders: () => cancelAllOrders(),
  placeBasket: vi.fn(async () => ({ hash: "0xbasket", code: 0 })),
}));

const { BotEngine } = await import("./runner.js");
const { loadConfig } = await import("./config.js");
const { createLogger } = await import("./logger.js");
const { walletFromPrivateKey } = await import("./wallet.js");
const { MemoryTracker } = await import("./tracking/memory.js");

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const legs = { impactId: 203, underlying: 7, cpy: 20300, cpn: 20301, eby: 20302, ebn: 20303, question: "", deadlineMs: Date.now() + 1e10, resolutionWindowMs: 0, status: "Trading" };
const meta = { market: 7, tickSize: 0n, lotSize: 0n, szDecimals: 2, takerFeeBps: 5, makerFeeBps: 2 };
const acct = (over: Partial<AccountInfo>): AccountInfo =>
  ({ balance: 0n, positions: [], equity: 10_000_000_000n, totalMm: 0n, totalIm: 0n, marginRatioBps: 5000n, ...over }) as AccountInfo;

function makeEngine(over: Record<string, string> = {}) {
  const config = loadConfig({ ...over });
  const logger = createLogger("fatal");
  const tracker = new MemoryTracker();
  const strat = { name: "fake", onTick: vi.fn(async () => {}) };
  const marketData = { ensureFresh: vi.fn(async () => {}), legsFor: () => legs, metaFor: () => meta } as never;
  const wallet = walletFromPrivateKey(KEY);
  return { config, logger, tracker, strat, marketData, wallet };
}

beforeEach(() => {
  cancelAllOrders.mockClear();
  queryAccountViaInfo.mockReset();
});

describe("BotEngine.tick", () => {
  it("SKIPS (not halts) when the account is unreadable", async () => {
    const { config, logger, tracker, strat, marketData, wallet } = makeEngine();
    queryAccountViaInfo.mockResolvedValue(null);
    const engine = await BotEngine.create(config, logger, [strat as never], { botId: "t", wallet, tracker, marketData, events: [203] });
    const res = await engine.tick();
    expect(res.halted).toBe(false);
    expect(strat.onTick).not.toHaveBeenCalled();
    expect(tracker.decisions.some((d) => d.action === "skip-tick")).toBe(true);
    expect(cancelAllOrders).not.toHaveBeenCalled();
    // a transient null must NOT permanently halt — next tick runs strategies again
    queryAccountViaInfo.mockResolvedValue(acct({}));
    await engine.tick();
    expect(strat.onTick).toHaveBeenCalledTimes(1);
  });

  it("runs each strategy over each event on a healthy account + records a snapshot", async () => {
    const { config, logger, tracker, strat, marketData, wallet } = makeEngine();
    queryAccountViaInfo.mockResolvedValue(acct({}));
    const engine = await BotEngine.create(config, logger, [strat as never], { botId: "t", wallet, tracker, marketData, events: [203] });
    const res = await engine.tick();
    expect(res.halted).toBe(false);
    expect(strat.onTick).toHaveBeenCalledTimes(1);
    expect(tracker.snapshots).toHaveLength(1);
  });

  it("trips the kill-switch (cancel + halt) on a margin breach and stops trading", async () => {
    const { config, logger, tracker, strat, marketData, wallet } = makeEngine();
    queryAccountViaInfo.mockResolvedValue(acct({ positions: [{ market: 7 } as never], marginRatioBps: 1500n }));
    const engine = await BotEngine.create(config, logger, [strat as never], { botId: "t", wallet, tracker, marketData, events: [203] });
    const res = await engine.tick();
    expect(res.halted).toBe(true);
    expect(strat.onTick).not.toHaveBeenCalled();
    expect(tracker.decisions.some((d) => d.action === "kill-switch")).toBe(true);
    expect(cancelAllOrders).toHaveBeenCalled();
    // latched — a subsequent tick short-circuits
    const res2 = await engine.tick();
    expect(res2.halted).toBe(true);
  });

  it("does NOT cancel on kill-switch in DRY_RUN", async () => {
    const { config, logger, tracker, strat, marketData, wallet } = makeEngine({ DRY_RUN: "1" });
    queryAccountViaInfo.mockResolvedValue(acct({ positions: [{ market: 7 } as never], marginRatioBps: 1500n }));
    const engine = await BotEngine.create(config, logger, [strat as never], { botId: "t", wallet, tracker, marketData, events: [203] });
    const res = await engine.tick();
    expect(res.halted).toBe(true);
    expect(cancelAllOrders).not.toHaveBeenCalled();
  });
});
