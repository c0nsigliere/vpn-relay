import { describe, expect, it } from "vitest";
import { bundleLabel, bundleStamp, checkEntry, selectForRotation } from "./backup.service";

const PRE_RESTORE_RE = /^pre-restore-.+\.db$/;

const bundles = (n: number) =>
  Array.from({ length: n }, (_, i) => `vpn-backup-heimdall-202607${String(i + 1).padStart(2, "0")}-0300Z.tar.gz.enc`);

describe("selectForRotation", () => {
  it("deletes nothing below the retention count", () => {
    expect(selectForRotation(bundles(5), 7)).toEqual([]);
    expect(selectForRotation(bundles(7), 7)).toEqual([]);
  });

  it("deletes the oldest beyond the retention count", () => {
    const deleted = selectForRotation(bundles(9), 7);
    expect(deleted).toHaveLength(2);
    expect(deleted).toEqual([
      "vpn-backup-heimdall-20260701-0300Z.tar.gz.enc",
      "vpn-backup-heimdall-20260702-0300Z.tar.gz.enc",
    ]);
  });

  it("orders by the embedded timestamp, not directory order", () => {
    const shuffled = [...bundles(9)].reverse();
    expect(selectForRotation(shuffled, 7)).toEqual([
      "vpn-backup-heimdall-20260701-0300Z.tar.gz.enc",
      "vpn-backup-heimdall-20260702-0300Z.tar.gz.enc",
    ]);
  });

  it("never counts pre-restore snapshots against the bundle quota", () => {
    const mixed = ["pre-restore-20260101-0000.db", "pre-restore-20260102-0000.db", ...bundles(7)];
    expect(selectForRotation(mixed, 7)).toEqual([]);
  });

  it("never deletes a pre-restore snapshot via the bundle pattern", () => {
    const deleted = selectForRotation(["pre-restore-20260101-0000.db", ...bundles(9)], 7);
    expect(deleted.every((n) => !n.startsWith("pre-restore"))).toBe(true);
  });

  it("ignores half-written .part files", () => {
    const withPart = [...bundles(7), "vpn-backup-heimdall-20260710-0300Z.tar.gz.enc.part"];
    expect(selectForRotation(withPart, 7)).toEqual([]);
  });

  it("rotates pre-restore snapshots under their own pattern", () => {
    const snaps = ["pre-restore-20260101-0000.db", "pre-restore-20260102-0000.db", "pre-restore-20260103-0000.db", "pre-restore-20260104-0000.db"];
    expect(selectForRotation(snaps, 3, PRE_RESTORE_RE)).toEqual(["pre-restore-20260101-0000.db"]);
  });

  it("ignores unrelated files in the directory", () => {
    expect(selectForRotation(["README", "data.db", ".keep"], 1)).toEqual([]);
  });

  /**
   * Regression: sorting whole filenames sorts by LABEL before timestamp, because the
   * label precedes the stamp. A node whose label changes — a TMA domain added, or the
   * IP fallback kicking in — then rotates by label and can delete its newest bundle.
   * '2' < 'n', so the IP-labelled bundle below sorted first and was deleted as
   * "oldest" despite being the most recent by six months.
   */
  it("orders by the extracted timestamp even when labels differ", () => {
    const old = Array.from(
      { length: 8 },
      (_, i) => `vpn-backup-node-202601${String(i + 1).padStart(2, "0")}-0300Z.tar.gz.enc`
    );
    const newest = "vpn-backup-203-0-113-1-20260720-1425Z.tar.gz.enc";

    // 9 files, keep 7 → the two oldest BY STAMP go, and the newest is not among them.
    const deleted = selectForRotation([...old, newest], 7);
    expect(deleted).toEqual([
      "vpn-backup-node-20260101-0300Z.tar.gz.enc",
      "vpn-backup-node-20260102-0300Z.tar.gz.enc",
    ]);
    expect(deleted).not.toContain(newest);
  });

  it("never deletes a file whose name carries no timestamp", () => {
    const undated = "vpn-backup-weird.tar.gz.enc";
    const deleted = selectForRotation([undated, ...bundles(9)], 7);
    expect(deleted).not.toContain(undated);
    expect(deleted).toHaveLength(2); // undated files are not counted either
  });
});

