import { Bot } from "grammy";
import { BotContext } from "../bot/context";
import { queries } from "../db/queries";
import { suspendClient } from "../services/client.service";
import { env } from "../config/env";

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function ttlWorker(bot: Bot<BotContext>): { stop: () => void } {
  const run = async () => {
    try {
      const expired = queries.getExpiredClients();
      for (const client of expired) {
        try {
          await suspendClient(client, "expired");

          await bot.api.sendMessage(
            env.ADMIN_ID,
            `Client *${client.name}* expired and has been suspended.`,
            { parse_mode: "Markdown" }
          );
        } catch (err) {
          console.error(`[ttl worker] failed to suspend ${client.name}:`, err);
        }
      }
    } catch (err) {
      console.error("[ttl worker] error:", err);
    }
  };

  const timer = setInterval(run, INTERVAL_MS);
  run().catch(() => {});

  return { stop: () => clearInterval(timer) };
}
