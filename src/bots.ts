import type { Sql } from "postgres";
import { decryptSecret, encryptSecret } from "./bot-crypto.js";
import { migrationSql } from "./tracking/postgres.js";
import { diffBotChange, type BotState, type ChangeRow } from "./bot-diff.js";
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

/** Current registry state for the change log (no key). Returns null if the bot is new. */
async function selectState(sql: Sql, schema: string, id: string): Promise<BotState | null> {
  const rows = await sql`select strategies, markets, tags, params, enabled
    from ${table(sql, schema, "bots")} where id = ${id}`;
  const r = rows[0];
  if (!r) return null;
  return {
    strategies: (r.strategies as string[]) ?? [],
    markets: parseMarkets(r.markets),
    tags: (r.tags as string[]) ?? [],
    params: (r.params as Record<string, string>) ?? {},
    enabled: r.enabled as boolean,
  };
}

/** Append one bot_changes row per change. Best-effort: a logging failure must never
 *  block the registry mutation itself. */
async function recordChanges(
  sql: Sql,
  schema: string,
  id: string,
  rows: ChangeRow[],
  note: string | undefined,
  logger?: Logger,
): Promise<void> {
  if (rows.length === 0) return;
  try {
    for (const c of rows) {
      await sql`insert into ${table(sql, schema, "bot_changes")} ${sql({
        bot: id,
        kind: c.kind,
        before: c.before === null ? null : sql.json(c.before as never),
        after: sql.json(c.after as never),
        note: note ?? null,
      })}`;
    }
  } catch (err) {
    logger?.warn({ id, err: (err as Error).message }, "bots: change-log write failed (non-fatal)");
  }
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
  note?: string; // optional annotation for the change log
}

/** Encrypt the key and upsert a bot row. Idempotent on id. */
export async function addBot(config: Config, args: AddBotArgs): Promise<void> {
  if (!config.botsEncKey) throw new Error("BOTS_ENC_KEY is required to encrypt bot keys");
  const enc = encryptSecret(args.privateKeyHex, config.botsEncKey);
  const sql = await openRegistrySql(config);
  try {
    await sql.unsafe(migrationSql(config.dbSchema));
    const before = await selectState(sql, config.dbSchema, args.id);
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
    const after: BotState = { strategies: args.strategies, markets: args.markets, tags: args.tags, params: args.params ?? {}, enabled: true };
    await recordChanges(sql, config.dbSchema, args.id, diffBotChange(before, after), args.note);
  } finally {
    await sql.end({ timeout: 3 });
  }
}

export interface UpdateBotArgs {
  params?: Record<string, string>;
  strategies?: string[];
  markets?: number[] | "all";
  tags?: string[];
  note?: string; // optional annotation for the change log
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
    const before = await selectState(sql, config.dbSchema, id);
    const parts: ReturnType<Sql>[] = [];
    if (args.params !== undefined) parts.push(sql`params = ${sql.json(args.params as never)}`);
    if (args.strategies !== undefined) parts.push(sql`strategies = ${args.strategies}`);
    if (args.markets !== undefined) parts.push(sql`markets = ${sql.json(args.markets as never)}`);
    if (args.tags !== undefined) parts.push(sql`tags = ${args.tags}`);
    if (parts.length === 0) throw new Error("updateBot: nothing to update");
    const setClause = parts.reduce((acc, p) => sql`${acc}, ${p}`);
    const res = await sql`update ${table(sql, config.dbSchema, "bots")} set ${setClause} where id = ${id}`;
    if (res.count === 0) throw new Error(`no bot with id "${id}"`);
    if (before) {
      const after: BotState = {
        strategies: args.strategies ?? before.strategies,
        markets: args.markets ?? before.markets,
        tags: args.tags ?? before.tags,
        params: args.params ?? before.params,
        enabled: before.enabled,
      };
      await recordChanges(sql, config.dbSchema, id, diffBotChange(before, after), args.note);
    }
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

export async function disableBot(config: Config, id: string, note?: string): Promise<void> {
  await setEnabled(config, id, false, note);
}

export async function enableBot(config: Config, id: string, note?: string): Promise<void> {
  await setEnabled(config, id, true, note);
}

async function setEnabled(config: Config, id: string, enabled: boolean, note?: string): Promise<void> {
  const sql = await openRegistrySql(config);
  try {
    await sql.unsafe(migrationSql(config.dbSchema));
    const before = await selectState(sql, config.dbSchema, id);
    await sql`update ${table(sql, config.dbSchema, "bots")} set enabled = ${enabled} where id = ${id}`;
    if (before) await recordChanges(sql, config.dbSchema, id, diffBotChange(before, { ...before, enabled }), note);
  } finally {
    await sql.end({ timeout: 3 });
  }
}
