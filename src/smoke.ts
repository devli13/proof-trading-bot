import { Side } from "@proof/trading-sdk";
import {
  createClient,
  placeLimitOrder,
  cancelAllOrders,
  queryAccountSafe,
} from "./client";
import { loadWallet } from "./wallet";
import { requestFaucetDrip } from "./faucet";
import { formatCents, formatMicroUsdc } from "./units";
import type { Config } from "./config";
import type { Logger } from "./logger";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * End-to-end devnet smoke test. Verifies connectivity + reads always, and —
 * when funded — places a guaranteed-maker bid and cancels it. Mirrors the SDK's
 * examples/connect-and-trade.ts but through this bot's modules.
 */
export async function runSmoke(config: Config, logger: Logger): Promise<void> {
  logger.info(
    { network: config.network, gateway: config.gatewayUrl, chain: config.chainId },
    "smoke: start",
  );
  const client = createClient(config);

  // 1. Health
  const health = await client.queryHealth();
  logger.info({ status: health.status, height: health.height }, "smoke: health ✓");

  // 2. Markets
  const markets = await client.queryMarkets();
  logger.info({ count: markets.length }, "smoke: markets");
  for (const m of markets.slice(0, 5)) {
    logger.info(
      `  market ${m.market} ${m.ticker ?? "—"} kind=${m.kind ?? "Perp"} im=${m.imBps}bps mm=${m.mmBps}bps`,
    );
  }

  // 3. Wallet
  const wallet = await loadWallet(config, logger);
  client.setPrivateKey(wallet.privateKey);
  logger.info({ address: wallet.address0x, source: wallet.source }, "smoke: wallet");

  // 4. Funding
  let funded = wallet.source === "byo" || wallet.source === "access-code";
  if (!funded && config.faucetToken) {
    const drip = await requestFaucetDrip({
      faucetUrl: config.faucetUrl,
      token: config.faucetToken,
      address0x: wallet.address0x,
      logger,
    });
    funded = drip.funded;
    if (funded) await sleep(3000); // wait for the deposit to land on chain
  } else if (!funded) {
    logger.warn(
      "smoke: no funding source (set PROOF_PRIVATE_KEY, PROOF_ACCESS_CODE, or PROOF_FAUCET_TOKEN) — read-only run",
    );
  }

  // 5. Account
  const account = await queryAccountSafe(client);
  if (account) {
    logger.info(
      {
        balance: `$${formatMicroUsdc(account.balance)}`,
        equity: `$${formatMicroUsdc(account.equity)}`,
        positions: account.positions.length,
      },
      "smoke: account",
    );
  } else {
    logger.warn("smoke: account not found (no deposit on chain yet)");
  }

  // 6. Orderbook
  const market = config.market;
  const book = await client.queryOrderbook(market);
  logger.info(
    {
      market,
      bids: book.bids.length,
      asks: book.asks.length,
      bestBid: book.bids[0]?.price?.toString() ?? null,
      bestAsk: book.asks[0]?.price?.toString() ?? null,
    },
    "smoke: orderbook",
  );

  // 7. Place + cancel a maker bid (only when funded with a positive balance)
  if (funded && account && account.balance > 0n) {
    const ref = book.bids[0]?.price ?? book.asks[0]?.price ?? 50_000_00n;
    const price = ref - ref / 100n; // 1% below reference → rests as a maker bid
    const quantity = config.maxOrderQty < 1n ? config.maxOrderQty : 1n;

    logger.info(
      { market, side: "Buy", price: `$${formatCents(price)}`, quantity: quantity.toString(), postOnly: true },
      "smoke: placing maker bid",
    );
    const placed = await placeLimitOrder(client, wallet, {
      market,
      side: Side.Buy,
      price,
      quantity,
      postOnly: true,
    });
    logger.info(
      { code: placed.code, hash: placed.hash, height: placed.height, log: placed.log },
      placed.code === 0 ? "smoke: order landed ✓" : "smoke: order rejected",
    );

    const open = await client.queryOpenOrders();
    logger.info({ openOrders: open.length }, "smoke: open orders");

    const cancelled = await cancelAllOrders(client, wallet, market);
    logger.info(
      { code: cancelled.code, height: cancelled.height },
      cancelled.code === 0 ? "smoke: cancelled ✓" : "smoke: cancel failed",
    );
  } else {
    logger.info("smoke: skipping order placement (no funds) — connectivity + reads verified");
  }

  client.disconnect();
  logger.info("smoke: done");
}
