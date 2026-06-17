import { promises as fs } from "node:fs";
import path from "node:path";
import {
  generateKeypair,
  getPublicKey,
  pubkeyToOwner,
  ownerToHex,
  hexToBytes,
  bytesToHex,
} from "@proof/trading-sdk";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

export type WalletSource = "byo" | "access-code" | "keystore" | "generated";

export interface Wallet {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  address: Uint8Array;
  /** 40-hex owner address, no 0x prefix (what queries/SDK use). */
  addressHex: string;
  /** 0x-prefixed owner address (what the faucet/redeem APIs expect). */
  address0x: string;
  source: WalletSource;
}

function fromPrivateKey(privHex: string, source: WalletSource): Wallet {
  const privateKey = hexToBytes(privHex.replace(/^0x/, ""));
  const publicKey = getPublicKey(privateKey);
  const address = pubkeyToOwner(publicKey);
  const addressHex = ownerToHex(address);
  return {
    privateKey,
    publicKey,
    address,
    addressHex,
    address0x: `0x${addressHex}`,
    source,
  };
}

/**
 * Resolves a wallet from the highest-precedence available source:
 *   1. PROOF_PRIVATE_KEY  (bring-your-own funded key — required on Vercel)
 *   2. PROOF_ACCESS_CODE  (paper-trading: server redeems a funded key)
 *   3. existing keystore file
 *   4. freshly generated key (unfunded — pair with PROOF_FAUCET_TOKEN)
 */
export async function loadWallet(config: Config, logger: Logger): Promise<Wallet> {
  if (config.privateKeyHex) {
    logger.info("wallet: using PROOF_PRIVATE_KEY (bring-your-own)");
    return fromPrivateKey(config.privateKeyHex, "byo");
  }

  if (config.accessCode) {
    if (!config.redeemUrl) {
      throw new Error("PROOF_ACCESS_CODE is set but PROOF_REDEEM_URL is missing");
    }
    logger.info("wallet: redeeming paper-trading access code");
    const wallet = await redeemAccessCode(config.redeemUrl, config.accessCode);
    await persistKeystore(config.keystorePath, wallet, logger);
    return wallet;
  }

  const existing = await readKeystore(config.keystorePath);
  if (existing) {
    logger.info({ path: config.keystorePath }, "wallet: loaded keystore");
    return fromPrivateKey(existing.privateKeyHex, "keystore");
  }

  logger.warn("wallet: no key configured — generating a new (unfunded) keypair");
  return generateWallet(config, logger);
}

/** Generate a brand-new Ed25519 keypair and persist it to the keystore. */
export async function generateWallet(
  config: Config,
  logger: Logger,
): Promise<Wallet> {
  const { publicKey, privateKey } = generateKeypair();
  const address = pubkeyToOwner(publicKey);
  const addressHex = ownerToHex(address);
  const wallet: Wallet = {
    privateKey,
    publicKey,
    address,
    addressHex,
    address0x: `0x${addressHex}`,
    source: "generated",
  };
  await persistKeystore(config.keystorePath, wallet, logger);
  return wallet;
}

/** Redeem a single-use paper-trading access code for a funded private key. */
export async function redeemAccessCode(
  redeemUrl: string,
  code: string,
): Promise<Wallet> {
  const res = await fetch(redeemUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    privateKeyHex?: string;
    address?: string;
    error?: string;
  };
  if (!res.ok || !data.privateKeyHex) {
    throw new Error(
      `access-code redeem failed (${res.status}): ${data.error ?? res.statusText}`,
    );
  }
  return fromPrivateKey(data.privateKeyHex, "access-code");
}

interface KeystoreFile {
  privateKeyHex: string;
  addressHex: string;
  source: WalletSource;
  createdAt: string;
}

async function readKeystore(p: string): Promise<KeystoreFile | null> {
  try {
    const raw = await fs.readFile(path.resolve(p), "utf8");
    return JSON.parse(raw) as KeystoreFile;
  } catch {
    return null;
  }
}

async function persistKeystore(
  p: string,
  wallet: Wallet,
  logger: Logger,
): Promise<void> {
  const file: KeystoreFile = {
    privateKeyHex: bytesToHex(wallet.privateKey),
    addressHex: wallet.addressHex,
    source: wallet.source,
    createdAt: new Date().toISOString(),
  };
  try {
    const abs = path.resolve(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, JSON.stringify(file, null, 2), { mode: 0o600 });
    logger.info({ path: p, address: wallet.address0x }, "wallet: keystore saved");
  } catch (err) {
    // Read-only filesystem (e.g. Vercel) — fine; the key should live in env there.
    logger.warn(
      { err: (err as Error).message },
      "wallet: could not persist keystore (continuing)",
    );
  }
}
