/**
 * Test environment bootstrap.
 *
 * config/env.ts validates process.env at import time and calls process.exit(1) if it
 * fails, and db/index.ts opens a real SQLite file at import time. Both run as a side
 * effect of importing almost anything under services/. So this file must populate the
 * environment BEFORE any test module is imported — which is exactly what vitest's
 * setupFiles guarantees.
 *
 * SERVER_A_HOST is empty on purpose: that puts the process in standalone mode, where
 * sshPool short-circuits without touching the network. Tests never dial out.
 *
 * Each test file gets its own temp directory (vitest isolates the module graph per
 * file, so each also gets its own db singleton).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpn-relay-test-"));
const keysDir = path.join(dir, "xray-keys");
fs.mkdirSync(keysDir, { recursive: true });

// Fixture key material — shape-accurate, obviously fake.
fs.writeFileSync(path.join(keysDir, "reality.key"), "TESTPRIVATEKEYTESTPRIVATEKEYTESTPRIVATEKEY0=\n");
fs.writeFileSync(path.join(keysDir, "reality.pub"), "TESTPUBLICKEYTESTPUBLICKEYTESTPUBLICKEYTES=\n");
fs.writeFileSync(path.join(keysDir, "shortid"), "0123456789abcdef\n");
fs.writeFileSync(path.join(dir, "backup.passphrase"), "test-passphrase-not-a-real-secret\n");
// hysteriaService.generateUris reads this file synchronously and throws without
// it, which would make every Hy2 subscription test unrunnable.
fs.writeFileSync(path.join(dir, "obfs.pw"), "test-obfs-password-not-real\n");

process.env.BOT_TOKEN = "0:test";
process.env.ADMIN_ID = "1";
process.env.SERVER_B_HOST = "203.0.113.1";
process.env.SERVER_A_HOST = ""; // standalone → no SSH, no network
process.env.DB_PATH = path.join(dir, "data.db");
process.env.XRAY_KEYS_DIR = keysDir;
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.BACKUP_PASSPHRASE_FILE = path.join(dir, "backup.passphrase");
process.env.LOG_LEVEL = "error";

// Hysteria 2 — needed by hysteriaService.generateUris.
process.env.SINGBOX_OBFS_FILE = path.join(dir, "obfs.pw");
process.env.HY2_HOST = "203.0.113.1";
process.env.HY2_DOMAIN = "hy2.test.example";
process.env.HY2_PORT = "443";

// Public origin for subscription links. Note this also becomes the CORS origin in
// buildApiServer, which is inert for app.inject() (injected requests send no Origin).
process.env.TMA_URL = "https://tma.test.example:8444";

/** Exported so integration tests can put fixtures next to the DB. */
export const TEST_DIR = dir;
