import { describe, expect, it } from "vitest";
import {
  AuthFailedError,
  BadMagicError,
  MAGIC,
  TruncatedContainerError,
  decryptContainer,
  encryptContainer,
  looksLikeContainer,
  passphraseFingerprint,
} from "./backup.container";

const PASS = "correct horse battery staple";

describe("encrypt → decrypt roundtrip", () => {
  it.each([
    ["empty", Buffer.alloc(0)],
    ["one byte", Buffer.from([0x42])],
    ["text", Buffer.from("manifest.json contents")],
    ["5 MB", Buffer.alloc(5 * 1024 * 1024, 0xab)],
  ])("survives %s", (_label, plaintext) => {
    // .equals() rather than toEqual(): the latter walks a 5-million-element buffer
    // pair and takes longer than the whole crypto operation it is checking.
    expect(decryptContainer(encryptContainer(plaintext, PASS), PASS).equals(plaintext)).toBe(true);
  });

  it("starts with the magic header", () => {
    const c = encryptContainer(Buffer.from("x"), PASS);
    expect(c.subarray(0, MAGIC.length)).toEqual(MAGIC);
    expect(looksLikeContainer(c)).toBe(true);
  });

  it("produces different bytes each time (random salt and iv)", () => {
    const a = encryptContainer(Buffer.from("same"), PASS);
    const b = encryptContainer(Buffer.from("same"), PASS);
    expect(a.equals(b)).toBe(false);
    // ...and both still decrypt
    expect(decryptContainer(a, PASS).toString()).toBe("same");
    expect(decryptContainer(b, PASS).toString()).toBe("same");
  });
});

describe("authentication", () => {
  it("rejects a wrong passphrase", () => {
    const c = encryptContainer(Buffer.from("secret"), PASS);
    expect(() => decryptContainer(c, "wrong")).toThrow(AuthFailedError);
  });

  it("rejects a flipped ciphertext byte", () => {
    const c = encryptContainer(Buffer.alloc(1024, 7), PASS);
    c[HEADER_END + 10] ^= 0xff;
    expect(() => decryptContainer(c, PASS)).toThrow(AuthFailedError);
  });

  it("rejects a flipped auth tag byte", () => {
    const c = encryptContainer(Buffer.from("secret"), PASS);
    c[c.length - 1] ^= 0xff;
    expect(() => decryptContainer(c, PASS)).toThrow(AuthFailedError);
  });

  it("rejects a flipped salt byte — the derived key no longer matches", () => {
    const c = encryptContainer(Buffer.from("secret"), PASS);
    c[MAGIC.length] ^= 0xff;
    expect(() => decryptContainer(c, PASS)).toThrow(AuthFailedError);
  });
});

describe("malformed input", () => {
  it("distinguishes a foreign file from a corrupted bundle", () => {
    const notOurs = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(100)]);
    expect(() => decryptContainer(notOurs, PASS)).toThrow(BadMagicError);
    expect(looksLikeContainer(notOurs)).toBe(false);
  });

  it("rejects a truncated container", () => {
    const c = encryptContainer(Buffer.from("secret"), PASS);
    expect(() => decryptContainer(c.subarray(0, 20), PASS)).toThrow(TruncatedContainerError);
    expect(() => decryptContainer(Buffer.alloc(0), PASS)).toThrow(TruncatedContainerError);
  });
});

describe("passphraseFingerprint", () => {
  it("is stable, short, and differs per passphrase", () => {
    expect(passphraseFingerprint(PASS)).toBe(passphraseFingerprint(PASS));
    expect(passphraseFingerprint(PASS)).toHaveLength(8);
    expect(passphraseFingerprint(PASS)).not.toBe(passphraseFingerprint("other"));
  });

  it("does not leak the passphrase itself", () => {
    expect(passphraseFingerprint(PASS)).not.toContain("horse");
  });
});

// magic(6) + salt(16) + iv(12)
const HEADER_END = 34;
