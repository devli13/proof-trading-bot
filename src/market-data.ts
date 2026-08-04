import type { ExchangeClient, MarketConfig } from "@proof/trading-sdk";
import { discoverEventLegs, discoverImpactEventIds } from "./impact.js";
import type { EventLegs } from "./impact.js";
import type { MarketMeta } from "./strategy/types.js";

// Cap only how many BRAND-NEW event ids we probe per refresh (highest ids first — new
// markets get the highest ids). Known-live + explicit events are ALWAYS probed on top of
// this, so a live low-id event can never be starved out by newer ids.
const MAX_NEW_PROBES = 32;
// Space out the /info probes so a burst doesn't trip the gateway's per-IP rate limit
// (which stalled discovery on the VPS). Once per cache window.
const PROBE_DELAY_MS = 120;
// Never treat an event as Trading based on cached status older than this — so a since-
// resolved event whose /info probe is failing (rate-limited) stops being run on stale status.
const LEGS_STALE_MS = 15 * 60_000;
// After an event stops being Trading, keep running its engine this long so the strategies'
// nearResolution guard can FLATTEN any open position before settlement (a sudden
// Trading→Resolved with no PreResolution window would otherwise strand inventory).
const FLATTEN_GRACE_MS = 15 * 60_000;
// Only a genuinely-terminal status is permanently dropped; PreResolution/Unknown keep being
// re-probed (a transient non-Trading first probe must not exile an event that then goes live).
const TERMINAL = new Set(["Resolved", "Settled", "Voided"]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  private legsFetchedAt = new Map<number, number>();
  private lastTradingAt = new Map<number, number>();
  private metas = new Map<number, MarketMeta>();
  private events: number[] = [];
  private runEventIds: number[] = []; // events the "all" bots run: Trading + pre-settlement grace
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

  /** Events the "all" bots should run: those currently Trading, PLUS ones that just stopped
   *  trading (PreResolution / within the flatten grace) so the strategies' nearResolution
   *  guard can close open positions before settlement. Drives the worker's unionEvents —
   *  new markets are picked up live, resolved ones age out after flattening. */
  tradingEvents(): number[] {
    return this.runEventIds;
  }

  async ensureFresh(now = Date.now()): Promise<void> {
    if (this.metas.size > 0 && now - this.fetchedAt < this.cacheMs) return;
    if (this.inflight) {
      await this.inflight;
      return;
    }
    let ok = false;
    this.inflight = this.refresh(now)
      .then(() => { ok = true; })
      .finally(() => {
        if (ok) this.fetchedAt = Date.now(); // only a SUCCESSFUL refresh resets the cache clock
        this.inflight = undefined;
      });
    await this.inflight;
  }

  private async refresh(now = Date.now()): Promise<void> {
    // queryMarkets = market metadata + the discovery candidate list. It's the big (~1.1MB)
    // call the gateway rate-limits from some IPs; if it fails we KEEP stale metas and still
    // refresh leg status below (a separate, cheap call), so we never run an event whose
    // status has silently gone stale. First-ever fetch must succeed — with no metadata
    // there's nothing to trade with.
    let discovered: number[] = [];
    try {
      const markets = await this.client.queryMarkets();
      const metas = new Map<number, MarketMeta>();
      for (const m of markets) metas.set(m.market, toMeta(m));
      this.metas = metas;
      if (this.autoDiscover) discovered = discoverImpactEventIds(markets);
    } catch (err) {
      if (this.metas.size === 0) throw err;
    }

    // ALWAYS probe explicit + currently-run events (so a live/held event is never starved by
    // the cap); ADD brand-new discovered ids, capped. Permanently drop only genuinely-terminal
    // events past their flatten grace — PreResolution/Unknown keep being probed so a transient
    // first status can't exile an event that later goes live.
    const known = new Set<number>([...this.events, ...this.runEventIds]);
    const newIds = discovered.filter((e) => !known.has(e)).sort((a, b) => b - a).slice(0, MAX_NEW_PROBES);
    const candidates = [...known, ...newIds].filter((ev) => {
      const cached = this.legsByEvent.get(ev);
      if (!cached || !TERMINAL.has(cached.status)) return true; // never-seen or non-terminal → probe
      const lt = this.lastTradingAt.get(ev); // terminal → keep only during the flatten grace
      return lt !== undefined && now - lt < FLATTEN_GRACE_MS;
    });

    // An event is RUN if it's tradeable now (Trading/PreResolution) or within the grace after
    // last trading — so nearResolution can flatten before settlement. Genuinely-terminal
    // events past grace drop out (rebuilding the "all" engines without them).
    const shouldRun = (status: string, ev: number): boolean => {
      if (status === "Trading" || status === "PreResolution") return true;
      const lt = this.lastTradingAt.get(ev);
      return lt !== undefined && now - lt < FLATTEN_GRACE_MS;
    };

    const run: number[] = [];
    for (const ev of candidates) {
      try {
        const legs = await discoverEventLegs(this.gatewayUrl, ev);
        this.legsByEvent.set(ev, legs);
        this.legsFetchedAt.set(ev, now);
        if (legs.status === "Trading") this.lastTradingAt.set(ev, now);
        if (shouldRun(legs.status, ev)) run.push(ev);
      } catch {
        // /info failed (rate-limited/transient): keep running ONLY on fresh, non-terminal
        // cached status. A stale status must NOT keep an event alive indefinitely.
        const cached = this.legsByEvent.get(ev);
        const age = now - (this.legsFetchedAt.get(ev) ?? 0);
        if (cached && !TERMINAL.has(cached.status) && age < LEGS_STALE_MS && shouldRun(cached.status, ev)) run.push(ev);
      }
      await sleep(PROBE_DELAY_MS);
    }
    this.runEventIds = Array.from(new Set(run)).sort((a, b) => a - b);
  }

  legsFor(event: number): EventLegs | undefined {
    return this.legsByEvent.get(event);
  }

  metaFor(market: number): MarketMeta | undefined {
    return this.metas.get(market);
  }
}
