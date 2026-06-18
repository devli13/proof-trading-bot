import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { addBot, listBots, disableBot, enableBot } from "./bots.js";

/**
 * `pnpm bots <subcommand>` — manage the registry. Keys are never printed.
 * Pass a key literally or as `-` to read it from the BOT_KEY env (keeps it out
 * of shell history / the process list).
 *
 *   pnpm bots list
 *   pnpm bots add <id> <strategies> <key|-> [markets] [tags] [paramsJson]
 *   pnpm bots disable <id>     pnpm bots enable <id>
 *
 * strategies/tags: comma-separated.  markets: "all" or comma-separated event ids.
 */
export async function botsCommand(config: Config, logger: Logger, argv: string[]): Promise<void> {
  const sub = argv[0] ?? "list";

  if (!config.databaseUrl) throw new Error("DATABASE_URL is required for `pnpm bots`");

  switch (sub) {
    case "list": {
      const bots = await listBots(config);
      if (bots.length === 0) {
        logger.info("bots: registry is empty");
        return;
      }
      for (const b of bots) {
        const markets = b.markets === "all" ? "all" : b.markets.join(",");
        logger.info(
          `${b.enabled ? "●" : "○"} ${b.id.padEnd(18)} [${b.strategies.join(",")}]  markets=${markets}  tags=${b.tags.join(",")}  key=${b.hasKey ? "set" : "MISSING"}`,
        );
      }
      return;
    }

    case "add": {
      const [id, strategiesArg, keyArg, marketsArg, tagsArg, paramsArg] = argv.slice(1);
      if (!id || !strategiesArg || !keyArg) {
        throw new Error("usage: bots add <id> <strategies> <key|-> [markets] [tags] [paramsJson]");
      }
      const privateKeyHex = keyArg === "-" ? process.env.BOT_KEY : keyArg;
      if (!privateKeyHex) throw new Error("no key provided (pass a hex key or `-` with BOT_KEY set)");
      if (!/^(0x)?[0-9a-fA-F]{32,}$/.test(privateKeyHex)) throw new Error("key does not look like a hex private key");

      const strategies = strategiesArg.split(",").map((s) => s.trim()).filter(Boolean);
      const markets =
        !marketsArg || marketsArg === "all"
          ? ("all" as const)
          : marketsArg.split(",").map((m) => Number(m.trim())).filter((n) => Number.isFinite(n) && n > 0);
      const tags = (tagsArg ?? "").split(",").map((t) => t.trim()).filter(Boolean);
      let params: Record<string, string> = {};
      if (paramsArg) {
        try {
          params = JSON.parse(paramsArg) as Record<string, string>;
        } catch {
          throw new Error(`paramsJson is not valid JSON: ${paramsArg}`);
        }
      }

      await addBot(config, { id, strategies, markets, tags, privateKeyHex, params });
      logger.info({ id, strategies, markets, tags, params: Object.keys(params) }, "bots: added/updated (key encrypted)");
      return;
    }

    case "disable":
      if (!argv[1]) throw new Error("usage: bots disable <id>");
      await disableBot(config, argv[1]);
      logger.info({ id: argv[1] }, "bots: disabled");
      return;

    case "enable":
      if (!argv[1]) throw new Error("usage: bots enable <id>");
      await enableBot(config, argv[1]);
      logger.info({ id: argv[1] }, "bots: enabled");
      return;

    default:
      throw new Error(`unknown bots subcommand "${sub}" — use: list | add | disable | enable`);
  }
}
