/**
 * Pure diff logic for the bot strategy-change log. Given a bot's prior state (or
 * `null` for a brand-new bot) and its new state, return one ChangeRow per changed
 * field — so re-running an identical `pnpm bots update` records NOTHING (idempotent).
 * Never touches private keys (only ever sees strategies/markets/tags/params/enabled).
 */

export type ChangeKind =
  | "created"
  | "enabled"
  | "disabled"
  | "params"
  | "strategies"
  | "markets"
  | "tags";

export interface ChangeRow {
  kind: ChangeKind;
  before: unknown;
  after: unknown;
}

export interface BotState {
  strategies: string[];
  markets: number[] | "all";
  tags: string[];
  params: Record<string, string>;
  enabled: boolean;
}

/**
 * Stable JSON (recursively sorted object keys) so a jsonb round-trip or a params
 * key reordering doesn't register as a spurious change. Arrays keep their order —
 * order is meaningful for strategies/markets/tags.
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

const eq = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

/** One ChangeRow per field that actually changed (empty array ⇒ a no-op update). */
export function diffBotChange(before: BotState | null, after: BotState): ChangeRow[] {
  if (before == null) {
    return [
      {
        kind: "created",
        before: null,
        after: { strategies: after.strategies, markets: after.markets, tags: after.tags, params: after.params, enabled: after.enabled },
      },
    ];
  }
  const rows: ChangeRow[] = [];
  if (!eq(before.params, after.params)) rows.push({ kind: "params", before: before.params, after: after.params });
  if (!eq(before.strategies, after.strategies)) rows.push({ kind: "strategies", before: before.strategies, after: after.strategies });
  if (!eq(before.markets, after.markets)) rows.push({ kind: "markets", before: before.markets, after: after.markets });
  if (!eq(before.tags, after.tags)) rows.push({ kind: "tags", before: before.tags, after: after.tags });
  if (before.enabled !== after.enabled)
    rows.push({ kind: after.enabled ? "enabled" : "disabled", before: { enabled: before.enabled }, after: { enabled: after.enabled } });
  return rows;
}
