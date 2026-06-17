import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { runSmoke } from "./smoke";
import { runBot } from "./runner";
import { NoopStrategy } from "./strategy/noop";

/**
 * CLI entry.
 *   pnpm smoke   → one-shot devnet smoke test (connect, read, place+cancel)
 *   pnpm run     → long-lived strategy loop (the NoopStrategy by default)
 */
async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "smoke";
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  switch (cmd) {
    case "smoke":
      await runSmoke(config, logger);
      break;
    case "run":
      await runBot(config, logger, new NoopStrategy());
      break;
    default:
      logger.error(`unknown command "${cmd}" — use: smoke | run`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
