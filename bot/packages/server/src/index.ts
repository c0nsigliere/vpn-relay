import { Bot, session } from "grammy";
import { env } from "./config/env";
import { db } from "./db/index";
import { BotContext, initialSession } from "./bot/context";
import { authMiddleware } from "./bot/middlewares/auth";
import { showMainMenu } from "./bot/menus/main";
import { handleAddClientCallback } from "./bot/menus/add-client";
import { showClientList } from "./bot/menus/client-list";
import { showClientCard, handleClientCardCallback } from "./bot/menus/client-card";
import { showServerStatus } from "./bot/menus/server-status";
import { showSettings, handleSettingsCallback } from "./bot/menus/settings";
import { textInputHandler } from "./bot/handlers/text-input";
import { trafficWorker } from "./workers/traffic.worker";
import { ttlWorker } from "./workers/ttl.worker";
import { healthWorker } from "./workers/health.worker";
import { updatesWorker } from "./workers/updates.worker";
import { rollupWorker } from "./workers/rollup.worker";
import { sshPool } from "./services/ssh";
import { xrayService } from "./services/xray.service";
import { startApiServer } from "./api/server";
import type { FastifyInstance } from "fastify";

const bot = new Bot<BotContext>(env.BOT_TOKEN);

// Session
bot.use(session({ initial: initialSession }));

// Auth — all subsequent handlers only run for ADMIN_ID
bot.use(authMiddleware);

// /start command
bot.command("start", async (ctx) => {
  ctx.session.step = "idle";
  ctx.session.data = {};
  await showMainMenu(ctx);
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
    await showMainMenu(ctx);
    return;
  }

  if (data === "menu:add_client" || data.startsWith("add:")) {
    await handleAddClientCallback(ctx);
    return;
  }

  if (data === "menu:client_list") {
    await ctx.answerCallbackQuery();
    const page = ctx.session.data.page ?? 0;
    await showClientList(ctx, page);
    return;
  }

  if (data.startsWith("list:")) {
    await ctx.answerCallbackQuery();
    const page = parseInt(data.replace("list:", ""), 10);
    await showClientList(ctx, page);
    return;
  }

  if (data.startsWith("client:")) {
    await ctx.answerCallbackQuery();
    const clientId = data.replace("client:", "");
    await showClientCard(ctx, clientId);
    return;
  }

  if (data.startsWith("card:")) {
    await handleClientCardCallback(ctx);
    return;
  }

  if (data === "menu:server_status") {
    await showServerStatus(ctx);
    return;
  }

  if (data === "menu:settings") {
    await showSettings(ctx);
    return;
  }

  if (data.startsWith("settings:")) {
    await handleSettingsCallback(ctx);
    return;
  }

  await ctx.answerCallbackQuery("Unknown action");
});

// Text input (session-driven)
bot.on("message:text", textInputHandler);

// Error handler — prevent unhandled Telegram API errors from crashing the bot
bot.catch((err) => {
  console.error("[bot error]", err.message);
});

// Workers
const workers = [
  trafficWorker(bot),
  ttlWorker(bot),
  healthWorker(bot),
  updatesWorker(bot),
  rollupWorker(),
];

// Register BotFather menu button if TMA_URL is configured
if (env.TMA_URL) {
  bot.api
    .setChatMenuButton({
      menu_button: {
        type: "web_app",
        text: "VPN Manager",
        web_app: { url: env.TMA_URL },
      },
    })
    .catch((err) => console.warn("[tma] Could not set menu button:", err.message));
}

let apiServer: FastifyInstance | null = null;

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);
  await bot.stop();
  if (apiServer) await apiServer.close();
  workers.forEach((w) => w.stop());
  sshPool.close();
  xrayService.close();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Start Fastify API (only if TMA_DOMAIN or TMA_PORT explicitly configured)
startApiServer(bot)
  .then((server) => { apiServer = server; })
  .catch((err) => console.warn("[api] Fastify failed to start:", err.message));

bot.start({
  onStart: (info) => console.log(`Bot @${info.username} started`),
}).catch((err) => {
  console.error("Bot crashed:", err);
  process.exit(1);
});
