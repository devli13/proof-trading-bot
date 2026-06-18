import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret } from "./bot-crypto.js";

describe("bot-crypto", () => {
  const key = "test-enc-key-123";
  const secret = "3a1ae6617cb516a6aaff94f4d0af6b36edfb9f8c8f70ce27769d3fa2f0ce8fb9";

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
