import { Bot } from "grammy";
import { BotContext } from "../bot/context";
import { queries } from "../db/queries";
import { suspendClient } from "../services/client.service";
import { env } from "../config/env";
import { createLogger, logOnError } from "../utils/logger";

const logger = createLogger("ttl");

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
          logger.error(`Failed to suspend ${client.name}`, err);
        }
      }
    } catch (err) {
      logger.error("Worker error", err);
    }
  };

  const timer = setInterval(run, INTERVAL_MS);
  run().catch(logOnError(logger, "initial run"));

  return { stop: () => clearInterval(timer) };
}
