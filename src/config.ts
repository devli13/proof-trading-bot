import { z } from "zod";

/**
 * Known-safe network presets. Trading against anything else (custom gateway /
 * chain id) requires PROOF_ALLOW_REAL=1 — a guard so the bot can never silently
 * point at a real-money deployment.
 */
const PRESETS = {
  devnet: {
    gatewayUrl: "https://api.dev.proof.trade",
    chainId: "exchange-devnet-1",
    faucetUrl: "https://faucet.dev.proof.trade",
  },
  local: {
    gatewayUrl: "http://localhost:9080",
    chainId: "proof-dev",
    faucetUrl: "http://localhost:8090",
  },
} as const;

const SAFE_NETWORKS = new Set<keyof typeof PRESETS>(["devnet", "local"]);

const boolish = (v: unknown): boolean =>
  typeof v === "string"
    ? ["1", "true", "yes", "on"].includes(v.toLowerCase())
    : Boolean(v);

const EnvSchema = z.object({
  PROOF_NETWORK: z.enum(["devnet", "local", "custom"]).default("devnet"),
  PROOF_GATEWAY_URL: z.string().url().optional(),
  PROOF_CHAIN_ID: z.string().min(1).optional(),
  PROOF_FAUCET_URL: z.string().url().optional(),
  PROOF_FAUCET_TOKEN: z.string().min(1).optional(),
  PROOF_ACCESS_CODE: z.string().min(1).optional(),
  PROOF_REDEEM_URL: z.string().url().optional(),
  PROOF_PRIVATE_KEY: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{2,}$/, "PROOF_PRIVATE_KEY must be hex")
    .optional(),
  PROOF_API_KEY: z.string().min(1).optional(),
  PROOF_ALLOW_REAL: z.preprocess(boolish, z.boolean()).default(false),
  KEYSTORE_PATH: z.string().min(1).default(".keys/devnet.json"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // ── Strategy selection / targets ─────────────────────────────────────────
  PROOF_IMPACT_EVENT: z.coerce.number().int().nonnegative().default(203),
  /** When true (worker), discover every live (status=Trading) impact event from the
   *  market list so `markets:"all"` bots automatically trade new markets as Proof
   *  launches them — no redeploy/registry edit needed. */
  AUTO_DISCOVER_EVENTS: z.preprocess(boolish, z.boolean()).default(true),
  STRATEGIES: z.string().default("market-maker,parity-arb"),
  /** Market the MM quotes. 0 = use the event's underlying perp. */
  MM_MARKET: z.coerce.number().int().nonnegative().default(0),

  // ── Sizing (qty is in 10^-szDecimals contract units; szDecimals=2 ⇒ 0.01) ──
  MM_ORDER_QTY: z.coerce.bigint().default(10n), // 0.1 HYPE ≈ $7
  MM_MAX_POSITION: z.coerce.bigint().default(100n), // 1 HYPE ≈ $69
  MM_SPREAD_BPS: z.coerce.number().int().positive().default(30), // 0.30%
  ARB_ORDER_QTY: z.coerce.bigint().default(100n), // 1 binary contract (lot=100)
  ARB_MIN_EDGE_BPS: z.coerce.number().int().positive().default(25),
  ARB_VOID_SAFETY_BPS: z.coerce.number().int().nonnegative().default(50),
  ARB_CONDITIONAL_ENABLED: z.preprocess(boolish, z.boolean()).default(false),
  /** Max |position| per binary leg (qty units; 100 = 1 contract). Past this the
   *  arb only takes inventory-REDUCING baskets, so net position can't drift. */
  ARB_MAX_POSITION: z.coerce.bigint().default(500n),

  // ── Directional (momentum / mean-reversion), on the base perp ──────────────
  DIR_MARKET: z.coerce.number().int().nonnegative().default(0), // 0 = base perp
  DIR_WINDOW: z.coerce.number().int().positive().default(20), // rolling-mean samples
  DIR_THRESHOLD_BPS: z.coerce.number().int().positive().default(15), // band around the mean
  DIR_ORDER_QTY: z.coerce.bigint().default(10n),
  DIR_MAX_POSITION: z.coerce.bigint().default(50n),
  /** Rest entries passively (post-only maker) instead of crossing the spread (taker).
   *  Stops paying the spread; fills become fill-rate-dependent. */
  DIR_POST_ONLY: z.preprocess(boolish, z.boolean()).default(false),

  // ── Volume / volatility driver (devnet-only) ───────────────────────────────
  VOL_MARKET: z.coerce.number().int().nonnegative().default(0),
  VOL_ORDER_QTY: z.coerce.bigint().default(20n), // sizable enough to move the book
  VOL_MAX_POSITION: z.coerce.bigint().default(40n),
  /** Post-only maker half-spread for the (redesigned) volume-driver — it now quotes
   *  two-sided like the market-maker to drive volume by EARNING the spread, not paying it. */
  VOL_SPREAD_BPS: z.coerce.number().int().positive().default(30),
  VOL_TAKE_PROFIT_BPS: z.coerce.number().int().positive().default(15),
  VOL_STOP_BPS: z.coerce.number().int().positive().default(25), // hard loss cap per cycle
  VOL_HOLD_MS: z.coerce.number().int().positive().default(60_000), // time-exit

  // ── Risk / kill-switch ───────────────────────────────────────────────────
  MIN_MARGIN_RATIO_BPS: z.coerce.number().int().nonnegative().default(2000), // 20%
  MAX_DRAWDOWN_BPS: z.coerce.number().int().positive().default(1000), // 10%
  MAX_ORDER_QTY: z.coerce.bigint().default(1000n),
  MAX_OPEN_ORDERS: z.coerce.number().int().positive().default(20),

  // ── Lifecycle / cadence ──────────────────────────────────────────────────
  RESOLUTION_GUARD_MS: z.coerce.number().int().nonnegative().default(86_400_000), // 24h
  MARKET_CACHE_MS: z.coerce.number().int().positive().default(60_000),
  TICK_INTERVAL_MS: z.coerce.number().int().positive().default(5000),

  // ── Tracking (Supabase/Postgres) ─────────────────────────────────────────
  DATABASE_URL: z.string().min(1).optional(),
  /** Dedicated schema so this project's tables are isolated from others in the
   *  same database. Validated as a bare identifier (used in DDL). */
  DB_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, "DB_SCHEMA must be a bare lowercase identifier")
    .default("proof_bot"),

  // ── Multi-bot worker / registry ──────────────────────────────────────────
  /** Secret that encrypts bot private keys at rest in the registry (worker + CLI only). */
  BOTS_ENC_KEY: z.string().min(1).optional(),
  /** How often the worker re-reads the registry to hot-add/remove bots. */
  BOTS_REFRESH_MS: z.coerce.number().int().positive().default(30_000),

  // ── Safety ───────────────────────────────────────────────────────────────
  DRY_RUN: z.preprocess(boolish, z.boolean()).default(false),
  CRON_SECRET: z.string().min(1).optional(),
});

