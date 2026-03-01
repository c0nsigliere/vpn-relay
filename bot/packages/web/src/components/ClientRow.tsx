import { useNavigate } from "react-router-dom";
import type { Client } from "@vpn-relay/shared";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

interface ClientRowProps {
  client: Client;
  totalRx?: number;
  totalTx?: number;
}

export function ClientRow({ client, totalRx = 0, totalTx = 0 }: ClientRowProps) {
  const navigate = useNavigate();

  const typeLabel =
    client.type === "both" ? "WG+XRay" : client.type.toUpperCase();

  const statusColor = client.is_active
    ? "text-green-500"
    : "text-red-500";

  return (
    <button
      onClick={() => navigate(`/client/${client.id}`)}
      className="w-full text-left flex items-center justify-between py-3 border-b border-tg last:border-0"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-xs ${statusColor}`}>●</span>
          <span className="font-medium text-tg truncate">{client.name}</span>
          <span className="text-xs text-tg-hint bg-tg-secondary px-1.5 py-0.5 rounded">
            {typeLabel}
          </span>
        </div>
        {(totalRx > 0 || totalTx > 0) && (
          <div className="text-xs text-tg-hint mt-0.5 ml-4">
            ↓{formatBytes(totalRx)} ↑{formatBytes(totalTx)}
          </div>
        )}
        {client.expires_at && (
          <div className="text-xs text-tg-hint mt-0.5 ml-4">
            Expires {new Date(client.expires_at).toLocaleDateString()}
          </div>
        )}
      </div>
      <span className="text-tg-hint ml-2">›</span>
    </button>
  );
}
