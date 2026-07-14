import { InlineKeyboard } from "grammy";
import { BotContext } from "../context";
import { isStandalone, wgHy2Available } from "../../config/standalone";

function buildAddClientMenu(): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!isStandalone) {
    kb.text("🔐 WireGuard", "add:wg");
  }
  kb.text("⚡ XRay", "add:xray");
  kb.text("🚀 Hysteria 2", "add:hysteria2");
  kb.row().text("« Back", "menu:main");
  return kb;
}

export const addClientMenu = buildAddClientMenu();

// Submenu shown after choosing WireGuard when the Hy2 uplink is available: pick
// which A→B tunnel the cascade takes.
const wgTransportMenu = new InlineKeyboard()
  .text("⚡ via XRay uplink", "addwg:xray")
  .text("🚀 via Hy2 uplink", "addwg:hy2")
  .row()
  .text("« Cancel", "menu:main");

function promptName(ctx: BotContext, label: string) {
  ctx.session.step = "awaiting_client_name";
  return ctx.editMessageText(
    `➕ *Add ${label} Client*\n\nEnter client name (letters, digits, underscores only):`,
    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("« Cancel", "menu:main") }
  );
}

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

  // WG cascade transport choice (only reachable when wgHy2Available)
  if (data.startsWith("addwg:")) {
    const transport = data.replace("addwg:", "") as "xray" | "hy2";
    ctx.session.data.clientType = "wg";
    ctx.session.data.wgCascadeTransport = transport;
    await promptName(ctx, `WireGuard (via ${transport === "hy2" ? "Hy2" : "XRay"})`);
    return;
  }

  if (data.startsWith("add:")) {
    const type = data.replace("add:", "") as "wg" | "xray" | "hysteria2";
    ctx.session.data.wgCascadeTransport = "xray";

    // WireGuard with an available Hy2 uplink → ask which transport first.
    if (type === "wg" && wgHy2Available) {
      ctx.session.data.clientType = "wg";
      await ctx.editMessageText(
        "🔐 *WireGuard Cascade Transport*\n\nHow should Server A tunnel this client to Server B?",
        { parse_mode: "Markdown", reply_markup: wgTransportMenu }
      );
      return;
    }

    ctx.session.data.clientType = type;
    const typeLabel = type === "hysteria2" ? "Hysteria 2" : type.toUpperCase();
    await promptName(ctx, typeLabel);
  }
}

export async function showAddClientMenu(ctx: BotContext): Promise<void> {
  await ctx.editMessageText(
    "➕ *Add New Client*\n\nSelect client type:",
    { parse_mode: "Markdown", reply_markup: addClientMenu }
  );
}
