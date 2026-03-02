import type { ServerStatus } from "@vpn-relay/shared";

interface ServerStatusCardProps {
  title: string;
  status: ServerStatus | { error: string } | undefined;
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="w-full h-1.5 rounded-full bg-tg-secondary overflow-hidden">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

function cpuColor(pct: number): string {
  if (pct >= 85) return "#f38ba8"; // red
  if (pct >= 60) return "#fab387"; // yellow/orange
  return "#a6e3a1"; // green
}

export function ServerStatusCard({ title, status }: ServerStatusCardProps) {
  return (
    <div className="bg-tg-secondary rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="font-medium text-sm text-tg">{title}</span>
        {status === undefined && (
          <span className="text-xs text-tg-hint">Loading…</span>
        )}
        {status && "error" in status && (
          <span className="text-xs text-tg-destructive">Unreachable</span>
        )}
        {status && !("error" in status) && (
          <span className="text-xs text-tg-hint">↑ {status.uptime}</span>
        )}
      </div>

      {status && "error" in status && (
        <p className="text-xs text-tg-hint">{status.error}</p>
      )}

      {status && !("error" in status) && (
        <div className="space-y-2.5">
          {/* CPU */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-tg-hint">CPU</span>
              <span className="text-tg">{status.cpuPercent.toFixed(0)}%</span>
            </div>
            <ProgressBar value={status.cpuPercent} max={100} color={cpuColor(status.cpuPercent)} />
          </div>

          {/* RAM */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-tg-hint">RAM</span>
              <span className="text-tg">
                {status.ramUsedMb} / {status.ramTotalMb} MB
              </span>
            </div>
            <ProgressBar value={status.ramUsedMb} max={status.ramTotalMb} color="#89b4fa" />
          </div>

          {/* Badges */}
          <div className="flex gap-2 pt-1">
            {status.rebootRequired && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
                Reboot required
              </span>
            )}
            {status.updatesAvailable > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">
                {status.updatesAvailable} security update{status.updatesAvailable !== 1 ? "s" : ""}
              </span>
            )}
            {!status.rebootRequired && status.updatesAvailable === 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">
                Up to date
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
