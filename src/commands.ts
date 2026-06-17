import { createClient, queryAccountSafe } from "./client.js";
import { loadWallet, generateWallet } from "./wallet.js";
import { requestFaucetDrip } from "./faucet.js";
import { formatMicroUsdc } from "./units.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

/** `wallet` — show the current keypair; `wallet new` — generate a fresh one. */
export async function walletCommand(
  config: Config,
  logger: Logger,
  fresh: boolean,
): Promise<void> {
  const wallet = fresh
    ? await generateWallet(config, logger)
    : await loadWallet(config, logger);
  logger.info(
    { address: wallet.address0x, source: wallet.source, keystore: config.keystorePath },
    fresh ? "wallet: created new keypair" : "wallet: current keypair",
  );
  logger.info(
    `  fund it: POST ${config.faucetUrl}/drip  body {"address":"${wallet.address0x}"}  (needs PROOF_FAUCET_TOKEN)`,
  );
}

/** `fund` — drip the configured devnet faucet into the loaded wallet. */
export async function fundCommand(config: Config, logger: Logger): Promise<void> {
  const wallet = await loadWallet(config, logger);
  const client = createClient(config);
  client.setPrivateKey(wallet.privateKey);

  if (!config.faucetToken) {
    logger.error(
      "fund: PROOF_FAUCET_TOKEN is not set — cannot call the privileged devnet faucet",
    );
    logger.error(
      "  alternatives: set PROOF_ACCESS_CODE + PROOF_REDEEM_URL, or import a funded PROOF_PRIVATE_KEY",
    );
    client.disconnect();
    process.exitCode = 1;
    return;
  }

  const drip = await requestFaucetDrip({
    faucetUrl: config.faucetUrl,
    token: config.faucetToken,
    address0x: wallet.address0x,
    logger,
  });

  if (drip.funded) {
    await new Promise((r) => setTimeout(r, 3000)); // let the deposit land
    const account = await queryAccountSafe(client);
    logger.info(
      {
        address: wallet.address0x,
        balance: account ? `$${formatMicroUsdc(account.balance)}` : "pending",
        equity: account ? `$${formatMicroUsdc(account.equity)}` : "pending",
      },
      "fund: done ✓",
    );
  } else {
    logger.error({ status: drip.status, message: drip.message }, "fund: faucet drip failed");
    process.exitCode = 1;
  }
  client.disconnect();
}
