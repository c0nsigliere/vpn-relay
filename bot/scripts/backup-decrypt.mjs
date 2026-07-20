#!/usr/bin/env node
/**
 * Decrypt a vpn-relay backup bundle. Zero dependencies, Node >= 18.
 *
 * `openssl enc` cannot do AES-GCM, so the disaster-recovery path needs a shipped
 * tool. This one deliberately duplicates the ~30 lines of container logic from
 * packages/server/src/services/backup.container.ts rather than importing it: it must
 * work from a bare repo checkout with no node_modules, and on a rebuilt server where
 * the bot is not installed yet.
 *
 * Usage:
 *   node backup-decrypt.mjs bundle.tar.gz.enc > bundle.tar.gz
 *   node backup-decrypt.mjs bundle.tar.gz.enc | tar xz -C ./restore
 *   BACKUP_PASSPHRASE=... node backup-decrypt.mjs bundle.enc -o bundle.tar.gz
 *   node backup-decrypt.mjs bundle.enc --passphrase-file ./backup.passphrase
 *
 * The passphrase is taken from $BACKUP_PASSPHRASE, or --passphrase-file, or a
 * no-echo prompt on the terminal.
 */

import { createDecipheriv, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const MAGIC = Buffer.from("VPNRB1", "ascii");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function usage(code) {
  process.stderr.write(
    "Usage: node backup-decrypt.mjs <bundle.tar.gz.enc> [-o out.tar.gz] [--passphrase-file <path>]\n" +
      "       Passphrase from $BACKUP_PASSPHRASE, --passphrase-file, or a prompt.\n"
  );
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("-h") || args.includes("--help")) usage(args.length === 0 ? 1 : 0);

let input = null;
let output = null;
let passphraseFile = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-o" || args[i] === "--output") output = args[++i];
  else if (args[i] === "--passphrase-file") passphraseFile = args[++i];
  else if (!input) input = args[i];
  else usage(1);
}
if (!input) usage(1);

// Refuse to spray binary over the operator's terminal.
if (!output && process.stdout.isTTY) {
  process.stderr.write("Refusing to write binary to a terminal — redirect stdout or pass -o <file>.\n");
  process.exit(1);
}

async function readPassphrase() {
  if (process.env.BACKUP_PASSPHRASE) return process.env.BACKUP_PASSPHRASE.trim();
  if (passphraseFile) return readFileSync(passphraseFile, "utf8").trim();

  if (!process.stdin.isTTY) {
    process.stderr.write("No passphrase: set $BACKUP_PASSPHRASE or pass --passphrase-file.\n");
    process.exit(1);
  }
  // Prompt without echoing. Errors go to stderr so stdout stays clean for the payload.
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise((resolve) => {
    process.stderr.write("Backup passphrase: ");
    rl.output.write = () => {}; // suppress echo
    rl.question("", (a) => resolve(a));
  });
  rl.close();
  process.stderr.write("\n");
  return answer.trim();
}

const container = readFileSync(input);

if (container.length < HEADER_LEN + TAG_LEN) {
  process.stderr.write("Bundle is truncated or empty.\n");
  process.exit(2);
}
if (!container.subarray(0, MAGIC.length).equals(MAGIC)) {
  process.stderr.write("Not a VPN backup bundle (bad magic header).\n");
  process.exit(2);
}

const passphrase = await readPassphrase();

const salt = container.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
const iv = container.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
const tag = container.subarray(container.length - TAG_LEN);
const ciphertext = container.subarray(HEADER_LEN, container.length - TAG_LEN);

const key = scryptSync(passphrase, salt, 32, SCRYPT_OPTS);
const decipher = createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);

let plaintext;
try {
  plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
} catch {
  // GCM final() only throws here on a tag mismatch.
  process.stderr.write("Cannot decrypt: wrong passphrase or corrupted file.\n");
  process.exit(3);
}

if (output) {
  writeFileSync(output, plaintext);
  process.stderr.write(`Wrote ${plaintext.length} bytes to ${output}\n`);
} else {
  process.stdout.write(plaintext);
}
