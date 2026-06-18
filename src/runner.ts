import { ExchangeClient, Side } from "@proof/trading-sdk";
import type { AccountInfo, AtomicBasketLeg, MarketConfig, Orderbook, TxResult } from "@proof/trading-sdk";
import {
  createClient,
  placeLimitOrder,
  cancelAllOrders,
  placeBasket,
  queryAccountViaInfo,
} from "./client.js";
import { loadWallet } from "./wallet.js";
import type { Wallet } from "./wallet.js";
import { discoverEventLegs } from "./impact.js";
import type { EventLegs } from "./impact.js";
import { snapPrice, snapQty, nextClientOrderId } from "./orders.js";
import { checkAccount, newRiskState } from "./risk.js";
import type { RiskState } from "./risk.js";
import { createTracker } from "./tracking/index.js";
import type { Tracker } from "./tracking/index.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type {
  BasketLegArg,
  MarketMeta,
  PlaceArgs,
  Strategy,
  StrategyContext,
} from "./strategy/types.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, tries = 3, baseMs = 200): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < tries - 1) await sleep(baseMs * (i + 1));
    }
  }
  throw last;
}

function toMeta(m: MarketConfig): MarketMeta {
  return {
    market: m.market,
    tickSize: m.tickSize ?? 0n,
    lotSize: m.lotSize ?? 0n,
    szDecimals: m.szDecimals ?? 0,
    takerFeeBps: m.takerFeeBps,
    makerFeeBps: m.makerFeeBps,
  };
}

export interface TickSummary {
  halted: boolean;
  reason?: string;
  equity?: string;
  marginRatioBps?: string;
}

/** Stateful engine: one client+wallet+tracker shared across strategies. */
export class BotEngine {
  private legs?: EventLegs;
  private readonly metas = new Map<number, MarketMeta>();
  private cacheAt = 0;
  private submitChain: Promise<unknown> = Promise.resolve();
  private lastSubmitMs = 0;
  private readonly riskState: RiskState = newRiskState();
  private halted = false;

