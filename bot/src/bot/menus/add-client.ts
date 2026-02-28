import { InlineKeyboard } from "grammy";
import { BotContext } from "../context";
import { showMainMenu } from "./main";

export const addClientMenu = new InlineKeyboard()
  .text("🔐 WireGuard", "add:wg").text("⚡ XRay", "add:xray").text("🔗 Both", "add:both").row()
  .text("« Back", "menu:main");

export async function handleAddClientCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  await ctx.answerCallbackQuery();

  if (data === "menu:add_client") {
    await ctx.editMessageText(
      "➕ *Add New Client*\n\nSelect client type:",
      { parse_mode: "Markdown", reply_markup: addClientMenu }
    );
    return;
  }

  if (data.startsWith("add:")) {
    const type = data.replace("add:", "") as "wg" | "xray" | "both";
    ctx.session.step = "awaiting_client_name";
    ctx.session.data.clientType = type;
    await ctx.editMessageText(
      `➕ *Add ${type.toUpperCase()} Client*\n\nEnter client name (letters, digits, underscores only):`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("« Cancel", "menu:main") }
    );
  }
}

export async function showAddClientMenu(ctx: BotContext): Promise<void> {
  await ctx.editMessageText(
    "➕ *Add New Client*\n\nSelect client type:",
    { parse_mode: "Markdown", reply_markup: addClientMenu }
  );
}
