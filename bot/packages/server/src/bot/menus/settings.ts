import { InlineKeyboard, InputFile } from "grammy";
import * as fs from "fs";
import { BotContext } from "../context";
import { env } from "../../config/env";
import { formatBytes } from "../../utils/format";

export async function showSettings(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery?.();

  let dbInfo = "";
  try {
    const stat = fs.statSync(env.DB_PATH);
    dbInfo = `\n\n💾 Database: ${formatBytes(stat.size)}`;
  } catch {}

  await ctx.editMessageText(
    `⚙️ *Settings*${dbInfo}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("💾 Download DB Backup", "settings:backup").row()
        .text("« Back", "menu:main"),
    }
  );
}

export async function handleSettingsCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  await ctx.answerCallbackQuery();

  if (data === "settings:backup") {
    if (!fs.existsSync(env.DB_PATH)) {
      await ctx.reply("❌ Database file not found.");
      return;
    }
    await ctx.replyWithDocument(new InputFile(env.DB_PATH, "vpn-bot-backup.db"), {
      caption: `💾 DB Backup — ${new Date().toISOString().slice(0, 10)}`,
    });
  }
}
