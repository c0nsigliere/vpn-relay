/**
 * Alert worker — evaluates all alert conditions every 30s and sends
 * Telegram notifications to the admin on fire and recovery.
 *
 * Design principles:
 * - Single centralized worker; existing workers (health, traffic, quota) only
 *   collect data. This worker evaluates.
 * - All settings (thresholds, cooldowns, enable/disable) live in alert_settings
 *   table, editable through TMA Settings page without redeployment.
 * - alert_state table persists fire/clear timestamps across bot restarts so
 *   cooldown logic survives process crashes.
 * - Composite state keys ("disk_full:a", "quota_warning:{id}") let per-server
 *   and per-client alerts have independent cooldowns.
 * - metricsCache prevents double-consuming the throughput delta and avoids
 *   repeated 500ms CPU sampling.
 */

import { Bot } from "grammy";
import * as os from "os";
import * as fs from "fs";
import { execSync } from "child_process";
import type { BotContext } from "../bot/context";
import { getPing } from "../services/ping.store";
import { sshPool } from "../services/ssh";
import { queries } from "../db/queries";
import { suspendClient } from "../services/client.service";
import { metricsCache } from "../services/metrics.cache";
import { env } from "../config/env";
import { isStandalone } from "../config/standalone";
import type { ServerStatus } from "../services/system.service";
import { createLogger } from "../utils/logger";
import { escapeMarkdown, sendMarkdown } from "../utils/telegram";

const logger = createLogger("alert");

const INTERVAL_MS = 30_000;
const STARTUP_DELAY_MS = 90_000; // let other workers populate data first
const GB = 1_073_741_824;

// Per-condition sustained-duration tracking.
// Maps composite key → timestamp (ms) when condition first became continuously true.
const sustainStart = new Map<string, number>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function isEnabled(alertKey: string): boolean {
  const s = queries.getAlertSetting(alertKey);
  return s ? s.enabled === 1 : true;
}

function getThreshold(alertKey: string, field: "threshold" | "threshold2", def: number): number {
  const s = queries.getAlertSetting(alertKey);
  const v = s?.[field];
  return v !== null && v !== undefined ? v : def;
}

function getCooldown(alertKey: string, def: number): number {
  const s = queries.getAlertSetting(alertKey);
  return s?.cooldown_min ?? def;
}

/**
 * Returns true if the alert should fire (either never fired, or cooldown expired).
 * Uses the base alertKey (without per-target suffix) for cooldown settings.
 */
function shouldFire(stateKey: string): boolean {
  const state = queries.getAlertState(stateKey);
  if (!state || state.status === "clear") return true;
  // Cooldown lookup uses the base key (before first ":")
  const baseKey = stateKey.split(":")[0];
  const cooldownMin = getCooldown(baseKey, 30);
  if (!state.fired_at) return true;
  // SQLite datetime('now') returns UTC without suffix; append "Z" so JS parses as UTC
  const firedAt = new Date(state.fired_at + "Z").getTime();
  return (Date.now() - firedAt) >= cooldownMin * 60_000;
}

async function fireAlert(stateKey: string, msg: string, bot: Bot<BotContext>, context?: string): Promise<void> {
  logger.warn(`Alert fired: ${stateKey}`);
  queries.upsertAlertState(stateKey, "fired", context);
  try {
    await sendMarkdown(bot.api, env.ADMIN_ID, msg);
  } catch (err) {
    logger.error(`Send failed for ${stateKey}`, err);
  }
}

async function clearAlert(stateKey: string, msg: string, bot: Bot<BotContext>): Promise<void> {
  logger.info(`Alert cleared: ${stateKey}`);
  queries.upsertAlertState(stateKey, "clear");
  try {
    await sendMarkdown(bot.api, env.ADMIN_ID, msg);
  } catch (err) {
    logger.error(`Recovery send failed for ${stateKey}`, err);
  }
}

/**
 * Sustained-condition evaluator.
 * Returns true only after the condition has been continuously true for durationMs.
 * Resets the timer when the condition becomes false.
 */
