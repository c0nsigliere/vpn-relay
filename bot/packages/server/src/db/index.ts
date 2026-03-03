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
