import { ExchangeClient, Side } from "@proof/trading-sdk";
import type { AccountInfo, AtomicBasketLeg, Orderbook, TxResult } from "@proof/trading-sdk";
import {
  createClient,
  placeLimitOrder,
  cancelAllOrders,
  placeBasket,
  queryAccountViaInfo,
} from "./client.js";
import { loadWallet } from "./wallet.js";
import type { Wallet } from "./wallet.js";
import type { EventLegs } from "./impact.js";
import { MarketData } from "./market-data.js";
import { snapPrice, snapQty, nextClientOrderId } from "./orders.js";
import { checkAccount, newRiskState } from "./risk.js";
import type { RiskState } from "./risk.js";
import { createTracker } from "./tracking/index.js";
import type { Tracker } from "./tracking/index.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type {
  BasketLegArg,
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

export interface TickSummary {
  halted: boolean;
  reason?: string;
  equity?: string;
  marginRatioBps?: string;
}

/** Everything a single bot needs that the worker/caller injects (shared or per-bot). */
export interface BotEngineDeps {
  botId: string; // registry id, tags every record
  wallet: Wallet; // this bot's own key
  tracker: Tracker; // SHARED across bots — engine never closes it
  marketData: MarketData; // SHARED — fetched once for all bots
  events: number[]; // resolved impact events this bot trades
}

/**
 * Stateful engine for ONE bot (one wallet / account). Strategies run against each
 * of the bot's assigned markets every tick. The tracker + market data are shared
 * across all bots (the worker owns their lifecycle); the wallet, client, kill-switch
 * and submit-queue are per-bot.
 */
export class BotEngine {
  private submitChain: Promise<unknown> = Promise.resolve();
  private lastSubmitMs = 0;
  private readonly riskState: RiskState = newRiskState();
  private halted = false;

  private constructor(
    private readonly botId: string,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly strategies: Strategy[],
    private readonly client: ExchangeClient,
    private readonly wallet: Wallet,
    private readonly tracker: Tracker,
    private readonly marketData: MarketData,
    private readonly events: number[],
  ) {}

  static async create(
    config: Config,
    logger: Logger,
    strategies: Strategy[],
    deps: BotEngineDeps,
  ): Promise<BotEngine> {
    const client = createClient(config);
    client.setPrivateKey(deps.wallet.privateKey);
    logger.info(
      {
        bot: deps.botId,
        address: deps.wallet.address0x,
        events: deps.events,
        strategies: strategies.map((s) => s.name),
        dryRun: config.dryRun,
      },
      "engine: created",
    );
    return new BotEngine(
      deps.botId,
      config,
      logger,
      strategies,
      client,
      deps.wallet,
      deps.tracker,
      deps.marketData,
      deps.events,
    );
  }

  get id(): string {
    return this.botId;
  }

