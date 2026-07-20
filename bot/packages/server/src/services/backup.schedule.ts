/**
 * Backup schedule: the runtime-editable config and the slot grid it drives.
 *
 * The grid is absolute and anchored, not "every N days since the last run". An
 * interval measured from the previous run drifts forward a little every time a run
 * is late, and a deploy restart can double-fire around it. An anchored grid asks a
 * question with one answer: "did the slot that was due produce a backup?"
 *
 * ANCHOR_DAY is 1970-01-05, a Monday, so a 7-day interval lands on Mondays rather
 * than on the Thursday the epoch would otherwise impose. For interval 1 the anchor
 * is irrelevant (every day is a slot) and the behaviour is identical to the original
 * daily schedule.
 */

import { queries } from "../db/queries";
import { env } from "../config/env";
import type { BackupConfig } from "@vpn-relay/shared";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Epoch day number of 1970-01-05 (a Monday). */
const ANCHOR_DAY = 4;

export const MIN_INTERVAL_DAYS = 1;
export const MAX_INTERVAL_DAYS = 30;

/** Slot instant for a given UTC day number. */
function slotAt(dayNumber: number, hourUtc: number): number {
  return dayNumber * DAY_MS + hourUtc * HOUR_MS;
}

/** Most recent slot at or before `now`. */
export function lastDueSlot(now: Date, hourUtc: number, intervalDays: number): Date {
  let day = Math.floor(now.getTime() / DAY_MS);
  // Today's slot may not have arrived yet.
  if (slotAt(day, hourUtc) > now.getTime()) day -= 1;
  // Walk back to the nearest day that is on the grid.
  const offset = (((day - ANCHOR_DAY) % intervalDays) + intervalDays) % intervalDays;
  return new Date(slotAt(day - offset, hourUtc));
}

/** Next slot strictly after `now`. UTC has no DST, so +N days is always exact. */
export function nextSlot(now: Date, hourUtc: number, intervalDays: number): Date {
  return new Date(lastDueSlot(now, hourUtc, intervalDays).getTime() + intervalDays * DAY_MS);
}

/**
 * True when the most recent slot has not produced a backup.
 *
 * `finishedAtSql` is SQLite's datetime('now'): UTC with no `Z`, so it must be parsed
 * as `new Date(s + "Z")`. Reading it as local time is a silent multi-hour offset.
 */
export function isCatchUpDue(
  finishedAtSql: string | null,
  now: Date,
  hourUtc: number,
  intervalDays: number
): boolean {
  if (!finishedAtSql) return true;
  const finishedAt = new Date(`${finishedAtSql}Z`).getTime();
  if (Number.isNaN(finishedAt)) return true;
  return finishedAt < lastDueSlot(now, hourUtc, intervalDays).getTime();
}

/**
 * Age (in hours) past which backups count as stale, given the current interval.
 * `graceHours` is the backup_stale alert threshold — expressed as slack on top of
 * the expected interval rather than as an absolute age, because an absolute 36h
 * would fire every week as soon as the schedule went weekly.
 */
export function staleAfterHours(intervalDays: number, graceHours: number): number {
  return intervalDays * 24 + graceHours;
}

export function clampIntervalDays(days: number): number {
  if (!Number.isFinite(days)) return env.BACKUP_INTERVAL_DAYS;
  return Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_INTERVAL_DAYS, Math.round(days)));
}

export function clampHourUtc(hour: number): number {
  if (!Number.isFinite(hour)) return env.BACKUP_HOUR_UTC;
  return Math.min(23, Math.max(0, Math.round(hour)));
}

/** Current schedule, read from the DB (env values are only the first-run seed). */
export function getBackupConfig(now: Date = new Date()): BackupConfig {
  const enabled = queries.getAppSettingInt("backup_enabled", env.BACKUP_ENABLED ? 1 : 0) === 1;
  const intervalDays = clampIntervalDays(
    queries.getAppSettingInt("backup_interval_days", env.BACKUP_INTERVAL_DAYS)
  );
  const hourUtc = clampHourUtc(queries.getAppSettingInt("backup_hour_utc", env.BACKUP_HOUR_UTC));

  return {
    enabled,
    intervalDays,
    hourUtc,
    retention: env.BACKUP_RETENTION,
    nextRun: nextSlot(now, hourUtc, intervalDays).toISOString(),
  };
}

export function setBackupConfig(patch: {
  enabled?: boolean;
  intervalDays?: number;
  hourUtc?: number;
}): BackupConfig {
  if (patch.enabled !== undefined) {
    queries.setAppSetting("backup_enabled", patch.enabled ? "1" : "0");
  }
  if (patch.intervalDays !== undefined) {
    queries.setAppSetting("backup_interval_days", String(clampIntervalDays(patch.intervalDays)));
  }
  if (patch.hourUtc !== undefined) {
    queries.setAppSetting("backup_hour_utc", String(clampHourUtc(patch.hourUtc)));
  }
  return getBackupConfig();
}

/** "Weekly at 03:00 UTC" / "Every 3 days at 03:00 UTC" / "Daily at 03:00 UTC" */
export function describeSchedule(config: BackupConfig): string {
  const hh = `${String(config.hourUtc).padStart(2, "0")}:00 UTC`;
  if (config.intervalDays === 1) return `Daily at ${hh}`;
  if (config.intervalDays === 7) return `Weekly (Mondays) at ${hh}`;
  return `Every ${config.intervalDays} days at ${hh}`;
}
