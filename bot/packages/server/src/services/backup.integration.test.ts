/**
 * End-to-end over the real filesystem and real SQLite — no network.
 *
 * The setup file puts the process in standalone mode (SERVER_A_HOST=""), so the WG
 * key fetch short-circuits without dialling out. Everything else here is genuine:
 * a real db.backup() snapshot, a real tar.gz, real AES-GCM, and a real second SQLite
 * handle running PRAGMA integrity_check on the result.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as tar from "tar";
import { queries } from "../db/queries";
import { env } from "../config/env";
import { backupService, BackupBusyError } from "./backup.service";
import { decryptContainer, encryptContainer } from "./backup.container";

const PASSPHRASE = fs.readFileSync(env.BACKUP_PASSPHRASE_FILE, "utf8").trim();

/** Collects what would have gone to Telegram. */
function fakeApi() {
  const sent: Array<{ chatId: number }> = [];
  return {
    sent,
    sendDocument: async (chatId: number) => {
      sent.push({ chatId });
    },
  };
}

function addClient(id: string, name: string): void {
  queries.insertClient({
    id, name, type: "xray", wg_ip: null, wg_pubkey: null, xray_uuid: `uuid-${id}`,
    hy2_password: null, expires_at: null, is_active: 1, daily_quota_gb: null,
    monthly_quota_gb: null, suspend_reason: null, wg_cascade_transport: "xray",
    sub_token: `token-${id}`,
  });
}

