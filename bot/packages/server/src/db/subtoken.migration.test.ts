/**
 * Guards the placement of the sub_token migration in db/index.ts.
 *
 * migrateClientsAddHysteria2() rebuilds `clients` with an explicit column list.
 * If the sub_token ALTER were moved up into the additive-ALTER block (where it
 * looks like it belongs), the rebuild would drop the column — silently, and only
 * on databases that have not yet been migrated, which includes every FRESH
 * install. The bot would boot fine and subscriptions would simply never work.
 *
 * So this test drives the migration from a synthetic PRE-hysteria2 database: the
 * old CHECK constraint, the old column set, and rows already in place.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { describe, it, expect, beforeAll } from "vitest";

/** The clients DDL exactly as it existed before the hysteria2 rebuild migration. */
const PRE_HY2_DDL = `
  CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('wg', 'xray', 'both')),
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
    wg_cascade_transport TEXT DEFAULT 'xray'
  );
`;

let db: import("better-sqlite3").Database;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpn-relay-premigration-"));
  const dbPath = path.join(dir, "data.db");

  const seed = new Database(dbPath);
  seed.exec(PRE_HY2_DDL);
  const insert = seed.prepare(
    "INSERT INTO clients (id, name, type, xray_uuid) VALUES (?, ?, ?, ?)"
  );
  insert.run("id-capable", "capable_xray", "xray", "uuid-1111");
  insert.run("id-wg", "wg_only", "wg", null);
  // Malformed row: claims xray but carries no credential. Must NOT get a token —
  // it would serve an empty, broken subscription.
  insert.run("id-malformed", "malformed_xray", "xray", null);
  seed.close();

  // Point the module at this DB and import dynamically: a static import would be
  // hoisted above the assignment and open the default path instead.
  process.env.DB_PATH = dbPath;
  ({ db } = await import("./index"));
});

describe("sub_token migration placement", () => {
  it("survives the hysteria2 table rebuild", () => {
    const cols = (db.pragma("table_info(clients)") as Array<{ name: string }>).map((c) => c.name);
    // The assertion that fails if the ALTER is moved before migrateClientsAddHysteria2().
    expect(cols).toContain("sub_token");
  });

  it("actually ran the rebuild it has to survive", () => {
    // Proves the test exercised the real hazard rather than an already-migrated DB.
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='clients'")
      .get() as { sql: string };
    expect(row.sql).toContain("hysteria2");
  });

  it("creates the partial unique index", () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_clients_sub_token'")
      .get();
    expect(idx).toBeTruthy();
  });

  it("backfills only subscription-capable rows", () => {
    const rows = db
      .prepare("SELECT id, sub_token FROM clients")
      .all() as Array<{ id: string; sub_token: string | null }>;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.sub_token]));

    expect(byId["id-capable"]).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(byId["id-wg"]).toBeNull();
    expect(byId["id-malformed"]).toBeNull();
  });
});
