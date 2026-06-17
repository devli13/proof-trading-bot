import "dotenv/config";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { runSmoke } from "./smoke.js";
import { runBot } from "./runner.js";
import { walletCommand, fundCommand } from "./commands.js";
import { NoopStrategy } from "./strategy/noop.js";

/**
 * CLI entry.
 *   pnpm wallet       → show the current devnet wallet (generates one if none)
 *   pnpm wallet:new   → generate a fresh keypair into the keystore
 *   pnpm fund         → drip the devnet faucet into the wallet (needs token)
 *   pnpm smoke        → one-shot devnet smoke test (connect, read, place+cancel)
 *   pnpm run          → long-lived strategy loop (NoopStrategy by default)
 */
async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "smoke";
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  switch (cmd) {
    case "wallet": {
      const fresh = process.argv[3] === "new" || process.argv.includes("--new");
      await walletCommand(config, logger, fresh);
      break;
    }
    case "fund":
      await fundCommand(config, logger);
      break;
    case "smoke":
      await runSmoke(config, logger);
      break;
    case "run":
      await runBot(config, logger, new NoopStrategy());
      break;
    default:
      logger.error(`unknown command "${cmd}" — use: wallet | fund | smoke | run`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
