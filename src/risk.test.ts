import { describe, it, expect } from "vitest";
import type { AccountInfo } from "@proof/trading-sdk";
import { checkAccount, newRiskState } from "./risk.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig({ MIN_MARGIN_RATIO_BPS: "2000", MAX_DRAWDOWN_BPS: "1000" });

const acct = (over: Partial<AccountInfo>): AccountInfo => ({
  balance: 0n,
  positions: [],
  equity: 10_000_000_000n,
  totalMm: 0n,
  totalIm: 0n,
  marginRatioBps: 0n,
  ...over,
});

describe("checkAccount kill-switch", () => {
  it("ok for a healthy, flat account", () => {
    const v = checkAccount(acct({}), newRiskState(), cfg);
    expect(v.ok).toBe(true);
  });

  it("trips when margin ratio falls below the floor (with positions)", () => {
    const s = newRiskState();
    s.startingEquity = 10_000_000_000n;
    const v = checkAccount(
      acct({ equity: 9_900_000_000n, positions: [{ market: 7 } as never], marginRatioBps: 1500n }),
      s,
      cfg,
    );
    expect(v.ok).toBe(false);
    expect(s.tripped).toBe(true);
  });

  it("trips on session drawdown over the cap", () => {
    const s = newRiskState();
    s.startingEquity = 10_000_000_000n;
    const v = checkAccount(acct({ equity: 8_900_000_000n }), s, cfg); // 11% > 10%
    expect(v.ok).toBe(false);
  });

  it("fails safe when the account is unreadable", () => {
    expect(checkAccount(null, newRiskState(), cfg).ok).toBe(false);
  });

  it("stays tripped once latched", () => {
    const s = newRiskState();
    s.tripped = true;
    expect(checkAccount(acct({}), s, cfg).ok).toBe(false);
  });
});
