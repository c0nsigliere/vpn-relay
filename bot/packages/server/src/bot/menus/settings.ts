import { InlineKeyboard } from "grammy";
import * as fs from "fs";
import { BotContext } from "../context";
import { env } from "../../config/env";
import { queries } from "../../db/queries";
import { backupService, BackupBusyError } from "../../services/backup.service";
import { describeSchedule, getBackupConfig, setBackupConfig } from "../../services/backup.schedule";
import { rescheduleBackups } from "../../workers/backup.worker";
import { BACKUP_INTERVAL_PRESETS } from "@vpn-relay/shared";
import { formatBytes } from "../../utils/format";
import { createLogger } from "../../utils/logger";
import { escapeMarkdown } from "../../utils/telegram";

const logger = createLogger("settings");

/** "2026-07-20 03:00 UTC ✅ (1.9 MB, sent to chat)" */
function lastBackupLine(): string {
  const last = queries.getLastBackupRun(["success", "degraded", "failed"]);
  if (!last || !last.finished_at) return "\n🗄 Last backup: never";

  const icon = last.status === "success" ? "✅" : last.status === "degraded" ? "⚠️" : "❌";
  const where = last.status === "success" ? ", sent to chat" : ", local only";
  const detail = last.bundle_bytes ? ` (${formatBytes(last.bundle_bytes)}${where})` : "";
  return `\n🗄 Last backup: ${last.finished_at} UTC ${icon}${detail}`;
}

export async function showSettings(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery?.();

  let dbInfo = "";
  try {
    const stat = fs.statSync(env.DB_PATH);
    dbInfo = `\n\n💾 Database: ${formatBytes(stat.size)}`;
  } catch {}

  const config = getBackupConfig();
  const schedule = config.enabled
    ? `\n🗓 Schedule: ${describeSchedule(config)}`
    : "\n🗓 Schedule: disabled";

  await ctx.editMessageText(
    `⚙️ *Settings*${dbInfo}${schedule}${lastBackupLine()}\n\n` +
      `_To restore, send a backup file (vpn-backup-\\*.enc) to this chat._`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("💾 Backup Now", "settings:backup_now").row()
        .text("🗓 Schedule", "settings:schedule").row()
        .text("« Back", "menu:main"),
    }
  );
}

/** Schedule submenu: presets plus the hour, mirroring the TMA card. */
export async function showBackupSchedule(ctx: BotContext): Promise<void> {
  const config = getBackupConfig();
  const kb = new InlineKeyboard();

  for (const preset of BACKUP_INTERVAL_PRESETS) {
    const active = config.intervalDays === preset.days ? "✅ " : "";
    kb.text(`${active}${preset.label}`, `settings:sched_days:${preset.days}`).row();
  }
  // Any non-preset interval is reachable from the TMA; surface it here so the bot
  // never silently misrepresents a custom schedule as one of the presets.
  const isCustom = !BACKUP_INTERVAL_PRESETS.some((p) => p.days === config.intervalDays);
  if (isCustom) kb.text(`✅ Every ${config.intervalDays} days (custom)`, "noop").row();

  kb.text("−1 h", `settings:sched_hour:${(config.hourUtc + 23) % 24}`)
    .text(`${String(config.hourUtc).padStart(2, "0")}:00 UTC`, "noop")
    .text("+1 h", `settings:sched_hour:${(config.hourUtc + 1) % 24}`)
    .row();
  kb.text(config.enabled ? "⏸ Disable backups" : "▶️ Enable backups", "settings:sched_toggle").row();
  kb.text("« Back", "menu:settings");

  const body = config.enabled
    ? `🗓 *Backup schedule*\n\n${describeSchedule(config)}\nNext run: ${config.nextRun.slice(0, 16).replace("T", " ")} UTC`
    : "🗓 *Backup schedule*\n\n⚠️ Backups are disabled.";

  await ctx.editMessageText(body, { parse_mode: "Markdown", reply_markup: kb });
}

export async function handleSettingsCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  await ctx.answerCallbackQuery();

  if (data === "settings:schedule") {
    await showBackupSchedule(ctx);
    return;
  }

  // Every schedule edit re-arms the worker: on a weekly cadence the pending timer
  // could be six days out, so without this the change would look like a no-op.
  if (data.startsWith("settings:sched_days:")) {
    setBackupConfig({ intervalDays: parseInt(data.split(":")[2], 10) });
    rescheduleBackups();
    await showBackupSchedule(ctx);
    return;
  }

  if (data.startsWith("settings:sched_hour:")) {
    setBackupConfig({ hourUtc: parseInt(data.split(":")[2], 10) });
    rescheduleBackups();
    await showBackupSchedule(ctx);
    return;
  }

  if (data === "settings:sched_toggle") {
    setBackupConfig({ enabled: !getBackupConfig().enabled });
    rescheduleBackups();
    await showBackupSchedule(ctx);
    return;
  }

  // Note: the raw "Download DB Backup" button that used to live here is gone. It sent
  // an unencrypted SQLite file — with every client credential in it — into the same
  // chat this feature now fills with encrypted bundles. Keeping a plaintext twin next
  // to the encrypted pipeline would defeat the point. The plain-download use case
  // lives on in the TMA, over TLS, deliberately.
  if (data === "settings:backup_now") {
    if (backupService.isRunning()) {
      await ctx.reply("⏳ A backup is already in progress.");
      return;
    }

    const status = await ctx.reply("⏳ Building encrypted backup…");
    try {
      const result = await backupService.runBackup("manual", ctx.api, status.chat.id);

      if (result.status === "failed") {
        await ctx.api.editMessageText(
          status.chat.id,
          status.message_id,
          `❌ Backup failed: ${escapeMarkdown(result.error ?? "unknown error")}`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      const note =
        result.status === "degraded"
          ? `⚠️ Saved locally but not delivered: ${escapeMarkdown(result.error ?? "")}`
          : "✅ Backup sent above.";
      await ctx.api.editMessageText(status.chat.id, status.message_id, note, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      const message = err instanceof BackupBusyError ? err.message : (err as Error).message;
      logger.error(`Manual backup failed: ${message}`);
      await ctx.api.editMessageText(
        status.chat.id,
        status.message_id,
        `❌ ${escapeMarkdown(message)}`,
        { parse_mode: "Markdown" }
      );
    }
  }
}
