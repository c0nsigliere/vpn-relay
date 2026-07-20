/**
 * BackupService — scheduled/on-demand encrypted DR bundles, and bot-driven restore.
 *
 * Why a full bundle and not just the DB: without the Reality private key and the Hy2
 * obfs password, a from-scratch restore regenerates them, which changes `pbk` and
 * `obfs-password` and kills every client URI ever distributed. Bundling them keeps
 * all issued configs valid.
 *
 * Why encrypted: the artifact sits in Telegram's cloud and contains the Reality
 * private key plus every client credential. It is also what would make an off-site
 * copy on Server A permissible at all under the Strict Secret Isolation invariant.
 *
 * Split of responsibility on restore (§5.3/F6): the bot restores the **DB only**.
 * Key material is root's job. This is not a compromise — on a same-server restore the
 * keys on disk are already correct and the startup syncs repair everything else; on a
 * dead-server restore there is no bot yet and root is doing the work anyway. It also
 * means restore needs zero new write privileges for the bot.
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as tar from "tar";
import { InputFile } from "grammy";
import { db } from "../db/index";
import { queries } from "../db/queries";
import { env } from "../config/env";
import { isStandalone } from "../config/standalone";
import { sshPool } from "./ssh";
import { runTeardownWithTimeout } from "../lifecycle";
import { createLogger } from "../utils/logger";
import { decryptContainer, encryptContainer } from "./backup.container";
import type { BackupStatus, BackupTrigger } from "@vpn-relay/shared";

const logger = createLogger("backup");

/**
 * Staging lives next to the DB, derived rather than hardcoded: commitRestore ends in
 * fs.renameSync(staged → DB_PATH), which is atomic only within one filesystem. A fixed
 * /var/lib/vpn-bot/tmp would raise EXDEV for any custom DB_PATH — including every test.
 */
const DATA_DIR = path.dirname(env.DB_PATH);
const STAGING_DIR = path.join(DATA_DIR, "tmp");
const RESTORE_MARKER = path.join(DATA_DIR, "restore-done.json");

const WG_SERVER_KEY = "/etc/wireguard/keys/wg-clients.key";
const WG_FETCH_TIMEOUT_MS = 10_000;

/** sendDocument tops out at 50 MB; leave headroom rather than fail the API call. */
const TELEGRAM_SEND_LIMIT = 45 * 1024 * 1024;
/** getFile — the download side — tops out at 20 MB. */
export const TELEGRAM_FETCH_LIMIT = 19 * 1024 * 1024;

const STAGED_TTL_MS = 10 * 60 * 1000;
const PRE_RESTORE_KEEP = 3;
const TEARDOWN_TIMEOUT_MS = 20_000;
/** Last-resort: if teardown wedges entirely, die before the swap so the OLD db survives. */
const COMMIT_BACKSTOP_MS = 60_000;

const BUNDLE_RE = /^vpn-backup-.+\.tar\.gz\.enc$/;
const PRE_RESTORE_RE = /^pre-restore-.+\.db$/;

/**
 * Exactly the §4.1 entry names, with per-entry size caps. An allowlist rather than a
 * denylist: anything not named here aborts the stage. GCM already proves the archive's
 * author held the passphrase, so this is defence in depth — but a restore path is
 * where defence in depth is cheapest and most warranted.
 */
const ALLOWED_ENTRIES = new Map<string, number>([
  ["manifest.json", 64 * 1024],
  ["data.db", 256 * 1024 * 1024],
  ["backup.passphrase", 4096],
  ["xray/reality.key", 4096],
  ["xray/reality.pub", 4096],
  ["xray/shortid", 4096],
  ["singbox/obfs.pw", 4096],
  ["wg/wg-clients.key", 4096],
]);
const MAX_ENTRIES = 16;

export class BackupBusyError extends Error {
  constructor(msg = "A backup or restore is already in progress") {
    super(msg);
    this.name = "BackupBusyError";
  }
}

export class BadBundleError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BadBundleError";
  }
}

export interface BackupManifest {
  format: 1;
  created_at: string;
  trigger: BackupTrigger;
  host: string;
  label: string;
  standalone: boolean;
  hy2_enabled: boolean;
  wg_key_included: boolean;
  clients: number;
  db_bytes: number;
  reality_pub: string;
}

export interface BackupRunResult {
  id: string;
  status: Exclude<BackupStatus, "running">;
  localPath: string | null;
  bundleBytes: number | null;
  dbBytes: number | null;
  telegramOk: boolean;
  wgKeyIncluded: boolean;
  error: string | null;
}