beforeEach(() => {
  for (const c of queries.getAllClients()) queries.deleteClient(c.id);
  fs.rmSync(env.BACKUP_DIR, { recursive: true, force: true });
  // Recreated here because tests that forge a bundle need somewhere to build it
  // without having run a backup first (runBackup creates it on its own).
  fs.mkdirSync(env.BACKUP_DIR, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  backupService.cancelStaged();
});

describe("runBackup", () => {
  it("produces a bundle that decrypts, unpacks, and passes integrity_check", async () => {
    addClient("c1", "alpha");
    addClient("c2", "beta");

    const api = fakeApi();
    const result = await backupService.runBackup("manual", api);

    expect(result.status).toBe("success");
    expect(result.telegramOk).toBe(true);
    expect(api.sent).toHaveLength(1);
    expect(fs.existsSync(result.localPath!)).toBe(true);
    expect(path.basename(result.localPath!)).toMatch(/^vpn-backup-.+-\d{8}-\d{4}Z\.tar\.gz\.enc$/);

    // Open it exactly the way the DR runbook does.
    const plain = decryptContainer(fs.readFileSync(result.localPath!), PASSPHRASE);
    const out = fs.mkdtempSync(path.join(env.BACKUP_DIR, "unpack-"));
    const tgz = path.join(out, "b.tar.gz");
    fs.writeFileSync(tgz, plain);
    await tar.extract({ file: tgz, cwd: out });

    expect(fs.existsSync(path.join(out, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(out, "data.db"))).toBe(true);
    expect(fs.existsSync(path.join(out, "backup.passphrase"))).toBe(true);
    expect(fs.existsSync(path.join(out, "xray/reality.key"))).toBe(true);
    expect(fs.existsSync(path.join(out, "xray/reality.pub"))).toBe(true);
    expect(fs.existsSync(path.join(out, "xray/shortid"))).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    expect(manifest.format).toBe(1);
    expect(manifest.clients).toBe(2);
    expect(manifest.standalone).toBe(true);
    expect(manifest.wg_key_included).toBe(false); // standalone → no Server A

    const handle = new Database(path.join(out, "data.db"), { readonly: true });
    expect((handle.pragma("integrity_check") as Array<{ integrity_check: string }>)[0].integrity_check).toBe("ok");
    expect((handle.prepare("SELECT COUNT(*) n FROM clients").get() as { n: number }).n).toBe(2);
    handle.close();
  });

  it("records a terminal row in backup_runs", async () => {
    await backupService.runBackup("scheduled", fakeApi());
    const last = queries.getLastBackupRun();
    expect(last?.status).toBe("success");
    expect(last?.trigger).toBe("scheduled");
    expect(last?.finished_at).toBeTruthy();
    expect(last?.bundle_bytes).toBeGreaterThan(0);
  });

  it("degrades — keeping the local bundle — when delivery is impossible", async () => {
    const result = await backupService.runBackup("scheduled", null);
    expect(result.status).toBe("degraded");
    expect(result.telegramOk).toBe(false);
    expect(fs.existsSync(result.localPath!)).toBe(true); // the point of `degraded`
    expect(queries.getLastBackupRun(["success", "degraded"])?.status).toBe("degraded");
  });

  it("degrades when Telegram rejects the upload", async () => {
    const api = {
      sendDocument: async () => {
        throw new Error("429 Too Many Requests");
      },
    };
    const result = await backupService.runBackup("scheduled", api);
    expect(result.status).toBe("degraded");
    expect(result.error).toContain("429");
    expect(fs.existsSync(result.localPath!)).toBe(true);
  });

  it("rejects a concurrent run", async () => {
    const first = backupService.runBackup("scheduled", fakeApi());
    await expect(backupService.runBackup("manual", fakeApi())).rejects.toThrow(BackupBusyError);
    await first;
  });

  it("rotates down to BACKUP_RETENTION, counting bundles that were never delivered", async () => {
    // Seed a backlog directly: the filename stamp has minute resolution, so
    // successive real runs inside one test would collide on a single name.
    const backlog = Array.from(
      { length: env.BACKUP_RETENTION + 3 },
      (_, i) => `vpn-backup-node-202601${String(i + 1).padStart(2, "0")}-0300Z.tar.gz.enc`
    );
    for (const name of backlog) fs.writeFileSync(path.join(env.BACKUP_DIR, name), "old");

    // null api → degraded, which proves rotation keys on the bundle existing
    // rather than on successful delivery.
    const result = await backupService.runBackup("scheduled", null);
    expect(result.status).toBe("degraded");

    const kept = fs.readdirSync(env.BACKUP_DIR).filter((n) => n.endsWith(".enc"));
    expect(kept).toHaveLength(env.BACKUP_RETENTION);
    // The newest is the one just written; the oldest seeded ones are gone.
    expect(kept).toContain(path.basename(result.localPath!));
    expect(kept).not.toContain(backlog[0]);
    expect(kept).not.toContain(backlog[1]);
  });
});

describe("stageRestore", () => {
  async function makeBundle(): Promise<string> {
    addClient("c1", "alpha");
    addClient("c2", "beta");
    addClient("c3", "gamma");
    const result = await backupService.runBackup("manual", fakeApi());
    return result.localPath!;
  }

  it("validates a real bundle and reports what it contains", async () => {
    const bundle = await makeBundle();
    const staged = await backupService.stageRestore(bundle);

    expect(staged.clientsInBundle).toBe(3);
    expect(staged.clientsCurrent).toBe(3);
    expect(staged.manifest.format).toBe(1);
    // The fixture reality.pub is this "node"'s own, so a self-bundle is same-server.
    expect(staged.sameServer).toBe(true);
    expect(fs.existsSync(staged.dbPath)).toBe(true);
  });

  it("flags a bundle from a different node", async () => {
    const bundle = await makeBundle();
    const pub = path.join(env.XRAY_KEYS_DIR, "reality.pub");
    const original = fs.readFileSync(pub, "utf8");
    try {
      fs.writeFileSync(pub, "DIFFERENTNODEDIFFERENTNODEDIFFERENTNODEDIF=\n");
      expect((await backupService.stageRestore(bundle)).sameServer).toBe(false);
    } finally {
      fs.writeFileSync(pub, original);
    }
  });

  it("cleans up its staging directory when it rejects a bundle", async () => {
    const junk = path.join(env.BACKUP_DIR, "junk.enc");
    fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
    fs.writeFileSync(junk, Buffer.from("not a bundle at all, no magic here"));

    await expect(backupService.stageRestore(junk)).rejects.toThrow();
    const leftovers = fs.readdirSync(backupService.stagingDir).filter((n) => n.startsWith("restore-"));
    expect(leftovers).toEqual([]);
  });

  it("rejects a bundle encrypted with a different passphrase", async () => {
    const foreign = path.join(env.BACKUP_DIR, "foreign.enc");
    fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
    fs.writeFileSync(foreign, encryptContainer(Buffer.from("whatever"), "some-other-node-passphrase"));
    await expect(backupService.stageRestore(foreign)).rejects.toThrow(/wrong passphrase|corrupted/i);
  });

  it("rejects a corrupted database inside an otherwise valid bundle", async () => {
    const staging = fs.mkdtempSync(path.join(env.BACKUP_DIR, "forge-"));
    // A structurally valid bundle whose data.db is garbage.
    fs.writeFileSync(path.join(staging, "data.db"), Buffer.alloc(8192, 0xde));
    fs.writeFileSync(
      path.join(staging, "manifest.json"),
      JSON.stringify({ format: 1, created_at: "x", trigger: "manual", host: "h", label: "l",
        standalone: true, hy2_enabled: false, wg_key_included: false, clients: 0,
        db_bytes: 8192, reality_pub: "x" })
    );
    const tgz = path.join(staging, "b.tar.gz");
    await tar.create({ gzip: true, cwd: staging, file: tgz, portable: true }, ["manifest.json", "data.db"]);

    
    const forged = path.join(env.BACKUP_DIR, "forged.enc");
    fs.writeFileSync(forged, encryptContainer(fs.readFileSync(tgz), PASSPHRASE));

    await expect(backupService.stageRestore(forged)).rejects.toThrow(/integrity_check|clients` table|file is not a database/i);
  });

  it("rejects an archive carrying an unexpected entry", async () => {
    const staging = fs.mkdtempSync(path.join(env.BACKUP_DIR, "evil-"));
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({ format: 1 }));
    fs.writeFileSync(path.join(staging, "evil.sh"), "#!/bin/sh\nrm -rf /\n");
    const tgz = path.join(staging, "b.tar.gz");
    await tar.create({ gzip: true, cwd: staging, file: tgz, portable: true }, ["manifest.json", "evil.sh"]);

    const evil = path.join(env.BACKUP_DIR, "evil.enc");
    fs.writeFileSync(evil, encryptContainer(fs.readFileSync(tgz), PASSPHRASE));

    await expect(backupService.stageRestore(evil)).rejects.toThrow(/not an expected bundle entry/);
  });

  it("expires the previous staging when a new bundle is staged", async () => {
    const bundle = await makeBundle();
    const first = await backupService.stageRestore(bundle);
    const second = await backupService.stageRestore(bundle);

    expect(backupService.getStaged(first.id)).toBeNull();
    expect(backupService.getStaged(second.id)).not.toBeNull();
    expect(fs.existsSync(first.dir)).toBe(false);
  });
});
