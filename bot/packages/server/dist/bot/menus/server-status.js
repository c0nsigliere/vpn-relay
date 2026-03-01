"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showServerStatus = showServerStatus;
const grammy_1 = require("grammy");
const system_service_1 = require("../../services/system.service");
async function showServerStatus(ctx) {
    await ctx.answerCallbackQuery?.();
    await ctx.editMessageText("⏳ Fetching server status...", {
        reply_markup: new grammy_1.InlineKeyboard().text("« Back", "menu:main"),
    });
    try {
        const [statusA, statusB] = await Promise.allSettled([
            system_service_1.systemService.getStatusA(),
            system_service_1.systemService.getStatusB(),
        ]);
        const fmtA = statusA.status === "fulfilled"
            ? [
                `CPU: ${statusA.value.cpuPercent.toFixed(1)}%`,
                `RAM: ${statusA.value.ramUsedMb}/${statusA.value.ramTotalMb} MB`,
                `Uptime: ${statusA.value.uptime}`,
                statusA.value.updatesAvailable > 0
                    ? `⚠️ ${statusA.value.updatesAvailable} updates pending`
                    : "✅ Up to date",
                statusA.value.rebootRequired ? "🔄 Reboot required" : "",
            ]
                .filter(Boolean)
                .join("\n")
            : `❌ Unreachable: ${statusA.reason?.message ?? "unknown"}`;
        const fmtB = statusB.status === "fulfilled"
            ? [
                `CPU: ${statusB.value.cpuPercent.toFixed(1)}%`,
                `RAM: ${statusB.value.ramUsedMb}/${statusB.value.ramTotalMb} MB`,
                `Uptime: ${statusB.value.uptime}`,
                statusB.value.updatesAvailable > 0
                    ? `⚠️ ${statusB.value.updatesAvailable} updates pending`
                    : "✅ Up to date",
                statusB.value.rebootRequired ? "🔄 Reboot required" : "",
            ]
                .filter(Boolean)
                .join("\n")
            : `❌ Error: ${statusB.reason?.message ?? "unknown"}`;
        const text = [
            "📊 *Server Status*\n",
            `*Server A (Russia — entry)*\n${fmtA}`,
            "",
            `*Server B (exit — this host)*\n${fmtB}`,
        ].join("\n");
        await ctx.editMessageText(text, {
            parse_mode: "Markdown",
            reply_markup: new grammy_1.InlineKeyboard()
                .text("🔄 Refresh", "menu:server_status")
                .text("« Back", "menu:main"),
        });
    }
    catch (err) {
        await ctx.editMessageText(`❌ Error: ${err.message}`, {
            reply_markup: new grammy_1.InlineKeyboard().text("« Back", "menu:main"),
        });
    }
}
//# sourceMappingURL=server-status.js.map