export interface StagedRestore {
  id: string;
  dir: string;
  dbPath: string;
  manifest: BackupManifest;
  clientsInBundle: number;
  clientsCurrent: number;
  /** manifest.reality_pub matches this node's — keys on disk are already correct. */
  sameServer: boolean;
  stagedAt: number;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** The YYYYMMDD-HHmm stamp both filename shapes embed. */
const STAMP_RE = /(\d{8}-\d{4})/;

/**
 * Which bundles to delete, keeping the newest `keep`.
 *
 * Ordered by the timestamp *extracted* from the filename — not by mtime (rsync, cp
 * and restore all rewrite it) and not by sorting the whole name. The latter looks
 * equivalent and isn't: the label precedes the stamp, so a node whose label ever
 * changes (a TMA domain added, or the IP fallback kicking in) would sort by label
 * first and could delete its newest bundle as "oldest". A rotation that deletes the
 * wrong file is the one action in this subsystem with no undo.
 *
 * A name with no parseable stamp is never deleted and never counted — refusing to
 * date a file is a reason to keep it, not to guess.
 */
export function selectForRotation(names: string[], keep: number, pattern: RegExp = BUNDLE_RE): string[] {
  const dated = names
    .filter((n) => pattern.test(n))
    .map((name) => ({ name, stamp: STAMP_RE.exec(name)?.[1] }))
    .filter((e): e is { name: string; stamp: string } => e.stamp !== undefined)
    .sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.name < b.name ? -1 : 1));

  return dated.length <= keep ? [] : dated.slice(0, dated.length - keep).map((e) => e.name);
}

/** `heimdall` from a TMA domain, else the host with dots → dashes. Filename-safe. */
export function bundleLabel(tmaDomain: string | undefined, serverBHost: string): string {
  const raw = tmaDomain && tmaDomain.length > 0 ? tmaDomain.split(".")[0] : serverBHost.replace(/\./g, "-");
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, "");
  return cleaned.length > 0 ? cleaned : "node";
}

/** `20260720-0300` — sorts lexicographically, which is what rotation relies on. */
export function bundleStamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
  );
}

export interface TarEntryLike {
  path: string;
  type: string;
  size: number;
}

