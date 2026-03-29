import { InlineKeyboard } from "grammy";
import { BotContext } from "../context";
import { isStandalone } from "../../config/standalone";

function buildAddClientMenu(): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!isStandalone) {
    kb.text("🔐 WireGuard", "add:wg");
  }
  kb.text("⚡ XRay", "add:xray");
  if (!isStandalone) {
    kb.text("🔗 Both", "add:both");
  }
  kb.row().text("« Back", "menu:main");
  return kb;
}

export const addClientMenu = buildAddClientMenu();

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