export interface Config {
  network: "devnet" | "local" | "custom";
  gatewayUrl: string;
  chainId: string;
  faucetUrl: string;
  faucetToken?: string;
  accessCode?: string;
  redeemUrl?: string;
  privateKeyHex?: string;
  apiKey?: string;
  allowReal: boolean;
  keystorePath: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";

  impactEvent: number;
  autoDiscoverEvents: boolean;
  strategies: string[];
  mmMarket: number;
  mmOrderQty: bigint;
  mmMaxPosition: bigint;
  mmSpreadBps: number;
  arbOrderQty: bigint;
  arbMinEdgeBps: number;
  arbVoidSafetyBps: number;
  arbConditionalEnabled: boolean;
  arbMaxPosition: bigint;

  dirMarket: number;
  dirWindow: number;
  dirThresholdBps: number;
  dirOrderQty: bigint;
  dirMaxPosition: bigint;
  dirPostOnly: boolean;

  volMarket: number;
  volOrderQty: bigint;
  volMaxPosition: bigint;
  volSpreadBps: number;
  volTakeProfitBps: number;
  volStopBps: number;
  volHoldMs: number;

  minMarginRatioBps: number;
  maxDrawdownBps: number;
  maxOrderQty: bigint;
  maxOpenOrders: number;

  resolutionGuardMs: number;
  marketCacheMs: number;
  tickIntervalMs: number;

  databaseUrl?: string;
  dbSchema: string;
  botsEncKey?: string;
  botsRefreshMs: number;
  dryRun: boolean;
  cronSecret?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  const preset = e.PROOF_NETWORK === "custom" ? undefined : PRESETS[e.PROOF_NETWORK];

