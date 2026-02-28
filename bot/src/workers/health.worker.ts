import { Bot } from "grammy";
import { BotContext } from "../bot/context";
import { sshPool } from "../services/ssh";
import { env } from "../config/env";

const INTERVAL_MS = 60 * 1000; // 1 minute
const FAILURE_THRESHOLD = 3;

export function healthWorker(bot: Bot<BotContext>): { stop: () => void } {
  let consecutiveFailures = 0;
  let alertSent = false;

  const run = async () => {
    try {
      const ok = await sshPool.ping();
      if (ok) {
        if (alertSent && consecutiveFailures >= FAILURE_THRESHOLD) {
          // Recovery notification
          await bot.api.sendMessage(
            env.ADMIN_ID,
            "✅ Server A is back online."
          );
        }
        consecutiveFailures = 0;
        alertSent = false;
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_THRESHOLD && !alertSent) {
          alertSent = true;
          await bot.api.sendMessage(
            env.ADMIN_ID,
            `🚨 *Server A unreachable!*\n${consecutiveFailures} consecutive SSH failures. VPN tunnel may be down.`,
            { parse_mode: "Markdown" }
          );
        }
      }
    } catch (err) {
      console.error("[health worker] error:", err);
    }
  };

  const timer = setInterval(run, INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}
