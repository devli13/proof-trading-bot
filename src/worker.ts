import "dotenv/config";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { loadBotsFromRegistry, openRegistrySql } from "./bots.js";
import type { BotSpec } from "./bots.js";
import { BotEngine } from "./runner.js";
import { MarketData } from "./market-data.js";
import { createClient } from "./client.js";
import { createTracker } from "./tracking/index.js";
import type { Tracker } from "./tracking/index.js";
import { buildStrategies } from "./strategy/index.js";
import { walletFromPrivateKey } from "./wallet.js";

/**
 * Persistent multi-bot worker (Render). Loads the bot roster from the Supabase
 * registry, runs one BotEngine per bot (its own wallet/kill-switch) against a
 * SHARED market-data + tracker, ticks them all concurrently, and hot-reloads the
 * roster so bots can be added/removed by inserting/disabling a row — no restart.
 */

function resolveEvents(spec: BotSpec, unionEvents: number[]): number[] {
  return spec.markets === "all" ? unionEvents : spec.markets;
}

export async function runWorker(): Promise<void> {
  const baseConfig = loadConfig();
  const logger = createLogger(baseConfig.logLevel);
  if (!baseConfig.databaseUrl) throw new Error("worker requires DATABASE_URL (the bots registry + tracking store)");
  if (!baseConfig.botsEncKey) throw new Error("worker requires BOTS_ENC_KEY (to decrypt bot keys)");

  const tracker = await createTracker(baseConfig, logger); // shared; migrates the schema (incl. bots table)
  const registrySql = await openRegistrySql(baseConfig); // shared registry connection (reused every refresh)
  const readClient = createClient(baseConfig);
  const marketData = new MarketData(baseConfig.gatewayUrl, readClient, baseConfig.marketCacheMs, baseConfig.autoDiscoverEvents);
  const engines = new Map<string, BotEngine>();
  const specHashByBot = new Map<string, string>();
  let lastEventsLog = "";

  // Fingerprint of the fields that, if changed, require recreating the engine. Includes
  // the RESOLVED events (not just spec.markets) so an "all" bot is rebuilt with the new
  // event set when auto-discovery picks up a freshly-launched market.
  const specHash = (s: BotSpec, unionEvents: number[]): string =>
    JSON.stringify({ s: s.strategies, m: s.markets, t: s.tags, p: s.params, k: s.privateKeyHex.slice(-10), e: resolveEvents(s, unionEvents) });

  async function buildEngine(spec: BotSpec, unionEvents: number[]): Promise<BotEngine | null> {
    const cfg: Config = loadConfig({
      ...process.env,
      PROOF_PRIVATE_KEY: spec.privateKeyHex,
      STRATEGIES: spec.strategies.join(","),
      ...spec.params,
    });
    const strategies = buildStrategies(cfg);
    if (strategies.length === 0) {
      logger.warn({ bot: spec.id, strategies: spec.strategies }, "worker: bot has no known strategies — skipping");
      return null;
    }
    const wallet = walletFromPrivateKey(spec.privateKeyHex);
    return BotEngine.create(cfg, logger, strategies, {
      botId: spec.id,
      wallet,
      tracker,
      marketData,
      events: resolveEvents(spec, unionEvents),
    });
  }

  async function syncRoster(): Promise<void> {
    let specs: BotSpec[];
    try {
      specs = await loadBotsFromRegistry(baseConfig, logger, registrySql);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "worker: failed to load roster — keeping current bots");
      return;
    }

    // Reject duplicate wallets across the roster: two bots on the SAME key would
    // collide on the ms-timestamp nonce (independent submit queues, same account).
    const seenAddr = new Map<string, string>();
    const usable: BotSpec[] = [];
    for (const spec of specs) {
      let addr: string;
      try {
        addr = walletFromPrivateKey(spec.privateKeyHex).address0x;
      } catch (err) {
        logger.error({ bot: spec.id, err: (err as Error).message }, "worker: bad key — skipping bot");
        continue;
      }
      const owner = seenAddr.get(addr);
      if (owner) {
        logger.error({ bot: spec.id, conflictsWith: owner, address: addr }, "worker: DUPLICATE wallet across bots — skipping (would collide on the ms-nonce)");
        continue;
      }
      seenAddr.set(addr, spec.id);
      usable.push(spec);
    }

    // Seed the explicitly-requested events (the union any bot lists by id), then refresh:
    // with auto-discovery on, MarketData also probes every live event and reports which are
    // Trading. "all" bots trade that live trading set, so newly-launched Proof markets are
    // picked up automatically (no registry edit). Falls back to explicit / configured event.
    const explicit = new Set<number>();
    for (const s of usable) if (Array.isArray(s.markets)) s.markets.forEach((e) => explicit.add(e));
    marketData.setEvents(explicit.size ? Array.from(explicit) : [baseConfig.impactEvent]);
    try {
      await marketData.ensureFresh();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "worker: market-data refresh failed during sync");
    }
    const trading = marketData.tradingEvents();
    const unionEvents = trading.length ? trading : explicit.size ? Array.from(explicit) : [baseConfig.impactEvent];
    const eventsKey = unionEvents.join(",");
    if (eventsKey !== lastEventsLog) {
      logger.info({ tradingEvents: unionEvents, discovered: baseConfig.autoDiscoverEvents }, "worker: live trading events updated");
      lastEventsLog = eventsKey;
    }

    // Remove bots that were disabled / deleted / skipped (dup or bad key).
    const live = new Set(usable.map((s) => s.id));
    for (const [id, engine] of engines) {
      if (live.has(id)) continue;
      engines.delete(id);
      specHashByBot.delete(id);
      void engine.shutdown().catch(() => {});
      logger.info({ bot: id }, "worker: bot removed");
    }

    // Add new bots; RECREATE ones whose config changed (hot-update).
    for (const spec of usable) {
      const hash = specHash(spec, unionEvents);
      if (engines.has(spec.id) && specHashByBot.get(spec.id) === hash) continue; // unchanged
      try {
        if (engines.has(spec.id)) {
          await engines.get(spec.id)!.shutdown().catch(() => {});
          logger.info({ bot: spec.id }, "worker: bot config changed — recreating");
        }
        const engine = await buildEngine(spec, unionEvents);
        if (!engine) {
          engines.delete(spec.id);
          specHashByBot.delete(spec.id);
          continue;
        }
        engines.set(spec.id, engine);
        specHashByBot.set(spec.id, hash);
        logger.info({ bot: spec.id, strategies: spec.strategies, tags: spec.tags, events: resolveEvents(spec, unionEvents) }, "worker: bot active");
      } catch (err) {
        logger.error({ bot: spec.id, err: (err as Error).message }, "worker: failed to start bot");
      }
    }
  }

  await syncRoster();
  logger.info({ bots: engines.size, tickMs: baseConfig.tickIntervalMs, refreshMs: baseConfig.botsRefreshMs, dryRun: baseConfig.dryRun }, "worker: started");

  await loop(baseConfig, logger, marketData, engines, syncRoster, async () => {
    readClient.disconnect();
    await registrySql.end({ timeout: 3 }).catch(() => {});
    await tracker.close();
  });
}

