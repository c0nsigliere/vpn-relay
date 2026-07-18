/**
 * MaintenanceCard — Update / Reboot for one server, plus the live progress view.
 *
 * The phase shown here is read straight from the status file the root helper writes,
 * so it reflects the real state of dpkg rather than optimistic UI state. It therefore
 * survives a page reload, a bot restart, and the server's own reboot.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchMaintenance, startMaintenance } from "../api/client";
import { useTelegram } from "../hooks/useTelegram";
import type { MaintenanceAction, MaintenanceJob, ServerId } from "@vpn-relay/shared";

/** SQLite datetime('now') — UTC, space-separated, no zone suffix. */
function parseSqlUtc(ts: string | null): Date | null {
  if (!ts) return null;
  const d = new Date(ts.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function elapsed(job: MaintenanceJob): string {
  const start = parseSqlUtc(job.started_at) ?? parseSqlUtc(job.created_at);
  if (!start) return "";
  const end = parseSqlUtc(job.finished_at) ?? new Date();
  const secs = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  const m = Math.floor(secs / 60);
  return m > 0 ? `${m}m ${secs % 60}s` : `${secs}s`;
}

const PHASE_LABEL: Record<string, string> = {
  arm: "Starting…",
  preflight: "Preparing",
  "apt-update": "Refreshing package lists",
  "dist-upgrade": "Installing upgrades",
  clean: "Cleaning up",
  rebooting: "Rebooting",
  done: "Done",
  busy: "Another job is running",
};

const ACTION_LABEL: Record<MaintenanceAction, string> = {
  update: "Update",
  "update-reboot": "Update + reboot",
  reboot: "Reboot",
};

function phaseText(job: MaintenanceJob): string {
  if (job.status === "queued") return "Starting…";
  return PHASE_LABEL[job.phase ?? ""] ?? job.phase ?? job.status;
}

export function MaintenanceCard({ serverId }: { serverId: ServerId }) {
  const { haptic } = useTelegram();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<null | "update" | "reboot">(null);
  const [error, setError] = useState("");

  const { data } = useQuery({
    queryKey: ["maintenance", serverId],
    queryFn: () => fetchMaintenance(serverId),
    // Lean in while a job runs, relax to the normal cadence when idle.
    refetchInterval: (q) => (q.state.data?.active ? 2_000 : 30_000),
    retry: false,
  });

  const startMutation = useMutation({
    mutationFn: (action: MaintenanceAction) => startMaintenance(serverId, action),
    onSuccess: () => {
      haptic.notification("success");
      setConfirm(null);
      setError("");
      void queryClient.invalidateQueries({ queryKey: ["maintenance", serverId] });
      void queryClient.invalidateQueries({ queryKey: ["servers-status"] });
    },
    onError: (err: Error) => {
      haptic.notification("error");
      setConfirm(null);
      setError(err.message);
      setTimeout(() => setError(""), 6000);
      // A 409 means someone else got there first — show it, don't fight it.
      void queryClient.invalidateQueries({ queryKey: ["maintenance", serverId] });
    },
  });

  const active = data?.active ?? null;
  const last = data?.last ?? null;
  const busy = startMutation.isPending || active !== null;

  const serverLabel = `Server ${serverId.toUpperCase()}`;

  return (
    <div className="bg-tg-secondary rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-tg">Maintenance</span>
        {active && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">
            <span className="inline-block animate-spin">⟳</span> {phaseText(active)}
          </span>
        )}
      </div>

      {error && (
        <div className="mb-3 px-4 py-2 rounded-lg bg-red-50 text-tg-destructive text-sm">
          {error}
        </div>
      )}

      {/* ── A job is running: no buttons, just the truth ── */}
      {active ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-tg">{ACTION_LABEL[active.action]}</span>
            <span className="text-tg-hint text-xs">{elapsed(active)}</span>
          </div>
          <div className="text-xs text-tg-hint">
            {active.status === "rebooting"
              ? serverId === "b"
                ? "Rebooting. This mini app will go offline; the result arrives in Telegram."
                : "Rebooting. Clients will reconnect automatically."
              : phaseText(active)}
          </div>
          {active.packages_upgraded !== null && active.packages_upgraded > 0 && (
            <div className="text-xs text-tg-hint">
              {active.packages_upgraded} package{active.packages_upgraded === 1 ? "" : "s"} to upgrade
            </div>
          )}
          {active.log_tail && (
            <pre className="mt-2 max-h-40 overflow-auto text-[10px] leading-tight text-tg-hint bg-tg rounded-lg p-2 whitespace-pre-wrap">
              {active.log_tail.slice(-1200)}
            </pre>
          )}
        </div>
      ) : confirm === "update" ? (
        <div className="space-y-2">
          <p className="text-xs text-tg-hint">
            Runs <code>apt update</code> + <code>dist-upgrade</code> on {serverLabel} — the same
            thing the maintenance playbook does.
          </p>
          <button
            onClick={() => startMutation.mutate("update")}
            disabled={busy}
            className="w-full px-4 py-3 rounded-xl bg-tg-button text-tg-button font-medium text-sm disabled:opacity-60"
          >
            Update only
          </button>
          <button
            onClick={() => startMutation.mutate("update-reboot")}
            disabled={busy}
            className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
          >
            Update + reboot if required
          </button>
          <button
            onClick={() => setConfirm(null)}
            className="w-full px-4 py-2 rounded-xl text-tg-hint text-sm"
          >
            Cancel
          </button>
        </div>
      ) : confirm === "reboot" ? (
        <div className="space-y-2">
          {/* Be honest: for Server B this kills the very app showing this message. */}
          <p className="text-xs text-tg-hint">
            {serverId === "b"
              ? "The bot, the API and this mini app will go offline for about a minute. The result will arrive in Telegram."
              : "All WireGuard and relay clients will drop for about a minute."}
          </p>
          <button
            onClick={() => startMutation.mutate("reboot")}
            disabled={busy}
            className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg-destructive font-medium text-sm border border-tg disabled:opacity-60"
          >
            Reboot {serverLabel}
          </button>
          <button
            onClick={() => setConfirm(null)}
            className="w-full px-4 py-2 rounded-xl text-tg-hint text-sm"
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => { haptic.impact("light"); setConfirm("update"); }}
              disabled={busy}
              className="px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
            >
              ⬆️ Update
            </button>
            <button
              onClick={() => { haptic.impact("light"); setConfirm("reboot"); }}
              disabled={busy}
              className="px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
            >
              🔄 Reboot
            </button>
          </div>
          {last && <LastJob job={last} />}
        </>
      )}
    </div>
  );
}

function LastJob({ job }: { job: MaintenanceJob }) {
  const icon = job.status === "succeeded" ? "✅" : job.status === "failed" ? "🔴" : "⚠️";
  const when = parseSqlUtc(job.finished_at) ?? parseSqlUtc(job.created_at);

  return (
    <div className="mt-3 pt-3 border-t border-tg text-xs text-tg-hint space-y-1">
      <div>
        {icon} Last: {ACTION_LABEL[job.action]} — {job.status}
        {when ? ` · ${when.toLocaleString()}` : ""}
      </div>
      {job.status === "succeeded" && job.action !== "reboot" && (
        <div>
          {job.packages_upgraded
            ? `${job.packages_upgraded} package${job.packages_upgraded === 1 ? "" : "s"} upgraded`
            : "Already up to date"}
        </div>
      )}
      {job.error && <div className="text-tg-destructive">{job.error}</div>}
    </div>
  );
}