function evalSustained(sustainKey: string, conditionTrue: boolean, durationMs: number): boolean {
  if (conditionTrue) {
    if (!sustainStart.has(sustainKey)) sustainStart.set(sustainKey, Date.now());
    return (Date.now() - sustainStart.get(sustainKey)!) >= durationMs;
  } else {
    sustainStart.delete(sustainKey);
    return false;
  }
}

/**
 * Fetch metrics from both servers via metricsCache, then build a per-server
 * check list. In standalone mode Server A is skipped entirely (no fetch, no check entry).
 */
async function fetchBothServersAndBuildChecks<T>(
  extract: (status: ServerStatus) => T
): Promise<Array<{ key: string; label: string; data: T | undefined }>> {
  const [resultA, resultB] = await Promise.allSettled([
    isStandalone ? Promise.reject("standalone") : metricsCache.getStatusA(),
    metricsCache.getStatusB(),
  ]);
  const checks: Array<{ key: string; label: string; data: T | undefined }> = [];
  if (!isStandalone) {
    checks.push({
      key: "a",
      label: "Server A",
      data: resultA.status === "fulfilled" ? extract(resultA.value) : undefined,
    });
  }
  checks.push({
    key: "b",
    label: "Server B",
    data: resultB.status === "fulfilled" ? extract(resultB.value) : undefined,
  });
  return checks;
}

// ── Check functions ───────────────────────────────────────────────────────────

async function checkCascadeDown(bot: Bot<BotContext>): Promise<void> {
  if (isStandalone || !isEnabled("cascade_down")) return;
  const threshold = getThreshold("cascade_down", "threshold", 100);
  const durationMin = getThreshold("cascade_down", "threshold2", 2);

  const ping = getPing();
  const conditionTrue = ping !== null && ping.lossPercent >= threshold;
  const sustained = evalSustained("cascade_down", conditionTrue, durationMin * 60_000);
  const state = queries.getAlertState("cascade_down");

  if (sustained && shouldFire("cascade_down")) {
    await fireAlert(
      "cascade_down",
      `🔴 *Cascade DOWN*\nServer A unreachable: ${ping!.lossPercent}% packet loss for ${durationMin}+ min`,
      bot
    );
  } else if (!conditionTrue && state?.status === "fired") {
    await clearAlert("cascade_down", `✅ *Cascade restored* — Server A reachable again`, bot);
  }
}

async function checkCascadeDegradation(bot: Bot<BotContext>): Promise<void> {
  if (isStandalone || !isEnabled("cascade_degradation")) return;
  const threshold = getThreshold("cascade_degradation", "threshold", 30);
  const durationMin = getThreshold("cascade_degradation", "threshold2", 5);

  const ping = getPing();
  // Only fire degradation when loss is above threshold but not a full outage
  const conditionTrue = ping !== null && ping.lossPercent >= threshold && ping.lossPercent < 100;
  const sustained = evalSustained("cascade_degradation", conditionTrue, durationMin * 60_000);
  const state = queries.getAlertState("cascade_degradation");

  if (sustained && shouldFire("cascade_degradation")) {
    await fireAlert(
      "cascade_degradation",
      `⚠️ *Cascade degraded*\nServer A: ${ping!.lossPercent}% packet loss for ${durationMin}+ min`,
      bot
    );
  } else if (!conditionTrue && state?.status === "fired") {
    await clearAlert("cascade_degradation", `✅ *Cascade degradation cleared*`, bot);
  }
}

async function checkServiceDeadXray(bot: Bot<BotContext>): Promise<void> {
  if (!isEnabled("service_dead_xray")) return;

  let xrayRunning = false;
  try {
    execSync("systemctl is-active xray", { timeout: 5000, stdio: "pipe" });
    xrayRunning = true;
  } catch {
    xrayRunning = false;
  }

  const state = queries.getAlertState("service_dead_xray");
  if (!xrayRunning && shouldFire("service_dead_xray")) {
    await fireAlert("service_dead_xray", `🔴 *XRay service DOWN* on Server B`, bot);
  } else if (xrayRunning && state?.status === "fired") {
    await clearAlert("service_dead_xray", `✅ *XRay service* restored`, bot);
  }
}

