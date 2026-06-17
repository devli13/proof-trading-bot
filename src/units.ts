/**
 * Money/unit helpers. Every on-chain value is an integer `bigint`:
 *   - prices are in cents (2 decimals): 6_675_000n = $66,750.00
 *   - balances are in microUSDC (6 decimals): 100_000_000_000n = $100,000
 * Never coerce these to `number` — use these helpers only for display/parsing.
 */

/** Render a scaled integer as a fixed-decimal, thousands-grouped string. */
export function formatScaled(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = (neg ? -value : value).toString().padStart(decimals + 1, "0");
  const cut = abs.length - decimals;
  const whole = abs.slice(0, cut);
  const frac = abs.slice(cut);
  return `${neg ? "-" : ""}${groupThousands(whole)}.${frac}`;
}

function groupThousands(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** microUSDC (6dp) → e.g. "100,000.000000" (no $ sign). */
export const formatMicroUsdc = (v: bigint): string => formatScaled(v, 6);

/** cents (2dp) → e.g. "66,750.00" (no $ sign). */
export const formatCents = (v: bigint): string => formatScaled(v, 2);

/** Parse a human dollar string ("1,234.56") into microUSDC bigint. */
export const parseUsdcToMicro = (dollars: string): bigint =>
  parseDecimal(dollars, 6);

/** Parse a human dollar string ("66,750") into integer-cents bigint. */
export const parseUsdcToCents = (dollars: string): bigint =>
  parseDecimal(dollars, 2);

function parseDecimal(input: string, decimals: number): bigint {
  const t = input.trim().replace(/[$,\s]/g, "");
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1) : t;
  const [whole = "0", frac = ""] = body.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const digits = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  const val = BigInt(digits || "0");
  return neg ? -val : val;
}
