import Database, { Database as DatabaseType } from "better-sqlite3";
import { env } from "../config/env";
import * as fs from "fs";
import * as path from "path";

// Ensure data directory exists
const dbDir = path.dirname(env.DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db: DatabaseType = new Database(env.DB_PATH);

// Performance settings
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('wg', 'xray', 'both')),
    wg_ip TEXT,
    wg_pubkey TEXT,
    xray_uuid TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS traffic_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP,
    wg_rx INTEGER DEFAULT 0,
    wg_tx INTEGER DEFAULT 0,
    xray_rx INTEGER DEFAULT 0,
    xray_tx INTEGER DEFAULT 0,
    FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_traffic_ts ON traffic_snapshots(ts);

  CREATE TABLE IF NOT EXISTS server_traffic_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL CHECK(server_id IN ('a', 'b')),
    ts DATETIME DEFAULT CURRENT_TIMESTAMP,
    rx_bytes INTEGER DEFAULT 0,
    tx_bytes INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_server_traffic_ts ON server_traffic_snapshots(ts);

  CREATE TABLE IF NOT EXISTS client_traffic_monthly (
    client_id TEXT NOT NULL,
    month TEXT NOT NULL,
    rx_total INTEGER DEFAULT 0,
    tx_total INTEGER DEFAULT 0,
    PRIMARY KEY (client_id, month)
  );

  CREATE TABLE IF NOT EXISTS server_traffic_monthly (
    server_id TEXT NOT NULL CHECK(server_id IN ('a', 'b')),
    month TEXT NOT NULL,
    rx_total INTEGER DEFAULT 0,
    tx_total INTEGER DEFAULT 0,
    PRIMARY KEY (server_id, month)
  );
`);

// Migrations (idempotent — ALTER TABLE ADD COLUMN fails silently if column exists)
try { db.exec("ALTER TABLE clients ADD COLUMN last_seen_at TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE clients ADD COLUMN daily_quota_gb REAL DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE clients ADD COLUMN monthly_quota_gb REAL DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE clients ADD COLUMN suspend_reason TEXT DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE clients ADD COLUMN last_ip TEXT DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE clients ADD COLUMN last_ip_isp TEXT DEFAULT NULL"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE clients ADD COLUMN last_connection_route TEXT DEFAULT NULL"); } catch { /* already exists */ }
// WG cascade uplink transport per client: 'xray' (VLESS+Reality) or 'hy2' (Hysteria 2).
// Only meaningful for wg/both clients; drives per-client source routing in Server A's XRay.
try { db.exec("ALTER TABLE clients ADD COLUMN wg_cascade_transport TEXT DEFAULT 'xray'"); } catch { /* already exists */ }

// Hysteria 2 traffic columns (additive — same idempotent pattern as above).
try { db.exec("ALTER TABLE traffic_snapshots ADD COLUMN hy2_rx INTEGER DEFAULT 0"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE traffic_snapshots ADD COLUMN hy2_tx INTEGER DEFAULT 0"); } catch { /* already exists */ }

/**
 * Widen the clients.type CHECK constraint to allow 'hysteria2' and add hy2_password.
 *
 * SQLite cannot ALTER a CHECK constraint, so we follow the canonical table-rebuild
 * recipe (https://sqlite.org/lang_altertable.html#otheralter). This is the first
 * rebuild migration in the codebase — every prior migration above is an additive
 * ALTER. It runs AFTER the ALTER block so the source table already carries every
 * migrated column; we copy those across explicitly and default hy2_password to NULL.
 */
function migrateClientsAddHysteria2(): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'clients'")
    .get() as { sql: string } | undefined;
  // Fresh table or already-migrated table already lists 'hysteria2' in its CHECK.
  if (!row || row.sql.includes("hysteria2")) return;

  // foreign_keys can only be toggled OUTSIDE a transaction. It must be OFF so the
  // DROP TABLE below does not cascade-delete traffic_snapshots (ON DELETE CASCADE).
  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE clients_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('wg', 'xray', 'both', 'hysteria2')),
        wg_ip TEXT,
        wg_pubkey TEXT,
        xray_uuid TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        is_active INTEGER DEFAULT 1,
        last_seen_at TEXT,
        daily_quota_gb REAL DEFAULT NULL,
        monthly_quota_gb REAL DEFAULT NULL,
        suspend_reason TEXT DEFAULT NULL,
        last_ip TEXT DEFAULT NULL,
        last_ip_isp TEXT DEFAULT NULL,
        last_connection_route TEXT DEFAULT NULL,
        hy2_password TEXT DEFAULT NULL,
        wg_cascade_transport TEXT DEFAULT 'xray'
      );
    `);
    db.exec(`
      INSERT INTO clients_new
        (id, name, type, wg_ip, wg_pubkey, xray_uuid, created_at, expires_at, is_active,
         last_seen_at, daily_quota_gb, monthly_quota_gb, suspend_reason, last_ip, last_ip_isp,
         last_connection_route, hy2_password, wg_cascade_transport)
      SELECT
         id, name, type, wg_ip, wg_pubkey, xray_uuid, created_at, expires_at, is_active,
         last_seen_at, daily_quota_gb, monthly_quota_gb, suspend_reason, last_ip, last_ip_isp,
         last_connection_route, NULL, wg_cascade_transport
      FROM clients;
    `);
    db.exec("DROP TABLE clients");
    db.exec("ALTER TABLE clients_new RENAME TO clients");
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(`foreign_key_check failed after clients rebuild: ${JSON.stringify(violations)}`);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.pragma("foreign_keys = ON");
    throw e;
  }
  db.pragma("foreign_keys = ON");
}
migrateClientsAddHysteria2();