async function checkServiceDeadWg(bot: Bot<BotContext>): Promise<void> {
  if (isStandalone || !isEnabled("service_dead_wg")) return;

  let wgRunning = false;
  try {
    const out = await sshPool.exec("systemctl is-active wg-quick@wg-clients");
    wgRunning = out.trim() === "active";
  } catch {
    // SSH unreachable — don't double-alert, cascade_down handles that
    return;
  }

  const state = queries.getAlertState("service_dead_wg");
  if (!wgRunning && shouldFire("service_dead_wg")) {
    await fireAlert("service_dead_wg", `🔴 *WireGuard service DOWN* on Server A`, bot);
  } else if (wgRunning && state?.status === "fired") {
    await clearAlert("service_dead_wg", `✅ *WireGuard service* restored`, bot);
  }
}

async function checkDiskFull(bot: Bot<BotContext>): Promise<void> {
  if (!isEnabled("disk_full")) return;
  const threshold = getThreshold("disk_full", "threshold", 90);

  const servers = await fetchBothServersAndBuildChecks((s) => ({
    usedGb: s.diskUsedGb, totalGb: s.diskTotalGb,
  }));

  for (const { key: serverId, label, data } of servers) {
    if (!data?.usedGb || !data?.totalGb || data.totalGb === 0) continue;
    const key = `disk_full:${serverId}`;
    const usagePercent = (data.usedGb / data.totalGb) * 100;
    const state = queries.getAlertState(key);
    if (usagePercent >= threshold && shouldFire(key)) {
      await fireAlert(
        key,
        `💾 *Disk full* on ${label}\n${data.usedGb.toFixed(1)} / ${data.totalGb.toFixed(1)} GB (${usagePercent.toFixed(0)}%)`,
        bot
      );
    } else if (usagePercent < threshold && state?.status === "fired") {
      await clearAlert(key, `✅ *Disk* on ${label} back below ${threshold}%`, bot);
    }
  }
}

async function checkNetworkSaturation(bot: Bot<BotContext>): Promise<void> {
  if (!isEnabled("network_saturation")) return;
  const threshold = getThreshold("network_saturation", "threshold", 80);
  const durationMin = getThreshold("network_saturation", "threshold2", 15);
  const channelMbps = getThreshold("channel_capacity", "threshold", 100);

  const servers = await fetchBothServersAndBuildChecks((s) => ({
    rxMbps: s.throughputRxMbps ?? 0, txMbps: s.throughputTxMbps ?? 0,
  }));

  for (const { key: serverId, label, data } of servers) {
    if (!data) continue;
    const key = `network_saturation:${serverId}`;
    const maxMbps = Math.max(data.rxMbps, data.txMbps);
    const usagePercent = (maxMbps / channelMbps) * 100;
    const conditionTrue = usagePercent >= threshold;
    const sustained = evalSustained(key, conditionTrue, durationMin * 60_000);
    const state = queries.getAlertState(key);

    if (sustained && shouldFire(key)) {
      await fireAlert(
        key,
        `📶 *Network saturated* on ${label}\n↑${data.txMbps.toFixed(1)} / ↓${data.rxMbps.toFixed(1)} Mbps (${usagePercent.toFixed(0)}% of ${channelMbps} Mbps) for ${durationMin}+ min`,
        bot
      );
    } else if (!conditionTrue && state?.status === "fired") {
      await clearAlert(key, `✅ *Network saturation* on ${label} cleared`, bot);
    }
  }
}

