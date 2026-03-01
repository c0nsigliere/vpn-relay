import { InlineKeyboard } from "grammy";
import { BotContext } from "../context";

export const mainMenu = new InlineKeyboard()
  .text("➕ Add Client", "menu:add_client").text("👥 Client List", "menu:client_list").row()
  .text("📊 Server Status", "menu:server_status").text("⚙️ Settings", "menu:settings");

export async function showMainMenu(ctx: BotContext): Promise<void> {
  const text = "🛡 *VPN Control Panel*\n\nSelect an action:";
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: mainMenu,
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "Markdown",
      reply_markup: mainMenu,
    });
  }
}
