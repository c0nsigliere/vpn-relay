/**
 * MaintenanceService — on-demand apt update / reboot, requested from the bot or the TMA.
 *
 * The bot never runs apt or reboot itself. Two escalation channels, one per server:
 *
 *   Server B (this host, unprivileged bot): write a trigger file into
 *     MAINTENANCE_TRIGGER_DIR (tmpfs, owned by vpn-bot). A systemd .path unit —
 *     one per action — fires the matching root oneshot, which execs the helper.
 *     The action lives in the *filename* and in the unit's ExecStart, so root never
 *     parses an action string that came from an unprivileged process.
 *
 *   Server A (remote, bot is root over SSH): systemd-run a transient unit. Detaching
 *     is mandatory — if the SSH channel drops (and this cascade has a dedicated
 *     cascade_down alert because it does), sshd SIGHUPs the session's children and
 *     would kill apt mid-dpkg.
 *
 * Either way the root helper owns the truth: it writes jobs/<id>.json on persistent
 * disk. This table is only a mirror. That split is what lets the bot report the result
 * of a reboot of the very host it runs on: the bot dies with the server, and the
 * freshly booted process reconciles from the file + a boot_id comparison.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { queries } from "../db/queries";
import { env } from "../config/env";
import { isStandalone, requireCascade } from "../config/standalone";
import { sshPool } from "./ssh";
import { createLogger } from "../utils/logger";
import type { MaintenanceAction, MaintenanceJob, MaintenanceStatus, ServerId } from "@vpn-relay/shared";

const logger = createLogger("maintenance");

export const MAINTENANCE_ACTIONS: MaintenanceAction[] = ["update", "update-reboot", "reboot"];

const TERMINAL: MaintenanceStatus[] = ["succeeded", "failed", "unknown"];
const JOB_ID_RE = /^[0-9a-f]{32}$/;
const LOG_TAIL_BYTES = 4096;
const LOG_TAIL_CHARS = 2000;

/** reboot_detected fires while uptime < 10 min; 15 covers it with margin. */
const PLANNED_BOOT_WINDOW_MS = 15 * 60_000;
/** After A's job is marked succeeded, wg-quick may still be seconds from active. */
const POST_TERMINAL_GRACE_MS = 3 * 60_000;

/** The root helper's jobs/<id>.json (schema 1). */
export interface AgentState {
  schema: number;
  job_id: string;
  action: MaintenanceAction;
  status: "running" | "rebooting" | "succeeded" | "failed";
  phase: string;
  boot_id: string;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  reboot_required: boolean;
  upgraded: number;
  packages: string;
}

/** One observation of a host: the job's state file plus the host's own liveness signals. */
export interface AgentProbe {
  state: AgentState | null;
  /** Current boot_id of the host — differs from state.boot_id once it has rebooted. */
  bootId: string | null;
  /** Is the unit that launched the helper still alive? null = could not tell. */
  unitAlive: boolean | null;
  logTail: string | null;
  /** Set when the host could not be reached at all (Server A only). */
  unreachable?: boolean;
}

export function isTerminal(status: MaintenanceStatus): boolean {
  return TERMINAL.includes(status);
}

/** SQLite datetime('now') is UTC with a space separator and no zone suffix. */
export function sqlUtcToMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? null : ms;
}

function epochToSqlUtc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export function nowSqlUtc(): string {
  return epochToSqlUtc(Date.now() / 1000);
}

function parseAgentState(raw: string | null): AgentState | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as AgentState;
    return parsed.schema === 1 ? parsed : null;
  } catch {
    return null; // torn read — the helper writes atomically, so just retry next tick
  }
}

/** Last `bytes` of a file, without slurping a log that a dist-upgrade may have grown. */
function readTail(file: string, bytes: number): string | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len === 0) return "";
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function trimLogTail(tail: string | null): string | null {
  if (tail === null) return null;
  return tail.length > LOG_TAIL_CHARS ? tail.slice(-LOG_TAIL_CHARS) : tail;
}

