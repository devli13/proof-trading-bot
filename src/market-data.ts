import type { ExchangeClient, MarketConfig } from "@proof/trading-sdk";
import { discoverEventLegs, discoverImpactEventIds } from "./impact.js";
import type { EventLegs } from "./impact.js";
import type { MarketMeta } from "./strategy/types.js";

// Bound on how many events we probe via /info per refresh (highest IDs first — new
// markets get the highest IDs). Guards against unbounded probing as events accumulate.
const MAX_DISCOVER_PROBES = 48;

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
  private tradingEventIds: number[] = [];
  private fetchedAt = 0;
  private inflight?: Promise<void>;

  constructor(
    private readonly gatewayUrl: string,
    private readonly client: ExchangeClient,
    private readonly cacheMs: number,
    /** Worker: discover every live event from the market list so "all" bots trade new
     *  markets automatically. Single-bot runner leaves this off (one configured event). */
    private readonly autoDiscover = false,
  ) {}

  /** Set the impact events to explicitly track (the union any bot lists by id). With
   *  auto-discovery on, the live trading set is merged in on top of these. */
  setEvents(events: number[]): void {
    this.events = Array.from(new Set(events)).filter((e) => Number.isFinite(e) && e > 0);
  }

  activeEvents(): number[] {
    return this.events;
  }

  /** Events currently status=Trading (discovered + explicit). What "all" bots should
   *  trade — drives the worker's unionEvents so new markets are picked up live. */
  tradingEvents(): number[] {
    return this.tradingEventIds;
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

    // Candidate events: the explicitly-tracked set, plus (when auto-discovery is on)
    // every event in the live market list — capped to the highest IDs, since new
    // markets always get the highest IDs. queryMarkets() is already fetched above, so
    // discovery is free; the only added cost is one /info probe per candidate event.
    let candidates = Array.from(new Set(this.events));
    if (this.autoDiscover) {
      const discovered = discoverImpactEventIds(markets);
      candidates = Array.from(new Set([...candidates, ...discovered]))
        .sort((a, b) => b - a)
        .slice(0, MAX_DISCOVER_PROBES);
    }

    const trading: number[] = [];
    for (const ev of candidates) {
      try {
        const legs = await discoverEventLegs(this.gatewayUrl, ev);
        this.legsByEvent.set(ev, legs);
        if (legs.status === "Trading") trading.push(ev);
      } catch {
        // keep any stale legs for this event if discovery momentarily fails; if it was
        // previously Trading, keep it in the active set so a blip doesn't drop a bot.
        if (this.legsByEvent.get(ev)?.status === "Trading") trading.push(ev);
      }
    }
    this.tradingEventIds = trading.sort((a, b) => a - b);
  }

  legsFor(event: number): EventLegs | undefined {
    return this.legsByEvent.get(event);
  }

  metaFor(market: number): MarketMeta | undefined {
    return this.metas.get(market);
  }
}
