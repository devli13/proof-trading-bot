import { describe, it, expect } from "vitest";
import { diffBotChange, stableStringify, type BotState } from "./bot-diff.js";

const base: BotState = { strategies: ["parity-arb"], markets: [203], tags: ["arb"], params: { EDGE: "8" }, enabled: true };

describe("stableStringify", () => {
  it("sorts object keys (params) but preserves array order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
    expect(stableStringify(null)).toBe("null");
  });
});

describe("diffBotChange", () => {
  it("brand-new bot → a single 'created' row with before=null", () => {
    const rows = diffBotChange(null, base);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("created");
    expect(rows[0]!.before).toBeNull();
    expect(rows[0]!.after).toMatchObject({ enabled: true, params: { EDGE: "8" } });
  });

  it("identical state → NO rows (idempotent re-run)", () => {
    expect(diffBotChange(base, { ...base })).toEqual([]);
    // params key reordering is not a change
    expect(diffBotChange({ ...base, params: { A: "1", B: "2" } }, { ...base, params: { B: "2", A: "1" } })).toEqual([]);
  });

  it("a changed param → one 'params' row with before/after", () => {
    const rows = diffBotChange(base, { ...base, params: { EDGE: "2" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ kind: "params", before: { EDGE: "8" }, after: { EDGE: "2" } });
  });

  it("markets all→[203] is a change; array order matters", () => {
    expect(diffBotChange({ ...base, markets: "all" }, base)).toEqual([
      { kind: "markets", before: "all", after: [203] },
    ]);
    const rows = diffBotChange({ ...base, strategies: ["a", "b"] }, { ...base, strategies: ["b", "a"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("strategies");
  });

  it("enabled flip emits a directional enabled/disabled row", () => {
    expect(diffBotChange(base, { ...base, enabled: false })[0]).toEqual({ kind: "disabled", before: { enabled: true }, after: { enabled: false } });
    expect(diffBotChange({ ...base, enabled: false }, base)[0]).toEqual({ kind: "enabled", before: { enabled: false }, after: { enabled: true } });
  });

  it("only the changed field is recorded when others are passed unchanged", () => {
    const rows = diffBotChange(base, { ...base, tags: ["arb", "tight"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("tags");
  });
});