describe("bundleStamp", () => {
  it("is zero-padded and sorts lexicographically in chronological order", () => {
    expect(bundleStamp(new Date("2026-07-20T03:00:00Z"))).toBe("20260720-0300");
    expect(bundleStamp(new Date("2026-01-05T09:07:00Z"))).toBe("20260105-0907");
    const sorted = ["2026-12-31T23:59:00Z", "2026-01-01T00:00:00Z", "2026-07-20T03:00:00Z"]
      .map((s) => bundleStamp(new Date(s)))
      .sort();
    expect(sorted).toEqual(["20260101-0000", "20260720-0300", "20261231-2359"]);
  });

  it("uses UTC, so the stamp matches the scheduled slot", () => {
    expect(bundleStamp(new Date("2026-07-20T03:00:00Z"))).toContain("-0300");
  });
});

describe("bundleLabel", () => {
  it("uses the first label of the TMA domain", () => {
    expect(bundleLabel("heimdall.gollum.ru", "37.120.173.140")).toBe("heimdall");
  });

  it("falls back to the host with dots as dashes", () => {
    expect(bundleLabel(undefined, "37.120.173.140")).toBe("37-120-173-140");
    expect(bundleLabel("", "37.120.173.140")).toBe("37-120-173-140");
  });

  it("strips anything that would be unsafe in a filename", () => {
    expect(bundleLabel("Node_One!.example.com", "1.2.3.4")).toBe("nodeone");
  });

  it("falls back rather than emitting a traversal fragment", () => {
    // "../../etc".split(".")[0] is "" — so this lands on the fallback, not on "etc".
    expect(bundleLabel("../../etc", "1.2.3.4")).toBe("node");
  });

  it("never returns an empty label", () => {
    expect(bundleLabel("!!!.example.com", "1.2.3.4")).toBe("node");
  });
});

describe("checkEntry — extraction allowlist", () => {
  const file = (path: string, size = 100) => ({ path, type: "File", size });

  it("accepts every legal bundle entry", () => {
    for (const name of [
      "manifest.json",
      "data.db",
      "backup.passphrase",
      "xray/reality.key",
      "xray/reality.pub",
      "xray/shortid",
      "singbox/obfs.pw",
      "wg/wg-clients.key",
    ]) {
      expect(checkEntry(file(name))).toBeNull();
    }
  });

  it("rejects an entry that is not in the allowlist", () => {
    expect(checkEntry(file("evil.sh"))).toMatch(/not an expected bundle entry/);
    expect(checkEntry(file("xray/../../etc/passwd"))).toMatch(/unsafe path|not an expected/);
  });

  it("rejects path traversal and absolute paths", () => {
    expect(checkEntry(file("../etc/passwd"))).toMatch(/unsafe path/);
    expect(checkEntry(file("/etc/passwd"))).toMatch(/unsafe path/);
  });

  it.each(["SymbolicLink", "Link", "Directory", "CharacterDevice", "FIFO"])(
    "rejects %s entries",
    (type) => {
      expect(checkEntry({ path: "data.db", type, size: 10 })).toMatch(/not a regular file/);
    }
  );

  it("rejects oversized members", () => {
    expect(checkEntry(file("manifest.json", 65 * 1024))).toMatch(/exceeds cap/);
    expect(checkEntry(file("data.db", 257 * 1024 * 1024))).toMatch(/exceeds cap/);
    expect(checkEntry(file("xray/reality.key", 5000))).toMatch(/exceeds cap/);
  });

  it("accepts members at exactly the cap", () => {
    expect(checkEntry(file("manifest.json", 64 * 1024))).toBeNull();
    expect(checkEntry(file("data.db", 256 * 1024 * 1024))).toBeNull();
  });
});