  private constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly strategies: Strategy[],
    private readonly client: ExchangeClient,
    private readonly wallet: Wallet,
    private readonly tracker: Tracker,
  ) {}

  static async create(
    config: Config,
    logger: Logger,
    strategies: Strategy[],
  ): Promise<BotEngine> {
    const wallet = await loadWallet(config, logger);
    const client = createClient(config);
    client.setPrivateKey(wallet.privateKey);
    const tracker = await createTracker(config, logger);
    logger.info(
      {
        address: wallet.address0x,
        event: config.impactEvent,
        strategies: strategies.map((s) => s.name),
        tracker: tracker.backend,
        dryRun: config.dryRun,
      },
      "engine: created",
    );
    return new BotEngine(config, logger, strategies, client, wallet, tracker);
  }

  get eventLegs(): EventLegs | undefined {
    return this.legs;
  }

  private async refreshCache(now: number): Promise<void> {
    if (this.legs && now - this.cacheAt < this.config.marketCacheMs) return;
    this.legs = await discoverEventLegs(this.config.gatewayUrl, this.config.impactEvent);
    const markets = await this.client.queryMarkets();
    this.metas.clear();
    for (const m of markets) this.metas.set(m.market, toMeta(m));
    this.cacheAt = now;
  }

  /** Serialize submits so no two share a millisecond-timestamp nonce (code 21). */
  private async enqueueSubmit<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      let now = Date.now();
      if (now <= this.lastSubmitMs) {
        await sleep(this.lastSubmitMs - now + 1);
        now = Date.now();
      }
      this.lastSubmitMs = now;
      return fn();
    };
    const p = this.submitChain.then(run, run);
    this.submitChain = p.then(
      () => undefined,
      () => undefined,
    );
    return p as Promise<T>;
  }

  async tick(): Promise<TickSummary> {
    if (this.halted) return { halted: true, reason: "halted" };
    const now = Date.now();
    await this.refreshCache(now);
    const legs = this.legs!;

    const account = await retry(() =>
      queryAccountViaInfo(this.config.gatewayUrl, this.wallet.address0x),
    ).catch(() => null);

    if (account) void this.recordSnapshot(account, now);

    const verdict = checkAccount(account, this.riskState, this.config);
    if (!verdict.ok) {
      this.logger.error({ reason: verdict.reason }, "RISK: kill-switch — cancelling all + halting");
      this.halted = true;
      void this.tracker.recordDecision({
        ts: now,
        strategy: "risk",
        action: "kill-switch",
        detail: { reason: verdict.reason ?? "", equity: verdict.equity.toString() },
      });
      if (!this.config.dryRun) {
        try {
          await this.enqueueSubmit(() => cancelAllOrders(this.client, this.wallet)); // account-wide
        } catch (err) {
          this.logger.error({ err: (err as Error).message }, "kill-switch cancel failed");
        }
      }
      return { halted: true, reason: verdict.reason, equity: verdict.equity.toString() };
    }

    const view = account ? { positions: account.positions, equity: account.equity } : null;
    for (const strat of this.strategies) {
      try {
        await strat.onTick(this.buildContext(strat, legs, view, now));
      } catch (err) {
        this.logger.error({ strategy: strat.name, err: (err as Error).message }, "strategy tick error");
      }
    }
    return {
      halted: false,
      equity: account?.equity.toString(),
      marginRatioBps: verdict.marginRatioBps.toString(),
    };
  }

  private async recordSnapshot(account: AccountInfo, now: number): Promise<void> {
    try {
      await this.tracker.recordSnapshot({
        ts: now,
        balance: account.balance.toString(),
        equity: account.equity.toString(),
        marginRatioBps: account.marginRatioBps.toString(),
        positions: account.positions.map((p) => ({
          market: p.market,
          side: p.side,
          size: p.size.toString(),
          entryPrice: p.entryPrice.toString(),
        })),
      });
    } catch {
      /* tracking must never break a tick */
    }
  }

  private buildContext(
    strat: Strategy,
    legs: EventLegs,
    account: StrategyContext["account"],
    now: number,
  ): StrategyContext {
    const slog = this.logger.child({ strategy: strat.name });
    return {
      name: strat.name,
      config: this.config,
      logger: slog,
      wallet: this.wallet,
      legs,
      account,
      nowMs: now,
      marketMeta: (m) => this.metas.get(m),
      orderbook: (m) => retry<Orderbook>(() => this.client.queryOrderbook(m)),
      positionFor: (m) => account?.positions.find((p) => p.market === m),
      place: (p) => this.place(strat.name, p),
      cancelMarket: (m) => this.cancelMarket(m),
      basket: (l, s) => this.basket(strat.name, l, s),
      recordDecision: (action, detail) => {
        void this.tracker.recordDecision({ ts: Date.now(), strategy: strat.name, action, detail });
        slog.debug({ action, ...detail }, `${strat.name}: ${action}`);
      },
    };
  }

  private async place(strategy: string, p: PlaceArgs): Promise<TxResult | null> {
    const meta = this.metas.get(p.market);
    if (!meta) {
      this.logger.warn({ market: p.market }, "place: no market meta");
      return null;
    }
    const side: "Buy" | "Sell" = p.side === Side.Buy ? "Buy" : "Sell";
    const price = snapPrice(p.price, meta.tickSize, side);
    let qty = snapQty(p.quantity, meta.lotSize);
    if (qty > this.config.maxOrderQty) qty = snapQty(this.config.maxOrderQty, meta.lotSize);
    if (qty <= 0n || price <= 0n) {
      this.logger.warn({ market: p.market, qty: qty.toString() }, "place: skipped after snap (zero qty/price)");
      return null;
    }
    const coid = nextClientOrderId();
    if (this.config.dryRun) {
      void this.recordOrder(strategy, "order", p.market, side, price, qty, coid, undefined, undefined, "dry-run");
      this.logger.info({ strategy, market: p.market, side, price: price.toString(), qty: qty.toString() }, "DRY_RUN place");
      return null;
    }
    const res = await this.enqueueSubmit(() =>
      placeLimitOrder(this.client, this.wallet, {
        market: p.market,
        side: p.side,
        price,
        quantity: qty,
        postOnly: p.postOnly,
        reduceOnly: p.reduceOnly,
        clientOrderId: coid,
      }),
    );
    void this.recordOrder(strategy, "order", p.market, side, price, qty, coid, res.hash, res.code);
    return res;
  }

  private async cancelMarket(market: number): Promise<TxResult | null> {
    if (this.config.dryRun) return null;
    return this.enqueueSubmit(() => cancelAllOrders(this.client, this.wallet, market));
  }

  private async basket(
    strategy: string,
    legsArg: BasketLegArg[],
    maxSlippageBps?: number,
  ): Promise<TxResult | null> {
    const snapped: AtomicBasketLeg[] = [];
    for (const l of legsArg) {
      const meta = this.metas.get(l.market);
      if (!meta) {
        this.logger.warn({ market: l.market }, "basket: no meta — aborting");
        return null;
      }
      const side: "Buy" | "Sell" = l.side === Side.Buy ? "Buy" : "Sell";
      const price = snapPrice(l.price, meta.tickSize, side);
      let qty = snapQty(l.quantity, meta.lotSize);
      if (qty > this.config.maxOrderQty) qty = snapQty(this.config.maxOrderQty, meta.lotSize);
      if (qty <= 0n || price <= 0n) {
        this.logger.warn({ market: l.market }, "basket: zero qty/price after snap — aborting");
        return null;
      }
      snapped.push({
        market: l.market,
        side: l.side,
        price,
        quantity: qty,
        clientOrderId: nextClientOrderId(),
        reduceOnly: l.reduceOnly,
      });
    }
    if (this.config.dryRun) {
      for (const l of snapped) {
        const side: "Buy" | "Sell" = l.side === Side.Buy ? "Buy" : "Sell";
        void this.recordOrder(strategy, "basket", l.market, side, l.price, l.quantity, l.clientOrderId ?? 0n, undefined, undefined, "dry-run");
      }
      this.logger.info({ strategy, legs: snapped.length }, "DRY_RUN basket");
      return null;
    }
    const res = await this.enqueueSubmit(() => placeBasket(this.client, this.wallet, snapped, maxSlippageBps));
    for (const l of snapped) {
      const side: "Buy" | "Sell" = l.side === Side.Buy ? "Buy" : "Sell";
      void this.recordOrder(strategy, "basket", l.market, side, l.price, l.quantity, l.clientOrderId ?? 0n, res.hash, res.code);
    }
    return res;
  }

  private async recordOrder(
    strategy: string,
    kind: "order" | "basket",
    market: number,
    side: "Buy" | "Sell",
    price: bigint,
    qty: bigint,
    coid: bigint,
    txHash: string | undefined,
    checkTxCode: number | undefined,
    note?: string,
  ): Promise<void> {
    try {
      await this.tracker.recordOrder({
        clientOrderId: coid.toString(),
        strategy,
        kind,
        market,
        side,
        price: price.toString(),
        quantity: qty.toString(),
        txHash,
        checkTxCode,
        note,
        ts: Date.now(),
      });
    } catch {
      /* ignore */
    }
  }

  /** Tear down WITHOUT cancelling (serverless: let resting orders persist between ticks). */
  async dispose(): Promise<void> {
    this.client.disconnect();
    await this.tracker.close();
  }

  /** Full shutdown: cancel everything, run strategy shutdowns, close. */
  async shutdown(): Promise<void> {
    if (!this.config.dryRun) {
      try {
        await this.enqueueSubmit(() => cancelAllOrders(this.client, this.wallet));
      } catch (err) {
        this.logger.error({ err: (err as Error).message }, "shutdown cancel failed");
      }
    }
    if (this.legs) {
      for (const s of this.strategies) {
        if (s.shutdown) {
          try {
            await s.shutdown(this.buildContext(s, this.legs, null, Date.now()));
          } catch (err) {
            this.logger.error({ strategy: s.name, err: (err as Error).message }, "strategy shutdown error");
          }
        }
      }
    }
    this.client.disconnect();
    await this.tracker.close();
  }
}

/** One-shot tick (Vercel cron / scheduled). Does NOT cancel resting orders on exit. */
export async function executeTick(
  config: Config,
  logger: Logger,
  strategies: Strategy[],
): Promise<TickSummary> {
  const engine = await BotEngine.create(config, logger, strategies);
  try {
    return await engine.tick();
  } finally {
    await engine.dispose();
  }
}

/** Long-lived loop (server/VM). Ticks every TICK_INTERVAL_MS; flattens on SIGINT/SIGTERM. */
export async function runBot(
  config: Config,
  logger: Logger,
  strategies: Strategy[],
): Promise<void> {
  const engine = await BotEngine.create(config, logger, strategies);
  logger.info({ tickMs: config.tickIntervalMs }, "bot: starting loop");

  let stopping = false;
  const timer = setInterval(() => {
    if (stopping) return;
    void engine.tick().catch((err) => logger.error({ err: (err as Error).message }, "tick error"));
  }, config.tickIntervalMs);

  await new Promise<void>((resolve) => {
    const shutdown = async (sig: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      logger.info({ sig }, "bot: shutting down — flattening");
      clearInterval(timer);
      await engine.shutdown();
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}
