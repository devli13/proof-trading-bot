import { describe, it, expect } from "vitest";
import { MemoryTracker } from "./memory.js";

describe("MemoryTracker", () => {
  it("records orders / snapshots / decisions", async () => {
    const t = new MemoryTracker();
    await t.recordOrder({ bot: "a" } as never);
    await t.recordSnapshot({ bot: "a" } as never);
    await t.recordDecision({ bot: "a", action: "x" } as never);
    expect(t.backend).toBe("memory");
    expect(t.orders).toHaveLength(1);
    expect(t.snapshots).toHaveLength(1);
    expect(t.decisions).toHaveLength(1);
    await t.close();
  });

  it("caps each buffer at 5000 (bounded ring)", async () => {
    const t = new MemoryTracker();
    for (let i = 0; i < 5005; i++) await t.recordOrder({ bot: "a", i } as never);
    expect(t.orders).toHaveLength(5000);
  });
});
