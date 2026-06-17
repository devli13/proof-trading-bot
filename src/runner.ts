import { ExchangeClient } from "@proof/trading-sdk";
import type { TxResult } from "@proof/trading-sdk";
import {
  createClient,
  placeLimitOrder,
  cancelAllOrders,
  queryAccountSafe,
} from "./client";
import { loadWallet } from "./wallet";
import type { Wallet } from "./wallet";
import { requestFaucetDrip } from "./faucet";
import type { Config } from "./config";
import type { Logger } from "./logger";
import type { PlaceLimitArgs, Strategy, StrategyContext } from "./strategy/types";

interface BuiltContext {
  ctx: StrategyContext;
  client: ExchangeClient;
  wallet: Wallet;
}

/** Wire up a client + wallet + risk-guarded StrategyContext. */
async function buildContext(config: Config, logger: Logger): Promise<BuiltContext> {
  const wallet = await loadWallet(config, logger);
  const client = createClient(config);
  client.setPrivateKey(wallet.privateKey);

  // Top up a freshly-generated/keystore key if a faucet token is available.
  if (
    config.faucetToken &&
    (wallet.source === "generated" || wallet.source === "keystore")
  ) {
    await requestFaucetDrip({
      faucetUrl: config.faucetUrl,
      token: config.faucetToken,
      address0x: wallet.address0x,
      logger,
    });
  }

  const ctx: StrategyContext = {
    client,
    wallet,
    config,
    logger,
    markets: () => client.queryMarkets(),
    orderbook: (m) => client.queryOrderbook(m),
    account: () => queryAccountSafe(client),
    openOrders: () => client.queryOpenOrders(),
    placeLimit: (p) => guardedPlace(client, wallet, config, logger, p),
    cancelAll: (m) => cancelAllOrders(client, wallet, m),
  };
  return { ctx, client, wallet };
}

/** Enforce risk caps before any order reaches the exchange. */
async function guardedPlace(
  client: ExchangeClient,
  wallet: Wallet,
  config: Config,
  logger: Logger,
  p: PlaceLimitArgs,
): Promise<TxResult> {
  if (p.quantity > config.maxOrderQty) {
    logger.warn(
      { quantity: p.quantity.toString(), cap: config.maxOrderQty.toString() },
      "risk: order qty exceeds MAX_ORDER_QTY — blocked",
    );
    throw new Error(
      `order qty ${p.quantity} exceeds MAX_ORDER_QTY ${config.maxOrderQty}`,
    );
  }
  const open = await client.queryOpenOrders();
  if (open.length >= config.maxOpenOrders) {
    logger.warn(
      { open: open.length, cap: config.maxOpenOrders },
      "risk: max open orders reached — blocked",
    );
    throw new Error(
      `max open orders reached (${open.length}/${config.maxOpenOrders})`,
    );
  }
  return placeLimitOrder(client, wallet, p);
}

export interface TickResult {
  strategy: string;
  address: string;
  equity?: string;
}

/**
 * Run a single strategy tick and tear down. This is the serverless/cron
 * entrypoint (Vercel `/api/tick`) and any one-shot scheduled invocation.
 */
export async function executeTick(
  config: Config,
  logger: Logger,
  strategy: Strategy,
): Promise<TickResult> {
  const { ctx, client, wallet } = await buildContext(config, logger);
  try {
    await strategy.onTick?.(ctx);
    const account = await ctx.account();
    return {
      strategy: strategy.name,
      address: wallet.address0x,
      equity: account ? account.equity.toString() : undefined,
    };
  } finally {
    client.disconnect();
  }
}

/**
 * Long-lived loop for a server/VM: init once, react to blocks (if a WS is
 * available) and to a fixed-interval tick, and flatten on shutdown.
 */
export async function runBot(
  config: Config,
  logger: Logger,
  strategy: Strategy,
): Promise<void> {
  const { ctx, client, wallet } = await buildContext(config, logger);
  logger.info(
    {
      strategy: strategy.name,
      address: wallet.address0x,
      network: config.network,
      tickMs: config.tickIntervalMs,
    },
    "bot: starting",
  );
  await strategy.init?.(ctx);

  let stopBlocks: (() => void) | undefined;
  try {
    stopBlocks = client.subscribeBlocks((event: Record<string, unknown>) => {
      void strategy
        .onBlock?.(ctx, event)
        .catch((err: unknown) =>
          logger.error({ err: (err as Error).message }, "onBlock error"),
        );
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "bot: block subscription unavailable — polling only",
    );
  }

  const timer = setInterval(() => {
    void strategy
      .onTick?.(ctx)
      .catch((err: unknown) =>
        logger.error({ err: (err as Error).message }, "onTick error"),
      );
  }, config.tickIntervalMs);

  await new Promise<void>((resolve) => {
    const shutdown = async (sig: string): Promise<void> => {
      logger.info({ sig }, "bot: shutting down");
      clearInterval(timer);
      stopBlocks?.();
      try {
        await strategy.shutdown?.(ctx);
      } catch (err) {
        logger.error({ err: (err as Error).message }, "shutdown error");
      }
      client.disconnect();
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}
