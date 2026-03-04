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
  status: ServerStatus | { error: string } | undefined;
  sparklineData?: SparklinePoint[];
  trafficTotal24h?: { rx: number; tx: number };
  onClick?: () => void;
}

export function ServerStatusCard({
  title,
  status,
  sparklineData,
  trafficTotal24h,
  onClick,
}: ServerStatusCardProps) {
  const isClickable = !!onClick;
  const isOk = status && !("error" in status);

  return (
    <div
      className={`bg-tg-secondary rounded-xl px-4 py-3 ${isClickable ? "cursor-pointer active:opacity-80" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        {/* Left: name + uptime + badges */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm text-tg">{title}</span>
          {status === undefined && (
            <span className="text-xs text-tg-hint">Loading…</span>
          )}
          {status && "error" in status && (
            <span className="text-xs text-tg-destructive">Unreachable</span>
          )}
          {isOk && (
            <span className="text-xs text-tg-hint">↑ {(status as ServerStatus).uptime}</span>
          )}
          {isOk && (status as ServerStatus).rebootRequired && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400">Reboot</span>
          )}
          {isOk && (status as ServerStatus).updatesAvailable > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">
              {(status as ServerStatus).updatesAvailable} upd
            </span>
          )}
        </div>

        {/* Right: sparkline + 24h total + chevron */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {sparklineData && sparklineData.length > 0 && (
            <div className="flex flex-col items-end gap-0.5">
              <Sparkline data={sparklineData} width={72} height={24} />
              {trafficTotal24h && (
                <span className="text-[10px] text-tg-hint leading-none">
                  ↓{formatBytesLong(trafficTotal24h.rx)} ↑{formatBytesLong(trafficTotal24h.tx)}
                </span>
              )}
            </div>
          )}
          {isClickable && <span className="text-tg-hint text-xs">›</span>}
        </div>
      </div>

      {status && "error" in status && (
        <p className="text-xs text-tg-hint mt-1">{status.error}</p>
      )}
    </div>
  );
}
