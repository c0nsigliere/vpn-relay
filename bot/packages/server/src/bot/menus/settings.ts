import { InlineKeyboard } from "grammy";
import * as fs from "fs";
import { BotContext } from "../context";
import { env } from "../../config/env";
import { queries } from "../../db/queries";
import { backupService, BackupBusyError } from "../../services/backup.service";
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

  await ctx.editMessageText(
    `⚙️ *Settings*${dbInfo}${lastBackupLine()}\n\n` +
      `_To restore, send a backup file (vpn-backup-\\*.enc) to this chat._`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("💾 Backup Now", "settings:backup_now").row()
        .text("« Back", "menu:main"),
    }
  );
}

export async function handleSettingsCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  await ctx.answerCallbackQuery();

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
