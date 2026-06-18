import "dotenv/config";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { runSmoke } from "./smoke.js";
import { runBot, executeTick } from "./runner.js";
import { runWorker } from "./worker.js";
import { botsCommand } from "./bots-cli.js";
import { walletCommand, fundCommand } from "./commands.js";
import { buildStrategies } from "./strategy/index.js";

/**
 * CLI entry.
 *   pnpm wallet      → show/generate the devnet wallet
 *   pnpm fund        → drip the faucet into the wallet
 *   pnpm smoke       → connectivity + read smoke test
 *   pnpm tick        → run ONE single-bot tick (no resting-order cleanup)
 *   pnpm run         → long-lived single-bot loop (flattens on SIGINT)
 *   pnpm worker      → persistent MULTI-bot worker (registry-driven; Render)
 *   pnpm bots ...    → manage the bot registry (list/add/disable/enable)
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
    case "tick": {
      const summary = await executeTick(config, logger, buildStrategies(config));
      logger.info(summary, "tick: done");
      break;
    }
    case "run":
      await runBot(config, logger, buildStrategies(config));
      break;
    case "worker":
      await runWorker();
      break;
    case "bots":
      await botsCommand(config, logger, process.argv.slice(3));
      break;
    default:
      logger.error(`unknown command "${cmd}" — use: wallet | fund | smoke | tick | run | worker | bots`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
