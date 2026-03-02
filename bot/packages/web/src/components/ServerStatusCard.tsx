import type { ServerStatus, ServerId } from "@vpn-relay/shared";
import { Sparkline } from "./Sparkline";
import { formatBytesLong } from "../utils/format";

interface SparklinePoint {
  ts: string;
  rx: number;
  tx: number;
}

interface ServerStatusCardProps {
  title: string;
  serverId: ServerId;
  ip?: string;
  status: ServerStatus | { error: string } | undefined;
  sparklineData?: SparklinePoint[];
  trafficTotal24h?: { rx: number; tx: number };
  onClick?: () => void;
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

function pingColor(ms: number, loss: number): string {
  if (loss > 0 || ms > 300) return "#f38ba8"; // red
  if (ms > 150) return "#fab387"; // yellow
  return "#a6e3a1"; // green
}

export function ServerStatusCard({
  title,
  ip,
  status,
  sparklineData,
  trafficTotal24h,
  onClick,
}: ServerStatusCardProps) {
  const isClickable = !!onClick;

  return (
    <div
      className={`bg-tg-secondary rounded-xl p-4 ${isClickable ? "cursor-pointer active:opacity-80" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="font-medium text-sm text-tg">{title}</span>
          {ip && <span className="block text-xs text-tg-hint font-mono">{ip}</span>}
        </div>
        <div className="flex items-center gap-2">
          {status === undefined && (
            <span className="text-xs text-tg-hint">Loading…</span>
          )}
          {status && "error" in status && (
            <span className="text-xs text-tg-destructive">Unreachable</span>
          )}
          {status && !("error" in status) && (
            <span className="text-xs text-tg-hint">↑ {status.uptime}</span>
          )}
          {isClickable && (
            <span className="text-tg-hint text-xs">›</span>
          )}
        </div>
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

          {/* Disk */}
          {status.diskTotalGb !== undefined && status.diskUsedGb !== undefined && (
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-tg-hint">Disk</span>
                <span className="text-tg">
                  {status.diskUsedGb} / {status.diskTotalGb} GB
                </span>
              </div>
              <ProgressBar value={status.diskUsedGb} max={status.diskTotalGb} color="#cba6f7" />
            </div>
          )}

          {/* Ping */}
          {status.pingMs !== undefined && status.pingLossPercent !== undefined && (
            <div className="flex items-center gap-1.5 text-xs">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: pingColor(status.pingMs, status.pingLossPercent) }}
              />
              <span className="text-tg-hint">A ↔ B Link:</span>
              <span className="text-tg">
                {status.pingLossPercent === 100
                  ? "unreachable"
                  : `${status.pingMs.toFixed(0)}ms`}
              </span>
            </div>
          )}

          {/* Badges */}
          <div className="flex flex-wrap gap-2 pt-1">
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

          {/* Sparkline */}
          {sparklineData && sparklineData.length > 0 && (
            <div className="pt-1">
              <Sparkline data={sparklineData} />
              {trafficTotal24h && (
                <div className="text-xs text-tg-hint mt-1">
                  24h: ↓{formatBytesLong(trafficTotal24h.rx)} / ↑{formatBytesLong(trafficTotal24h.tx)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
