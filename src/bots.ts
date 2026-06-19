import type { Sql } from "postgres";
import { decryptSecret, encryptSecret } from "./bot-crypto.js";
import { migrationSql } from "./tracking/postgres.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

/**
 * Bot registry — the roster of bots lives in the `proof_bot.bots` table so we
 * scale by inserting a row (no per-bot env / redeploy). Private keys are stored
 * AES-256-GCM encrypted (BOTS_ENC_KEY) and decrypted only here, in memory. No
 * public/dashboard endpoint ever reads the key column.
 */

export interface BotSpec {
  id: string;
  strategies: string[];
  markets: number[] | "all";
  tags: string[];
  privateKeyHex: string; // decrypted — in-memory only, never logged
  params: Record<string, string>;
}

/** Roster row WITHOUT the key — safe to print / return from an API. */
export interface BotInfo {
  id: string;
  strategies: string[];
  markets: number[] | "all";
  tags: string[];
  enabled: boolean;
  hasKey: boolean;
}

/** Open a registry connection. The worker opens ONE and reuses it (passes it to
 *  loadBotsFromRegistry); the CLI opens a short-lived one per command. */
export async function openRegistrySql(config: Config): Promise<Sql> {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required for the bots registry");
  const { default: postgres } = await import("postgres");
  return postgres(config.databaseUrl, {
    max: 2,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

function table(sql: Sql, schema: string, name: string) {
  return sql`${sql(schema)}.${sql(name)}`;
}

function parseMarkets(m: unknown): number[] | "all" {
  if (m === "all" || m == null) return "all";
  if (Array.isArray(m)) return m.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (typeof m === "string") {
    try {
      return parseMarkets(JSON.parse(m));
    } catch {
      return "all";
    }
  }
  return "all";
}

/**
 * Load all ENABLED bots, decrypting their keys. Throws if BOTS_ENC_KEY is missing.
 * Pass `shared` (the worker's long-lived connection) to avoid opening a pool per
 * call — the worker calls this every BOTS_REFRESH_MS.
 */
export async function loadBotsFromRegistry(config: Config, logger?: Logger, shared?: Sql): Promise<BotSpec[]> {
  if (!config.botsEncKey) throw new Error("BOTS_ENC_KEY is required to decrypt bot keys");
  const sql = shared ?? (await openRegistrySql(config));
  try {
    if (!shared) await sql.unsafe(migrationSql(config.dbSchema)); // tracker already migrated when shared
    const rows = await sql`select id, strategies, markets, tags, private_key_enc, params
      from ${table(sql, config.dbSchema, "bots")} where enabled = true order by id`;
    const specs: BotSpec[] = [];
    for (const r of rows) {
      try {
        specs.push({
          id: r.id as string,
          strategies: (r.strategies as string[]) ?? [],
          markets: parseMarkets(r.markets),
          tags: (r.tags as string[]) ?? [],
          privateKeyHex: decryptSecret(r.private_key_enc as string, config.botsEncKey),
          params: ((r.params as Record<string, string>) ?? {}),
        });
      } catch (err) {
        logger?.warn({ id: r.id, err: (err as Error).message }, "bots: failed to decrypt — skipping");
      }
    }
    return specs;
  } finally {
    if (!shared) await sql.end({ timeout: 3 });
  }
}

export interface AddBotArgs {
  id: string;
  strategies: string[];
  markets: number[] | "all";
  tags: string[];
  privateKeyHex: string;
  params?: Record<string, string>;
}

/** Encrypt the key and upsert a bot row. Idempotent on id. */
export async function addBot(config: Config, args: AddBotArgs): Promise<void> {
  if (!config.botsEncKey) throw new Error("BOTS_ENC_KEY is required to encrypt bot keys");
  const enc = encryptSecret(args.privateKeyHex, config.botsEncKey);
  const sql = await openRegistrySql(config);
  try {
    await sql.unsafe(migrationSql(config.dbSchema));
    await sql`insert into ${table(sql, config.dbSchema, "bots")} ${sql({
      id: args.id,
      strategies: args.strategies,
      markets: sql.json(args.markets as never),
      tags: args.tags,
      private_key_enc: enc,
      params: sql.json((args.params ?? {}) as never),
      enabled: true,
    })}
    on conflict (id) do update set
      strategies = excluded.strategies,
      markets = excluded.markets,
      tags = excluded.tags,
      private_key_enc = excluded.private_key_enc,
      params = excluded.params,
      enabled = true`;
  } finally {
    await sql.end({ timeout: 3 });
  }
}

export interface UpdateBotArgs {
  params?: Record<string, string>;
  strategies?: string[];
  markets?: number[] | "all";
  tags?: string[];
}

/**
 * Update an EXISTING bot's non-key fields (params/strategies/markets/tags) WITHOUT
 * re-supplying its private key — so a bot can be re-tuned even when we no longer hold
 * its key locally. NEVER touches private_key_enc. The worker hot-reloads the change
 * (specHash includes params/strategies/markets/tags).
 */
export async function updateBot(config: Config, id: string, args: UpdateBotArgs): Promise<void> {
  const sql = await openRegistrySql(config);
  try {
    await sql.unsafe(migrationSql(config.dbSchema));
    const parts: ReturnType<Sql>[] = [];
    if (args.params !== undefined) parts.push(sql`params = ${sql.json(args.params as never)}`);
    if (args.strategies !== undefined) parts.push(sql`strategies = ${args.strategies}`);
    if (args.markets !== undefined) parts.push(sql`markets = ${sql.json(args.markets as never)}`);
    if (args.tags !== undefined) parts.push(sql`tags = ${args.tags}`);
    if (parts.length === 0) throw new Error("updateBot: nothing to update");
    const setClause = parts.reduce((acc, p) => sql`${acc}, ${p}`);
    const res = await sql`update ${table(sql, config.dbSchema, "bots")} set ${setClause} where id = ${id}`;
    if (res.count === 0) throw new Error(`no bot with id "${id}"`);
  } finally {
    await sql.end({ timeout: 3 });
  }
}

/** Roster WITHOUT keys — for `pnpm bots list` and (read-only) dashboards. */
export async function listBots(config: Config): Promise<BotInfo[]> {
  const sql = await openRegistrySql(config);
  try {
    await sql.unsafe(migrationSql(config.dbSchema));
    const rows = await sql`select id, strategies, markets, tags, enabled,
      (private_key_enc is not null and private_key_enc <> '') as has_key
      from ${table(sql, config.dbSchema, "bots")} order by id`;
    return rows.map((r) => ({
      id: r.id as string,
      strategies: (r.strategies as string[]) ?? [],
      markets: parseMarkets(r.markets),
      tags: (r.tags as string[]) ?? [],
      enabled: r.enabled as boolean,
      hasKey: r.has_key as boolean,
    }));
  } finally {
    await sql.end({ timeout: 3 });
  }
}

export async function disableBot(config: Config, id: string): Promise<void> {
  const sql = await openRegistrySql(config);
  try {
    await sql.unsafe(migrationSql(config.dbSchema));
    await sql`update ${table(sql, config.dbSchema, "bots")} set enabled = false where id = ${id}`;
  } finally {
    await sql.end({ timeout: 3 });
  }
}

export async function enableBot(config: Config, id: string): Promise<void> {
  const sql = await openRegistrySql(config);
  try {
    await sql.unsafe(migrationSql(config.dbSchema));
    await sql`update ${table(sql, config.dbSchema, "bots")} set enabled = true where id = ${id}`;
  } finally {
    await sql.end({ timeout: 3 });
  }
}