async function checkCpuOverload(bot: Bot<BotContext>): Promise<void> {
  if (!isEnabled("cpu_overload")) return;
  const threshold = getThreshold("cpu_overload", "threshold", 95);
  const durationMin = getThreshold("cpu_overload", "threshold2", 10);

  const servers = await fetchBothServersAndBuildChecks((s) => s.cpuPercent);

  for (const { key: serverId, label, data: cpu } of servers) {
    if (cpu === undefined) continue;
    const key = `cpu_overload:${serverId}`;
    const conditionTrue = cpu >= threshold;
    const sustained = evalSustained(key, conditionTrue, durationMin * 60_000);
    const state = queries.getAlertState(key);

    if (sustained && shouldFire(key)) {
      await fireAlert(
        key,
        `🔥 *CPU overload* on ${label}\n${cpu.toFixed(1)}% for ${durationMin}+ min`,
        bot
      );
    } else if (!conditionTrue && state?.status === "fired") {
      await clearAlert(key, `✅ *CPU* on ${label} back to normal`, bot);
    }
  }
}

async function checkAbnormalTraffic(bot: Bot<BotContext>): Promise<void> {
  if (!isEnabled("abnormal_traffic")) return;
  const thresholdGb = getThreshold("abnormal_traffic", "threshold", 50);

  const activeClients = queries.getActiveClients();
  for (const client of activeClients) {
    const usedBytes = queries.getClientTrafficLastHour(client.id);
    const usedGb = usedBytes / GB;
    const stateKey = `abnormal_traffic:${client.id}`;

    if (usedGb >= thresholdGb && shouldFire(stateKey)) {
      // Auto-suspend
      try {
        await suspendClient(client, "abnormal_traffic");
      } catch (err) {
        logger.error(`Failed to suspend ${client.name} for abnormal traffic`, err);
      }
      await fireAlert(
        stateKey,
        `🚨 *Abnormal traffic* — *${escapeMarkdown(client.name)}* suspended\n${usedGb.toFixed(1)} GB in last hour (limit: ${thresholdGb} GB/hr)`,
        bot
      );
    }
    // No recovery for abnormal_traffic — manual resume via TMA
  }
}

async function checkQuotaWarning(bot: Bot<BotContext>): Promise<void> {
  if (!isEnabled("quota_warning")) return;
  const threshold = getThreshold("quota_warning", "threshold", 90);

  const allClients = queries.getAllClients();
  const withMonthly = allClients.filter(
    (c) => c.is_active === 1 && c.monthly_quota_gb !== null
  );
  if (withMonthly.length === 0) return;

  const usageBatch = queries.getQuotaUsageBatch(withMonthly.map((c) => c.id));

  for (const client of withMonthly) {
    const usage = usageBatch.get(client.id);
    const monthlyUsedBytes = usage?.monthly_used_bytes ?? 0;
    const monthlyQuotaBytes = client.monthly_quota_gb! * GB;
    const usagePercent = (monthlyUsedBytes / monthlyQuotaBytes) * 100;
    const stateKey = `quota_warning:${client.id}`;

    if (usagePercent >= threshold && shouldFire(stateKey)) {
      await fireAlert(
        stateKey,
        `⚠️ *Quota warning* — *${escapeMarkdown(client.name)}*\n${usagePercent.toFixed(0)}% of ${client.monthly_quota_gb} GB monthly quota used`,
        bot
      );
    } else if (usagePercent < threshold && queries.getAlertState(stateKey)?.status === "fired") {
      await clearAlert(stateKey, `✅ *Quota warning* for *${escapeMarkdown(client.name)}* cleared`, bot);
    }
  }
}

async function checkCertExpiry(bot: Bot<BotContext>): Promise<void> {
  if (!isEnabled("cert_expiry")) return;
  if (!env.TMA_DOMAIN) return;

  const thresholdDays = getThreshold("cert_expiry", "threshold", 7);
  const certPath = `/etc/letsencrypt/live/${env.TMA_DOMAIN}/cert.pem`;

  if (!fs.existsSync(certPath)) return;

  try {
    const out = execSync(`openssl x509 -enddate -noout -in "${certPath}"`, {
      encoding: "utf8",
      timeout: 5000,
    });
    const match = out.match(/notAfter=(.+)/);
    if (!match) return;
    const expiry = new Date(match[1].trim());
    const daysLeft = (expiry.getTime() - Date.now()) / 86_400_000;
    const state = queries.getAlertState("cert_expiry");

    if (daysLeft <= thresholdDays && shouldFire("cert_expiry")) {
      await fireAlert(
        "cert_expiry",
        `🔐 *TLS cert expiring soon*\n${env.TMA_DOMAIN}: ${Math.ceil(daysLeft)} days left`,
        bot
      );
    } else if (daysLeft > thresholdDays && state?.status === "fired") {
      await clearAlert("cert_expiry", `✅ *TLS cert* renewed for ${env.TMA_DOMAIN}`, bot);
    }
  } catch (err) {
    logger.error("cert_expiry check failed", err);
  }
}

