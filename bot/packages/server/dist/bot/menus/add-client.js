"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addClientMenu = void 0;
exports.handleAddClientCallback = handleAddClientCallback;
exports.showAddClientMenu = showAddClientMenu;
const grammy_1 = require("grammy");
exports.addClientMenu = new grammy_1.InlineKeyboard()
    .text("🔐 WireGuard", "add:wg").text("⚡ XRay", "add:xray").text("🔗 Both", "add:both").row()
    .text("« Back", "menu:main");
async function handleAddClientCallback(ctx) {
    const data = ctx.callbackQuery?.data;
    if (!data)
        return;
    await ctx.answerCallbackQuery();
    if (data === "menu:add_client") {
        await ctx.editMessageText("➕ *Add New Client*\n\nSelect client type:", { parse_mode: "Markdown", reply_markup: exports.addClientMenu });
        return;
    }
    if (data.startsWith("add:")) {
        const type = data.replace("add:", "");
        ctx.session.step = "awaiting_client_name";
        ctx.session.data.clientType = type;
        await ctx.editMessageText(`➕ *Add ${type.toUpperCase()} Client*\n\nEnter client name (letters, digits, underscores only):`, { parse_mode: "Markdown", reply_markup: new grammy_1.InlineKeyboard().text("« Cancel", "menu:main") });
    }
}
async function showAddClientMenu(ctx) {
    await ctx.editMessageText("➕ *Add New Client*\n\nSelect client type:", { parse_mode: "Markdown", reply_markup: exports.addClientMenu });
}
//# sourceMappingURL=add-client.js.map