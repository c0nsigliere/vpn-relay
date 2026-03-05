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

// Seed default alert settings (INSERT OR IGNORE — never overrides user changes)
const _alertDefaults = [
  { alert_key: "cascade_down",       enabled: 1, threshold: 100, threshold2: 2,    cooldown_min: 30 },
  { alert_key: "cascade_degradation",enabled: 1, threshold: 30,  threshold2: 5,    cooldown_min: 15 },
  { alert_key: "service_dead_xray",  enabled: 1, threshold: null, threshold2: null, cooldown_min: 30 },
  { alert_key: "service_dead_wg",    enabled: 1, threshold: null, threshold2: null, cooldown_min: 30 },
  { alert_key: "disk_full",          enabled: 1, threshold: 90,  threshold2: null, cooldown_min: 60 },
  { alert_key: "network_saturation", enabled: 1, threshold: 80,  threshold2: 15,   cooldown_min: 30 },
  { alert_key: "cpu_overload",       enabled: 1, threshold: 95,  threshold2: 10,   cooldown_min: 30 },
  { alert_key: "abnormal_traffic",   enabled: 1, threshold: 50,  threshold2: null, cooldown_min: 60 },
  { alert_key: "quota_warning",      enabled: 1, threshold: 90,  threshold2: null, cooldown_min: 720 },
  { alert_key: "cert_expiry",        enabled: 1, threshold: 7,   threshold2: null, cooldown_min: 1440 },
  { alert_key: "reboot_detected",    enabled: 1, threshold: null, threshold2: null, cooldown_min: 60 },
  { alert_key: "channel_capacity",   enabled: 1, threshold: 100, threshold2: null, cooldown_min: 0 },
];
const _seedStmt = db.prepare(
  "INSERT OR IGNORE INTO alert_settings (alert_key, enabled, threshold, threshold2, cooldown_min) VALUES (@alert_key, @enabled, @threshold, @threshold2, @cooldown_min)"
);
for (const row of _alertDefaults) _seedStmt.run(row);
