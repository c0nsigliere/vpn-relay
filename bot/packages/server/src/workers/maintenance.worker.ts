/**
 * MaintenanceWorker — mirrors the root helper's state into the DB and narrates the job.
 *
 * The helper (running as root, outside this process) owns the truth. This worker only
 * observes: it polls jobs/<id>.json, copies it into maintenance_jobs, and sends the
 * Telegram transitions. That separation is deliberate — it means a job survives the bot
 * being restarted by its own apt run, and it means the progress the TMA shows is the
 * real state of dpkg rather than optimistic UI state.
 *
 * Ticks every 3s, but a tick is a single indexed query when nothing is running.
 */

import { Bot } from "grammy";
import { BotContext } from "../bot/context";
import { queries } from "../db/queries";
import { env } from "../config/env";
import { sendMarkdown, escapeMarkdown } from "../utils/telegram";
import { createLogger, logOnError } from "../utils/logger";
import { metricsCache } from "../services/metrics.cache";
import { xrayUplinkService } from "../services/xray-uplink.service";
import {
  maintenanceService,
  isTerminal,
  nowSqlUtc,
  sqlUtcToMs,
  type AgentProbe,
} from "../services/maintenance.service";
import type { MaintenanceJob, MaintenanceStatus } from "@vpn-relay/shared";

const logger = createLogger("maintenance-worker");

const INTERVAL_MS = 3_000;
/** No state file this long after the request → the helper never started. */
const STALL_QUEUED_MS = 60_000;
/** Consecutive ticks with a dead launcher unit before we call the helper dead. */
const STALL_TICKS = 2;
/** A server that has not come back this long after `rebooting` is not coming back. */
const REBOOT_DEADLINE_MS = 10 * 60_000;
/** Telegram caps messages at 4096 chars. */
const LOG_TAIL_IN_MESSAGE = 800;

/** Consecutive ticks a job's launcher unit has been dead while its state was non-terminal. */
const deadUnitTicks = new Map<string, number>();
/** Last status we announced, per job — so a transition is announced exactly once. */
const announced = new Map<string, MaintenanceStatus>();
/** Last phase logged, per job — phases are journald-only (too chatty for Telegram). */
const loggedPhase = new Map<string, string>();

/** One-line job identity for the log: "e8c2c0d0 update/a". */
function tag(job: MaintenanceJob): string {
  return `${job.id.slice(0, 8)} ${job.action}/${job.server_id}`;
}

function serverLabel(job: MaintenanceJob): string {
  return `Server ${job.server_id.toUpperCase()}`;
}

function actionLabel(job: MaintenanceJob): string {
  switch (job.action) {
    case "update": return "Update";
    case "update-reboot": return "Update + reboot";
    case "reboot": return "Reboot";
  }
}

function fail(job: MaintenanceJob, error: string, probe: AgentProbe | null): void {
  queries.updateMaintenanceJob(job.id, {
    status: "failed",
    error,
    finished_at: nowSqlUtc(),
    log_tail: probe?.logTail ?? undefined,
  });
  logger.warn(`Job ${job.id} failed: ${error}`);
}

async function notify(bot: Bot<BotContext>, text: string): Promise<void> {
  await sendMarkdown(bot.api, env.ADMIN_ID, text);
}

function terminalSummary(job: MaintenanceJob): string {
  const head = `*${escapeMarkdown(serverLabel(job))} — ${escapeMarkdown(actionLabel(job))}*`;

  if (job.status === "succeeded") {
    const lines = [`✅ ${head}`];
    if (job.action !== "reboot") {
      const n = job.packages_upgraded ?? 0;
      lines.push(n > 0 ? `Upgraded ${n} package${n === 1 ? "" : "s"}.` : "Already up to date.");
      if (job.packages) {
        const pkgs = job.packages.trim().split(/\s+/);
        const shown = pkgs.slice(0, 20).join(", ");
        lines.push(`\`${escapeMarkdown(shown)}${pkgs.length > 20 ? ` … +${pkgs.length - 20} more` : ""}\``);
        // better-sqlite3 is a native module built against Node's ABI — a nodejs bump is
        // the one apt package capable of bricking this control plane.
        if (pkgs.some((p) => p === "nodejs")) {
          lines.push("⚠️ *nodejs was upgraded* — if the bot fails to start, rebuild better-sqlite3.");
        }
      }
    }
    if (job.action === "update" && job.log_tail?.includes("reboot-required")) {
      lines.push("🔄 A reboot is still required.");
    }
    return lines.join("\n");
  }

  if (job.status === "unknown") {
    return `⚠️ ${head}\nOutcome unknown — no status file after restart.`;
  }

  const lines = [`🔴 ${head} failed`];
  if (job.phase) lines.push(`Phase: ${escapeMarkdown(job.phase)}`);
  if (job.error) lines.push(escapeMarkdown(job.error));
  if (job.log_tail) {
    const tail = job.log_tail.slice(-LOG_TAIL_IN_MESSAGE);
    lines.push("```\n" + tail + "\n```");
  }
  return lines.join("\n");
}

