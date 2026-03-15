import { Bot } from "grammy";
import { BotContext } from "../bot/context";
import { sshPool } from "../services/ssh";
import { setPing } from "../services/ping.store";
import { env } from "../config/env";
import { execSync } from "child_process";
import { createLogger } from "../utils/logger";

const logger = createLogger("health");

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
          await bot.api.sendMessage(env.ADMIN_ID, "✅ Server A is back online.");
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
      logger.error("Worker error", err);
    }

    // ICMP ping A ↔ B — requires CAP_NET_RAW (set via AmbientCapabilities in systemd unit)
    try {
      const out = execSync(`ping -c 3 -W 2 ${env.SERVER_A_HOST}`, {
        encoding: "utf8",
        timeout: 10000,
      });
      const rttMatch = out.match(/rtt min\/avg\/max[^=]+=\s*[\d.]+\/([\d.]+)\//);
      const lossMatch = out.match(/(\d+)%\s*packet loss/);
      const ms = rttMatch ? parseFloat(rttMatch[1]) : 0;
      const lossPercent = lossMatch ? parseInt(lossMatch[1], 10) : 0;
      setPing({ ms, lossPercent });
    } catch {
      setPing({ ms: 0, lossPercent: 100 });
    }
  };

  // Run immediately on start so ping is available before first interval fires
  void run();
  const timer = setInterval(run, INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}
