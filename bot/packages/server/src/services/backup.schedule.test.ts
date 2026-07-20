import { describe, expect, it } from "vitest";
import {
  clampHourUtc,
  clampIntervalDays,
  describeSchedule,
  isCatchUpDue,
  lastDueSlot,
  nextSlot,
  staleAfterHours,
} from "./backup.schedule";
import type { BackupConfig } from "@vpn-relay/shared";

const at = (iso: string) => new Date(iso);
/** SQLite's datetime('now') format: UTC, no Z suffix. */
const sqlite = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "");

const DAILY = 1;
const WEEKLY = 7;

describe("lastDueSlot — daily (interval 1)", () => {
  it("returns today's slot once it has passed", () => {
    expect(lastDueSlot(at("2026-07-20T05:00:00Z"), 3, DAILY).toISOString()).toBe("2026-07-20T03:00:00.000Z");
  });

  it("returns yesterday's slot before today's", () => {
    expect(lastDueSlot(at("2026-07-20T02:59:59Z"), 3, DAILY).toISOString()).toBe("2026-07-19T03:00:00.000Z");
  });

  it("treats the exact slot moment as due", () => {
    expect(lastDueSlot(at("2026-07-20T03:00:00Z"), 3, DAILY).toISOString()).toBe("2026-07-20T03:00:00.000Z");
  });

  it("handles hour 0 across midnight", () => {
    expect(lastDueSlot(at("2026-07-20T00:00:00Z"), 0, DAILY).toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(lastDueSlot(at("2026-07-19T23:59:59Z"), 0, DAILY).toISOString()).toBe("2026-07-19T00:00:00.000Z");
  });

  it("crosses a month boundary", () => {
    expect(lastDueSlot(at("2026-08-01T01:00:00Z"), 3, DAILY).toISOString()).toBe("2026-07-31T03:00:00.000Z");
  });
});

describe("lastDueSlot — weekly (interval 7)", () => {
  /** The anchor is chosen so a 7-day interval lands on Mondays, not the epoch's Thursday. */
  it("lands on a Monday", () => {
    const slot = lastDueSlot(at("2026-07-24T12:00:00Z"), 3, WEEKLY); // a Friday
    expect(slot.getUTCDay()).toBe(1);
    expect(slot.toISOString()).toBe("2026-07-20T03:00:00.000Z");
  });

  it("stays on the same Monday all week", () => {
    for (const day of ["2026-07-20T03:00:00Z", "2026-07-22T09:00:00Z", "2026-07-26T23:59:59Z"]) {
      expect(lastDueSlot(at(day), 3, WEEKLY).toISOString()).toBe("2026-07-20T03:00:00.000Z");
    }
  });

  it("moves to the next Monday once its hour arrives", () => {
    expect(lastDueSlot(at("2026-07-27T02:59:59Z"), 3, WEEKLY).toISOString()).toBe("2026-07-20T03:00:00.000Z");
    expect(lastDueSlot(at("2026-07-27T03:00:00Z"), 3, WEEKLY).toISOString()).toBe("2026-07-27T03:00:00.000Z");
  });
});

describe("nextSlot", () => {
  it("is exactly one interval after the last slot", () => {
    for (const interval of [1, 3, 7, 14, 30]) {
      const now = at("2026-07-20T05:00:00Z");
      const delta = nextSlot(now, 3, interval).getTime() - lastDueSlot(now, 3, interval).getTime();
      expect(delta).toBe(interval * 86_400_000);
    }
  });

  it("is always in the future", () => {
    for (const iso of ["2026-07-20T02:59:59Z", "2026-07-20T03:00:00Z", "2026-07-26T23:59:59Z"]) {
      for (const interval of [1, 7]) {
        expect(nextSlot(at(iso), 3, interval).getTime()).toBeGreaterThan(at(iso).getTime());
      }
    }
  });

  it("keeps weekly runs on Mondays", () => {
    expect(nextSlot(at("2026-07-24T12:00:00Z"), 3, WEEKLY).getUTCDay()).toBe(1);
  });
});

describe("isCatchUpDue", () => {
  it("is due when no backup has ever run", () => {
    expect(isCatchUpDue(null, at("2026-07-20T05:00:00Z"), 3, DAILY)).toBe(true);
  });

  it("is not due when the last slot already produced one", () => {
    expect(isCatchUpDue(sqlite("2026-07-20T03:00:12"), at("2026-07-20T05:00:00Z"), 3, DAILY)).toBe(false);
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
    expect(isCatchUpDue(sqlite(lastRun), bootedAt, 3, DAILY)).toBe(true);
  });

  it("does not fire mid-week on a weekly schedule", () => {
    // Ran Monday, it is now Thursday: nothing is due until next Monday. A naive
    // "older than 24h" check would run a backup every single day here.
    expect(isCatchUpDue(sqlite("2026-07-20T03:00:10"), at("2026-07-23T12:00:00Z"), 3, WEEKLY)).toBe(false);
  });

  it("fires when a whole weekly slot was missed", () => {
    expect(isCatchUpDue(sqlite("2026-07-13T03:00:10"), at("2026-07-28T12:00:00Z"), 3, WEEKLY)).toBe(true);
  });

  it("parses SQLite timestamps as UTC, not local time", () => {
    expect(isCatchUpDue(sqlite("2026-07-20T03:10:00"), at("2026-07-20T04:00:00Z"), 3, DAILY)).toBe(false);
  });

  it("is due on an unparseable timestamp rather than silently skipping", () => {
    expect(isCatchUpDue("not-a-date", at("2026-07-20T05:00:00Z"), 3, DAILY)).toBe(true);
  });
});

describe("staleAfterHours", () => {
  /**
   * Why the threshold is grace-on-top rather than an absolute age: a fixed 36h would
   * put a weekly schedule permanently past its own staleness threshold, firing the
   * alert every cycle forever.
   */
  it("scales with the interval", () => {
    expect(staleAfterHours(1, 12)).toBe(36);
    expect(staleAfterHours(7, 12)).toBe(180); // 7.5 days
    expect(staleAfterHours(30, 12)).toBe(732);
  });

  it("always leaves room past a punctual run", () => {
    for (const interval of [1, 3, 7, 30]) {
      expect(staleAfterHours(interval, 12)).toBeGreaterThan(interval * 24);
    }
  });

  it("would have false-alarmed weekly under the old fixed 36h", () => {
    const weeklyAgeAtNextRun = 7 * 24;
    expect(weeklyAgeAtNextRun).toBeGreaterThan(36); // the bug this replaced
    expect(weeklyAgeAtNextRun).toBeLessThan(staleAfterHours(7, 12)); // fixed
  });
});

describe("clamping", () => {
  it("bounds the interval to 1-30 days", () => {
    expect(clampIntervalDays(0)).toBe(1);
    expect(clampIntervalDays(-5)).toBe(1);
    expect(clampIntervalDays(31)).toBe(30);
    expect(clampIntervalDays(7)).toBe(7);
    expect(clampIntervalDays(7.4)).toBe(7);
  });

  it("bounds the hour to 0-23", () => {
    expect(clampHourUtc(-1)).toBe(0);
    expect(clampHourUtc(24)).toBe(23);
    expect(clampHourUtc(3)).toBe(3);
  });

  it("falls back rather than producing NaN", () => {
    expect(Number.isFinite(clampIntervalDays(NaN))).toBe(true);
    expect(Number.isFinite(clampHourUtc(NaN))).toBe(true);
  });
});

describe("describeSchedule", () => {
  const cfg = (intervalDays: number, hourUtc = 3): BackupConfig => ({
    enabled: true, intervalDays, hourUtc, retention: 7, nextRun: "",
  });

  it("reads naturally for each shape", () => {
    expect(describeSchedule(cfg(1))).toBe("Daily at 03:00 UTC");
    expect(describeSchedule(cfg(7))).toBe("Weekly (Mondays) at 03:00 UTC");
    expect(describeSchedule(cfg(3))).toBe("Every 3 days at 03:00 UTC");
    expect(describeSchedule(cfg(1, 0))).toBe("Daily at 00:00 UTC");
  });
});
