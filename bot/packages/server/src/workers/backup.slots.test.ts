import { describe, expect, it } from "vitest";
import { isCatchUpDue, lastDueSlot, nextSlot } from "./backup.worker";

const at = (iso: string) => new Date(iso);
/** SQLite's datetime('now') format: UTC, no Z suffix. */
const sqlite = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "");

describe("lastDueSlot", () => {
  it("returns today's slot once it has passed", () => {
    expect(lastDueSlot(at("2026-07-20T05:00:00Z"), 3).toISOString()).toBe("2026-07-20T03:00:00.000Z");
  });

  it("returns yesterday's slot before today's", () => {
    expect(lastDueSlot(at("2026-07-20T02:59:59Z"), 3).toISOString()).toBe("2026-07-19T03:00:00.000Z");
  });

  it("treats the exact slot moment as due", () => {
    expect(lastDueSlot(at("2026-07-20T03:00:00Z"), 3).toISOString()).toBe("2026-07-20T03:00:00.000Z");
  });

  it("handles hour 0 across midnight", () => {
    expect(lastDueSlot(at("2026-07-20T00:00:00Z"), 0).toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(lastDueSlot(at("2026-07-19T23:59:59Z"), 0).toISOString()).toBe("2026-07-19T00:00:00.000Z");
  });

  it("handles hour 23", () => {
    expect(lastDueSlot(at("2026-07-20T00:30:00Z"), 23).toISOString()).toBe("2026-07-19T23:00:00.000Z");
  });

  it("crosses a month boundary", () => {
    expect(lastDueSlot(at("2026-08-01T01:00:00Z"), 3).toISOString()).toBe("2026-07-31T03:00:00.000Z");
  });
});

describe("nextSlot", () => {
  it("is always exactly 24h after the last slot (UTC has no DST)", () => {
    for (const iso of ["2026-07-20T05:00:00Z", "2026-03-29T01:30:00Z", "2026-10-25T01:30:00Z"]) {
      const now = at(iso);
      expect(nextSlot(now, 3).getTime() - lastDueSlot(now, 3).getTime()).toBe(86_400_000);
    }
  });

  it("is always in the future", () => {
    for (const iso of ["2026-07-20T02:59:59Z", "2026-07-20T03:00:00Z", "2026-07-20T23:59:59Z"]) {
      expect(nextSlot(at(iso), 3).getTime()).toBeGreaterThan(at(iso).getTime());
    }
  });
});

describe("isCatchUpDue", () => {
  it("is due when no backup has ever run", () => {
    expect(isCatchUpDue(null, at("2026-07-20T05:00:00Z"), 3)).toBe(true);
  });

  it("is not due when the last slot already produced one", () => {
    expect(isCatchUpDue(sqlite("2026-07-20T03:00:12"), at("2026-07-20T05:00:00Z"), 3)).toBe(false);
  });

  it("is due when the last run predates the most recent slot", () => {
    expect(isCatchUpDue(sqlite("2026-07-19T03:00:12"), at("2026-07-20T05:00:00Z"), 3)).toBe(true);
  });

  /**
   * The case an age-based check gets wrong. Backup due 03:00; host down 02:50-03:45.
   * At boot the last success is only 24h45m old, so "older than 25h" says skip — and
   * the gap silently stretches to 48h. The slot question cannot miss it.
   */
  it("catches the host-down-across-the-slot case that an age check misses", () => {
    const lastRun = "2026-07-19T03:00:00";
    const bootedAt = at("2026-07-20T03:45:00Z");

    const ageHours = (bootedAt.getTime() - new Date(`${lastRun}Z`).getTime()) / 3_600_000;
    expect(ageHours).toBeLessThan(25); // an age check would skip
    expect(isCatchUpDue(sqlite(lastRun), bootedAt, 3)).toBe(true); // slot check does not
  });

  it("parses SQLite timestamps as UTC, not local time", () => {
    // 10 minutes after the slot. Misread as local time on a +3 node this becomes
    // 00:10 UTC — before the slot — and would trigger a spurious catch-up.
    expect(isCatchUpDue(sqlite("2026-07-20T03:10:00"), at("2026-07-20T04:00:00Z"), 3)).toBe(false);
  });

  it("is due on an unparseable timestamp rather than silently skipping", () => {
    expect(isCatchUpDue("not-a-date", at("2026-07-20T05:00:00Z"), 3)).toBe(true);
  });
});
