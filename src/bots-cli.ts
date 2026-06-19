import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { addBot, listBots, disableBot, enableBot, updateBot } from "./bots.js";
import type { UpdateBotArgs } from "./bots.js";

/**
 * `pnpm bots <subcommand>` — manage the registry. Keys are never printed.
 * Pass a key literally or as `-` to read it from the BOT_KEY env (keeps it out
 * of shell history / the process list).
 *
 *   pnpm bots list
 *   pnpm bots add <id> <strategies> <key|-> [markets] [tags] [paramsJson]
 *   pnpm bots update <id> [--params <json>] [--strategies a,b] [--tags a,b] [--markets all|ids] [--note <why>]
 *   pnpm bots disable <id> [--note <why>]     pnpm bots enable <id> [--note <why>]
 *
 * Every add/update/enable/disable is recorded in the bot_changes log (with the
 * optional --note) so strategy changes can be audited against PnL later.
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

    case "update": {
      // Re-tune an existing bot WITHOUT its key (params/strategies/tags/markets only).
      //   pnpm bots update <id> [--params <json>] [--strategies a,b] [--tags a,b] [--markets all|1,2]
      const id = argv[1];
      if (!id) throw new Error("usage: bots update <id> [--params <json>] [--strategies a,b] [--tags a,b] [--markets all|ids]");
      const out: UpdateBotArgs = {};
      for (let i = 2; i < argv.length; i += 2) {
        const flag = argv[i];
        const val = argv[i + 1];
        if (val === undefined) throw new Error(`missing value for ${flag}`);
        if (flag === "--params") {
          try {
            out.params = JSON.parse(val) as Record<string, string>;
          } catch {
            throw new Error(`--params is not valid JSON: ${val}`);
          }
        } else if (flag === "--strategies") {
          out.strategies = val.split(",").map((s) => s.trim()).filter(Boolean);
        } else if (flag === "--tags") {
          out.tags = val.split(",").map((s) => s.trim()).filter(Boolean);
        } else if (flag === "--markets") {
          out.markets = val === "all" ? "all" : val.split(",").map((m) => Number(m.trim())).filter((n) => Number.isFinite(n) && n > 0);
        } else if (flag === "--note") {
          out.note = val;
        } else {
          throw new Error(`unknown flag "${flag}" (use --params/--strategies/--tags/--markets/--note)`);
        }
      }
      const mutates = out.params !== undefined || out.strategies !== undefined || out.tags !== undefined || out.markets !== undefined;
      if (!mutates) throw new Error("nothing to update — pass at least one of --params/--strategies/--tags/--markets");
      await updateBot(config, id, out);
      logger.info({ id, updated: Object.keys(out).filter((k) => k !== "note"), note: out.note }, "bots: updated (key untouched, change logged)");
      return;
    }

    case "disable": {
      if (!argv[1]) throw new Error("usage: bots disable <id> [--note <why>]");
      const note = argv[2] === "--note" ? argv[3] : undefined;
      await disableBot(config, argv[1], note);
      logger.info({ id: argv[1], note }, "bots: disabled");
      return;
    }

    case "enable": {
      if (!argv[1]) throw new Error("usage: bots enable <id> [--note <why>]");
      const note = argv[2] === "--note" ? argv[3] : undefined;
      await enableBot(config, argv[1], note);
      logger.info({ id: argv[1], note }, "bots: enabled");
      return;
    }

    default:
      throw new Error(`unknown bots subcommand "${sub}" — use: list | add | update | disable | enable`);
  }
}
