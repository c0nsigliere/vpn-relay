import { Bot } from "grammy";
import { BotContext } from "../bot/context";
import { queries } from "../db/queries";
import { suspendClient } from "../services/client.service";
import { env } from "../config/env";
import { createLogger, logOnError } from "../utils/logger";
import { escapeMarkdown, sendMarkdown } from "../utils/telegram";

const logger = createLogger("ttl");

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function ttlWorker(bot: Bot<BotContext>): { stop: () => void } {
  const run = async () => {
    try {
      const expired = queries.getExpiredClients();
      for (const client of expired) {
        try {
          await suspendClient(client, "expired");

          await sendMarkdown(
            bot.api,
            env.ADMIN_ID,
            `Client *${escapeMarkdown(client.name)}* expired and has been suspended.`,
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

  logger.info("started (every 1h)");
  return { stop: () => clearInterval(timer) };
}
