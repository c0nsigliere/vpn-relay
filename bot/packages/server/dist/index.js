"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const grammy_1 = require("grammy");
const env_1 = require("./config/env");
const index_1 = require("./db/index");
const context_1 = require("./bot/context");
const auth_1 = require("./bot/middlewares/auth");
const main_1 = require("./bot/menus/main");
const add_client_1 = require("./bot/menus/add-client");
const client_list_1 = require("./bot/menus/client-list");
const client_card_1 = require("./bot/menus/client-card");
const server_status_1 = require("./bot/menus/server-status");
const settings_1 = require("./bot/menus/settings");
const text_input_1 = require("./bot/handlers/text-input");
const traffic_worker_1 = require("./workers/traffic.worker");
const ttl_worker_1 = require("./workers/ttl.worker");
const health_worker_1 = require("./workers/health.worker");
const updates_worker_1 = require("./workers/updates.worker");
const ssh_1 = require("./services/ssh");
const xray_service_1 = require("./services/xray.service");
const server_1 = require("./api/server");
const bot = new grammy_1.Bot(env_1.env.BOT_TOKEN);
// Session
bot.use((0, grammy_1.session)({ initial: context_1.initialSession }));
// Auth — all subsequent handlers only run for ADMIN_ID
bot.use(auth_1.authMiddleware);
// /start command
bot.command("start", async (ctx) => {
    ctx.session.step = "idle";
    ctx.session.data = {};
    await (0, main_1.showMainMenu)(ctx);
});
// Callback query router
bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data === "noop") {
        await ctx.answerCallbackQuery();
        return;
    }
    if (data === "menu:main") {
        await ctx.answerCallbackQuery();
        await (0, main_1.showMainMenu)(ctx);
        return;
    }
    if (data === "menu:add_client" || data.startsWith("add:")) {
        await (0, add_client_1.handleAddClientCallback)(ctx);
        return;
    }
    if (data === "menu:client_list") {
        await ctx.answerCallbackQuery();
        const page = ctx.session.data.page ?? 0;
        await (0, client_list_1.showClientList)(ctx, page);
        return;
    }
    if (data.startsWith("list:")) {
        await ctx.answerCallbackQuery();
        const page = parseInt(data.replace("list:", ""), 10);
        await (0, client_list_1.showClientList)(ctx, page);
        return;
    }
    if (data.startsWith("client:")) {
        await ctx.answerCallbackQuery();
        const clientId = data.replace("client:", "");
        await (0, client_card_1.showClientCard)(ctx, clientId);
        return;
    }
    if (data.startsWith("card:")) {
        await (0, client_card_1.handleClientCardCallback)(ctx);
        return;
    }
    if (data === "menu:server_status") {
        await (0, server_status_1.showServerStatus)(ctx);
        return;
    }
    if (data === "menu:settings") {
        await (0, settings_1.showSettings)(ctx);
        return;
    }
    if (data.startsWith("settings:")) {
        await (0, settings_1.handleSettingsCallback)(ctx);
        return;
    }
    await ctx.answerCallbackQuery("Unknown action");
});
// Text input (session-driven)
bot.on("message:text", text_input_1.textInputHandler);
// Error handler — prevent unhandled Telegram API errors from crashing the bot
bot.catch((err) => {
    console.error("[bot error]", err.message);
});
// Workers
const workers = [
    (0, traffic_worker_1.trafficWorker)(bot),
    (0, ttl_worker_1.ttlWorker)(bot),
    (0, health_worker_1.healthWorker)(bot),
    (0, updates_worker_1.updatesWorker)(bot),
];
// Register BotFather menu button if TMA_DOMAIN is configured
if (env_1.env.TMA_DOMAIN) {
    bot.api
        .setChatMenuButton({
        menu_button: {
            type: "web_app",
            text: "VPN Manager",
            web_app: { url: `https://${env_1.env.TMA_DOMAIN}` },
        },
    })
        .catch((err) => console.warn("[tma] Could not set menu button:", err.message));
}
let apiServer = null;
// Graceful shutdown
async function shutdown(signal) {
    console.log(`Received ${signal}, shutting down...`);
    await bot.stop();
    if (apiServer)
        await apiServer.close();
    workers.forEach((w) => w.stop());
    ssh_1.sshPool.close();
    xray_service_1.xrayService.close();
    index_1.db.close();
    process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// Start Fastify API (only if TMA_DOMAIN or TMA_PORT explicitly configured)
(0, server_1.startApiServer)(bot)
    .then((server) => { apiServer = server; })
    .catch((err) => console.warn("[api] Fastify failed to start:", err.message));
bot.start({
    onStart: (info) => console.log(`Bot @${info.username} started`),
}).catch((err) => {
    console.error("Bot crashed:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map