/** Side effects that only make sense once, when a job reaches its final state. */
async function onTerminal(bot: Bot<BotContext>, job: MaintenanceJob): Promise<void> {
  if (job.status === "succeeded") {
    // A reboot-only job upgraded nothing, so updates are still genuinely pending.
    if (job.action !== "reboot") {
      const key = `updates_pending:${job.server_id}`;
      const state = queries.getAlertState(key);
      if (state?.status === "fired") {
        queries.upsertAlertState(key, "clear");
        logger.info(`${tag(job)}: cleared alert ${key}`);
      }
    }
    // Without this the TMA would keep serving the pre-update "N upd" badge for 20s.
    metricsCache.invalidate(job.server_id);

    // Cheap, and re-asserts cascade routing in case the upgrade touched xray's unit.
    if (job.server_id === "a") {
      await xrayUplinkService
        .syncRoutingAndRestart()
        .then(() => logger.info(`${tag(job)}: re-asserted Server A cascade routing`))
        .catch(logOnError(logger, "post-maintenance routing sync"));
    }
  } else {
    metricsCache.invalidate(job.server_id);
  }

  await notify(bot, terminalSummary(job));
  loggedPhase.delete(job.id);
}

/** Announce a status change exactly once per job. */
async function announceTransition(bot: Bot<BotContext>, jobId: string): Promise<void> {
  const job = queries.getMaintenanceJob(jobId);
  if (!job) return;
  if (announced.get(jobId) === job.status) return;
  announced.set(jobId, job.status);

  // Record every transition locally before notifying. Telegram delivery can fail, and
  // this is a privileged apt/reboot run on a production host — journald must carry its
  // own account of what happened, independent of the chat.
  const detail = [
    job.phase ? `phase=${job.phase}` : "",
    job.exit_code !== null ? `exit=${job.exit_code}` : "",
    job.packages_upgraded ? `upgraded=${job.packages_upgraded}` : "",
    job.error ? `error=${job.error}` : "",
  ].filter(Boolean).join(" ");
  const line = `${tag(job)}: ${job.status}${detail ? ` (${detail})` : ""}`;
  if (job.status === "failed") logger.error(line); else logger.info(line);

  if (job.status === "running") {
    await notify(bot, `🛠 *${escapeMarkdown(serverLabel(job))}* — ${escapeMarkdown(actionLabel(job))} started.`);
    return;
  }

  if (job.status === "rebooting") {
    const extra = job.server_id === "b"
      ? "\nThe bot and mini app go offline until it is back."
      : "\nWireGuard and relay clients will drop for about a minute.";
    await notify(bot, `🔄 *${escapeMarkdown(serverLabel(job))}* is rebooting now.${extra}`);
    return;
  }

  if (isTerminal(job.status)) {
    await onTerminal(bot, job);
    announced.delete(jobId);
    deadUnitTicks.delete(jobId);
  }
}

