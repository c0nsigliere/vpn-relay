/**
 * Encrypted backup container — AES-256-GCM over a scrypt-derived key.
 *
 * Deliberately free of every project import (env, db, logger): the container is the
 * one thing a disaster-recovery path must be able to open with nothing but Node, and
 * keeping it dependency-free is also what makes it unit-testable without a configured
 * environment. `scripts/backup-decrypt.mjs` re-implements decrypt() in ~30 lines for
 * exactly that reason — `openssl enc` cannot do GCM.
 *
 * Layout:
 *   bytes 0-5     magic "VPNRB1"
 *   bytes 6-21    salt (16 B, random per backup)
 *   bytes 22-33   iv   (12 B, random per backup)
 *   ...           ciphertext
 *   last 16 B     GCM auth tag
 *
 * GCM rather than CBC+HMAC: authenticated encryption in one primitive, so a wrong
 * passphrase or a tampered byte fails loudly instead of restoring garbage.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "crypto";

export const MAGIC = Buffer.from("VPNRB1", "ascii");

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;

// N=16384, r=8 needs ~16 MB; Node's default maxmem is 32 MB. Set it explicitly so a
// future parameter bump fails a test rather than throwing on a production node.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** The file is not one of ours — a different format, not a corrupted bundle. */
export class BadMagicError extends Error {
  constructor() {
    super("Not a VPN backup bundle (bad magic header)");
    this.name = "BadMagicError";
  }
}

/** Truncated below the fixed header + tag. */
export class TruncatedContainerError extends Error {
  constructor() {
    super("Backup bundle is truncated or empty");
    this.name = "TruncatedContainerError";
  }
}

/** GCM authentication failed: wrong passphrase, or the bytes were altered. */
export class AuthFailedError extends Error {
  constructor() {
    super("Cannot decrypt: wrong passphrase or corrupted file");
    this.name = "AuthFailedError";
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, SCRYPT_OPTS);
}

export function encryptContainer(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, ciphertext, cipher.getAuthTag()]);
}

export function decryptContainer(container: Buffer, passphrase: string): Buffer {
  if (container.length < HEADER_LEN + TAG_LEN) throw new TruncatedContainerError();
  if (!container.subarray(0, MAGIC.length).equals(MAGIC)) throw new BadMagicError();

  const salt = container.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = container.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
  const tag = container.subarray(container.length - TAG_LEN);
  const ciphertext = container.subarray(HEADER_LEN, container.length - TAG_LEN);

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // The only way final() throws here is a tag mismatch.
    throw new AuthFailedError();
  }
}

/** Cheap pre-download check on a document's first bytes. */
export function looksLikeContainer(head: Buffer): boolean {
  return head.length >= MAGIC.length && head.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Short fingerprint of the passphrase, safe to send to Telegram — it lets the admin
 * confirm the copy in their password manager matches the node without the chat ever
 * carrying the secret that protects the bundles sitting in that same chat.
 */
export function passphraseFingerprint(passphrase: string): string {
  return createHash("sha256").update(passphrase).digest("hex").slice(0, 8);
}
