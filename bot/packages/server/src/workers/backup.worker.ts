/**
 * Backup worker — runs the encrypted bundle on the configured schedule, and delivers
 * the receipt for a restore the previous process applied before dying.
 *
 * The schedule itself (enabled / interval / hour) lives in the DB and is edited from
 * the TMA and the bot, so this worker re-reads it every time it arms and exposes
 * rescheduleBackups() for an immediate re-arm when the operator changes it. See
 * services/backup.schedule.ts for the slot grid and why it is anchored rather than
 * measured from the last run.
 */

import { Bot } from "grammy";
import * as fs from "fs";
import type { BotContext } from "../bot/context";
import { queries } from "../db/queries";
import { env } from "../config/env";
import { backupService } from "../services/backup.service";
import { passphraseFingerprint } from "../services/backup.container";
import {
  describeSchedule,
  getBackupConfig,
  isCatchUpDue,
  nextSlot,
} from "../services/backup.schedule";
import { createLogger } from "../utils/logger";
import { escapeMarkdown, sendMarkdown } from "../utils/telegram";

const logger = createLogger("backup-worker");

const CATCH_UP_DELAY_MS = 120_000; // let the startup syncs settle first

const PASSPHRASE_NOTE_KEY = "backup_passphrase_note";

/**
 * Set by the running worker so an API or bot settings change takes effect now rather
 * than after the currently-armed timer fires — which, on a weekly schedule, could be
 * six days away. Module-level rather than a returned handle because the workers array
 * in index.ts is typed to `{ stop }`.
 */
let rescheduleFn: (() => void) | null = null;

export function rescheduleBackups(): void {
  rescheduleFn?.();
}

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

  // Re-reads the config on every arm, so a schedule change is picked up without a
  // restart. `scheduleTimer` is tracked separately from the catch-up timer so a
  // reschedule cancels only the pending run, never a catch-up already in flight.
  let scheduleTimer: NodeJS.Timeout | null = null;

  const scheduleNext = (): void => {
    if (scheduleTimer) {
      clearTimeout(scheduleTimer);
      timers.delete(scheduleTimer);
      scheduleTimer = null;
    }
    if (stopped) return;

    const config = getBackupConfig();
    if (!config.enabled) {
      logger.info("Scheduling paused (backups disabled in settings)");
      return;
    }

    const now = new Date();
    const due = nextSlot(now, config.hourUtc, config.intervalDays);
    const delay = due.getTime() - now.getTime();
    logger.info(
      `${describeSchedule(config)} — next run ${due.toISOString()} (in ${Math.round(delay / 60_000)} min)`
    );

    const t = setTimeout(() => {
      timers.delete(t);
      scheduleTimer = null;
      if (!stopped) void runOnce("scheduled").finally(scheduleNext);
    }, delay);
    timers.add(t);
    scheduleTimer = t;
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

  // A restore may have been applied before the operator turned scheduling off, so the
  // receipt is delivered regardless of whether backups are enabled.
  void deliverRestoreReceipt();

  const config = getBackupConfig();

  if (config.enabled) {
    const last = queries.getLastBackupRun(["success", "degraded"]);
    if (isCatchUpDue(last?.finished_at ?? null, new Date(), config.hourUtc, config.intervalDays)) {
      logger.info("Missed the last scheduled slot — catching up shortly");
      arm(CATCH_UP_DELAY_MS, () => void runOnce("scheduled"));
    }
    logger.info(`started (${describeSchedule(config)}, keep ${config.retention})`);
  } else {
    logger.info("started (backups disabled in settings)");
  }

  scheduleNext();
  rescheduleFn = scheduleNext;

  return {
    stop: () => {
      stopped = true;
      rescheduleFn = null;
      timers.forEach(clearTimeout);
      timers.clear();
    },
  };
}
