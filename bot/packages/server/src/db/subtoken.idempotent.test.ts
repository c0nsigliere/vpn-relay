/**
 * The already-migrated database — the state every live node is in on its second
 * and every subsequent boot.
 *
 * The failure this guards against is severe: if the startup backfill overwrote
 * existing tokens instead of only filling NULLs, every deployed client's
 * subscription link would break on every bot restart. The `WHERE sub_token IS
 * NULL` clause is what prevents that, and nothing else would catch its removal.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";
import { describe, it, expect, beforeAll } from "vitest";

/** Post-hysteria2 schema, already carrying sub_token — i.e. a live node's DB. */
const MIGRATED_DDL = `
  CREATE TABLE clients (
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
    wg_cascade_transport TEXT DEFAULT 'xray',
    sub_token TEXT
  );
`;

let db: import("better-sqlite3").Database;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpn-relay-migrated-"));
  const dbPath = path.join(dir, "data.db");

  const seed = new Database(dbPath);
  seed.exec(MIGRATED_DDL);
  const insert = seed.prepare(
    "INSERT INTO clients (id, name, type, xray_uuid, hy2_password, sub_token) VALUES (?, ?, ?, ?, ?, ?)"
  );
  // Already has a link in the wild — must survive untouched.
  insert.run("existing", "existing_client", "xray", "uuid-existing", null, "PREEXISTING_TOKEN");
  // Predates the feature — should get one on this boot.
  insert.run("fresh", "fresh_client", "hysteria2", null, "hy2pw", null);
  insert.run("wgonly", "wg_client", "wg", null, null, null);
  seed.close();

  process.env.DB_PATH = dbPath;
  ({ db } = await import("./index"));
});

describe("backfill on an already-migrated database", () => {
  it("never touches a token that already exists", () => {
    const row = db.prepare("SELECT sub_token FROM clients WHERE id = 'existing'").get() as {
      sub_token: string;
    };
    // If this ever fails, every live client's subscription link breaks on restart.
    expect(row.sub_token).toBe("PREEXISTING_TOKEN");
  });

  it("fills in a capable client that had none", () => {
    const row = db.prepare("SELECT sub_token FROM clients WHERE id = 'fresh'").get() as {
      sub_token: string | null;
    };
    expect(row.sub_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("still leaves wg-only clients without a token", () => {
    const row = db.prepare("SELECT sub_token FROM clients WHERE id = 'wgonly'").get() as {
      sub_token: string | null;
    };
    expect(row.sub_token).toBeNull();
  });

  it("did not rebuild the table (already migrated)", () => {
    const n = db.prepare("SELECT COUNT(*) AS n FROM clients").get() as { n: number };
    expect(n.n).toBe(3);
  });
});