async function loop(
  config: Config,
  logger: Logger,
  marketData: MarketData,
  engines: Map<string, BotEngine>,
  syncRoster: () => Promise<void>,
  teardown: () => Promise<void>,
): Promise<void> {
  let stopping = false;
  let ticking = false;
  let syncing = false;

  const tickTimer = setInterval(() => {
    if (stopping || ticking) return; // skip if the previous batch is still running (no self-overlap)
    ticking = true;
    void (async () => {
      try {
        await marketData.ensureFresh();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "worker: market-data refresh failed");
      }
      await Promise.all(
        Array.from(engines.values()).map((e) =>
          e.tick().catch((err) => logger.error({ bot: e.id, err: (err as Error).message }, "worker: tick error")),
        ),
      );
    })().finally(() => {
      ticking = false;
    });
  }, config.tickIntervalMs);

  const refreshTimer = setInterval(() => {
    if (stopping || syncing) return;
    syncing = true;
    void syncRoster()
      .catch((err) => logger.error({ err: (err as Error).message }, "worker: roster sync error"))
      .finally(() => {
        syncing = false;
      });
  }, config.botsRefreshMs);

  await new Promise<void>((resolve) => {
    const shutdown = async (sig: string): Promise<void> => {
      if (stopping) return;
      stopping = true;
      logger.info({ sig, bots: engines.size }, "worker: shutting down — flattening all bots");
      clearInterval(tickTimer);
      clearInterval(refreshTimer);
      await Promise.all(Array.from(engines.values()).map((e) => e.shutdown().catch(() => {})));
      await teardown();
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}
