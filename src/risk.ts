import type { AccountInfo } from "@proof/trading-sdk";
import type { Config } from "./config.js";

/**
 * Account-level risk monitor / kill-switch. Margin on Proof is account-wide and
 * SCENARIO-aware (totalMm/marginRatioBps are worst-case across resolution
 * outcomes — PROOF review #scenario-margin), so we trip on the engine's own
 * margin ratio plus a session drawdown guard.
 */

export interface RiskState {
  /** Session baseline equity (microUSDC); set on first reading. */
  startingEquity: bigint | null;
  /** Latched once tripped — stays halted for the session. */
  tripped: boolean;
}

export function newRiskState(): RiskState {
  return { startingEquity: null, tripped: false };
}

export interface RiskVerdict {
  ok: boolean;
  reason?: string;
  marginRatioBps: bigint;
  drawdownBps: number;
  equity: bigint;
}

/**
 * Returns ok=false (and latches `state.tripped`) when the account breaches the
 * margin-ratio floor or the session drawdown cap. ok=false on an unreadable
 * account too (fail-safe: don't trade blind).
 */
export function checkAccount(
  account: AccountInfo | null,
  state: RiskState,
  config: Config,
): RiskVerdict {
  if (state.tripped) {
    return {
      ok: false,
      reason: "kill-switch already tripped this session",
      marginRatioBps: 0n,
      drawdownBps: 0,
      equity: account?.equity ?? 0n,
    };
  }
  if (!account) {
    return {
      ok: false,
      reason: "account not readable",
      marginRatioBps: 0n,
      drawdownBps: 0,
      equity: 0n,
    };
  }

  if (state.startingEquity === null) state.startingEquity = account.equity;

  const drawdownBps =
    state.startingEquity > 0n
      ? Number(((state.startingEquity - account.equity) * 10000n) / state.startingEquity)
      : 0;

  const mr = account.marginRatioBps;
  const hasPositions = account.positions.length > 0;

  // marginRatioBps is "equity / total notional * 10000" — higher is safer; it is
  // 0/undefined when there are no positions, so only enforce it once we have risk.
  // With positions, a non-positive ratio means ~zero/negative margin buffer
  // (liquidation risk) and must trip too.
  if (hasPositions && (mr <= 0n || mr < BigInt(config.minMarginRatioBps))) {
    state.tripped = true;
    return {
      ok: false,
      reason: `margin ratio ${mr}bps at/below floor ${config.minMarginRatioBps}bps`,
      marginRatioBps: mr,
      drawdownBps,
      equity: account.equity,
    };
  }

  if (drawdownBps >= config.maxDrawdownBps) {
    state.tripped = true;
    return {
      ok: false,
      reason: `session drawdown ${drawdownBps}bps at/over cap ${config.maxDrawdownBps}bps`,
      marginRatioBps: mr,
      drawdownBps,
      equity: account.equity,
    };
  }

  return { ok: true, marginRatioBps: mr, drawdownBps, equity: account.equity };
}
