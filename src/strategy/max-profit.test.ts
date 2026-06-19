import { describe, it, expect, vi } from "vitest";
import { MaxProfitStrategy } from "./max-profit.js";

const ctx = () => ({ logger: { error: vi.fn() } }) as never;

describe("MaxProfitStrategy", () => {
  it("runs both sub-strategies each tick", async () => {
    const arb = { name: "parity-arb", onTick: vi.fn(async () => {}) };
    const mom = { name: "momentum", onTick: vi.fn(async () => {}) };
    const mp = new MaxProfitStrategy(arb as never, mom as never);
    expect(mp.name).toBe("max-profit");
    await mp.onTick(ctx());
    expect(arb.onTick).toHaveBeenCalledTimes(1);
    expect(mom.onTick).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing sub-strategy — the other still runs + the error is logged", async () => {
    const arb = { name: "parity-arb", onTick: vi.fn(async () => { throw new Error("boom"); }) };
    const mom = { name: "momentum", onTick: vi.fn(async () => {}) };
    const c = ctx();
    const mp = new MaxProfitStrategy(arb as never, mom as never);
    await mp.onTick(c);
    expect(mom.onTick).toHaveBeenCalledTimes(1); // arb's throw did not skip momentum
    expect((c as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalled();
  });
});
