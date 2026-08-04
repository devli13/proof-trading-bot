import { describe, it, expect, vi, afterEach } from "vitest";
import { encode } from "@msgpack/msgpack";
import { MarketData } from "./market-data.js";
import type { ExchangeClient, MarketConfig } from "@proof/trading-sdk";

function infoPayload(id: number, status: string): { data: string } {
  const raw = [id, 7, id * 100, id * 100 + 1, id * 100 + 2, id * 100 + 3, "q", 9e15, 0, status];
  return { data: Buffer.from(encode(raw)).toString("base64") };
}
function marketsFor(eventIds: number[]): MarketConfig[] {
  const out: MarketConfig[] = [{ market: 7 } as MarketConfig];
  for (const ev of eventIds) out.push({ market: ev * 100 + 2, kind: { PredictionBinary: [ev, "Yes"] } } as unknown as MarketConfig);
  return out;
}
// Mutable status map so a test can flip an event's status between refreshes.
function mockGateway(statusById: Map<number, string | "THROW">) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, opts: { body: string }) => {
    const { id } = JSON.parse(opts.body) as { id: number };
    const st = statusById.get(id);
    if (st === undefined || st === "THROW") throw new Error("rate limit exceeded");
    return { ok: true, json: async () => infoPayload(id, st) } as unknown as Response;
  }));
}
const fakeClient = (markets: MarketConfig[] | (() => MarketConfig[])): ExchangeClient =>
  ({ queryMarkets: async () => (typeof markets === "function" ? markets() : markets) }) as unknown as ExchangeClient;
const throwingClient = (): ExchangeClient => ({ queryMarkets: async () => { throw new Error("rate limit"); } }) as unknown as ExchangeClient;
const MIN = 60_000;

describe("MarketData discovery robustness", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("runs Trading + PreResolution events (to flatten), excludes fresh Resolved", async () => {
    mockGateway(new Map<number, string>([[397, "Trading"], [396, "PreResolution"], [203, "Resolved"]]));
    const md = new MarketData("http://gw", fakeClient(marketsFor([397, 396, 203])), 60000, true);
    md.setEvents([]);
    await md.ensureFresh();
    expect(md.tradingEvents()).toEqual([396, 397]); // 203 Resolved (never traded here) excluded
  });

  it("keeps refreshing leg status when queryMarkets fails, and drops a resolved event after the flatten grace", async () => {
    mockGateway(new Map<number, string>([[397, "Trading"]]));
    const md = new MarketData("http://gw", fakeClient(marketsFor([397])), 0, true); // cacheMs 0 → always refresh
    md.setEvents([]);
    const t0 = Date.now();
    await md.ensureFresh();
    expect(md.tradingEvents()).toEqual([397]);
    // queryMarkets now down; 397 has resolved. Discovery still runs (via known events).
    (md as unknown as { client: ExchangeClient }).client = throwingClient();
    mockGateway(new Map<number, string>([[397, "Resolved"]]));
    await md.ensureFresh(t0 + 5 * MIN); // within the 15-min grace → still run (so it can flatten)
    expect(md.tradingEvents()).toEqual([397]);
    await md.ensureFresh(t0 + 20 * MIN); // past grace → dropped
    expect(md.tradingEvents()).toEqual([]);
  });

  it("drops a Trading event once its probe keeps failing past the staleness window", async () => {
    mockGateway(new Map<number, string>([[397, "Trading"]]));
    const md = new MarketData("http://gw", fakeClient(marketsFor([397])), 0, true);
    md.setEvents([]);
    const t0 = Date.now();
    await md.ensureFresh();
    expect(md.tradingEvents()).toEqual([397]);
    mockGateway(new Map<number, string>([[397, "THROW"]]));
    await md.ensureFresh(t0 + 5 * MIN); // fresh → kept
    expect(md.tradingEvents()).toEqual([397]);
    await md.ensureFresh(t0 + 20 * MIN); // stale → dropped
    expect(md.tradingEvents()).toEqual([]);
  });

  it("M2: an event first seen non-Trading is re-probed and picked up when it goes live", async () => {
    mockGateway(new Map<number, string>([[400, "PreResolution"]])); // transient/early non-Trading
    const md = new MarketData("http://gw", fakeClient(marketsFor([400])), 0, true);
    md.setEvents([]);
    await md.ensureFresh();
    expect(md.tradingEvents()).toEqual([400]); // PreResolution is still run (to flatten)
    // now it flips to Trading — must be re-probed and kept (not permanently exiled)
    mockGateway(new Map<number, string>([[400, "Trading"]]));
    await md.ensureFresh(Date.now() + MIN);
    expect(md.tradingEvents()).toEqual([400]);
  });

  it("M1: a live explicit low-id event is never starved by the new-probe cap", async () => {
    // event 5 is explicit + Trading; dozens of newer discovered ids exist.
    const many = [5, ...Array.from({ length: 60 }, (_, i) => 500 + i)];
    const statuses = new Map<number, string>(many.map((e) => [e, e === 5 ? "Trading" : "Resolved"]));
    mockGateway(statuses);
    const md = new MarketData("http://gw", fakeClient(marketsFor(many)), 60000, true);
    md.setEvents([5]); // explicitly tracked
    await md.ensureFresh();
    expect(md.tradingEvents()).toContain(5); // not starved out by the 60 newer resolved ids
  });
});
