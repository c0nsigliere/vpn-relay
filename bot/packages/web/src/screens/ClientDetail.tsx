import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "../components/Layout";
import { TrafficChart } from "../components/TrafficChart";
import { useTelegram } from "../hooks/useTelegram";
import { fetchClient, patchClient, deleteClient, sendConfig, fetchTrafficHistory, fetchClientMonthly } from "../api/client";
import { formatBytesLong, formatMonth } from "../utils/format";

type Period = "24h" | "7d" | "14d";

const PERIOD_LIMITS: Record<Period, number> = {
  "24h": 144,
  "7d": 1008,
  "14d": 2016,
};

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { haptic } = useTelegram();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<Period>("24h");

  const { data: client, isLoading, error } = useQuery({
    queryKey: ["client", id],
    queryFn: () => fetchClient(id!),
    enabled: !!id,
  });

  const { data: trafficData } = useQuery({
    queryKey: ["traffic", id, period],
    queryFn: () => fetchTrafficHistory(id!, PERIOD_LIMITS[period]),
    enabled: !!id,
  });

  const { data: monthlyData } = useQuery({
    queryKey: ["client-monthly", id],
    queryFn: () => fetchClientMonthly(id!),
    enabled: !!id,
  });

  const patchMutation = useMutation({
    mutationFn: (action: "suspend" | "resume") => patchClient(id!, { action }),
    onSuccess: () => {
      haptic.notification("success");
      void queryClient.invalidateQueries({ queryKey: ["client", id] });
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteClient(id!),
    onSuccess: () => {
      haptic.notification("success");
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
      navigate("/clients");
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  const configMutation = useMutation({
    mutationFn: () => sendConfig(id!),
    onSuccess: () => {
      haptic.notification("success");
      alert("Config sent to your Telegram chat!");
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  if (isLoading) {
    return <Layout backTo="/clients" title="Client"><div className="text-tg-hint py-8 text-center">Loading…</div></Layout>;
  }

  if (error || !client) {
    return <Layout backTo="/clients" title="Client"><div className="text-tg-destructive py-8 text-center">Client not found.</div></Layout>;
  }

  const typeLabel = client.type === "both" ? "WireGuard + XRay" : client.type.toUpperCase();
  const isActive = client.is_active === 1;

  // Compute totals from snapshots
  const snapshots = trafficData?.snapshots ?? [];
  const totals = snapshots.reduce(
    (acc, s) => ({
      wgRx: acc.wgRx + s.wg_rx,
      wgTx: acc.wgTx + s.wg_tx,
      xrayRx: acc.xrayRx + s.xray_rx,
      xrayTx: acc.xrayTx + s.xray_tx,
    }),
    { wgRx: 0, wgTx: 0, xrayRx: 0, xrayTx: 0 }
  );

  const handleDelete = () => {
    if (window.confirm(`Delete ${client.name}? This cannot be undone.`)) {
      deleteMutation.mutate();
    }
  };

  return (
    <Layout backTo="/clients" title={client.name}>
      {/* Info card */}
      <div className="bg-tg-secondary rounded-xl p-4 mb-4">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-tg-hint">Status</div>
          <div className={isActive ? "text-green-500 font-medium" : "text-red-500 font-medium"}>
            {isActive ? "Active" : "Suspended"}
          </div>

          <div className="text-tg-hint">Type</div>
          <div className="text-tg">{typeLabel}</div>

          {client.wg_ip && (
            <>
              <div className="text-tg-hint">WG IP</div>
              <div className="text-tg font-mono text-xs">{client.wg_ip}</div>
            </>
          )}

          {client.expires_at && (
            <>
              <div className="text-tg-hint">Expires</div>
              <div className="text-tg">{new Date(client.expires_at).toLocaleDateString()}</div>
            </>
          )}

          <div className="text-tg-hint">Created</div>
          <div className="text-tg">{new Date(client.created_at).toLocaleDateString()}</div>

          {/* Traffic totals */}
          {(client.type === "wg" || client.type === "both") && (
            <>
              <div className="text-tg-hint">WG Traffic ({period})</div>
              <div className="text-tg text-xs">↓{formatBytesLong(totals.wgRx)} ↑{formatBytesLong(totals.wgTx)}</div>
            </>
          )}
          {(client.type === "xray" || client.type === "both") && (
            <>
              <div className="text-tg-hint">XRay Traffic ({period})</div>
              <div className="text-tg text-xs">↓{formatBytesLong(totals.xrayRx)} ↑{formatBytesLong(totals.xrayTx)}</div>
            </>
          )}
        </div>
      </div>

      {/* Traffic chart */}
      <div className="bg-tg-secondary rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-tg">Traffic</span>
          <div className="flex gap-1">
            {(["24h", "7d", "14d"] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-2 py-0.5 rounded text-xs border ${
                  period === p
                    ? "bg-tg-button text-tg-button border-transparent"
                    : "bg-tg text-tg-hint border-tg"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <TrafficChart snapshots={snapshots} clientType={client.type} />
      </div>

      {/* Monthly Traffic */}
      <div className="bg-tg-secondary rounded-xl p-4 mb-4">
        <span className="text-sm font-medium text-tg block mb-3">Monthly Traffic</span>
        {!monthlyData || monthlyData.history.length === 0 ? (
          <div className="text-tg-hint text-sm text-center py-4">No monthly data yet.</div>
        ) : (
          <div className="space-y-3">
            {monthlyData.history.map((m) => (
              <div key={m.month}>
                <div className="text-xs text-tg-hint mb-1">{formatMonth(m.month)}</div>
                <div className="text-sm text-tg">
                  ↓ {formatBytesLong(m.rx_total)}&nbsp;&nbsp;|&nbsp;&nbsp;↑ {formatBytesLong(m.tx_total)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-2">
        <button
          onClick={() => configMutation.mutate()}
          disabled={configMutation.isPending}
          className="w-full px-4 py-3 rounded-xl bg-tg-button text-tg-button font-medium text-sm disabled:opacity-60"
        >
          {configMutation.isPending ? "Sending…" : "📩 Send Config to Chat"}
        </button>

        {isActive ? (
          <button
            onClick={() => patchMutation.mutate("suspend")}
            disabled={patchMutation.isPending}
            className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
          >
            {patchMutation.isPending ? "Suspending…" : "⏸ Suspend"}
          </button>
        ) : (
          <button
            onClick={() => patchMutation.mutate("resume")}
            disabled={patchMutation.isPending}
            className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
          >
            {patchMutation.isPending ? "Resuming…" : "▶ Resume"}
          </button>
        )}

        <button
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
          className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg-destructive font-medium text-sm border border-tg disabled:opacity-60"
        >
          {deleteMutation.isPending ? "Deleting…" : "🗑 Delete Client"}
        </button>
      </div>
    </Layout>
  );
}
