/**
 * Fresh-DB path for sub_token plus the query round-trip.
 *
 * setup.ts points DB_PATH at a per-file temp directory, so importing db/index
 * here exercises the FRESH-database branch — the complement to the synthetic
 * pre-hysteria2 database in subtoken.migration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { db } from "./index";
import { queries } from "./queries";
import type { Client } from "@vpn-relay/shared";

type InsertArg = Parameters<typeof queries.insertClient>[0];

function makeClient(over: Partial<InsertArg> & Pick<InsertArg, "id" | "name">): InsertArg {
  return {
    type: "xray",
    wg_ip: null,
    wg_pubkey: null,
    xray_uuid: "uuid-" + over.id,
    hy2_password: null,
    expires_at: null,
    is_active: 1,
    daily_quota_gb: null,
    monthly_quota_gb: null,
    suspend_reason: null,
    wg_cascade_transport: "xray",
    sub_token: null,
    ...over,
  } as InsertArg;
}

describe("sub_token on a fresh database", () => {
  it("has the column and the partial unique index", () => {
    const cols = (db.pragma("table_info(clients)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("sub_token");

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_clients_sub_token'")
      .get();
    expect(idx).toBeTruthy();
  });
});

describe("getClientBySubToken / setClientSubToken", () => {
  it("round-trips a token", () => {
    queries.insertClient(makeClient({ id: "c1", name: "roundtrip", sub_token: "token-one" }));

    const found = queries.getClientBySubToken("token-one");
    expect(found?.id).toBe("c1");
    expect(found?.name).toBe("roundtrip");
  });

  it("returns undefined for an unknown token", () => {
    expect(queries.getClientBySubToken("no-such-token")).toBeUndefined();
  });

  it("rotation makes the old token unresolvable", () => {
    queries.insertClient(makeClient({ id: "c2", name: "rotates", sub_token: "old-token" }));

    queries.setClientSubToken("c2", "new-token");

    // The core promise of the rotate action: the old LINK stops resolving.
    expect(queries.getClientBySubToken("old-token")).toBeUndefined();
    expect(queries.getClientBySubToken("new-token")?.id).toBe("c2");
  });
});

describe("idx_clients_sub_token (partial unique)", () => {
  it("permits many NULL tokens", () => {
    queries.insertClient(makeClient({ id: "n1", name: "null_one", type: "wg", xray_uuid: null }));
    queries.insertClient(makeClient({ id: "n2", name: "null_two", type: "wg", xray_uuid: null }));

    const n = db
      .prepare("SELECT COUNT(*) AS n FROM clients WHERE sub_token IS NULL")
      .get() as { n: number };
    expect(n.n).toBeGreaterThanOrEqual(2);
  });

  it("rejects a duplicate non-null token", () => {
    queries.insertClient(makeClient({ id: "d1", name: "dup_one", sub_token: "shared-token" }));

    expect(() =>
      queries.insertClient(makeClient({ id: "d2", name: "dup_two", sub_token: "shared-token" }))
    ).toThrow(/UNIQUE/i);
  });
});

describe("Client type", () => {
  it("carries sub_token through SELECT *", () => {
    queries.insertClient(makeClient({ id: "t1", name: "typed", sub_token: "typed-token" }));
    const c: Client | undefined = queries.getClientById("t1");
    expect(c?.sub_token).toBe("typed-token");
  });
});