/** Returns a violation string, or null when the entry is acceptable. */
export function checkEntry(entry: TarEntryLike): string | null {
  if (entry.type !== "File") return `${entry.path}: not a regular file (${entry.type})`;
  if (entry.path.includes("..") || entry.path.startsWith("/")) return `${entry.path}: unsafe path`;
  const cap = ALLOWED_ENTRIES.get(entry.path);
  if (cap === undefined) return `${entry.path}: not an expected bundle entry`;
  if (entry.size > cap) return `${entry.path}: ${entry.size} bytes exceeds cap ${cap}`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

interface SendApi {
  sendDocument(chatId: number, doc: InputFile, opts?: Record<string, unknown>): Promise<unknown>;
}

class BackupService {
  readonly stagingDir = STAGING_DIR;
  readonly restoreMarker = RESTORE_MARKER;

  /** Guards backup-vs-backup AND backup-vs-restore. A restore swaps the very file a
   *  running backup is reading, so the flag has to cover both directions. */
  private running = false;
  private staged: StagedRestore | null = null;
  private stagedTimer: NodeJS.Timeout | null = null;

  isRunning(): boolean {
    return this.running;
  }

  getStaged(id: string): StagedRestore | null {
    return this.staged && this.staged.id === id ? this.staged : null;
  }

  /** Wipe and recreate staging. Called synchronously at worker startup. */
  wipeStaging(): void {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    fs.mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });
  }

  cancelStaged(id?: string): void {
    if (id && this.staged?.id !== id) return;
    if (this.stagedTimer) {
      clearTimeout(this.stagedTimer);
      this.stagedTimer = null;
    }
    if (this.staged) {
      fs.rmSync(this.staged.dir, { recursive: true, force: true });
      this.staged = null;
    }
  }

  // ── Backup ─────────────────────────────────────────────────────────────────

  async runBackup(
    trigger: BackupTrigger,
    api: SendApi | null,
    chatId: number = env.ADMIN_ID
  ): Promise<BackupRunResult> {
    if (this.running) throw new BackupBusyError();
    this.running = true;

    const id = randomUUID();
    // Record 'running' before any work, so a crash mid-backup leaves evidence.
    queries.insertBackupRun({ id, trigger });

    const stage = path.join(STAGING_DIR, `backup-${id}`);
    let localPath: string | null = null;

    try {
      this.ensureDirs();
      fs.mkdirSync(stage, { recursive: true, mode: 0o700 });

      // 1. Consistent snapshot — online and non-blocking under WAL, unlike a raw copy
      //    of a live DB (which silently misses everything still in the -wal file).
      const stagedDb = path.join(stage, "data.db");
      await db.backup(stagedDb);
      const dbBytes = fs.statSync(stagedDb).size;

      // 2. Key material
      fs.mkdirSync(path.join(stage, "xray"), { recursive: true, mode: 0o700 });
      const realityPub = this.copyKey("reality.pub", path.join(stage, "xray/reality.pub"));
      this.copyKey("shortid", path.join(stage, "xray/shortid"));
      // reality.key is fatal on failure: a bundle without it cannot keep client URIs
      // alive on a rebuild, which is the entire reason this is a bundle and not a DB.
      try {
        this.copyKey("reality.key", path.join(stage, "xray/reality.key"));
      } catch (err) {
        throw new Error(
          `Cannot read reality.key (${(err as Error).message}). The vpn-bot read ACL is ` +
            `missing — run: ansible-playbook playbooks/stack.yml -i inventory/<node>/ --tags bot`
        );
      }

      if (env.HY2_ENABLED) {
        fs.mkdirSync(path.join(stage, "singbox"), { recursive: true, mode: 0o700 });
        fs.copyFileSync(env.SINGBOX_OBFS_FILE, path.join(stage, "singbox/obfs.pw"));
      }

      // 3. The passphrase rides inside the bundle. Not circular: it is what *encrypted*
      //    the bundle, so including it leaks nothing to anyone who cannot already
      //    decrypt. The payoff is that a restored node keeps decrypting its OLDER
      //    bundles without re-provisioning secrets.
      const passphrase = this.readPassphrase();
      fs.copyFileSync(env.BACKUP_PASSPHRASE_FILE, path.join(stage, "backup.passphrase"));

      // 4. Server A's WG server key — best-effort. If A is redeployed from scratch its
      //    key regenerates and every WG client config dies; client private keys are
      //    never stored, so the server key plus the pubkeys in the DB is exactly what
      //    is needed for existing clients to survive.
      let wgKeyIncluded = false;
      if (!isStandalone) {
        const wgKey = await this.fetchWgServerKey();
        if (wgKey) {
          fs.mkdirSync(path.join(stage, "wg"), { recursive: true, mode: 0o700 });
          // Trailing newline restored: the value arrives .trim()'ed from SSH, and
          // every other key in the bundle keeps the one it has on disk. Without it a
          // restored wg-clients.key differs byte-wise from what `wg genkey` writes.
          fs.writeFileSync(path.join(stage, "wg/wg-clients.key"), `${wgKey}\n`, { mode: 0o600 });
          wgKeyIncluded = true;
        }
      }

      // 5. Manifest — client count read from the SNAPSHOT, not the live DB, so it
      //    describes the artifact exactly and exercises the same path stageRestore does.
      const clients = countClients(stagedDb);
      const manifest: BackupManifest = {
        format: 1,
        created_at: new Date().toISOString(),
        trigger,
        host: env.SERVER_B_HOST,
        label: bundleLabel(env.TMA_DOMAIN, env.SERVER_B_HOST),
        standalone: isStandalone,
        hy2_enabled: env.HY2_ENABLED,
        wg_key_included: wgKeyIncluded,
        clients,
        db_bytes: dbBytes,
        reality_pub: realityPub,
      };
      fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));

      // 6. tar.gz → encrypt → land atomically (.part then rename, so rotation and any
      //    concurrent reader never observe a half-written bundle)
      const entries = [...ALLOWED_ENTRIES.keys()].filter((e) => fs.existsSync(path.join(stage, e)));
      const tgz = path.join(stage, "bundle.tar.gz");
      await tar.create({ gzip: true, cwd: stage, file: tgz, portable: true }, entries);

      const filename = `vpn-backup-${manifest.label}-${bundleStamp(new Date())}Z.tar.gz.enc`;
      localPath = path.join(env.BACKUP_DIR, filename);
      const part = `${localPath}.part`;
      fs.writeFileSync(part, encryptContainer(fs.readFileSync(tgz), passphrase), { mode: 0o600 });
      fs.renameSync(part, localPath);
      const bundleBytes = fs.statSync(localPath).size;

      // 7. Rotate on bundle existence, NOT on delivery — otherwise a long Telegram
      //    outage accumulates unrotated `degraded` bundles until the disk notices.
      this.rotate(BUNDLE_RE, env.BACKUP_RETENTION);

      // 8. Deliver
      let telegramOk = false;
      let error: string | null = null;
      if (!api) {
        error = "Telegram delivery skipped (no API available)";
      } else if (bundleBytes > TELEGRAM_SEND_LIMIT) {
        error = `Bundle is ${fmtMb(bundleBytes)} — over the ${fmtMb(TELEGRAM_SEND_LIMIT)} send limit; kept locally only`;
      } else {
        try {
          const caption =
            `🗄 Backup — ${manifest.label} — ${manifest.clients} clients, ${fmtMb(bundleBytes)}` +
            (wgKeyIncluded || isStandalone ? "" : "\n⚠️ Server A unreachable — WG server key not included");
          await api.sendDocument(chatId, new InputFile(localPath, filename), { caption });
          telegramOk = true;
        } catch (err) {
          error = `Telegram delivery failed: ${(err as Error).message}`;
        }
      }

      const status: Exclude<BackupStatus, "running"> = telegramOk ? "success" : "degraded";
      queries.finishBackupRun(id, {
        status,
        bundle_bytes: bundleBytes,
        db_bytes: dbBytes,
        telegram_ok: telegramOk ? 1 : 0,
        local_path: localPath,
        wg_key_included: wgKeyIncluded ? 1 : 0,
        error,
      });
      logger.info(`Backup ${status}: ${filename} (${fmtMb(bundleBytes)}, ${clients} clients)`);

      return { id, status, localPath, bundleBytes, dbBytes, telegramOk, wgKeyIncluded, error };
    } catch (err) {
      const message = (err as Error).message;
      queries.finishBackupRun(id, { status: "failed", error: message });
      logger.error(`Backup failed: ${message}`);
      return {
        id, status: "failed", localPath: null, bundleBytes: null, dbBytes: null,
        telegramOk: false, wgKeyIncluded: false, error: message,
      };
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      this.running = false;
    }
  }

  // ── Restore ────────────────────────────────────────────────────────────────

  async stageRestore(filePath: string): Promise<StagedRestore> {
    this.cancelStaged();
    this.ensureDirs();

    const id = randomUUID();
    const dir = path.join(STAGING_DIR, `restore-${id}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    try {
      const plain = decryptContainer(fs.readFileSync(filePath), this.readPassphrase());
      const tgz = path.join(dir, "bundle.tar.gz");
      fs.writeFileSync(tgz, plain, { mode: 0o600 });

      const unpacked = path.join(dir, "unpacked");
      fs.mkdirSync(unpacked, { mode: 0o700 });

      // node-tar's filter only SKIPS an entry; a restore wants an abort. Collect the
      // violations and throw after extraction rather than silently unpacking a subset.
      const violations: string[] = [];
      let seen = 0;
      await tar.extract({
        file: tgz,
        cwd: unpacked,
        strict: true,
        filter: (entryPath, stat) => {
          if (++seen > MAX_ENTRIES) {
            violations.push(`archive has more than ${MAX_ENTRIES} entries`);
            return false;
          }
          const violation = checkEntry({
            path: entryPath,
            type: String((stat as { type?: string }).type ?? "File"),
            size: (stat as { size?: number }).size ?? 0,
          });
          if (violation) {
            violations.push(violation);
            return false;
          }
          return true;
        },
      });
      if (violations.length > 0) {
        throw new BadBundleError(`Rejected bundle contents: ${violations.join("; ")}`);
      }

      const manifestPath = path.join(unpacked, "manifest.json");
      if (!fs.existsSync(manifestPath)) throw new BadBundleError("Bundle has no manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
      if (manifest.format !== 1) {
        throw new BadBundleError(`Unsupported bundle format ${manifest.format} (expected 1)`);
      }

      const dbPath = path.join(unpacked, "data.db");
      if (!fs.existsSync(dbPath)) throw new BadBundleError("Bundle has no data.db");
      const clientsInBundle = validateStagedDb(dbPath);

      const staged: StagedRestore = {
        id,
        dir,
        dbPath,
        manifest,
        clientsInBundle,
        clientsCurrent: queries.getAllClients().length,
        sameServer: manifest.reality_pub.trim() === this.currentRealityPub(),
        stagedAt: Date.now(),
      };

      this.staged = staged;
      this.stagedTimer = setTimeout(() => this.cancelStaged(id), STAGED_TTL_MS);
      this.stagedTimer.unref();

      logger.info(`Staged restore ${id}: ${clientsInBundle} clients, sameServer=${staged.sameServer}`);
      return staged;
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Swap the restored DB in and exit. Never returns — systemd restarts the bot in 10s
   * (Restart=always, RestartSec=10) and the startup syncs push the restored state to
   * XRay, sing-box, Server A's routing and Server A's WG peers.
   */
  async commitRestore(staged: StagedRestore): Promise<never> {
    if (this.running) throw new BackupBusyError("A backup is running — try again in a minute");
    this.running = true;

    // If teardown wedges completely, die BEFORE the swap: the old DB is still intact
    // and systemd brings the bot back cleanly. A half-applied restore is the one
    // outcome worse than no restore.
    const backstop = setTimeout(() => {
      logger.error("Restore backstop fired — exiting without swapping");
      process.exit(1);
    }, COMMIT_BACKSTOP_MS);
    backstop.unref();

    const snapshot = path.join(env.BACKUP_DIR, `pre-restore-${bundleStamp(new Date())}.db`);
    await db.backup(snapshot);
    this.rotate(PRE_RESTORE_RE, PRE_RESTORE_KEEP);
    logger.info(`Pre-restore snapshot written: ${snapshot}`);

    await runTeardownWithTimeout(TEARDOWN_TIMEOUT_MS);
    try {
      db.close();
    } catch {
      /* already closed by the teardown step */
    }

    // The old DB's WAL must not be replayed into the NEW file. Dropping it is safe
    // precisely because db.close() checkpointed it moments ago.
    fs.rmSync(`${env.DB_PATH}-wal`, { force: true });
    fs.rmSync(`${env.DB_PATH}-shm`, { force: true });
    fs.renameSync(staged.dbPath, env.DB_PATH);

    // The restoring process dies by design, so the NEXT process delivers the receipt.
    fs.writeFileSync(
      RESTORE_MARKER,
      JSON.stringify({
        restored_at: new Date().toISOString(),
        clients: staged.clientsInBundle,
        bundle_created_at: staged.manifest.created_at,
        pre_restore_snapshot: snapshot,
      })
    );
    fs.rmSync(staged.dir, { recursive: true, force: true });

    logger.info("Restore applied — exiting for systemd to restart");
    process.exit(0);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private ensureDirs(): void {
    fs.mkdirSync(env.BACKUP_DIR, { recursive: true, mode: 0o700 });
    fs.mkdirSync(STAGING_DIR, { recursive: true, mode: 0o700 });
  }

  private readPassphrase(): string {
    const p = fs.readFileSync(env.BACKUP_PASSPHRASE_FILE, "utf8").trim();
    if (!p) throw new Error(`Backup passphrase file is empty: ${env.BACKUP_PASSPHRASE_FILE}`);
    return p;
  }

  private copyKey(name: string, dest: string): string {
    const src = path.join(env.XRAY_KEYS_DIR, name);
    const content = fs.readFileSync(src, "utf8");
    fs.writeFileSync(dest, content, { mode: 0o600 });
    return content.trim();
  }

  private currentRealityPub(): string {
    try {
      return fs.readFileSync(path.join(env.XRAY_KEYS_DIR, "reality.pub"), "utf8").trim();
    } catch {
      return "";
    }
  }

  private async fetchWgServerKey(): Promise<string | null> {
    try {
      const key = (await sshPool.exec(`cat ${WG_SERVER_KEY}`, WG_FETCH_TIMEOUT_MS)).trim();
      return key.length > 0 ? key : null;
    } catch (err) {
      logger.warn(`Server A unreachable — WG server key not included: ${(err as Error).message}`);
      return null;
    }
  }

  private rotate(pattern: RegExp, keep: number): void {
    let names: string[];
    try {
      names = fs.readdirSync(env.BACKUP_DIR);
    } catch {
      return;
    }
    for (const name of selectForRotation(names, keep, pattern)) {
      fs.rmSync(path.join(env.BACKUP_DIR, name), { force: true });
      logger.info(`Rotated out ${name}`);
    }
  }
}

function countClients(dbPath: string): number {
  const handle = new Database(dbPath, { readonly: true });
  try {
    return (handle.prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number }).n;
  } finally {
    handle.close();
  }
}

/** integrity_check + schema presence on the staged snapshot. Returns the client count. */
function validateStagedDb(dbPath: string): number {
  const handle = new Database(dbPath, { readonly: true });
  try {
    const rows = handle.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
      throw new BadBundleError(
        `Database in the bundle failed integrity_check: ${rows.map((r) => r.integrity_check).join("; ")}`
      );
    }
    try {
      return (handle.prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number }).n;
    } catch {
      throw new BadBundleError("Database in the bundle has no `clients` table");
    }
  } finally {
    handle.close();
  }
}

function fmtMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const backupService = new BackupService();