async function checkRebootDetected(bot: Bot<BotContext>): Promise<void> {
  if (!isEnabled("reboot_detected")) return;
  const thresholdMin = 10;

  // Server B (local)
  const uptimeBSec = os.uptime();
  const stateB = queries.getAlertState("reboot_detected:b");
  if (uptimeBSec < thresholdMin * 60 && shouldFire("reboot_detected:b")) {
    await fireAlert(
      "reboot_detected:b",
      `🔄 *Server B rebooted*\nCurrent uptime: ${Math.floor(uptimeBSec / 60)}m`,
      bot
    );
  } else if (uptimeBSec >= thresholdMin * 60 && stateB?.status === "fired") {
    await clearAlert("reboot_detected:b", `✅ *Server B* uptime stable`, bot);
  }

  // Server A (remote, cascade mode only)
  if (!isStandalone) {
    try {
      const rawUptime = await sshPool.exec("cat /proc/uptime");
      const uptimeASec = parseFloat(rawUptime.trim().split(" ")[0]);
      const stateA = queries.getAlertState("reboot_detected:a");
      if (uptimeASec < thresholdMin * 60 && shouldFire("reboot_detected:a")) {
        await fireAlert(
          "reboot_detected:a",
          `🔄 *Server A rebooted*\nCurrent uptime: ${Math.floor(uptimeASec / 60)}m`,
          bot
        );
      } else if (uptimeASec >= thresholdMin * 60 && stateA?.status === "fired") {
        await clearAlert("reboot_detected:a", `✅ *Server A* uptime stable`, bot);
      }
    } catch {
      // SSH unreachable — cascade_down handles that
    }
  }
}

async function checkRebootRequired(bot: Bot<BotContext>): Promise<void> {
  if (!isEnabled("reboot_required")) return;

  const servers = await fetchBothServersAndBuildChecks((s) => s.rebootRequired);

  for (const { key: serverId, label, data: required } of servers) {
    if (required === undefined) continue;
    const key = `reboot_required:${serverId}`;
    const state = queries.getAlertState(key);
    if (required && shouldFire(key)) {
      await fireAlert(key, `🔄 *Reboot required* on ${label}`, bot);
    } else if (!required && state?.status === "fired") {
      await clearAlert(key, `✅ *Reboot no longer required* on ${label}`, bot);
    }
  }
}

// ── Worker loop ───────────────────────────────────────────────────────────────

export function alertWorker(bot: Bot<BotContext>): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const run = async () => {
    if (stopped) return;
    try {
      // Run checks sequentially to avoid thundering-herd on SSH / metrics
      await checkCascadeDown(bot);
      await checkCascadeDegradation(bot);
      await checkServiceDeadXray(bot);
      await checkServiceDeadWg(bot);
      await checkDiskFull(bot);
      await checkNetworkSaturation(bot);
      await checkCpuOverload(bot);
      await checkAbnormalTraffic(bot);
      await checkQuotaWarning(bot);
      await checkCertExpiry(bot);
      await checkRebootDetected(bot);
      await checkRebootRequired(bot);
    } catch (err) {
      logger.error("Unhandled error", err);
    }
  };

  // Delayed start: let health/traffic workers populate ping + metrics first
  const startTimer = setTimeout(() => {
    if (stopped) return;
    void run();
    timer = setInterval(() => { void run(); }, INTERVAL_MS);
  }, STARTUP_DELAY_MS);

  logger.info("started (every 30s, first run in 90s)");
  return {
    stop: () => {
      stopped = true;
      clearTimeout(startTimer);
      if (timer) clearInterval(timer);
    },
  };
}
