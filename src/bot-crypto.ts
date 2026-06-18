import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Symmetric encryption for bot private keys stored in the registry. Keys are
 * AES-256-GCM encrypted with a 32-byte key derived (scrypt) from BOTS_ENC_KEY,
 * so the DB never holds plaintext. Output: base64(iv[12] | tag[16] | ciphertext).
 */

const SALT = "proof-bot-enc-v1";

function keyFrom(secret: string): Buffer {
  if (!secret) throw new Error("BOTS_ENC_KEY is required to encrypt/decrypt bot keys");
  return scryptSync(secret, SALT, 32);
}

export function encryptSecret(plaintext: string, encKey: string): string {
  const key = keyFrom(encKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(enc: string, encKey: string): string {
  const key = keyFrom(encKey);
  const buf = Buffer.from(enc, "base64");
  if (buf.length < 28) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