function isUnitStateAlive(activeState: string): boolean {
  // A oneshot in flight reports "activating"; a collected/finished one reports
  // "inactive", "failed" or nothing at all.
  const s = activeState.trim();
  return s === "activating" || s === "active" || s === "reloading";
}

class MaintenanceService {
  private get jobsDir(): string {
    return path.join(env.MAINTENANCE_STATE_DIR, "jobs");
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getActiveJob(server: ServerId): MaintenanceJob | null {
    return queries.getActiveMaintenanceJob(server) ?? null;
  }

  getLastJob(server: ServerId): MaintenanceJob | null {
    return queries.getLastMaintenanceJob(server) ?? null;
  }

  isInProgress(server: ServerId): boolean {
    return this.getActiveJob(server) !== null;
  }

  /**
   * True while a job is running on this server, and for a grace period after it ends.
   * The grace matters: A's job flips to succeeded the moment boot_id changes, but
   * wg-quick@wg-clients may still be seconds from active — without it, service_dead_wg
   * would fire on the very next 30s alert tick.
   */
  shouldSuppressAlerts(server: ServerId): boolean {
    if (this.isInProgress(server)) return true;
    const last = queries.getLastTerminalMaintenanceJob(server);
    if (!last) return false;
    const endedMs = sqlUtcToMs(last.finished_at) ?? sqlUtcToMs(last.created_at);
    if (endedMs === null) return false;
    return Date.now() - endedMs < POST_TERMINAL_GRACE_MS;
  }

  /** True if we deliberately rebooted this server recently — suppresses reboot_detected. */
  isPlannedBoot(server: ServerId): boolean {
    const candidates = [
      queries.getActiveMaintenanceJob(server),
      queries.getLastTerminalMaintenanceJob(server),
    ];
    return candidates.some((job) => {
      const rebootMs = sqlUtcToMs(job?.reboot_at);
      return rebootMs !== null && Date.now() - rebootMs < PLANNED_BOOT_WINDOW_MS;
    });
  }

  // ── Starting a job ─────────────────────────────────────────────────────────

  async startJob(
    server: ServerId,
    action: MaintenanceAction,
    requestedBy: "tma" | "bot"
  ): Promise<MaintenanceJob> {
    if (!MAINTENANCE_ACTIONS.includes(action)) {
      throw new MaintenanceError(`Unknown action: ${action}`, 400);
    }
    if (server === "a") requireCascade("Server A maintenance");

    if (this.getActiveJob(server)) {
      throw new MaintenanceError(`A maintenance job is already running on Server ${server.toUpperCase()}`, 409);
    }

    const id = crypto.randomBytes(16).toString("hex");

    try {
      queries.insertMaintenanceJob({ id, server_id: server, action, status: "queued", requested_by: requestedBy });
    } catch (err) {
      // The partial unique index is the real guard — it catches a request that raced
      // past the check above, from the other entry point or another open client.
      if (String((err as { code?: string }).code ?? "").startsWith("SQLITE_CONSTRAINT")) {
        throw new MaintenanceError(`A maintenance job is already running on Server ${server.toUpperCase()}`, 409);
      }
      throw err;
    }

    try {
      if (server === "b") {
        this.armServerB(id, action);
      } else {
        await this.armServerA(id, action);
      }
    } catch (err) {
      // Keep the row as an audit trail; 'failed' is terminal so it frees the index.
      const message = (err as Error).message;
      queries.updateMaintenanceJob(id, {
        status: "failed",
        phase: "arm",
        error: message,
        finished_at: nowSqlUtc(),
      });
      logger.error(`Failed to start ${action} on server ${server}: ${message}`);
      throw new MaintenanceError(`Could not start maintenance on Server ${server.toUpperCase()}: ${message}`, 502);
    }

    logger.info(`Started ${action} on server ${server} (job ${id}, by ${requestedBy})`);
    return queries.getMaintenanceJob(id)!;
  }

  /** Write the trigger atomically — the .path unit watches the exact final name. */
  private armServerB(jobId: string, action: MaintenanceAction): void {
    const dir = env.MAINTENANCE_TRIGGER_DIR;
    const finalPath = path.join(dir, `req-${action}`);
    const tmpPath = `${finalPath}.tmp`;
    fs.writeFileSync(tmpPath, jobId, { mode: 0o644 });
    fs.renameSync(tmpPath, finalPath);
  }

  /**
   * Hand the job to A's own system manager and return immediately. --unit gives it an
   * idempotent name (a duplicate systemd-run fails loudly instead of starting a second
   * apt); --collect reaps the transient unit even on failure.
   *
   * jobId and action are interpolated into a shell string, so both are gated here as
   * well as inside the helper — two independent checks.
   */
  private async armServerA(jobId: string, action: MaintenanceAction): Promise<void> {
    if (!JOB_ID_RE.test(jobId)) throw new Error("Refusing to launch: malformed job id");
    if (!MAINTENANCE_ACTIONS.includes(action)) throw new Error("Refusing to launch: unknown action");

    await sshPool.exec(
      `systemd-run -q --collect --unit=vpn-maint-${jobId} ` +
        `--setenv=VPN_MAINT_JOB=${jobId} ${env.MAINTENANCE_AGENT_BIN} ${action}`,
      15_000
    );
  }

  // ── Observing a job ────────────────────────────────────────────────────────

  async probe(job: MaintenanceJob): Promise<AgentProbe> {
    return job.server_id === "b" ? this.probeServerB(job) : this.probeServerA(job);
  }

  private probeServerB(job: MaintenanceJob): AgentProbe {
    const state = parseAgentState(readTail(path.join(this.jobsDir, `${job.id}.json`), 64 * 1024));

    let bootId: string | null = null;
    try {
      bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      bootId = null;
    }

    let unitAlive: boolean | null = null;
    try {
      // Unprivileged read-only D-Bus call — no escalation needed.
      const out = execSync(
        `systemctl show -p ActiveState --value vpn-maintenance-${job.action}.service`,
        { encoding: "utf8", timeout: 4000, stdio: "pipe" }
      );
      unitAlive = isUnitStateAlive(out);
    } catch {
      unitAlive = null;
    }

    return {
      state,
      bootId,
      unitAlive,
      logTail: trimLogTail(readTail(path.join(this.jobsDir, `${job.id}.log`), LOG_TAIL_BYTES)),
    };
  }

  /** Everything about A in a single SSH round trip — the worker ticks every 3s. */
  private async probeServerA(job: MaintenanceJob): Promise<AgentProbe> {
    const jsonPath = path.join(this.jobsDir, `${job.id}.json`);
    const logPath = path.join(this.jobsDir, `${job.id}.log`);

    // Ends in `true` on purpose: sshPool.exec rejects on a non-zero exit, and a missing
    // state file (perfectly normal early on) would otherwise look like an SSH failure.
    const cmd =
      `cat ${jsonPath} 2>/dev/null; echo '---BOOT---'; ` +
      `cat /proc/sys/kernel/random/boot_id; echo '---UNIT---'; ` +
      `systemctl show -p ActiveState --value vpn-maint-${job.id}.service 2>/dev/null; ` +
      `echo '---LOG---'; tail -c ${LOG_TAIL_BYTES} ${logPath} 2>/dev/null; true`;

    let out: string;
    try {
      out = await sshPool.exec(cmd, 20_000);
    } catch (err) {
      // Expected while A is rebooting; sshPool reconnects on its own.
      logger.debug(`Server A probe failed: ${(err as Error).message}`);
      return { state: null, bootId: null, unitAlive: null, logTail: null, unreachable: true };
    }

    const [jsonPart = "", rest = ""] = splitOnce(out, "---BOOT---");
    const [bootPart = "", rest2 = ""] = splitOnce(rest, "---UNIT---");
    const [unitPart = "", logPart = ""] = splitOnce(rest2, "---LOG---");

    return {
      state: parseAgentState(jsonPart),
      bootId: bootPart.trim() || null,
      unitAlive: unitPart.trim() ? isUnitStateAlive(unitPart) : false,
      logTail: trimLogTail(logPart),
    };
  }

  // ── Startup reconcile ──────────────────────────────────────────────────────

  /**
   * Decide what happened to jobs that were in flight when this process last died.
   *
   * This is the whole reason the status file is on persistent disk and carries a
   * boot_id: rebooting Server B kills the bot, so the only way to report the outcome
   * is for the next process to read the file the root helper left behind and compare
   * boot ids.
   *
   * Returns the jobs whose status changed, so the caller can notify.
   */
  async reconcileOnStartup(): Promise<MaintenanceJob[]> {
    const active = queries.getActiveMaintenanceJobs();
    if (active.length === 0) return [];

    logger.info(`Reconciling ${active.length} in-flight maintenance job(s) after restart`);
    const changed: MaintenanceJob[] = [];

    for (const job of active) {
      try {
        const probe = await this.probe(job);
        // Server A unreachable: leave the row alone, the worker keeps polling.
        if (probe.unreachable) continue;

        const resolved = this.reconcileOne(job, probe);
        if (resolved) changed.push(resolved);
      } catch (err) {
        logger.error(`Reconcile failed for job ${job.id}: ${(err as Error).message}`);
      }
    }

    return changed;
  }

  /** The decision table. Returns the updated row, or null to leave the job to the worker. */
  private reconcileOne(job: MaintenanceJob, probe: AgentProbe): MaintenanceJob | null {
    const { state, bootId } = probe;
    const rebooted = !!(state && bootId && state.boot_id !== bootId);

    if (state && isTerminal(state.status as MaintenanceStatus)) {
      this.applyAgentState(job, state, probe.logTail);
      return queries.getMaintenanceJob(job.id)!;
    }

    if (state?.status === "rebooting" && rebooted) {
      // The machine came back — that is exactly what "success" means for a reboot job.
      queries.updateMaintenanceJob(job.id, {
        status: "succeeded",
        phase: "done",
        exit_code: 0,
        finished_at: nowSqlUtc(),
        log_tail: probe.logTail ?? undefined,
      });
      return queries.getMaintenanceJob(job.id)!;
    }

    if (state && rebooted) {
      queries.updateMaintenanceJob(job.id, {
        status: "failed",
        phase: state.phase,
        error: "Interrupted by an unexpected reboot",
        finished_at: nowSqlUtc(),
        log_tail: probe.logTail ?? undefined,
      });
      return queries.getMaintenanceJob(job.id)!;
    }

    if (!state) {
      // No state file. If the job is young the helper may simply not have started yet —
      // leave it, the worker's stall detection owns that call.
      const createdMs = sqlUtcToMs(job.created_at);
      if (createdMs !== null && Date.now() - createdMs < 60_000) return null;
      queries.updateMaintenanceJob(job.id, {
        status: "unknown",
        error: "No status file found after restart — outcome unknown",
        finished_at: nowSqlUtc(),
      });
      return queries.getMaintenanceJob(job.id)!;
    }

    return null; // still genuinely running
  }

  /** Mirror the helper's state file into the DB row. */
  applyAgentState(job: MaintenanceJob, state: AgentState, logTail: string | null): void {
    queries.updateMaintenanceJob(job.id, {
      status: state.status,
      phase: state.phase,
      boot_id: state.boot_id,
      started_at: state.started_at ? epochToSqlUtc(state.started_at) : undefined,
      finished_at: state.finished_at ? epochToSqlUtc(state.finished_at) : undefined,
      exit_code: state.exit_code ?? undefined,
      packages_upgraded: state.upgraded ?? undefined,
      packages: state.packages || undefined,
      log_tail: logTail ?? undefined,
      error: state.status === "failed" ? `apt failed during ${state.phase} (exit ${state.exit_code ?? "?"})` : undefined,
    });
  }
}

/** Carries the HTTP status the API route should map this to. */
export class MaintenanceError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "MaintenanceError";
  }
}

function splitOnce(input: string, marker: string): [string, string] {
  const i = input.indexOf(marker);
  if (i === -1) return [input, ""];
  return [input.slice(0, i), input.slice(i + marker.length)];
}

export const maintenanceService = new MaintenanceService();

/** Server A can never be a maintenance target in standalone mode. */
export const maintenanceServers: ServerId[] = isStandalone ? ["b"] : ["a", "b"];
