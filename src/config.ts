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
  PROOF_MARKET: z.coerce.number().int().nonnegative().default(1),
  PROOF_ALLOW_REAL: z.preprocess(boolish, z.boolean()).default(false),
  KEYSTORE_PATH: z.string().min(1).default(".keys/devnet.json"),
  MAX_ORDER_QTY: z.coerce.bigint().default(1n),
  MAX_OPEN_ORDERS: z.coerce.number().int().positive().default(10),
  TICK_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
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
  market: number;
  allowReal: boolean;
  keystorePath: string;
  maxOrderQty: bigint;
  maxOpenOrders: number;
  tickIntervalMs: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
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

  // Only the unmodified devnet/local presets are auto-allowed.
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
    market: e.PROOF_MARKET,
    allowReal: e.PROOF_ALLOW_REAL,
    keystorePath: e.KEYSTORE_PATH,
    maxOrderQty: e.MAX_ORDER_QTY,
    maxOpenOrders: e.MAX_OPEN_ORDERS,
    tickIntervalMs: e.TICK_INTERVAL_MS,
    logLevel: e.LOG_LEVEL,
  };
}
