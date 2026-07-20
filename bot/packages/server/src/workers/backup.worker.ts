/**
 * Backup worker — daily encrypted bundle at BACKUP_HOUR_UTC, plus the restore receipt.
 *
 * Scheduling is ABSOLUTE, not interval-based. The rollup.worker style
 * (setInterval(24h) armed at boot) would make backup time drift with every deploy
 * restart and can double-fire around one; an absolute next-occurrence timer re-armed
 * after each run cannot.
 *
 * Catch-up is SLOT-based, not age-based. Consider: backup due 03:00, host down
 * 02:50–03:45. At boot the last success is only 24h45m old, so a "last success older
 * than 25h" check skips it and the gap silently stretches to 48h. Asking "did the
 * 03:00 slot produce a backup?" cannot miss that.
 */

import { Bot } from "grammy";
import * as fs from "fs";
import type { BotContext } from "../bot/context";
import { queries } from "../db/queries";
import { env } from "../config/env";
import { backupService } from "../services/backup.service";
import { passphraseFingerprint } from "../services/backup.container";
import { createLogger } from "../utils/logger";
import { escapeMarkdown, sendMarkdown } from "../utils/telegram";

const logger = createLogger("backup-worker");

const CATCH_UP_DELAY_MS = 120_000; // let the startup syncs settle first
const DAY_MS = 86_400_000;

const PASSPHRASE_NOTE_KEY = "backup_passphrase_note";

// ── Slot math (pure, exported for tests) ─────────────────────────────────────

/** Most recent occurrence of `hourUtc` at or before `now`. */
export function lastDueSlot(now: Date, hourUtc: number): Date {
  const slot = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0)
  );
  if (slot.getTime() > now.getTime()) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot;
}

/** Next occurrence strictly after `now`. UTC has no DST, so +24h is always right. */
export function nextSlot(now: Date, hourUtc: number): Date {
  return new Date(lastDueSlot(now, hourUtc).getTime() + DAY_MS);
}

/**
 * True when the most recent slot has not produced a backup.
 *
 * `finishedAtSql` comes from SQLite's datetime('now'): UTC with no `Z` suffix, so it
 * must be parsed as `new Date(s + "Z")`. Treating it as local time is a silent
 * multi-hour offset on any node with a non-UTC TZ.
 */
export function isCatchUpDue(finishedAtSql: string | null, now: Date, hourUtc: number): boolean {
  if (!finishedAtSql) return true;
  const finishedAt = new Date(`${finishedAtSql}Z`).getTime();
  if (Number.isNaN(finishedAt)) return true;
  return finishedAt < lastDueSlot(now, hourUtc).getTime();
}

// ─────────────────────────────────────────────────────────────────────────────

function alertEnabled(key: string): boolean {
  const s = queries.getAlertSetting(key);
  return s ? s.enabled === 1 : true;
}

/** Same cooldown semantics as alert.worker's shouldFire, kept local per the
 *  updates.worker precedent (those helpers are module-private to alert.worker). */
function shouldFire(key: string, defaultCooldownMin: number): boolean {
  const state = queries.getAlertState(key);
  if (!state || state.status === "clear") return true;
  if (!state.fired_at) return true;
  const cooldownMin = queries.getAlertSetting(key)?.cooldown_min ?? defaultCooldownMin;
  return Date.now() - new Date(`${state.fired_at}Z`).getTime() >= cooldownMin * 60_000;
}