// Alert tables
db.exec(`
  CREATE TABLE IF NOT EXISTS alert_settings (
    alert_key    TEXT PRIMARY KEY,
    enabled      INTEGER DEFAULT 1,
    threshold    REAL,
    threshold2   REAL,
    cooldown_min INTEGER DEFAULT 30
  );

  CREATE TABLE IF NOT EXISTS alert_state (
    alert_key  TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'clear',
    fired_at   TEXT,
    cleared_at TEXT,
    context    TEXT
  );
`);

// On-demand maintenance jobs (apt update / reboot triggered from the bot or TMA).
// The row is the bot's mirror of the root helper's /var/lib/vpn-maintenance/jobs/<id>.json;
// the helper is the source of truth for status/phase, this table for who asked and when.
db.exec(`
  CREATE TABLE IF NOT EXISTS maintenance_jobs (
    id                TEXT PRIMARY KEY,
    server_id         TEXT NOT NULL CHECK(server_id IN ('a', 'b')),
    action            TEXT NOT NULL CHECK(action IN ('update', 'update-reboot', 'reboot')),
    status            TEXT NOT NULL CHECK(status IN ('queued', 'running', 'rebooting', 'succeeded', 'failed', 'unknown')),
    phase             TEXT,
    requested_by      TEXT NOT NULL CHECK(requested_by IN ('tma', 'bot')),
    boot_id           TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at        DATETIME,
    finished_at       DATETIME,
    reboot_at         DATETIME,
    exit_code         INTEGER,
    error             TEXT,
    packages_upgraded INTEGER,
    packages          TEXT,
    log_tail          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_maint_server_created
    ON maintenance_jobs(server_id, created_at DESC);

  -- The real single-job guarantee: a second concurrent INSERT for the same server
  -- hits this constraint (-> HTTP 409). Survives bot restarts, needs no in-memory
  -- mutex, and covers the TMA and the bot menu identically. 'unknown' is terminal,
  -- so it frees the index.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_maint_active
    ON maintenance_jobs(server_id) WHERE status IN ('queued', 'running', 'rebooting');
`);

// Scheduled encrypted backup runs. History for the staleness watchdog, the slot-based
// catch-up on startup, and the "last backup" lines in the bot menu and the TMA.
// A row is inserted as 'running' before any work starts, so a crash mid-backup leaves
// evidence rather than nothing; backupWorker marks orphaned rows failed at startup.
db.exec(`
  CREATE TABLE IF NOT EXISTS backup_runs (
    id              TEXT PRIMARY KEY,
    trigger         TEXT NOT NULL CHECK(trigger IN ('scheduled', 'manual')),
    status          TEXT NOT NULL CHECK(status IN ('running', 'success', 'degraded', 'failed')),
    started_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at     DATETIME,
    bundle_bytes    INTEGER,
    db_bytes        INTEGER,
    telegram_ok     INTEGER,
    local_path      TEXT,
    wg_key_included INTEGER,
    error           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs(started_at);
`);

// Seed default alert settings (INSERT OR IGNORE — never overrides user changes)
const _alertDefaults = [
  { alert_key: "cascade_down",       enabled: 1, threshold: 100, threshold2: 2,    cooldown_min: 30 },
  { alert_key: "cascade_degradation",enabled: 1, threshold: 30,  threshold2: 5,    cooldown_min: 15 },
  { alert_key: "service_dead_xray",  enabled: 1, threshold: null, threshold2: null, cooldown_min: 30 },
  { alert_key: "service_dead_singbox", enabled: 1, threshold: null, threshold2: null, cooldown_min: 30 },
  { alert_key: "service_dead_wg",    enabled: 1, threshold: null, threshold2: null, cooldown_min: 30 },
  { alert_key: "disk_full",          enabled: 1, threshold: 90,  threshold2: null, cooldown_min: 60 },
  { alert_key: "network_saturation", enabled: 1, threshold: 80,  threshold2: 15,   cooldown_min: 30 },
  { alert_key: "cpu_overload",       enabled: 1, threshold: 95,  threshold2: 10,   cooldown_min: 30 },
  { alert_key: "abnormal_traffic",   enabled: 1, threshold: 50,  threshold2: null, cooldown_min: 60 },
  { alert_key: "quota_warning",      enabled: 1, threshold: 90,  threshold2: null, cooldown_min: 720 },
  { alert_key: "cert_expiry",        enabled: 1, threshold: 7,   threshold2: null, cooldown_min: 1440 },
  { alert_key: "reboot_detected",    enabled: 1, threshold: null, threshold2: null, cooldown_min: 60 },
  { alert_key: "reboot_required",   enabled: 1, threshold: null, threshold2: null, cooldown_min: 720 },
  { alert_key: "channel_capacity",   enabled: 1, threshold: 100, threshold2: null, cooldown_min: 0 },
  { alert_key: "updates_pending",   enabled: 1, threshold: null, threshold2: null, cooldown_min: 720 },
  { alert_key: "backup_failed",      enabled: 1, threshold: null, threshold2: null, cooldown_min: 360 },
  // threshold = max age in hours of the newest success/degraded run
  { alert_key: "backup_stale",       enabled: 1, threshold: 36,  threshold2: null, cooldown_min: 720 },
];
const _seedStmt = db.prepare(
  "INSERT OR IGNORE INTO alert_settings (alert_key, enabled, threshold, threshold2, cooldown_min) VALUES (@alert_key, @enabled, @threshold, @threshold2, @cooldown_min)"
);
for (const row of _alertDefaults) _seedStmt.run(row);
