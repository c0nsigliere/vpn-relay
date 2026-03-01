"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showClientList = showClientList;
const grammy_1 = require("grammy");
const queries_1 = require("../../db/queries");
const PAGE_SIZE = 5;
function typeIcon(type) {
    if (type === "wg")
        return "🔐";
    if (type === "xray")
        return "⚡";
    return "🔗";
}
async function showClientList(ctx, page = 0) {
    await ctx.answerCallbackQuery?.();
    ctx.session.data.page = page;
    const { clients, total } = queries_1.queries.getPagedClients(page, PAGE_SIZE);
    const totalPages = Math.ceil(total / PAGE_SIZE);
    if (total === 0) {
        await ctx.editMessageText("👥 *Client List*\n\nNo clients yet. Use ➕ Add Client to create one.", {
            parse_mode: "Markdown",
            reply_markup: new grammy_1.InlineKeyboard().text("« Back", "menu:main"),
        });
        return;
    }
    const kb = new grammy_1.InlineKeyboard();
    for (const client of clients) {
        const status = client.is_active ? "🟢" : "🔴";
        kb.text(`${status} ${typeIcon(client.type)} ${client.name}`, `client:${client.id}`).row();
    }
    // Pagination row
    if (totalPages > 1) {
        if (page > 0)
            kb.text("«", `list:${page - 1}`);
        kb.text(`${page + 1}/${totalPages}`, "noop");
        if (page < totalPages - 1)
            kb.text("»", `list:${page + 1}`);
        kb.row();
    }
    kb.text("« Back", "menu:main");
    await ctx.editMessageText(`👥 *Client List* (${total} total)`, { parse_mode: "Markdown", reply_markup: kb });
}
//# sourceMappingURL=client-list.js.map