  const gatewayUrl = e.PROOF_GATEWAY_URL ?? preset?.gatewayUrl;
  const chainId = e.PROOF_CHAIN_ID ?? preset?.chainId;
  const faucetUrl = e.PROOF_FAUCET_URL ?? preset?.faucetUrl ?? "";

  if (!gatewayUrl || !chainId) {
    throw new Error(
      `network "${e.PROOF_NETWORK}" requires PROOF_GATEWAY_URL and PROOF_CHAIN_ID to be set`,
    );
  }

  const isSafe =
    e.PROOF_NETWORK !== "custom" &&
    SAFE_NETWORKS.has(e.PROOF_NETWORK) &&
    chainId === preset?.chainId &&
    gatewayUrl === preset?.gatewayUrl;

  if (!isSafe && !e.PROOF_ALLOW_REAL) {
    throw new Error(
      `Refusing to trade against a non-devnet target (network=${e.PROOF_NETWORK}, chain=${chainId}). ` +
        `This bot defaults to devnet paper money. Set PROOF_ALLOW_REAL=1 to override intentionally.`,
    );
  }

  return {
    network: e.PROOF_NETWORK,
    gatewayUrl,
    chainId,
    faucetUrl,
    faucetToken: e.PROOF_FAUCET_TOKEN,
    accessCode: e.PROOF_ACCESS_CODE,
    redeemUrl: e.PROOF_REDEEM_URL,
    privateKeyHex: e.PROOF_PRIVATE_KEY,
    apiKey: e.PROOF_API_KEY,
    allowReal: e.PROOF_ALLOW_REAL,
    keystorePath: e.KEYSTORE_PATH,
    logLevel: e.LOG_LEVEL,

    impactEvent: e.PROOF_IMPACT_EVENT,
    autoDiscoverEvents: e.AUTO_DISCOVER_EVENTS,
    strategies: e.STRATEGIES.split(",").map((s) => s.trim()).filter(Boolean),
    mmMarket: e.MM_MARKET,
    mmOrderQty: e.MM_ORDER_QTY,
    mmMaxPosition: e.MM_MAX_POSITION,
    mmSpreadBps: e.MM_SPREAD_BPS,
    arbOrderQty: e.ARB_ORDER_QTY,
    arbMinEdgeBps: e.ARB_MIN_EDGE_BPS,
    arbVoidSafetyBps: e.ARB_VOID_SAFETY_BPS,
    arbConditionalEnabled: e.ARB_CONDITIONAL_ENABLED,
    arbMaxPosition: e.ARB_MAX_POSITION,

    dirMarket: e.DIR_MARKET,
    dirWindow: e.DIR_WINDOW,
    dirThresholdBps: e.DIR_THRESHOLD_BPS,
    dirOrderQty: e.DIR_ORDER_QTY,
    dirMaxPosition: e.DIR_MAX_POSITION,
    dirPostOnly: e.DIR_POST_ONLY,

    volMarket: e.VOL_MARKET,
    volOrderQty: e.VOL_ORDER_QTY,
    volMaxPosition: e.VOL_MAX_POSITION,
    volSpreadBps: e.VOL_SPREAD_BPS,
    volTakeProfitBps: e.VOL_TAKE_PROFIT_BPS,
    volStopBps: e.VOL_STOP_BPS,
    volHoldMs: e.VOL_HOLD_MS,

    minMarginRatioBps: e.MIN_MARGIN_RATIO_BPS,
    maxDrawdownBps: e.MAX_DRAWDOWN_BPS,
    maxOrderQty: e.MAX_ORDER_QTY,
    maxOpenOrders: e.MAX_OPEN_ORDERS,

    resolutionGuardMs: e.RESOLUTION_GUARD_MS,
    marketCacheMs: e.MARKET_CACHE_MS,
    tickIntervalMs: e.TICK_INTERVAL_MS,

    databaseUrl: e.DATABASE_URL,
    dbSchema: e.DB_SCHEMA,
    botsEncKey: e.BOTS_ENC_KEY,
    botsRefreshMs: e.BOTS_REFRESH_MS,
    dryRun: e.DRY_RUN,
    cronSecret: e.CRON_SECRET,
  };
}