export function backupWorker(bot: Bot<BotContext>): { stop: () => void } {
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();

  const arm = (ms: number, fn: () => void): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!stopped) fn();
    }, ms);
    timers.add(t);
  };

  // SYNCHRONOUS: this runs while index.ts builds the `workers` array, before
  // bot.start(), so no "Backup Now" tap can be in flight yet. The started_at scope in
  // the query makes that guarantee independent of this ordering anyway.
  const stuck = queries.failStuckBackupRuns(new Date().toISOString().replace("T", " ").slice(0, 19));
  if (stuck > 0) logger.warn(`Marked ${stuck} interrupted backup run(s) as failed`);
  try {
    backupService.wipeStaging();
  } catch (err) {
    logger.error("Could not wipe staging dir", err);
  }

  const runOnce = async (trigger: "scheduled" | "manual" = "scheduled"): Promise<void> => {
    try {
      const result = await backupService.runBackup(trigger, bot.api);

      if (result.status === "success") {
        // backup_failed has no natural clear — nothing evaluates it on the happy
        // path — so a success has to clear it explicitly or it stays 'fired' forever.
        const state = queries.getAlertState("backup_failed");
        if (state?.status === "fired") {
          queries.upsertAlertState("backup_failed", "clear");
          await sendMarkdown(bot.api, env.ADMIN_ID, "✅ *Backup succeeded again*").catch(() => {});
        }
        await maybeSendPassphraseNote();
      } else if (alertEnabled("backup_failed") && shouldFire("backup_failed", 360)) {
        const what = result.status === "degraded"
          ? "completed but was NOT delivered off-site"
          : "failed";
        queries.upsertAlertState("backup_failed", "fired");
        await sendMarkdown(
          bot.api,
          env.ADMIN_ID,
          `⚠️ *Backup ${what}*\n\n${escapeMarkdown(result.error ?? "unknown error")}` +
            (result.status === "degraded" ? "\n\nA local copy exists in the backups directory." : "")
        ).catch((err) => logger.error("Could not deliver backup_failed alert", err));
      }
    } catch (err) {
      logger.error("Backup run threw", err);
    }
  };

  const maybeSendPassphraseNote = async (): Promise<void> => {
    if (queries.getAlertState(PASSPHRASE_NOTE_KEY)?.status === "fired") return;
    try {
      const passphrase = fs.readFileSync(env.BACKUP_PASSPHRASE_FILE, "utf8").trim();
      // The passphrase itself is never sent: it would end up in the same chat as the
      // bundles it protects. The fingerprint is enough to verify a saved copy.
      await sendMarkdown(
        bot.api,
        env.ADMIN_ID,
        "🔑 *Save the backup passphrase*\n\n" +
          "Backups are encrypted. Without the passphrase they are unreadable — store it " +
          "in your password manager, *outside* this server.\n\n" +
          `Read it with:\n\`ssh root@${escapeMarkdown(env.SERVER_B_HOST)} cat ${escapeMarkdown(env.BACKUP_PASSPHRASE_FILE)}\`\n\n` +
          `Fingerprint: \`${passphraseFingerprint(passphrase)}\``
      );
      queries.upsertAlertState(PASSPHRASE_NOTE_KEY, "fired");
    } catch (err) {
      logger.error("Could not send passphrase reminder", err);
    }
  };

  const scheduleNext = (): void => {
    const now = new Date();
    const due = nextSlot(now, env.BACKUP_HOUR_UTC);
    const delay = due.getTime() - now.getTime();
    logger.info(`Next scheduled backup at ${due.toISOString()} (in ${Math.round(delay / 60_000)} min)`);
    arm(delay, () => {
      void runOnce("scheduled").finally(scheduleNext);
    });
  };

  // Restore receipt first — the process that applied it died by design.
  const deliverRestoreReceipt = async (): Promise<void> => {
    if (!fs.existsSync(backupService.restoreMarker)) return;
    try {
      const marker = JSON.parse(fs.readFileSync(backupService.restoreMarker, "utf8")) as {
        clients?: number;
        bundle_created_at?: string;
      };
      await sendMarkdown(
        bot.api,
        env.ADMIN_ID,
        `✅ *Restore completed*\n\n${marker.clients ?? "?"} clients restored from a backup of ` +
          `${escapeMarkdown(marker.bundle_created_at ?? "unknown date")}.`
      );
    } catch (err) {
      logger.error("Could not deliver restore receipt", err);
    } finally {
      fs.rmSync(backupService.restoreMarker, { force: true });
    }
  };

  if (!env.BACKUP_ENABLED) {
    logger.info("disabled (BACKUP_ENABLED=false)");
    // Still deliver a pending receipt: a restore may have been applied before the
    // operator turned scheduling off.
    void deliverRestoreReceipt();
    return { stop: () => { stopped = true; timers.forEach(clearTimeout); } };
  }

  void deliverRestoreReceipt();

  const last = queries.getLastBackupRun(["success", "degraded"]);
  if (isCatchUpDue(last?.finished_at ?? null, new Date(), env.BACKUP_HOUR_UTC)) {
    logger.info("Missed the last scheduled slot — catching up shortly");
    arm(CATCH_UP_DELAY_MS, () => void runOnce("scheduled"));
  }
  scheduleNext();

  logger.info(`started (daily at ${String(env.BACKUP_HOUR_UTC).padStart(2, "0")}:00 UTC, keep ${env.BACKUP_RETENTION})`);

  return {
    stop: () => {
      stopped = true;
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}
