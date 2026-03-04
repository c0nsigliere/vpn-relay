import { Bot } from "grammy";
import { BotContext } from "../bot/context";
import { queries } from "../db/queries";
import { suspendClient, resumeClient } from "../services/client.service";
import { env } from "../config/env";

const INTERVAL_MS = 60 * 1000; // 1 minute
const GB = 1_073_741_824; // bytes per GiB

function currentDayKey(): string {
  // YYYY-MM-DD in local timezone using TZ_OFFSET
  const mod = env.TZ_OFFSET ?? "+0:00";
  const match = mod.match(/^([+-]\d+):/);
  const offsetHours = match ? parseInt(match[1], 10) : 0;
  const now = new Date(Date.now() + offsetHours * 3_600_000);
  return now.toISOString().slice(0, 10);
}

function currentMonthKey(): string {
  return currentDayKey().slice(0, 7); // YYYY-MM
}

export function quotaWorker(bot: Bot<BotContext>): { stop: () => void } {
  let lastDay = currentDayKey();
  let lastMonth = currentMonthKey();

  const notify = (msg: string) =>
    bot.api.sendMessage(env.ADMIN_ID, msg, { parse_mode: "Markdown" }).catch(() => {});

  const run = async () => {
    try {
      const nowDay = currentDayKey();
      const nowMonth = currentMonthKey();

      // ── Phase 1: Daily reset ─────────────────────────────────────────────
      if (nowDay !== lastDay) {
        lastDay = nowDay;
        const dailySuspended = queries.getQuotaSuspendedClients("daily_quota");
        for (const client of dailySuspended) {
          try {
            if (client.monthly_quota_gb !== null) {
              const monthlyUsed = queries.getClientMonthlyUsageBytes(client.id);
              if (monthlyUsed >= client.monthly_quota_gb * GB) {
                // Upgrade to monthly suspension
                queries.setClientActive(client.id, false, "monthly_quota");
                await notify(`📅 *${client.name}*: daily quota reset but monthly quota still exceeded — kept suspended.`);
                continue;
              }
            }
            await resumeClient(client);
            await notify(`✅ *${client.name}*: daily quota reset — client resumed.`);
          } catch (err) {
            console.error(`[quota worker] daily reset failed for ${client.name}:`, err);
          }
        }
      }

      // ── Phase 2: Monthly reset ───────────────────────────────────────────
      if (nowMonth !== lastMonth) {
        lastMonth = nowMonth;
        const monthlySuspended = queries.getQuotaSuspendedClients("monthly_quota");
        for (const client of monthlySuspended) {
          try {
            await resumeClient(client);
            await notify(`✅ *${client.name}*: monthly quota reset — client resumed.`);
          } catch (err) {
            console.error(`[quota worker] monthly reset failed for ${client.name}:`, err);
          }
        }
      }

      // ── Phase 3: Quota enforcement ───────────────────────────────────────
      const activeWithQuotas = queries.getClientsWithQuotas();
      for (const client of activeWithQuotas) {
        try {
          const dailyUsed = client.daily_quota_gb !== null
            ? queries.getClientDailyUsageBytes(client.id)
            : 0;
          const monthlyUsed = client.monthly_quota_gb !== null
            ? queries.getClientMonthlyUsageBytes(client.id)
            : 0;

          // Monthly takes priority
          if (client.monthly_quota_gb !== null && monthlyUsed >= client.monthly_quota_gb * GB) {
            await suspendClient(client, "monthly_quota");
            const usedGb = (monthlyUsed / GB).toFixed(2);
            const limitGb = client.monthly_quota_gb.toFixed(2);
            await notify(`🚫 *${client.name}* suspended: monthly quota exceeded (${usedGb} / ${limitGb} GB)`);
            continue;
          }

          if (client.daily_quota_gb !== null && dailyUsed >= client.daily_quota_gb * GB) {
            await suspendClient(client, "daily_quota");
            const usedGb = (dailyUsed / GB).toFixed(2);
            const limitGb = client.daily_quota_gb.toFixed(2);
            await notify(`🚫 *${client.name}* suspended: daily quota exceeded (${usedGb} / ${limitGb} GB)`);
          }
        } catch (err) {
          console.error(`[quota worker] enforcement failed for ${client.name}:`, err);
        }
      }
    } catch (err) {
      console.error("[quota worker] error:", err);
    }
  };

  const timer = setInterval(run, INTERVAL_MS);
  run().catch(() => {});

  return { stop: () => clearInterval(timer) };
}