  /**
   * Serialize submits so no two share a millisecond-timestamp nonce (code 21).
   * Each call waits for the prior submit to settle, then advances `lastSubmitMs`
   * strictly forward (also covering a backwards clock). The caller sees the real
   * result via `result`; the chain swallows so one failure can't poison the queue.
   */
  private enqueueSubmit<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.submitChain.then(async (): Promise<T> => {
      let now = Date.now();
      if (now <= this.lastSubmitMs) {
        await sleep(this.lastSubmitMs - now + 1);
        now = Date.now();
      }
      this.lastSubmitMs = now;
      return fn();
    });
    this.submitChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async tick(): Promise<TickSummary> {
    if (this.halted) return { halted: true, reason: "halted" };
    const now = Date.now();
    await this.marketData.ensureFresh(now); // deduped — usually a no-op (worker refreshed)

    const account = await retry(() =>
      queryAccountViaInfo(this.config.gatewayUrl, this.wallet.address0x),
    ).catch(() => null);

    if (account) void this.recordSnapshot(account, now);

    const verdict = checkAccount(account, this.riskState, this.config);
    if (!verdict.ok) {
      this.logger.error({ bot: this.botId, reason: verdict.reason }, "RISK: kill-switch — cancelling all + halting");
      this.halted = true;
      void this.tracker.recordDecision({
        bot: this.botId,
        ts: now,
        strategy: "risk",
        action: "kill-switch",
        detail: { reason: verdict.reason ?? "", equity: verdict.equity.toString() },
      });
      if (!this.config.dryRun) {
        try {
          await retry(() => this.enqueueSubmit(() => cancelAllOrders(this.client, this.wallet)), 3, 300);
        } catch (err) {
          this.logger.error({ bot: this.botId, err: (err as Error).message }, "kill-switch cancel FAILED after retries");
        }
      }
      return { halted: true, reason: verdict.reason, equity: verdict.equity.toString() };
    }

    const view = account ? { positions: account.positions, equity: account.equity } : null;
    for (const strat of this.strategies) {
      for (const ev of this.events) {
        const legs = this.marketData.legsFor(ev);
        if (!legs) continue;
        try {
          await strat.onTick(this.buildContext(strat, legs, view, now));
        } catch (err) {
          this.logger.error(
            { bot: this.botId, strategy: strat.name, event: ev, err: (err as Error).message },
            "strategy tick error",
          );
        }
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
        bot: this.botId,
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
    const slog = this.logger.child({ bot: this.botId, strategy: strat.name, event: legs.impactId });
    return {
      name: strat.name,
      config: this.config,
      logger: slog,
      wallet: this.wallet,
      legs,
      account,
      nowMs: now,
      marketMeta: (m) => this.marketData.metaFor(m),
      orderbook: (m) => retry<Orderbook>(() => this.client.queryOrderbook(m)),
      positionFor: (m) => account?.positions.find((p) => p.market === m),
      place: (p) => this.place(strat.name, p),
      cancelMarket: (m) => this.cancelMarket(m),
      basket: (l, s) => this.basket(strat.name, l, s),
      recordDecision: (action, detail) => {
        void this.tracker.recordDecision({
          bot: this.botId,
          ts: Date.now(),
          strategy: strat.name,
          action,
          market: legs.impactId,
          detail,
        });
        slog.debug({ action, ...detail }, `${strat.name}: ${action}`);
      },
    };
  }

  private async place(strategy: string, p: PlaceArgs): Promise<TxResult | null> {
    const meta = this.marketData.metaFor(p.market);
    if (!meta) {
      this.logger.warn({ bot: this.botId, market: p.market }, "place: no market meta");
      return null;
    }
    const side: "Buy" | "Sell" = p.side === Side.Buy ? "Buy" : "Sell";
    const price = snapPrice(p.price, meta.tickSize, side);
    let qty = snapQty(p.quantity, meta.lotSize);
    if (qty > this.config.maxOrderQty) qty = snapQty(this.config.maxOrderQty, meta.lotSize);
    if (qty <= 0n || price <= 0n) {
      this.logger.warn({ bot: this.botId, market: p.market, qty: qty.toString() }, "place: skipped after snap (zero qty/price)");
      return null;
    }
    const coid = nextClientOrderId();
    if (this.config.dryRun) {
      void this.recordOrder(strategy, "order", p.market, side, price, qty, coid, undefined, undefined, "dry-run");
      this.logger.info({ bot: this.botId, strategy, market: p.market, side, price: price.toString(), qty: qty.toString() }, "DRY_RUN place");
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
      const meta = this.marketData.metaFor(l.market);
      if (!meta) {
        this.logger.warn({ bot: this.botId, market: l.market }, "basket: no meta — aborting");
        return null;
      }
      const side: "Buy" | "Sell" = l.side === Side.Buy ? "Buy" : "Sell";
      const price = snapPrice(l.price, meta.tickSize, side);
      let qty = snapQty(l.quantity, meta.lotSize);
      if (qty > this.config.maxOrderQty) qty = snapQty(this.config.maxOrderQty, meta.lotSize);
      if (qty <= 0n || price <= 0n) {
        this.logger.warn({ bot: this.botId, market: l.market }, "basket: zero qty/price after snap — aborting");
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
      this.logger.info({ bot: this.botId, strategy, legs: snapped.length }, "DRY_RUN basket");
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
        bot: this.botId,
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

  /** Tear down WITHOUT cancelling (serverless: let resting orders persist). Does NOT close the shared tracker. */
  dispose(): void {
    this.client.disconnect();
  }

  /** Full shutdown: cancel everything, run strategy shutdowns, disconnect. Does NOT close the shared tracker. */
  async shutdown(): Promise<void> {
    if (!this.config.dryRun) {
      try {
        await this.enqueueSubmit(() => cancelAllOrders(this.client, this.wallet));
      } catch (err) {
        this.logger.error({ bot: this.botId, err: (err as Error).message }, "shutdown cancel failed");
      }
    }
    const legs = this.events.map((e) => this.marketData.legsFor(e)).find(Boolean);
    if (legs) {
      for (const s of this.strategies) {
        if (s.shutdown) {
          try {
            await s.shutdown(this.buildContext(s, legs, null, Date.now()));
          } catch (err) {
            this.logger.error({ bot: this.botId, strategy: s.name, err: (err as Error).message }, "strategy shutdown error");
          }
        }
      }
    }
    this.client.disconnect();
  }
}

/**
 * Assemble a single "main" bot from env config (used by the Vercel cron tick and
 * the local `pnpm run` loop). The multi-bot worker builds engines directly.
 */
async function assembleSingleBot(
  config: Config,
  logger: Logger,
  strategies: Strategy[],
): Promise<{ engine: BotEngine; tracker: Tracker; readClient: ExchangeClient }> {
  const wallet = await loadWallet(config, logger);
  const tracker = await createTracker(config, logger);
  const readClient = createClient(config);
  const marketData = new MarketData(config.gatewayUrl, readClient, config.marketCacheMs);
  marketData.setEvents([config.impactEvent]);
  await marketData.ensureFresh();
  const engine = await BotEngine.create(config, logger, strategies, {
    botId: "main",
    wallet,
    tracker,
    marketData,
    events: [config.impactEvent],
  });
  return { engine, tracker, readClient };
}

/** One-shot tick (Vercel cron / scheduled). Does NOT cancel resting orders on exit. */
export async function executeTick(
  config: Config,
  logger: Logger,
  strategies: Strategy[],
): Promise<TickSummary> {
  const { engine, tracker, readClient } = await assembleSingleBot(config, logger, strategies);
  try {
    return await engine.tick();
  } finally {
    engine.dispose();
    readClient.disconnect();
    await tracker.close();
  }
}

/** Long-lived single-bot loop (server/VM). Ticks every TICK_INTERVAL_MS; flattens on SIGINT/SIGTERM. */
export async function runBot(
  config: Config,
  logger: Logger,
  strategies: Strategy[],
): Promise<void> {
  const { engine, tracker, readClient } = await assembleSingleBot(config, logger, strategies);
  logger.info({ tickMs: config.tickIntervalMs }, "bot: starting loop");

  let stopping = false;
  let ticking = false;
  const timer = setInterval(() => {
    if (stopping || ticking) return; // no self-overlap if a tick outlasts the interval
    ticking = true;
    void engine
      .tick()
      .catch((err) => logger.error({ err: (err as Error).message }, "tick error"))
      .finally(() => {
        ticking = false;
      });
  }, config.tickIntervalMs);

  await new Promise<void>((resolve) => {
    const shutdown = async (sig: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      logger.info({ sig }, "bot: shutting down — flattening");
      clearInterval(timer);
      await engine.shutdown();
      readClient.disconnect();
      await tracker.close();
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}