async function tickJob(bot: Bot<BotContext>, job: MaintenanceJob): Promise<void> {
  const probe = await maintenanceService.probe(job);

  // ── The server is (or should be) rebooting ───────────────────────────────
  // Server B's reboot kills this process, so in practice this branch tracks Server A.
  // SSH rejections here are expected and already swallowed by probe().
  if (job.status === "rebooting") {
    if (probe.bootId && job.boot_id && probe.bootId !== job.boot_id) {
      queries.updateMaintenanceJob(job.id, {
        status: "succeeded",
        phase: "done",
        exit_code: 0,
        finished_at: nowSqlUtc(),
        log_tail: probe.logTail ?? undefined,
      });
      await announceTransition(bot, job.id);
      return;
    }

    const rebootMs = sqlUtcToMs(job.reboot_at);
    if (rebootMs !== null && Date.now() - rebootMs > REBOOT_DEADLINE_MS) {
      fail(job, "The server did not come back within 10 minutes", probe);
      await announceTransition(bot, job.id);
    }
    return;
  }

  // Server A briefly unreachable — keep polling, do not judge.
  if (probe.unreachable) return;

  // ── No state file yet ────────────────────────────────────────────────────
  if (!probe.state) {
    const createdMs = sqlUtcToMs(job.created_at);
    if (job.status === "queued" && createdMs !== null && Date.now() - createdMs > STALL_QUEUED_MS) {
      fail(job, "The maintenance helper never started", probe);
      await announceTransition(bot, job.id);
    }
    return;
  }

  // ── Mirror the helper's state into the row ───────────────────────────────
  maintenanceService.applyAgentState(job, probe.state, probe.logTail);

  const updated = queries.getMaintenanceJob(job.id);
  if (!updated) return;

  // Phase progress goes to journald only — it is the record of what apt actually did,
  // but far too chatty for a chat message.
  if (updated.phase && loggedPhase.get(job.id) !== updated.phase) {
    loggedPhase.set(job.id, updated.phase);
    logger.info(`${tag(updated)}: phase ${updated.phase}`);
  }

  // First sighting of `rebooting` — stamp the deadline clock.
  if (updated.status === "rebooting" && !updated.reboot_at) {
    queries.updateMaintenanceJob(job.id, { reboot_at: nowSqlUtc() });
  }

  // ── Stall detection: the helper was killed (SIGKILL, systemd timeout, OOM) ──
  // Its state file is frozen mid-run while the unit that launched it is gone.
  // Two consecutive ticks, so a momentary probe glitch cannot fail a healthy job.
  const nonTerminal = !isTerminal(updated.status) && updated.status !== "rebooting";
  if (nonTerminal && probe.unitAlive === false) {
    const ticks = (deadUnitTicks.get(job.id) ?? 0) + 1;
    deadUnitTicks.set(job.id, ticks);
    if (ticks >= STALL_TICKS) {
      fail(job, `The maintenance helper died during ${updated.phase ?? "the run"}`, probe);
      await announceTransition(bot, job.id);
      return;
    }
  } else {
    deadUnitTicks.delete(job.id);
  }

  await announceTransition(bot, job.id);
}

export function maintenanceWorker(bot: Bot<BotContext>): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const run = async (): Promise<void> => {
    try {
      const jobs = queries.getActiveMaintenanceJobs();
      if (jobs.length === 0) return;
      for (const job of jobs) {
        await tickJob(bot, job);
      }
    } catch (err) {
      logger.error("Worker error", err);
    }
  };

  // Reconcile before the first tick, never after: a job left in flight by a bot restart
  // (or by rebooting the very host the bot runs on) must be resolved from the persistent
  // state file + boot_id before stall detection gets a chance to call it dead.
  maintenanceService
    .reconcileOnStartup()
    .then(async (resolved) => {
      for (const job of resolved) {
        announced.set(job.id, job.status);
        // This is how the outcome of a reboot of B's own host reaches the operator —
        // worth its own log line, since the bot was dead while it happened.
        logger.info(`${tag(job)}: resolved on startup as ${job.status}`);
        await onTerminal(bot, job).catch(logOnError(logger, "reconcile notification"));
      }
      // Anything still active was already announced in a previous life — do not repeat it.
      for (const job of queries.getActiveMaintenanceJobs()) {
        announced.set(job.id, job.status);
      }
    })
    .catch(logOnError(logger, "maintenance reconcile"))
    .finally(() => {
      if (stopped) return;
      void run();
      timer = setInterval(() => { void run(); }, INTERVAL_MS);
      logger.info(`started (every ${INTERVAL_MS / 1000}s, idle unless a job is active)`);
    });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}
