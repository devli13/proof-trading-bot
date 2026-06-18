import type { ExchangeClient, MarketConfig } from "@proof/trading-sdk";
import { discoverEventLegs } from "./impact.js";
import type { EventLegs } from "./impact.js";
import type { MarketMeta } from "./strategy/types.js";

export function toMeta(m: MarketConfig): MarketMeta {
  return {
    market: m.market,
    tickSize: m.tickSize ?? 0n,
    lotSize: m.lotSize ?? 0n,
    szDecimals: m.szDecimals ?? 0,
    takerFeeBps: m.takerFeeBps,
    makerFeeBps: m.makerFeeBps,
  };
}

/**
 * Shared, read-only market data for ALL bots — fetched once per cache window
 * instead of every engine pulling the ~1.1 MB `queryMarkets` itself. Tracks a
 * configurable set of impact events (the union any bot trades) and exposes their
 * legs + per-market metadata. Concurrent `ensureFresh()` calls dedupe to one
 * in-flight refresh.
 */
export class MarketData {
  private legsByEvent = new Map<number, EventLegs>();
  private metas = new Map<number, MarketMeta>();
  private events: number[] = [];
  private fetchedAt = 0;
  private inflight?: Promise<void>;

  constructor(
    private readonly gatewayUrl: string,
    private readonly client: ExchangeClient,
    private readonly cacheMs: number,
  ) {}

  /** Set the impact events to track (union across the active bot roster). */
  setEvents(events: number[]): void {
    this.events = Array.from(new Set(events)).filter((e) => Number.isFinite(e) && e > 0);
  }

  activeEvents(): number[] {
    return this.events;
  }

  async ensureFresh(now = Date.now()): Promise<void> {
    if (this.metas.size > 0 && now - this.fetchedAt < this.cacheMs) return;
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.refresh().finally(() => {
      this.fetchedAt = Date.now();
      this.inflight = undefined;
    });
    await this.inflight;
  }

  private async refresh(): Promise<void> {
    const markets = await this.client.queryMarkets();
    const metas = new Map<number, MarketMeta>();
    for (const m of markets) metas.set(m.market, toMeta(m));
    this.metas = metas;
    for (const ev of this.events) {
      try {
        this.legsByEvent.set(ev, await discoverEventLegs(this.gatewayUrl, ev));
      } catch {
        /* keep any stale legs for this event if discovery momentarily fails */
      }
    }
  }

  legsFor(event: number): EventLegs | undefined {
    return this.legsByEvent.get(event);
  }

  metaFor(market: number): MarketMeta | undefined {
    return this.metas.get(market);
  }
}
