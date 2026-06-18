/**
 * Order-construction utilities. The engine REJECTS prices/quantities that don't
 * snap to a market's tickSize/lotSize (PROOF review #tick-lot-snapping), so every
 * order/leg must pass through these. A gate value of 0 means "no gate".
 *
 * Units: prices are micro-USDC; quantity is in 10^-szDecimals contract units.
 */

/** Round a price DOWN to the nearest tick (use for bids — never more aggressive). */
export function snapPriceDown(price: bigint, tickSize: bigint): bigint {
  if (tickSize <= 0n) return price;
  return (price / tickSize) * tickSize;
}

/** Round a price UP to the nearest tick (use for asks). */
export function snapPriceUp(price: bigint, tickSize: bigint): bigint {
  if (tickSize <= 0n) return price;
  const r = price % tickSize;
  return r === 0n ? price : price + (tickSize - r);
}

/** Snap a price so a Buy floors and a Sell ceils (no more aggressive than intended). */
export function snapPrice(
  price: bigint,
  tickSize: bigint,
  side: "Buy" | "Sell",
): bigint {
  return side === "Buy"
    ? snapPriceDown(price, tickSize)
    : snapPriceUp(price, tickSize);
}

/** Floor a quantity to the nearest whole lot (0 = no gate). 0n if below one lot. */
export function snapQty(qty: bigint, lotSize: bigint): bigint {
  if (qty < 0n) return 0n;
  if (lotSize <= 0n) return qty;
  return (qty / lotSize) * lotSize;
}

// ── clientOrderId — process-unique, monotonic (bigint) ──────────────────────
let coidCounter = 0n;
const coidBase = BigInt(Date.now()) * 1_000_000n;

/** A unique clientOrderId for correlating submits → fills in the tracker. */
export function nextClientOrderId(): bigint {
  coidCounter += 1n;
  return coidBase + coidCounter;
}
