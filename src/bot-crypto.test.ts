import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./bot-crypto.js";

describe("bot-crypto", () => {
  const key = "test-enc-key-123";
  // NOT a real key — a fixed dummy hex string just to exercise round-tripping.
  const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("round-trips a secret", () => {
    const enc = encryptSecret(secret, key);
    expect(enc).not.toContain(secret);
    expect(decryptSecret(enc, key)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret(secret, key)).not.toBe(encryptSecret(secret, key));
  });

  it("fails to decrypt with the wrong key", () => {
    const enc = encryptSecret(secret, key);
    expect(() => decryptSecret(enc, "wrong-key")).toThrow();
  });

  it("requires an encryption key", () => {
    expect(() => encryptSecret(secret, "")).toThrow(/BOTS_ENC_KEY/);
  });
});
