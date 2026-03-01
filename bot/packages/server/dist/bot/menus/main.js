"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mainMenu = void 0;
exports.showMainMenu = showMainMenu;
const grammy_1 = require("grammy");
exports.mainMenu = new grammy_1.InlineKeyboard()
    .text("➕ Add Client", "menu:add_client").text("👥 Client List", "menu:client_list").row()
    .text("📊 Server Status", "menu:server_status").text("⚙️ Settings", "menu:settings");
async function showMainMenu(ctx) {
    const text = "🛡 *VPN Control Panel*\n\nSelect an action:";
    if (ctx.callbackQuery) {
        await ctx.editMessageText(text, {
            parse_mode: "Markdown",
            reply_markup: exports.mainMenu,
        });
    }
    else {
        await ctx.reply(text, {
            parse_mode: "Markdown",
            reply_markup: exports.mainMenu,
        });
    }
}
//# sourceMappingURL=main.js.map