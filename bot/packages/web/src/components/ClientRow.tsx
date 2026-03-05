import { useNavigate } from "react-router-dom";
import type { Client, ClientQuotaUsage } from "@vpn-relay/shared";
import { formatRelativeTime } from "../utils/format";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

const SUSPEND_REASON_SHORT: Record<string, string> = {
  manual: "Suspended",
  daily_quota: "Daily limit",
  monthly_quota: "Monthly limit",
  expired: "Expired",
};

function getStatusInfo(client: Client): { dot: string; label: string } {
  if (!client.is_active) return { dot: "#f38ba8", label: SUSPEND_REASON_SHORT[client.suspend_reason ?? ""] ?? "Suspended" };
  if (!client.last_seen_at) return { dot: "#6c7086", label: "Offline" };
  const diffMs = Date.now() - new Date(
    client.last_seen_at.endsWith("Z") ? client.last_seen_at : client.last_seen_at + "Z"
  ).getTime();
  const diffMin = diffMs / 60_000;
  if (diffMin <= 15) return { dot: "#a6e3a1", label: "Online" };
  if (diffMin <= 1440) return { dot: "#f9e2af", label: formatRelativeTime(client.last_seen_at) };
  return { dot: "#6c7086", label: "Offline" };
}

interface ClientRowProps {
  client: Client;
  totalRx?: number;
  totalTx?: number;
  quota?: ClientQuotaUsage;
}

export function ClientRow({ client, totalRx = 0, totalTx = 0, quota }: ClientRowProps) {
  const navigate = useNavigate();
  const { dot, label } = getStatusInfo(client);

  const dailyPct = quota?.daily_quota_bytes ? quota.daily_used_bytes / quota.daily_quota_bytes * 100 : 0;
  const monthlyPct = quota?.monthly_quota_bytes ? quota.monthly_used_bytes / quota.monthly_quota_bytes * 100 : 0;

  const typeLabel =
    client.type === "both" ? "WG+XRay" : client.type.toUpperCase();

  return (
    <button
      onClick={() => navigate(`/client/${client.id}`)}
      className="w-full text-left flex items-center justify-between py-3 border-b border-tg last:border-0"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: dot }}>●</span>
          <span className="font-medium text-tg truncate">{client.name}</span>
          <span className="text-xs text-tg-hint bg-tg-secondary px-1.5 py-0.5 rounded">
            {typeLabel}
          </span>
          {client.last_connection_route && (client.type === "xray" || client.type === "both") && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: client.last_connection_route === "direct" ? "#89b4fa20" : "#cba6f720",
                color: client.last_connection_route === "direct" ? "#89b4fa" : "#cba6f7",
              }}
            >
              {client.last_connection_route === "direct" ? "Direct" : "Relay"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 ml-4">
          <span className="text-xs" style={{ color: dot === "#a6e3a1" ? "#a6e3a1" : "var(--tg-hint)" }}>
            {label}
          </span>
          {(totalRx > 0 || totalTx > 0) && (
            <span className="text-xs text-tg-hint">
              ↓{formatBytes(totalRx)} ↑{formatBytes(totalTx)}
            </span>
          )}
          {client.last_ip_isp && (
            <span className="text-xs text-tg-hint truncate max-w-[100px]">
              {client.last_ip_isp}
            </span>
          )}
        </div>
        {client.expires_at && (
          <div className="text-xs text-tg-hint mt-0.5 ml-4">
            Expires {new Date(client.expires_at).toLocaleDateString()}
          </div>
        )}
        {(dailyPct >= 90 || monthlyPct >= 90) && (
          <div className="flex gap-1 mt-0.5 ml-4">
            {dailyPct >= 100 && (
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f38ba820", color: "#f38ba8" }}>
                Daily limit
              </span>
            )}
            {dailyPct >= 90 && dailyPct < 100 && (
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f9e2af20", color: "#f9e2af" }}>
                90% daily
              </span>
            )}
            {monthlyPct >= 100 && (
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f38ba820", color: "#f38ba8" }}>
                Monthly limit
              </span>
            )}
            {monthlyPct >= 90 && monthlyPct < 100 && (
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: "#f9e2af20", color: "#f9e2af" }}>
                90% monthly
              </span>
            )}
          </div>
        )}
      </div>
      <span className="text-tg-hint ml-2">›</span>
    </button>
  );
}
