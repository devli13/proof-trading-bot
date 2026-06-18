import { describe, it, expect } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("defaults to devnet paper trading", () => {
    const c = loadConfig({});
    expect(c.network).toBe("devnet");
    expect(c.chainId).toBe("exchange-devnet-1");
    expect(c.gatewayUrl).toContain("dev.proof.trade");
    expect(c.allowReal).toBe(false);
    expect(c.impactEvent).toBe(203);
    expect(c.strategies).toContain("market-maker");
  });

  it("refuses a custom network without PROOF_ALLOW_REAL", () => {
    expect(() =>
      loadConfig({
        PROOF_NETWORK: "custom",
        PROOF_GATEWAY_URL: "https://x.example",
        PROOF_CHAIN_ID: "mainnet-1",
      }),
    ).toThrow(/PROOF_ALLOW_REAL/);
  });

  it("allows a custom network when explicitly opted in", () => {
    const c = loadConfig({
      PROOF_NETWORK: "custom",
      PROOF_GATEWAY_URL: "https://x.example",
      PROOF_CHAIN_ID: "mainnet-1",
      PROOF_ALLOW_REAL: "1",
    });
    expect(c.chainId).toBe("mainnet-1");
    expect(c.allowReal).toBe(true);
  });

  it("reads risk caps from env (qty as bigint)", () => {
    const c = loadConfig({ MAX_ORDER_QTY: "5", MAX_OPEN_ORDERS: "3" });
    expect(c.maxOrderQty).toBe(5n);
    expect(c.maxOpenOrders).toBe(3);
  });
});
